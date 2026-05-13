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
  SESSION_INACTIVITY_TIMEOUT_MINUTES: z.coerce.number().default(30),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().default(10),

  VM_ID_RANGE_START: z.coerce.number().default(10000),
  VM_ID_RANGE_END: z.coerce.number().default(19999),

  CONFIG_DIR: z.string().default("/app/config"),
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
  snapshot_name: z.string().default("baseline"),
  protocol: z.enum(["rdp", "vnc"]),
  port: z.number().int().default(3389),
  username: z.string(),
  password: z.string(),
  cpu_cores: z.number().int().min(1).default(2),
  memory_mb: z.number().int().min(512).default(2048),
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
  enabled: boolean;
  color?: string;
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
  return _templates;
}

export function getTemplate(id: string): TemplateConfig | undefined {
  return getTemplates().find((t) => t.id === id);
}

/** Force reload from disk. Useful for tests and the /admin/reload endpoint. */
export function reloadConfigs(): void {
  _nodes = null;
  _templates = null;
  getNodes();
  getTemplates();
}
