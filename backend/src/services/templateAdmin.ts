/**
 * Template (image) administration.
 *
 * The dashboard tile, the Proxmox template VM it clones from, the warm pool,
 * and any running clones are four separate things that all have to agree.
 * Until now an admin could only remove the tile — leaving the template VM and
 * its disks on the cluster with no way to reach them from the UI. This module
 * gives one view of all four, and one operation that removes all four.
 */
import {
  getAllTemplatesRaw,
  isTemplateHidden,
  isYamlTemplate,
  setHiddenTemplates,
  TemplateConfig,
} from "../config";
import { many, one, query } from "../db/client";
import { logger } from "./logger";
import { proxmox } from "./proxmox";
import { deleteImportedTemplate, refreshImportedTemplates } from "./importedTemplates";
import { listStagingHealth } from "./stagingHealth";
import { releaseVmid } from "./vmidPool";

export interface TemplateVmRef {
  node: string;
  vmid: number;
  /** null when we could not reach the node to check. */
  exists: boolean | null;
  isTemplate: boolean | null;
  error?: string;
}

export interface ManagedTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  protocol: "rdp" | "vnc";
  port: number;
  cpuCores: number;
  memoryMb: number;
  /** Where the tile is defined. YAML tiles can be hidden but not deleted. */
  source: "yaml" | "imported";
  enabled: boolean;
  hidden: boolean;
  templateVms: TemplateVmRef[];
  readyCount: number;
  stagedCount: number;
  activeSessions: number;
  poolSize: number;
  lastError: string | null;
  consecutiveFailures: number;
}

const LIVE_SESSION_STATES = ["queued", "provisioning", "running", "cleaning"];

/** Load the hidden-template overlay from the database into config. */
export async function refreshHiddenTemplates(): Promise<void> {
  const rows = await many<{ template_id: string }>(
    `SELECT template_id FROM template_overrides WHERE hidden`
  );
  setHiddenTemplates(rows.map((row) => row.template_id));
}

/** Drop a template's override row entirely (used when the tile itself goes). */
export async function clearTemplateOverride(templateId: string): Promise<void> {
  await query(`DELETE FROM template_overrides WHERE template_id=$1`, [templateId]);
  await refreshHiddenTemplates();
}

export async function setTemplateHidden(templateId: string, hidden: boolean, reason?: string): Promise<void> {
  await query(
    `INSERT INTO template_overrides (template_id, hidden, hidden_at, reason, updated_at)
     VALUES ($1, $2, CASE WHEN $2 THEN NOW() ELSE NULL END, $3, NOW())
     ON CONFLICT (template_id) DO UPDATE
       SET hidden = EXCLUDED.hidden,
           hidden_at = EXCLUDED.hidden_at,
           reason = EXCLUDED.reason,
           updated_at = NOW()`,
    [templateId, hidden, reason ?? null]
  );
  await refreshHiddenTemplates();
}

/** Every node/VMID pair a template clones from. */
function templateVmIds(template: TemplateConfig): Array<{ node: string | null; vmid: number }> {
  if (template.proxmox_template_ids) {
    return Object.entries(template.proxmox_template_ids).map(([node, vmid]) => ({ node, vmid }));
  }
  // No per-node map: one VMID that lives on whichever node holds it.
  return [{ node: null, vmid: template.proxmox_template_id }];
}

/**
 * Resolve every template VMID in one pass.
 *
 * /cluster/resources is cluster-wide, so a single call covers every template
 * on every node — far better than a status probe per VMID, which on a cluster
 * with an unreachable node would mean one timeout each. The point of this is
 * to be able to say "this image points at VMID 9003 and no such VM exists",
 * which is the single most common reason a tile never stages.
 */
type ClusterIndex = Map<number, { node: string; name?: string; status?: string }> | null;

async function loadClusterIndex(): Promise<ClusterIndex> {
  try {
    const vms = await proxmox.listClusterVms();
    const index = new Map<number, { node: string; name?: string; status?: string }>();
    for (const vm of vms) {
      if (vm.type === "qemu" && vm.vmid && vm.node) {
        index.set(vm.vmid, { node: vm.node, name: vm.name, status: vm.status });
      }
    }
    return index;
  } catch (err) {
    // No cluster view: report "unknown" rather than claiming every template
    // VM is missing, which would be a far more alarming and wrong answer.
    logger.warn({ err: String(err) }, "could not read cluster resources for template view");
    return null;
  }
}

