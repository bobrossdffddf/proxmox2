/**
 * Proxmox cluster client.
 *
 * Reads node definitions from config/nodes.yaml and exposes:
 *   - selectLeastLoadedNode(): pick a target node for a new VM
 *   - cloneTemplate(): linked-clone a template into a new VM
 *   - powerOn / powerOff / deleteVM
 *   - rollbackToSnapshot
 *   - waitForGuestIp(): poll qemu-guest-agent until we get a non-loopback IPv4
 *
 * Each Proxmox node has its own axios instance because the API token is
 * the same across the cluster but the host changes.
 */
import https from "https";
import axios, { AxiosInstance } from "axios";
import { env, getNodes, ProxmoxNodeConfig } from "../config";
import { logger } from "./logger";

interface ProxmoxNodeStatus {
  cpu: number;       // 0..1 fractional utilization
  maxcpu: number;    // total cores (informational)
  memory: { used: number; total: number };
}

interface ProxmoxResponse<T> {
  data: T;
}

export class ProxmoxClusterClient {
  private clients: Map<string, AxiosInstance> = new Map();

  constructor() {
    const agent = new https.Agent({
      rejectUnauthorized: env.PROXMOX_VERIFY_TLS,
      keepAlive: true,
    });

    for (const node of getNodes()) {
      const client = axios.create({
        baseURL: `https://${node.host}:${node.port}/api2/json`,
        timeout: 15000,
        httpsAgent: agent,
        headers: {
          Authorization: `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`,
        },
      });
      this.clients.set(node.name, client);
    }
  }

  private clientFor(nodeName: string): AxiosInstance {
    const c = this.clients.get(nodeName);
    if (!c) throw new Error(`Unknown Proxmox node: ${nodeName}`);
    return c;
  }

  /**
   * Ask Proxmox where a given VMID lives. We try each configured node's
   * /cluster/resources view (it's cluster-wide, so one query is enough).
   * Returns the node name that owns the VM, or null if the VM isn't found.
   */
  async findVmNode(vmId: number): Promise<string | null> {
    for (const node of getNodes()) {
      try {
        const res = await this.clientFor(node.name).get<ProxmoxResponse<Array<{ type: string; vmid?: number; node?: string }>>>(
          `/cluster/resources?type=vm`
        );
        const match = res.data.data.find((r) => r.vmid === vmId);
        if (match?.node) return match.node;
        // First successful response means the cluster view is complete; no need to keep asking other nodes.
        return null;
      } catch (err) {
        logger.debug({ node: node.name, err: String(err) }, "findVmNode: node unreachable, trying next");
      }
    }
    return null;
  }

  /**
   * Reachable, enabled nodes. We try the API once to filter out offline nodes.
   */
  async listHealthyNodes(): Promise<ProxmoxNodeConfig[]> {
    const healthy: ProxmoxNodeConfig[] = [];
    for (const node of getNodes()) {
      if (!node.enabled) continue;
      try {
        await this.clientFor(node.name).get(`/nodes/${node.name}/status`);
        healthy.push(node);
      } catch (err) {
        logger.warn({ node: node.name, err: String(err) }, "Proxmox node unreachable, skipping");
      }
    }
    return healthy;
  }

  /**
   * Returns the node name with the lowest combined CPU + memory utilization.
   * Score = 0.6 * cpu% + 0.4 * memory%.
   */
  async selectLeastLoadedNode(): Promise<string> {
    const healthy = await this.listHealthyNodes();
    if (healthy.length === 0) {
      throw new Error("No reachable Proxmox nodes");
    }

    const scored: Array<{ node: string; score: number; cpu: number; mem: number }> = [];

    for (const node of healthy) {
      try {
        const res = await this.clientFor(node.name).get<ProxmoxResponse<ProxmoxNodeStatus>>(
          `/nodes/${node.name}/status`
        );
        const s = res.data.data;
        const cpuPct = s.cpu * 100;                          // already 0..1
        const memPct = (s.memory.used / s.memory.total) * 100;
        const score = 0.6 * cpuPct + 0.4 * memPct;
        scored.push({ node: node.name, score, cpu: cpuPct, mem: memPct });
      } catch (err) {
        logger.warn({ node: node.name, err: String(err) }, "failed to read node status");
      }
    }

    if (scored.length === 0) {
      throw new Error("Could not read status from any Proxmox node");
    }

    scored.sort((a, b) => a.score - b.score);
    logger.info({ nodes: scored }, "node load snapshot");
    return scored[0].node;
  }

