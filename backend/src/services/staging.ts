import { many, one, query } from "../db/client";

export interface StagedVmRow {
  id: number;
  template_id: string;
  template_name: string;
  protocol: "rdp" | "vnc";
  proxmox_node: string;
  proxmox_vmid: number;
  proxmox_template_id: number;
  snapshot_name: string;
  guest_ip: string | null;
  guest_port: number;
  guest_username: string | null;
  guest_password: string | null;
  status: "queued" | "provisioning" | "running" | "failed";
  failure_reason: string | null;
}

export async function claimReadyStagedVm(templateId: string): Promise<StagedVmRow | null> {
  return one<StagedVmRow>(
    `WITH picked AS (
       SELECT id FROM staged_vms
       WHERE template_id=$1 AND status='running'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM staged_vms
     WHERE id IN (SELECT id FROM picked)
     RETURNING *`,
    [templateId]
  );
}

export async function countLiveStagedVms(templateId: string, node?: string): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM staged_vms
     WHERE template_id=$1
       AND ($2::text IS NULL OR proxmox_node=$2)
       AND status IN ('queued','provisioning','running')`,
    [templateId, node ?? null]
  );
  return Number(row?.count ?? 0);
}

export async function countAllLiveStagedVms(): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM staged_vms
     WHERE status IN ('queued','provisioning','running')`
  );
  return Number(row?.count ?? 0);
}

export async function listStagedVms(): Promise<StagedVmRow[]> {
  return many<StagedVmRow>(`SELECT * FROM staged_vms ORDER BY template_id, created_at`);
}

export async function getStagedVmById(id: number): Promise<StagedVmRow | null> {
  return one<StagedVmRow>(`SELECT * FROM staged_vms WHERE id=$1`, [id]);
}

export async function insertStagedVm(
  data: Omit<StagedVmRow, "id" | "guest_ip" | "status" | "failure_reason">
): Promise<StagedVmRow> {
  const row = await one<StagedVmRow>(
    `INSERT INTO staged_vms
       (template_id, template_name, protocol, proxmox_node, proxmox_vmid,
        proxmox_template_id, snapshot_name, guest_port, guest_username,
        guest_password, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued')
     RETURNING *`,
    [
      data.template_id,
      data.template_name,
      data.protocol,
      data.proxmox_node,
      data.proxmox_vmid,
      data.proxmox_template_id,
      data.snapshot_name,
      data.guest_port,
      data.guest_username,
      data.guest_password,
    ]
  );
  if (!row) throw new Error("Failed to insert staged VM");
  return row;
}

export async function markStagedProvisioning(id: number): Promise<void> {
  await query(`UPDATE staged_vms SET status='provisioning', updated_at=NOW() WHERE id=$1`, [id]);
}

export async function markStagedRunning(id: number, ip: string): Promise<void> {
  await query(`UPDATE staged_vms SET status='running', guest_ip=$2, updated_at=NOW() WHERE id=$1`, [id, ip]);
}

export async function markStagedFailed(id: number, reason: string): Promise<void> {
  await query(`UPDATE staged_vms SET status='failed', failure_reason=$2, updated_at=NOW() WHERE id=$1`, [id, reason]);
}

export async function deleteStagedVm(id: number): Promise<void> {
  await query(`DELETE FROM staged_vms WHERE id=$1`, [id]);
}
