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
import fs from "fs";
import https from "https";
import { Readable } from "stream";
import axios, { AxiosInstance } from "axios";
import { env, getNodes, ProxmoxNodeConfig } from "../config";
import { logger } from "./logger";

interface ProxmoxNodeStatus {
  cpu: number;       // 0..1 fractional utilization
  maxcpu: number;    // total cores (informational)
  memory: { used: number; total: number };
}

export interface ProxmoxVmStatus {
  status: string;
  cpu?: number;
  cpus?: number;
  mem?: number;
  maxmem?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  uptime?: number;
}

export interface ProxmoxClusterVm {
  type: string;
  vmid?: number;
  node?: string;
  name?: string;
  status?: string;
}

interface ProxmoxResponse<T> {
  data: T;
}

export interface ProxmoxStorage {
  storage: string;
  type: string;
  /** Content types this storage accepts: images, iso, vztmpl, import, … */
  content: string[];
  active: boolean;
  shared: boolean;
  avail: number | null;
  total: number | null;
}

export interface ProxmoxVolume {
  volid: string;
  size: number;
  format?: string;
  ctime?: number;
}

/**
 * What Proxmox's own OVF/OVA parser made of an uploaded bundle. Available on
 * PVE 8.2 and newer; older clusters 501 this endpoint.
 */
export interface ProxmoxImportMetadata {
  type?: string;
  source?: string;
  /** VM config keys Proxmox suggests: name, cores, memory, ostype, bios… */
  "create-args"?: Record<string, string | number>;
  /** Disk key ("scsi0") to the importable volume behind it. */
  disks?: Record<string, { volid: string; size?: number } | string>;
  /** NIC key ("net0") to a model/bridge string. */
  net?: Record<string, { model?: string; bridge?: string } | string>;
  warnings?: Array<{ type?: string; key?: string; value?: string } | string>;
}

export class ProxmoxClusterClient {
  private clients: Map<string, AxiosInstance> = new Map();

  private clientFor(nodeName: string): AxiosInstance {
    const c = this.clients.get(nodeName);
    if (!c) throw new Error(`Unknown Proxmox node: ${nodeName}`);
    return c;
  }

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
      
      client.interceptors.response.use(
        (res) => res,
        (err) => {
          if (axios.isAxiosError(err) && err.response?.data) {
            const pxErr = err.response.data;
            const msg = typeof pxErr === 'string' ? pxErr : JSON.stringify(pxErr);
            throw new Error(`Proxmox Error (${err.response.status}): ${msg}`);
          }
          throw err;
        }
      );

