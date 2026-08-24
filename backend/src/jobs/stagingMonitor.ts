/**
 * Warm-pool sweeper. Runs every two minutes.
 *
 * Before this existed, `ensureAllStagedVms()` was only ever called at boot,
 * when a student claimed a VM, or when an admin pressed Refill. That is fine
 * while staging succeeds - but if it failed (a node briefly unreachable, the
 * cluster momentarily at capacity, a template VMID not yet present on a node),
 * nothing ever tried again. The tile sat on "Warming up" until somebody
 * restarted the backend, which is exactly the failure this sweeper exists to
 * end.
 *
 * Each tick does two things:
 *
 *   1. Reaps staged rows wedged in `queued`/`provisioning`. Those states are
 *      meant to last milliseconds; a row stuck in one is a VM the maintainer
 *      still counts toward the pool, so one wedged row silently caps the
 *      template's warm count forever.
 *   2. Tops the pool back up. `ensureStagedVm` also discards stalled BullMQ
 *      jobs, so a job that died mid-clone gets replaced rather than blocking
 *      its slot.
 */
import { logger } from "../services/logger";
import { proxmox } from "../services/proxmox";
import { deleteStagedVm, listStagedVms } from "../services/staging";
import { recordStagingFailure } from "../services/stagingHealth";
import { ensureAllStagedVms } from "../services/stagingMaintainer";
import { releaseVmid } from "../services/vmidPool";

const SWEEP_INTERVAL_MS = 120_000;

/**
 * How long a staged row may sit in a non-running state before we treat it as
 * abandoned. Generous on purpose: the provisioning worker writes the row and
 * moves it to `running` in the same breath, so anything past this is not a
 * slow clone, it is a row whose worker is gone.
 */
const STAGED_ROW_STALL_MS = 15 * 60 * 1000;

async function reapWedgedStagedRows(): Promise<number> {
  const rows = await listStagedVms();
  const now = Date.now();
  let reaped = 0;

  for (const row of rows) {
    const isWedged =
      (row.status === "queued" || row.status === "provisioning") &&
      now - new Date(row.updated_at).getTime() > STAGED_ROW_STALL_MS;
    const isFailed = row.status === "failed";
    if (!isWedged && !isFailed) continue;

    logger.warn(
      { stagedId: row.id, templateId: row.template_id, vmId: row.proxmox_vmid, status: row.status },
      "reaping abandoned staged VM row"
    );

    // Drop the row first: it is the thing miscounting the pool, and we would
    // rather leak a VM on Proxmox (visible in Admin -> Delete Inactive VMs)
    // than leave the template permanently unable to stage.
    await deleteStagedVm(row.id);
    reaped += 1;

    if (isWedged) {
      await recordStagingFailure(
        row.template_id,
        `A staged VM was left in "${row.status}" and was cleaned up. Check the backend log around VM ${row.proxmox_vmid} on ${row.proxmox_node}.`
      ).catch(() => undefined);
    }

    try {
      await proxmox
        .powerOff(row.proxmox_node, row.proxmox_vmid, true)
        .then((upid) => proxmox.waitForTask(row.proxmox_node, upid, 60_000))
        .catch(() => undefined);
      const deleteUpid = await proxmox.deleteVM(row.proxmox_node, row.proxmox_vmid);
      await proxmox.waitForTask(row.proxmox_node, deleteUpid, 120_000);
    } catch (err) {
      logger.warn(
        { vmId: row.proxmox_vmid, node: row.proxmox_node, err: String(err) },
        "could not delete abandoned staged VM - left for the admin VM cleanup"
      );
    }
    await releaseVmid(row.proxmox_vmid).catch(() => undefined);
  }

  return reaped;
}

export function startStagingMonitor(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const reaped = await reapWedgedStagedRows();
      if (reaped > 0) logger.info({ reaped }, "staging sweep reaped abandoned rows");
      await ensureAllStagedVms();
    } catch (err) {
      logger.error({ err: String(err) }, "staging sweep failed");
    }
  };

  const initial = setTimeout(tick, 30_000);
  const interval = setInterval(tick, SWEEP_INTERVAL_MS);
  interval.unref();
  initial.unref();
  return interval;
}