function resolveTemplateVms(template: TemplateConfig, index: ClusterIndex): TemplateVmRef[] {
  return templateVmIds(template).map((entry) => {
    if (!index) {
      return {
        node: entry.node ?? "unknown",
        vmid: entry.vmid,
        exists: null,
        isTemplate: null,
        error: "Could not reach any Proxmox node to check.",
      };
    }

    const found = index.get(entry.vmid);
    if (!found) {
      return {
        node: entry.node ?? "not found on any node",
        vmid: entry.vmid,
        exists: false,
        isTemplate: null,
        error: entry.node
          ? `VMID ${entry.vmid} does not exist on ${entry.node}.`
          : `VMID ${entry.vmid} does not exist on any node in the cluster.`,
      };
    }

    // A pinned per-node mapping that points at a VM living somewhere else will
    // fail every clone, so say so rather than reporting a bare "exists".
    if (entry.node && found.node !== entry.node) {
      return {
        node: entry.node,
        vmid: entry.vmid,
        exists: false,
        isTemplate: null,
        error: `VMID ${entry.vmid} exists but is on ${found.node}, not ${entry.node}.`,
      };
    }

    return {
      node: found.node,
      vmid: entry.vmid,
      exists: true,
      // Cluster resources report a template as stopped; we cannot tell a
      // template from a plain stopped VM from this view alone.
      isTemplate: null,
    };
  });
}

export async function listManagedTemplates(): Promise<ManagedTemplate[]> {
  const templates = getAllTemplatesRaw();
  const health = await listStagingHealth();
  const clusterIndex = await loadClusterIndex();

  const stagedRows = await many<{ template_id: string; status: string; count: string }>(
    `SELECT template_id, status, COUNT(*)::text AS count FROM staged_vms GROUP BY template_id, status`
  );
  const sessionRows = await many<{ template_id: string; count: string }>(
    `SELECT template_id, COUNT(*)::text AS count
       FROM sessions
      WHERE status = ANY($1::text[])
      GROUP BY template_id`,
    [LIVE_SESSION_STATES]
  );
  const poolRows = await many<{ template_id: string; pool_size: number }>(
    `SELECT template_id, pool_size FROM template_staging_settings`
  );

  const activeByTemplate = new Map(sessionRows.map((r) => [r.template_id, Number(r.count)]));
  const poolByTemplate = new Map(poolRows.map((r) => [r.template_id, Number(r.pool_size)]));

  return templates.map((template) => {
      const staged = stagedRows.filter((r) => r.template_id === template.id);
      const ready = staged.filter((r) => r.status === "running").reduce((n, r) => n + Number(r.count), 0);
      const total = staged.reduce((n, r) => n + Number(r.count), 0);
      const row = health.get(template.id);

      return {
        id: template.id,
        name: template.name,
        description: template.description,
        icon: template.icon,
        protocol: template.protocol,
        port: template.port,
        cpuCores: template.cpu_cores,
        memoryMb: template.memory_mb,
        source: isYamlTemplate(template.id) ? ("yaml" as const) : ("imported" as const),
        enabled: template.enabled && !isTemplateHidden(template.id),
        hidden: isTemplateHidden(template.id),
        templateVms: resolveTemplateVms(template, clusterIndex),
        readyCount: ready,
        stagedCount: total,
        activeSessions: activeByTemplate.get(template.id) ?? 0,
        poolSize: poolByTemplate.get(template.id) ?? template.staging_pool_size ?? 1,
        lastError: row?.last_error ?? null,
        consecutiveFailures: row?.consecutive_failures ?? 0,
      };
  });
}

export interface DestroyReport {
  templateId: string;
  tileRemoved: "deleted" | "hidden";
  clonesDeleted: Array<{ vmid: number; node: string; kind: "session" | "staged" }>;
  templatesDeleted: Array<{ vmid: number; node: string }>;
  failed: Array<{ vmid: number; node: string; error: string }>;
}

/** True when the error means the VM is already gone or the node is unreachable. */
function alreadyGone(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return ["404", "not found", "does not exist", "no such"].some((needle) => msg.includes(needle));
}

async function destroyVm(node: string, vmid: number): Promise<void> {
  try {
    const stopUpid = await proxmox.powerOff(node, vmid, true);
    await proxmox.waitForTask(node, stopUpid, 60_000).catch(() => undefined);
  } catch {
    // Already off, or off-limits. Deletion below is the step that matters.
  }
  const deleteUpid = await proxmox.deleteVM(node, vmid);
  await proxmox.waitForTask(node, deleteUpid, 120_000);
  await releaseVmid(vmid).catch(() => undefined);
}

/**
 * Remove a template and everything derived from it.
 *
 * Order is not incidental. Clones are *linked* clones — their disks reference
 * the template's. Proxmox refuses to delete a template while a linked clone
 * still exists, so every clone has to go first, and we have to wait for each
 * delete task rather than firing them off.
 */
