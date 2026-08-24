/**
 * Centralized configuration. Reads env vars (validated with zod) and the
 * YAML files under /app/config (templates.yaml, nodes.yaml).
 *
 * Everything else in the codebase should import from here instead of touching
 * process.env directly, so we have one source of truth and one place to validate.
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env schema
// ---------------------------------------------------------------------------
const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  BACKEND_PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().default("http://localhost:8080"),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_EXPIRES_IN: z.string().default("12h"),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),

  PROXMOX_TOKEN_ID: z.string(),
  PROXMOX_TOKEN_SECRET: z.string(),
  PROXMOX_VERIFY_TLS: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  GUACD_HOST: z.string().default("guacd"),
  GUACD_PORT: z.coerce.number().default(4822),

  MAX_VMS_PER_USER: z.coerce.number().default(2),
  MAX_CLUSTER_VMS: z.coerce.number().default(60),
  SESSION_HARD_TIMEOUT_MINUTES: z.coerce.number().default(240),
  SESSION_EXTEND_MINUTES: z.coerce.number().default(60),
  SESSION_INACTIVITY_TIMEOUT_MINUTES: z.coerce.number().default(30),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().default(10),

  VM_ID_RANGE_START: z.coerce.number().default(10000),
  VM_ID_RANGE_END: z.coerce.number().default(19999),

  // -------------------------------------------------------------------------
  // Guest performance. These are applied to every clone alongside cores and
  // memory. The defaults are what a browser-rendered desktop actually needs;
  // Proxmox's own defaults are tuned for live migration between mismatched
  // hosts, which is not something a disposable practice VM ever does.
  // -------------------------------------------------------------------------
  /**
   * QEMU CPU model. Proxmox defaults to `kvm64`, which hides AES-NI, AVX and
   * most of the last decade of instructions from the guest - the single
   * largest cause of "the VMs are slow", and brutal for Windows. `host` passes
   * the physical CPU straight through. Set this to `kvm64` only if you need to
   * live-migrate between nodes with different CPUs.
   */
  VM_CPU_TYPE: z.string().default("host"),
  /**
   * Turn memory ballooning off. With it on, the host reclaims guest RAM under
   * pressure and the guest starts swapping while `free` still looks fine.
   */
  VM_DISABLE_BALLOON: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  /**
   * Display adapter. `std` with real video memory is what keeps a 1080p+
   * console from tearing and repainting in bands over VNC. Blank leaves the
   * template's own setting alone.
   */
  VM_VGA_TYPE: z.string().default("std"),
  /** Video memory in MB (Proxmox range 4-512). 16 covers 1080p, 32 covers 4K. */
  VM_VGA_MEMORY_MB: z.coerce.number().min(4).max(512).default(32),
  /**
   * Pin every clone to one socket. Multi-socket topology on a desktop guest
   * buys nothing and costs NUMA-crossing latency.
   */
  VM_SOCKETS: z.coerce.number().min(1).max(4).default(1),

  CONFIG_DIR: z.string().default("/app/config"),

  // VM import pipeline. Uploaded bundles land in IMPORT_DIR, get repackaged
  // there, and are deleted once the import finishes.
  IMPORT_DIR: z.string().default("/app/uploads"),
  IMPORT_MAX_UPLOAD_GB: z.coerce.number().default(128),
  /**
   * Fail an upload if no bytes arrive for this long. Replaces Node's default
   * 5-minute whole-request timeout, which a multi-gigabyte upload trips every
   * time — see the server timeout setup in index.ts.
   */
  IMPORT_UPLOAD_STALL_MINUTES: z.coerce.number().default(5),
  /**
   * Base URL a Proxmox node can use to reach this backend, for the pull
   * transfer (the node fetches the image itself instead of us pushing it).
   * Leave blank to derive it from PUBLIC_URL's host and BACKEND_PORT, which is
   * right whenever the backend port is published on the same machine.
   */
  IMPORT_PULL_URL_BASE: z.string().default(""),
  /** VMIDs for imported templates live outside the clone pool. */
  IMPORT_VMID_RANGE_START: z.coerce.number().default(9000),
  IMPORT_VMID_RANGE_END: z.coerce.number().default(9899),
  /** Ceiling for the disk-conversion task, which dominates a large import. */
  IMPORT_TASK_TIMEOUT_MINUTES: z.coerce.number().default(240),
});

export const env = envSchema.parse(process.env);

// ---------------------------------------------------------------------------
// YAML configs (nodes + templates)
// ---------------------------------------------------------------------------
const nodeSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().default(8006),
  enabled: z.boolean().default(true),
});

const nodesFileSchema = z.object({
  nodes: z.array(nodeSchema).min(1, "config/nodes.yaml must list at least one node"),
});

const templateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "template id must be lowercase alphanumeric, dashes, underscores"),
  name: z.string(),
  description: z.string().default(""),
  icon: z.enum(["windows", "server", "linux", "network", "generic"]).default("generic"),
  proxmox_template_id: z.number().int().positive(),
  proxmox_template_ids: z.record(z.number().int().positive()).optional(),
  snapshot_name: z.string().nullable().optional().transform((value) => value ?? ""),
  protocol: z.enum(["rdp", "vnc"]),
  port: z.number().int().default(3389),
  username: z.string(),
  password: z.string(),
  cpu_cores: z.number().int().min(1).default(2),
  memory_mb: z.number().int().min(512).default(2048),
  staging_pool_size: z.number().int().min(0).max(20).default(1),
  enabled: z.boolean().default(true),
  color: z.string().optional(),
});

const templatesFileSchema = z.object({
  templates: z.array(templateSchema),
});

// Explicit output shapes. We avoid `z.infer` here because newer zod versions
// keep defaulted fields as optional in the inferred input type even though the
// parsed output always has them.
export interface ProxmoxNodeConfig {
  name: string;
  host: string;
  port: number;
  enabled: boolean;
}

export interface TemplateConfig {
  id: string;
  name: string;
  description: string;
  icon: "windows" | "server" | "linux" | "network" | "generic";
  proxmox_template_id: number;
  snapshot_name: string;
  protocol: "rdp" | "vnc";
  port: number;
  username: string;
  password: string;
  cpu_cores: number;
  memory_mb: number;
  staging_pool_size: number;
  enabled: boolean;
  color?: string;
  proxmox_template_ids?: Record<string, number>;
}

function readYaml<T>(file: string, schema: z.ZodType<T>): T {
  const full = path.join(env.CONFIG_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing config file: ${full}`);
  }
  const raw = fs.readFileSync(full, "utf8");
  const parsed = yaml.load(raw);
  return schema.parse(parsed);
}

let _nodes: ProxmoxNodeConfig[] | null = null;
let _templates: TemplateConfig[] | null = null;
/**
 * Templates created by the import wizard. They live in Postgres rather than
 * templates.yaml so the config mount can stay read-only and a new tile appears
 * without editing a file or restarting the container. Kept in this module so
 * getTemplates() can stay synchronous for its many callers; the DB read happens
 * at startup and after each import (see services/importedTemplates.ts).
 */
let _imported: TemplateConfig[] = [];
/**
 * Template ids an admin has hidden. Kept as a synchronous overlay for the same
 * reason as `_imported`: getTemplates() has many callers and none of them can
 * await. Loaded at startup and refreshed whenever the set changes.
 */
let _hidden: Set<string> = new Set();

export function getNodes(): ProxmoxNodeConfig[] {
  if (!_nodes) {
    _nodes = readYaml("nodes.yaml", nodesFileSchema).nodes as ProxmoxNodeConfig[];
  }
  return _nodes;
}

export function getTemplates(): TemplateConfig[] {
  if (!_templates) {
    _templates = readYaml("templates.yaml", templatesFileSchema).templates as TemplateConfig[];
  }

  // A YAML entry with the same id wins: hand-written config is the more
  // deliberate of the two.
  const yamlIds = new Set(_templates.map((t) => t.id));
  const all = _imported.length === 0
    ? _templates
    : [..._templates, ..._imported.filter((t) => !yamlIds.has(t.id))];

  if (_hidden.size === 0) return all;
  // A hidden template is reported as disabled rather than dropped, so the many
  // `.filter(t => t.enabled)` callers keep working and admin tooling can still
  // see that the template exists.
  return all.map((t) => (_hidden.has(t.id) ? { ...t, enabled: false } : t));
}

/** Every template including hidden ones, with their real enabled flag. */
export function getAllTemplatesRaw(): TemplateConfig[] {
  if (!_templates) {
    _templates = readYaml("templates.yaml", templatesFileSchema).templates as TemplateConfig[];
  }
  const yamlIds = new Set(_templates.map((t) => t.id));
  return [..._templates, ..._imported.filter((t) => !yamlIds.has(t.id))];
}

/** True when the template came from templates.yaml rather than an import. */
export function isYamlTemplate(id: string): boolean {
  if (!_templates) {
    _templates = readYaml("templates.yaml", templatesFileSchema).templates as TemplateConfig[];
  }
  return _templates.some((t) => t.id === id);
}

export function isTemplateHidden(id: string): boolean {
  return _hidden.has(id);
}

/** Replace the hidden-template overlay. Called after loading it from the DB. */
export function setHiddenTemplates(ids: string[]): void {
  _hidden = new Set(ids);
}

/** Replace the imported-template overlay. Called after loading them from the DB. */
export function setImportedTemplates(templates: TemplateConfig[]): void {
  _imported = templates;
}

/** Validate a template record from outside the YAML file (i.e. from Postgres). */
export function parseTemplateConfig(raw: unknown): TemplateConfig {
  return templateSchema.parse(raw) as TemplateConfig;
}

export function getTemplate(id: string): TemplateConfig | undefined {
  return getTemplates().find((t) => t.id === id);
}

/** Force reload from disk. Useful for tests and the /admin/reload endpoint. */
export function reloadConfigs(): void {
  _nodes = null;
  _templates = null;
  // _imported and _hidden are database overlays, not file state — leave them.
  getNodes();
  getTemplates();
}