      this.clients.set(node.name, client);
    }
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

  async listClusterVms(): Promise<ProxmoxClusterVm[]> {
    for (const node of getNodes()) {
      try {
        const res = await this.clientFor(node.name).get<ProxmoxResponse<ProxmoxClusterVm[]>>(
          `/cluster/resources?type=vm`
        );
        return res.data.data;
      } catch (err) {
        logger.debug({ node: node.name, err: String(err) }, "listClusterVms: node unreachable, trying next");
      }
    }
    throw new Error("Could not read VM list from any Proxmox node");
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

  async selectLeastLoadedNodeFrom(nodeNames: string[]): Promise<string> {
    const allowed = new Set(nodeNames);
    const healthy = (await this.listHealthyNodes()).filter((node) => allowed.has(node.name));
    if (healthy.length === 0) {
      throw new Error(`No reachable candidate Proxmox nodes: ${nodeNames.join(", ")}`);
    }

    const scored: Array<{ node: string; score: number; cpu: number; mem: number }> = [];
    for (const node of healthy) {
      const s = await this.getNodeStatus(node.name);
      const cpuPct = s.cpu * 100;
      const memPct = (s.memory.used / s.memory.total) * 100;
      const score = 0.6 * cpuPct + 0.4 * memPct;
      scored.push({ node: node.name, score, cpu: cpuPct, mem: memPct });
    }
    scored.sort((a, b) => a.score - b.score);
    logger.info({ nodes: scored }, "candidate node load snapshot");
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
  }): Promise<void> {
    const params = new URLSearchParams();
    params.append("cores", String(opts.cores));
    params.append("memory", String(opts.memoryMb));
    await this.clientFor(opts.node).put(
      `/nodes/${opts.node}/qemu/${opts.vmId}/config`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
  }


  async setDescription(node: string, vmId: number, description: string): Promise<void> {
    const params = new URLSearchParams();
    params.append("description", description);
    await this.clientFor(node).put(`/nodes/${node}/qemu/${vmId}/config`, params.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  }

  async powerOn(node: string, vmId: number): Promise<string> {
    const res = await this.clientFor(node).post<ProxmoxResponse<string>>(
      `/nodes/${node}/qemu/${vmId}/status/start`
    );
    return res.data.data;
  }

  async powerOff(node: string, vmId: number, force = false): Promise<string> {
    if (force) {
      // Hard stop — /status/stop accepts no extra params
      const res = await this.clientFor(node).post<ProxmoxResponse<string>>(
        `/nodes/${node}/qemu/${vmId}/status/stop`
      );
      return res.data.data;
    } else {
      // Graceful ACPI shutdown with a fallback timeout
      const params = new URLSearchParams();
      params.append("forceStop", "1");
      params.append("timeout", "30");
      const res = await this.clientFor(node).post<ProxmoxResponse<string>>(
        `/nodes/${node}/qemu/${vmId}/status/shutdown`,
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      return res.data.data;
    }
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

  async getVmCurrentStatus(node: string, vmId: number): Promise<ProxmoxVmStatus> {
    const res = await this.clientFor(node).get<ProxmoxResponse<ProxmoxVmStatus>>(
      `/nodes/${node}/qemu/${vmId}/status/current`
    );
    return res.data.data;
  }

  async getNodeStatus(node: string): Promise<ProxmoxNodeStatus> {
    const res = await this.clientFor(node).get<ProxmoxResponse<ProxmoxNodeStatus>>(
      `/nodes/${node}/status`
    );
    return res.data.data;
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
  /**
   * Write a file into the guest via the QEMU agent. Content must already be
   * base64-encoded; the agent enforces a ~60 KiB payload cap, so this is for
   * README/config-sized drops, not ISO uploads.
   */
  async agentFileWrite(node: string, vmId: number, filePath: string, contentBase64: string): Promise<void> {
    const params = new URLSearchParams();
    params.append("file", filePath);
    params.append("content", contentBase64);
    params.append("encode", "0"); // content is pre-encoded
    await this.clientFor(node).post(
      `/nodes/${node}/qemu/${vmId}/agent/file-write`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
  }

  // -------------------------------------------------------------------------
  // Import support
  //
  // Everything below backs the VM import pipeline. It leans on the storage
  // `import` content type and `qm create --scsi0 …,import-from=…`, both of
  // which arrived in Proxmox VE 8.2 — see capability probing in
  // services/vmImport/pipeline.ts.
  // -------------------------------------------------------------------------

  /** Cluster version, e.g. { version: "8.3.2", release: "8.3" }. */
  async getVersion(node: string): Promise<{ version: string; release: string }> {
    const res = await this.clientFor(node).get<ProxmoxResponse<{ version: string; release: string }>>(
      `/version`
    );
    return res.data.data;
  }

  async listStorages(node: string): Promise<ProxmoxStorage[]> {
    const res = await this.clientFor(node).get<
      ProxmoxResponse<Array<{
        storage: string;
        type: string;
        content?: string;
        active?: number;
        shared?: number;
        avail?: number;
        total?: number;
      }>>
    >(`/nodes/${node}/storage`);

    return res.data.data.map((s) => ({
      storage: s.storage,
      type: s.type,
      content: (s.content ?? "").split(",").filter(Boolean),
      active: s.active === 1,
      shared: s.shared === 1,
      avail: s.avail ?? null,
      total: s.total ?? null,
    }));
  }

  /** Bridge interfaces available for `net0` on this node. */
  async listBridges(node: string): Promise<string[]> {
    const res = await this.clientFor(node).get<ProxmoxResponse<Array<{ iface: string; type: string }>>>(
      `/nodes/${node}/network?type=any_bridge`
    );
    return res.data.data.map((n) => n.iface).sort();
  }

  async listStorageContent(node: string, storage: string, content?: string): Promise<ProxmoxVolume[]> {
    const suffix = content ? `?content=${encodeURIComponent(content)}` : "";
    const res = await this.clientFor(node).get<ProxmoxResponse<ProxmoxVolume[]>>(
      `/nodes/${node}/storage/${encodeURIComponent(storage)}/content${suffix}`
    );
    return res.data.data;
  }

  async getImportMetadata(node: string, storage: string, volume: string): Promise<ProxmoxImportMetadata> {
    const res = await this.clientFor(node).get<ProxmoxResponse<ProxmoxImportMetadata>>(
      `/nodes/${node}/storage/${encodeURIComponent(storage)}/import-metadata?volume=${encodeURIComponent(volume)}`
    );
    return res.data.data;
  }

  /**
   * Stream a local file into a Proxmox storage.
   *
   * Proxmox's upload endpoint wants multipart/form-data with the file field
   * last, and pveproxy rejects chunked bodies — so the multipart envelope is
   * assembled by hand with an exact Content-Length, and the file itself is
   * streamed rather than buffered. `onProgress` fires as bytes go out.
   */
  async uploadToStorage(opts: {
    node: string;
    storage: string;
    content: "iso" | "vztmpl" | "import";
    filePath: string;
    filename: string;
    onProgress?: (sent: number, total: number) => void;
  }): Promise<string> {
    const { size } = await fs.promises.stat(opts.filePath);
    const boundary = `----wctarange${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;

    const field = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

    const preamble = Buffer.from(
      field("content", opts.content) +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="filename"; filename="${opts.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      "utf8"
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

    const filePath = opts.filePath;
    const onProgress = opts.onProgress;
    const body = Readable.from(
      (async function* () {
        yield preamble;
        let sent = 0;
        for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) {
          sent += (chunk as Buffer).length;
          onProgress?.(sent, size);
          yield chunk as Buffer;
        }
        yield epilogue;
      })()
    );

    const res = await this.clientFor(opts.node).post<ProxmoxResponse<string>>(
      `/nodes/${opts.node}/storage/${encodeURIComponent(opts.storage)}/upload`,
      body,
      {
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(preamble.length + size + epilogue.length),
        },
        timeout: 0,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    return res.data.data;
  }

  /** Have the node fetch the image itself. Far faster than proxying it twice. */
  async downloadUrlToStorage(opts: {
    node: string;
    storage: string;
    content: "iso" | "vztmpl" | "import";
    url: string;
    filename: string;
    verifyCertificates?: boolean;
  }): Promise<string> {
    const params = new URLSearchParams();
    params.append("content", opts.content);
    params.append("filename", opts.filename);
    params.append("url", opts.url);
    params.append("verify-certificates", opts.verifyCertificates === false ? "0" : "1");

    const res = await this.clientFor(opts.node).post<ProxmoxResponse<string>>(
      `/nodes/${opts.node}/storage/${encodeURIComponent(opts.storage)}/download-url`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 60_000 }
    );
    return res.data.data;
  }

  async deleteVolume(node: string, volid: string): Promise<void> {
    await this.clientFor(node).delete(
      `/nodes/${node}/storage/${encodeURIComponent(volid.split(":")[0])}/content/${encodeURIComponent(volid)}`
    );
  }

  /**
   * Create a VM from scratch. Disk parameters may carry `import-from=<volid>`,
   * which is what turns a VMDK into a Proxmox disk without a separate step.
   */
  async createVm(node: string, config: Record<string, string | number>): Promise<string> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(config)) {
      params.append(key, String(value));
    }
    const res = await this.clientFor(node).post<ProxmoxResponse<string>>(
      `/nodes/${node}/qemu`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 120_000 }
    );
    return res.data.data;
  }

  async updateVmConfig(node: string, vmId: number, config: Record<string, string | number>): Promise<void> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(config)) {
      params.append(key, String(value));
    }
    await this.clientFor(node).put(`/nodes/${node}/qemu/${vmId}/config`, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  async convertToTemplate(node: string, vmId: number): Promise<void> {
    await this.clientFor(node).post(`/nodes/${node}/qemu/${vmId}/template`, "", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 300_000,
    });
  }

  /** A free VMID from Proxmox's own allocator. */
  async getNextVmid(node: string): Promise<number> {
    const res = await this.clientFor(node).get<ProxmoxResponse<string>>(`/cluster/nextid`);
    return Number(res.data.data);
  }

  /** Last lines of a task's log — the only place Proxmox explains a failure. */
  async getTaskLog(node: string, upid: string, limit = 25): Promise<string[]> {
    try {
      const res = await this.clientFor(node).get<ProxmoxResponse<Array<{ n: number; t: string }>>>(
        `/nodes/${node}/tasks/${encodeURIComponent(upid)}/log?limit=${limit}&start=0`
      );
      return res.data.data.map((line) => line.t);
    } catch {
      return [];
    }
  }

  /**
   * Like waitForTask, but for the hour-long ones: disk conversion on an 80 GB
   * Windows image is not a two-minute job. Calls `onProgress` on each poll so
   * the caller can keep a UI alive, and pulls the task log on failure.
   */
  async waitForLongTask(
    node: string,
    upid: string,
    opts: { timeoutMs: number; pollMs?: number; onProgress?: (elapsedMs: number) => void }
  ): Promise<void> {
    const start = Date.now();
    const pollMs = opts.pollMs ?? 5000;

    while (Date.now() - start < opts.timeoutMs) {
      const res = await this.clientFor(node).get<ProxmoxResponse<{ status: string; exitstatus?: string }>>(
        `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`
      );
      const { status, exitstatus } = res.data.data;

      if (status === "stopped") {
        if (exitstatus && exitstatus !== "OK") {
          const log = await this.getTaskLog(node, upid);
          const detail = log.length > 0 ? `\n${log.slice(-10).join("\n")}` : "";
          throw new Error(`Proxmox task failed: ${exitstatus}${detail}`);
        }
        return;
      }

      opts.onProgress?.(Date.now() - start);
      await sleep(pollMs);
    }
    throw new Error(`Proxmox task ${upid} timed out after ${Math.round(opts.timeoutMs / 60_000)} minutes`);
  }

  /**
   * Create a VNC proxy for a VM. Returns the ticket and port needed to
   * connect to the Proxmox VNC websocket.
   */
  async createVncProxy(node: string, vmId: number): Promise<{ ticket: string; port: number }> {
    const params = new URLSearchParams();
    params.append("websocket", "1"); // We want a websocket-capable proxy

    const res = await this.clientFor(node).post<ProxmoxResponse<{ ticket: string; port: string }>>(
      `/nodes/${node}/qemu/${vmId}/vncproxy`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return {
      ticket: res.data.data.ticket,
      port: parseInt(res.data.data.port, 10),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const proxmox = new ProxmoxClusterClient();