export async function destroyTemplateCompletely(templateId: string): Promise<DestroyReport> {
  const template = getAllTemplatesRaw().find((t) => t.id === templateId);
  if (!template) throw new Error(`unknown template: ${templateId}`);

  const report: DestroyReport = {
    templateId,
    tileRemoved: "deleted",
    clonesDeleted: [],
    templatesDeleted: [],
    failed: [],
  };

  // 1. Hide the tile first, so nobody can claim a new VM from this template
  //    while we are part-way through tearing it down.
  await setTemplateHidden(templateId, true, "template destroyed by an admin");

  // 2. Live sessions using this template.
  const sessions = await many<{ id: number; proxmox_vmid: number; proxmox_node: string }>(
    `SELECT id, proxmox_vmid, proxmox_node FROM sessions
      WHERE template_id=$1 AND status = ANY($2::text[])`,
    [templateId, LIVE_SESSION_STATES]
  );
  for (const session of sessions) {
    try {
      await destroyVm(session.proxmox_node, session.proxmox_vmid);
      report.clonesDeleted.push({ vmid: session.proxmox_vmid, node: session.proxmox_node, kind: "session" });
    } catch (err) {
      if (alreadyGone(err)) {
        report.clonesDeleted.push({ vmid: session.proxmox_vmid, node: session.proxmox_node, kind: "session" });
      } else {
        report.failed.push({ vmid: session.proxmox_vmid, node: session.proxmox_node, error: String(err) });
      }
    }
    await query(
      `UPDATE sessions SET status='stopped', cleaned_up_at=NOW(), demo_active=FALSE WHERE id=$1`,
      [session.id]
    );
  }

  // 3. Warm pool.
  const staged = await many<{ id: number; proxmox_vmid: number; proxmox_node: string }>(
    `SELECT id, proxmox_vmid, proxmox_node FROM staged_vms WHERE template_id=$1`,
    [templateId]
  );
  for (const vm of staged) {
    await query(`DELETE FROM staged_vms WHERE id=$1`, [vm.id]);
    try {
      await destroyVm(vm.proxmox_node, vm.proxmox_vmid);
      report.clonesDeleted.push({ vmid: vm.proxmox_vmid, node: vm.proxmox_node, kind: "staged" });
    } catch (err) {
      if (alreadyGone(err)) {
        report.clonesDeleted.push({ vmid: vm.proxmox_vmid, node: vm.proxmox_node, kind: "staged" });
      } else {
        report.failed.push({ vmid: vm.proxmox_vmid, node: vm.proxmox_node, error: String(err) });
      }
    }
  }

  // 4. The template VM(s) themselves — only now that no linked clone remains.
  for (const entry of templateVmIds(template)) {
    let node = entry.node;
    if (!node) {
      node = await proxmox.findVmNode(entry.vmid).catch(() => null);
      if (!node) {
        logger.info({ templateId, vmid: entry.vmid }, "template VM not present on any node - nothing to delete");
        continue;
      }
    }
    try {
      await destroyVm(node, entry.vmid);
      report.templatesDeleted.push({ vmid: entry.vmid, node });
    } catch (err) {
      if (alreadyGone(err)) {
        report.templatesDeleted.push({ vmid: entry.vmid, node });
      } else {
        report.failed.push({ vmid: entry.vmid, node, error: String(err) });
      }
    }
  }

  // 5. The tile and its bookkeeping. A YAML tile cannot be deleted — the file
  //    is the source of truth and the config mount is read-only — so the hide
  //    from step 1 stands in for it and the caller is told which happened.
  if (isYamlTemplate(templateId)) {
    report.tileRemoved = "hidden";
  } else {
    await deleteImportedTemplate(templateId);
    await refreshImportedTemplates();
    // The tile is gone, so its override row has nothing left to describe.
    await clearTemplateOverride(templateId);
    report.tileRemoved = "deleted";
  }

  await query(`DELETE FROM template_staging_settings WHERE template_id=$1`, [templateId]);
  await query(`DELETE FROM template_staging_health WHERE template_id=$1`, [templateId]);

  return report;
}

/** Drop override rows for templates that no longer exist anywhere. */
export async function pruneTemplateOverrides(): Promise<void> {
  const known = getAllTemplatesRaw().map((t) => t.id);
  const stale = await one<{ count: string }>(
    `WITH removed AS (
       DELETE FROM template_overrides WHERE NOT (template_id = ANY($1::text[])) RETURNING 1
     ) SELECT COUNT(*)::text AS count FROM removed`,
    [known]
  );
  if (Number(stale?.count ?? 0) > 0) {
    logger.info({ removed: Number(stale!.count) }, "pruned stale template overrides");
    await refreshHiddenTemplates();
  }
}