  /**
   * Clone a template VM into a new VM. Uses linked clones (full=0) for speed.
   * Returns the UPID Proxmox uses to identify the clone task.
   */
  async cloneTemplate(opts: {
    node: string;
    templateId: number;
    newVmId: number;
    name: string;
  }): Promise<string> {
    const params = new URLSearchParams();
    params.append("newid", String(opts.newVmId));
    params.append("name", opts.name);
    params.append("full", "0");

    const res = await this.clientFor(opts.node).post<ProxmoxResponse<string>>(
      `/nodes/${opts.node}/qemu/${opts.templateId}/clone`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return res.data.data;
  }

  /**
   * Poll a UPID until the task is done. Throws if the task ended with an error.
   */
  async waitForTask(node: string, upid: string, timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await this.clientFor(node).get<ProxmoxResponse<{ status: string; exitstatus?: string }>>(
        `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`
      );
      const { status, exitstatus } = res.data.data;
      if (status === "stopped") {
        if (exitstatus && exitstatus !== "OK") {
          throw new Error(`Proxmox task ${upid} failed: ${exitstatus}`);
        }
        return;
      }
      await sleep(2000);
    }
    throw new Error(`Proxmox task ${upid} timed out`);
  }

  async setResources(opts: {
    node: string;
    vmId: number;
    cores: number;
    memoryMb: number;
    args?: string;
  }): Promise<void> {
    const params = new URLSearchParams();
    params.append("cores", String(opts.cores));
    params.append("memory", String(opts.memoryMb));
    if (opts.args) {
      params.append("args", opts.args);
    }
    await this.clientFor(opts.node).put(
      `/nodes/${opts.node}/qemu/${opts.vmId}/config`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
  }

  async powerOn(node: string, vmId: number): Promise<string> {
    const res = await this.clientFor(node).post<ProxmoxResponse<string>>(
      `/nodes/${node}/qemu/${vmId}/status/start`
    );
    return res.data.data;
  }

  async powerOff(node: string, vmId: number, force = false): Promise<string> {
    const path = force
      ? `/nodes/${node}/qemu/${vmId}/status/stop`
      : `/nodes/${node}/qemu/${vmId}/status/shutdown`;
    const params = new URLSearchParams();
    params.append("forceStop", "1");
    params.append("timeout", "30");
    const res = await this.clientFor(node).post<ProxmoxResponse<string>>(
      path,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return res.data.data;
  }

  async deleteVM(node: string, vmId: number): Promise<string> {
    const params = new URLSearchParams();
    params.append("purge", "1");
    params.append("destroy-unreferenced-disks", "1");
    const res = await this.clientFor(node).delete<ProxmoxResponse<string>>(
      `/nodes/${node}/qemu/${vmId}?${params.toString()}`
    );
    return res.data.data;
  }

  async rollbackToSnapshot(node: string, vmId: number, snapshot: string): Promise<string> {
    const res = await this.clientFor(node).post<ProxmoxResponse<string>>(
      `/nodes/${node}/qemu/${vmId}/snapshot/${snapshot}/rollback`
    );
    return res.data.data;
  }

  async getVmStatus(node: string, vmId: number): Promise<string> {
    const res = await this.clientFor(node).get<ProxmoxResponse<{ status: string }>>(
      `/nodes/${node}/qemu/${vmId}/status/current`
    );
    return res.data.data.status;
  }

  /**
   * Ask the guest agent for the VM's IPv4 address. Returns null if the agent
   * isn't responding yet (template still booting, agent not installed, etc.).
   * Callers usually poll this with a backoff.
   */
  async getGuestIp(node: string, vmId: number): Promise<string | null> {
    interface Ifc {
      "ip-addresses"?: Array<{
        "ip-address-type": string;
        "ip-address": string;
      }>;
      name?: string;
    }
    try {
      const res = await this.clientFor(node).get<ProxmoxResponse<{ result: Ifc[] }>>(
        `/nodes/${node}/qemu/${vmId}/agent/network-get-interfaces`
      );
      const ifaces = res.data.data?.result ?? [];
      for (const iface of ifaces) {
        if (iface.name && /lo/i.test(iface.name)) continue;
        for (const addr of iface["ip-addresses"] ?? []) {
          if (
            addr["ip-address-type"] === "ipv4" &&
            !addr["ip-address"].startsWith("127.") &&
            !addr["ip-address"].startsWith("169.254.")
          ) {
            return addr["ip-address"];
          }
        }
      }
    } catch (err) {
      // 500 here usually means the guest agent isn't up yet. Not fatal.
      logger.debug({ node, vmId, err: String(err) }, "guest-agent IP not available yet");
    }
    return null;
  }

  /**
   * Block until we get a guest IP, or throw after the deadline.
   */
  async waitForGuestIp(node: string, vmId: number, timeoutMs = 180_000): Promise<string> {
    const start = Date.now();
    let backoff = 2000;
    while (Date.now() - start < timeoutMs) {
      const ip = await this.getGuestIp(node, vmId);
      if (ip) return ip;
      await sleep(backoff);
      backoff = Math.min(backoff * 1.25, 8000);
    }
    throw new Error(`Timed out waiting for guest IP on VM ${vmId} (${node})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const proxmox = new ProxmoxClusterClient();
