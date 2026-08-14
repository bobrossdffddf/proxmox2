/**
 * Merging a split VMDK into a single image with qemu-img.
 *
 * VMware splits a disk into 2 GB extents by default: a small text descriptor
 * plus `name-s001.vmdk`, `name-s002.vmdk`, … Neither of the two ways Proxmox
 * accepts an image can carry that set:
 *
 *   - inside an OVA, Proxmox extracts *only* the member named by `import-from`,
 *     so the descriptor arrives without the extents holding the data;
 *   - uploaded as separate files, Proxmox runs qemu-img over each one, and an
 *     extent on its own is not a valid image:
 *
 *       qemu-img: Could not open 'disk-s001.vmdk': Invalid argument
 *
 * So the disk has to become one file before it leaves here. qemu-img reads the
 * descriptor, follows it to the extents sitting beside it, and writes a single
 * qcow2 — compact, and something Proxmox opens without complaint.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/** Set once we've looked; null until then. */
let qemuImgPath: string | null | undefined;

/**
 * Locate qemu-img, or null if the image was built without it. Cached, since the
 * answer can't change while the process lives.
 */
export async function findQemuImg(): Promise<string | null> {
  if (qemuImgPath !== undefined) return qemuImgPath;

  for (const candidate of ["/usr/bin/qemu-img", "/usr/local/bin/qemu-img", "/bin/qemu-img"]) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      qemuImgPath = candidate;
      return candidate;
    } catch {
      // try the next one
    }
  }

  qemuImgPath = null;
  return null;
}

export interface MergeResult {
  /** Bytes the merged image occupies on disk. */
  size: number;
  /** Seconds the conversion took, for the log. */
  seconds: number;
}

/**
 * Convert `descriptorPath` (and, implicitly, the extents beside it) into a
 * single qcow2 at `outPath`.
 *
 * Progress is reported as a 0–100 fraction. qemu-img with `-p` writes
 * `    (12.34/100%)` repeatedly on stdout with carriage returns rather than
 * newlines, so the stream is scanned for the last complete reading in each
 * chunk instead of being split into lines.
 */
export async function mergeToQcow2(
  qemuImg: string,
  descriptorPath: string,
  outPath: string,
  onProgress?: (percent: number) => void
): Promise<MergeResult> {
  const startedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      qemuImg,
      [
        "convert",
        "-p",
        // Naming the input format keeps qemu-img from probing, so a bundle
        // can't talk it into treating the descriptor as something else.
        "-f",
        "vmdk",
        "-O",
        "qcow2",
        descriptorPath,
        outPath,
      ],
      { cwd: path.dirname(descriptorPath), stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    let lastPercent = -1;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const readings = chunk.match(/\(\s*([\d.]+)\/100%\)/g);
      if (!readings || !onProgress) return;
      const last = readings[readings.length - 1].match(/([\d.]+)/);
      if (!last) return;
      const percent = Math.floor(Number(last[1]));
      if (percent > lastPercent) {
        lastPercent = percent;
        onProgress(percent);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep the tail: a qemu-img failure says everything in its last line.
      stderr = (stderr + chunk).slice(-4096);
    });

    child.on("error", (err) => reject(new Error(`Could not run qemu-img: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const detail = stderr.trim().split("\n").pop() ?? `exit code ${code}`;
      reject(new Error(`qemu-img could not merge the disk: ${detail}`));
    });
  });

  const { size } = await fs.promises.stat(outPath);
  return { size, seconds: Math.round((Date.now() - startedAt) / 1000) };
}
