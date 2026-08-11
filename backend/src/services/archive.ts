/**
 * Minimal ZIP and TAR readers/writers.
 *
 * VMware exports arrive as one of three shapes: a `.zip` someone made by
 * selecting the whole VM folder, an `.ova` (which is just a tar), or a loose
 * pile of files. All three need the same treatment — list what's inside,
 * pull out the small text files (`.ovf`, `.vmx`) to read the specs, and
 * stream the multi-gigabyte disks somewhere else without ever holding them
 * in memory.
 *
 * Everything here works off file offsets and streams for exactly that reason,
 * and ZIP64 is handled because a zipped Windows image blows past 4 GB easily.
 * Written by hand rather than pulled from npm: the format subset we need is
 * small, and an unzip dependency that shells out or buffers whole entries
 * would defeat the point.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream/promises";

export interface ArchiveEntry {
  /** Path as stored in the archive, normalized to forward slashes. */
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** Byte offset of the entry's header within the archive. */
  headerOffset: number;
  /** Compressed size on disk (equals `size` for stored/tar entries). */
  compressedSize: number;
  /** ZIP compression method: 0 = stored, 8 = deflate. Always 0 for tar. */
  method: number;
  /** True for directory markers, which callers normally skip. */
  isDirectory: boolean;
}

export type ArchiveKind = "zip" | "tar";

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_EOCD64_LOCATOR_SIG = 0x07064b50;
const ZIP_EOCD64_SIG = 0x06064b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

/**
 * Sniff the container format from the first bytes. Returns null for anything
 * that isn't an archive we can walk (a bare `.vmdk`/`.qcow2`, say).
 */
export async function detectArchiveKind(filePath: string): Promise<ArchiveKind | null> {
  const head = await readRange(filePath, 0, 512);
  if (head.length >= 4 && head.readUInt32LE(0) === ZIP_LOCAL_SIG) return "zip";
  // Empty zips start with the end-of-central-directory record.
  if (head.length >= 4 && head.readUInt32LE(0) === ZIP_EOCD_SIG) return "zip";
  // ustar magic lives at offset 257 of the first tar header.
  if (head.length >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  return null;
}

export async function listEntries(filePath: string, kind: ArchiveKind): Promise<ArchiveEntry[]> {
  return kind === "zip" ? listZipEntries(filePath) : listTarEntries(filePath);
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

export async function listZipEntries(filePath: string): Promise<ArchiveEntry[]> {
  const { size } = await fs.promises.stat(filePath);

  // The EOCD is at the very end, but a trailing comment can push it back by
  // up to 64 KiB. Read the tail and scan backwards for the signature.
  const tailLen = Math.min(size, 64 * 1024 + 22);
  const tail = await readRange(filePath, size - tailLen, tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid ZIP archive (no end-of-central-directory record)");

  let entryCount = tail.readUInt16LE(eocd + 10);
  let centralSize = tail.readUInt32LE(eocd + 12);
  let centralOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record pointed at by the ZIP64 locator that precedes the EOCD.
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP_EOCD64_LOCATOR_SIG) {
    const eocd64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const eocd64 = await readRange(filePath, eocd64Offset, 56);
    if (eocd64.readUInt32LE(0) === ZIP_EOCD64_SIG) {
      entryCount = Number(eocd64.readBigUInt64LE(32));
      centralSize = Number(eocd64.readBigUInt64LE(40));
      centralOffset = Number(eocd64.readBigUInt64LE(48));
    }
  }

  const central = await readRange(filePath, centralOffset, centralSize);
  const entries: ArchiveEntry[] = [];
  let p = 0;

  for (let i = 0; i < entryCount && p + 46 <= central.length; i++) {
    if (central.readUInt32LE(p) !== ZIP_CENTRAL_SIG) break;

    const method = central.readUInt16LE(p + 10);
    let compressedSize = central.readUInt32LE(p + 20);
    let uncompressedSize = central.readUInt32LE(p + 24);
    const nameLen = central.readUInt16LE(p + 28);
    const extraLen = central.readUInt16LE(p + 30);
    const commentLen = central.readUInt16LE(p + 32);
    let headerOffset = central.readUInt32LE(p + 42);
    const name = central.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // Any field that reads as all-ones is really stored in the ZIP64 extra
    // field, in this fixed order, only for the fields that overflowed.
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || headerOffset === 0xffffffff) {
      const extra = central.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let e = 0;
      while (e + 4 <= extra.length) {
        const tag = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (tag === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (headerOffset === 0xffffffff) { headerOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }

    const normalized = name.replace(/\\/g, "/");
    entries.push({
      name: normalized,
      size: uncompressedSize,
      compressedSize,
      headerOffset,
      method,
      isDirectory: normalized.endsWith("/"),
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Where an entry's payload actually starts. The central directory records the
 * local header offset, and the local header has its own (often different)
 * name/extra lengths, so we have to read it to find the data.
 */
async function zipDataOffset(filePath: string, entry: ArchiveEntry): Promise<number> {
  const local = await readRange(filePath, entry.headerOffset, 30);
  if (local.readUInt32LE(0) !== ZIP_LOCAL_SIG) {
    throw new Error(`Corrupt ZIP: bad local header for ${entry.name}`);
  }
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  return entry.headerOffset + 30 + nameLen + extraLen;
}

// ---------------------------------------------------------------------------
// TAR (and therefore OVA)
// ---------------------------------------------------------------------------

export async function listTarEntries(filePath: string): Promise<ArchiveEntry[]> {
  const { size: fileSize } = await fs.promises.stat(filePath);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  /** Set by a preceding GNU long-name ('L') or PAX ('x') record. */
  let pendingLongName: string | null = null;

  while (offset + 512 <= fileSize) {
    const header = await readRange(filePath, offset, 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    const rawName = cstr(header.subarray(0, 100));
    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const prefix = cstr(header.subarray(345, 500));
    const dataOffset = offset + 512;
    const padded = Math.ceil(size / 512) * 512;

    if (typeFlag === "L") {
      // GNU long name: the next record's real name is this record's payload.
      pendingLongName = cstr(await readRange(filePath, dataOffset, size));
      offset = dataOffset + padded;
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      // PAX header: "<len> path=<value>\n" among other keywords.
      const pax = (await readRange(filePath, dataOffset, size)).toString("utf8");
      const match = /\d+ path=(.*)\n/.exec(pax);
      if (match && typeFlag === "x") pendingLongName = match[1];
      offset = dataOffset + padded;
      continue;
    }

    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    if (name) {
      const normalized = name.replace(/\\/g, "/");
      entries.push({
        name: normalized,
        size,
        compressedSize: size,
        headerOffset: dataOffset,
        method: 0,
        isDirectory: typeFlag === "5" || normalized.endsWith("/"),
      });
    }

    offset = dataOffset + padded;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Reading entries out
// ---------------------------------------------------------------------------

/**
 * Read a whole entry into memory. Only for the small text members — the
 * `maxBytes` guard exists so a malformed archive can't make us buffer a disk.
 */
export async function readEntry(
  filePath: string,
  kind: ArchiveKind,
  entry: ArchiveEntry,
  maxBytes = 8 * 1024 * 1024
): Promise<Buffer> {
  if (entry.size > maxBytes) {
    throw new Error(`Refusing to read ${entry.name} into memory (${entry.size} bytes)`);
  }
  if (kind === "tar") {
    return readRange(filePath, entry.headerOffset, entry.size);
  }
  const start = await zipDataOffset(filePath, entry);
  const raw = await readRange(filePath, start, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/**
 * Read just the first `bytes` of an entry. Used to peek at VMDK headers, where
 * the interesting fields sit in the first few KB of a file that may be 80 GB.
 */
export async function readEntryHead(
  filePath: string,
  kind: ArchiveKind,
  entry: ArchiveEntry,
  bytes: number
): Promise<Buffer> {
  const want = Math.min(bytes, entry.size);
  if (want <= 0) return Buffer.alloc(0);

  if (kind === "tar") {
    return readRange(filePath, entry.headerOffset, want);
  }

  const start = await zipDataOffset(filePath, entry);
  if (entry.method === 0) return readRange(filePath, start, want);
  if (entry.method !== 8) return Buffer.alloc(0);

  // Deflate: inflate only as far as we need, then tear the stream down.
  const source = fs.createReadStream(filePath, {
    start,
    end: start + entry.compressedSize - 1,
  });
  const inflate = zlib.createInflateRaw();
  source.pipe(inflate);

  return new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = () => {
      source.destroy();
      inflate.destroy();
      resolve(Buffer.concat(chunks).subarray(0, want));
    };
    inflate.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= want) finish();
    });
    inflate.on("end", finish);
    inflate.on("error", finish);
    source.on("error", finish);
  });
}

/** Stream an entry out to a file on disk. Safe for multi-gigabyte disks. */
export async function extractEntry(
  filePath: string,
  kind: ArchiveKind,
  entry: ArchiveEntry,
  destPath: string
): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  if (kind === "tar") {
    await pipeline(
      fs.createReadStream(filePath, {
        start: entry.headerOffset,
        end: entry.headerOffset + entry.size - 1,
      }),
      fs.createWriteStream(destPath)
    );
    return;
  }

  const start = await zipDataOffset(filePath, entry);
  const source = fs.createReadStream(filePath, {
    start,
    end: start + entry.compressedSize - 1,
  });
  const sink = fs.createWriteStream(destPath);

  if (entry.method === 0) {
    await pipeline(source, sink);
  } else if (entry.method === 8) {
    await pipeline(source, zlib.createInflateRaw(), sink);
  } else {
    source.destroy();
    sink.destroy();
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  }
}

// ---------------------------------------------------------------------------
// TAR writing (repackaging into a .ova)
// ---------------------------------------------------------------------------

export interface TarInput {
  /** Name to store in the archive. Kept short and flat — no directories. */
  name: string;
  /** File on disk to stream in. */
  sourcePath: string;
}

/**
 * Write a ustar archive. Members are streamed, so this can build an OVA out of
 * disks far larger than memory. Entry order is preserved, which matters: the
 * OVF descriptor must come first for Proxmox to find it cheaply.
 */
export async function writeTar(destPath: string, inputs: TarInput[]): Promise<void> {
  const out = fs.createWriteStream(destPath);
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      out.write(chunk, (err) => (err ? reject(err) : resolve()));
    });

  try {
    for (const input of inputs) {
      const stat = await fs.promises.stat(input.sourcePath);
      if (Buffer.byteLength(input.name, "utf8") > 99) {
        throw new Error(`Archive member name too long for ustar: ${input.name}`);
      }
      await write(tarHeader(input.name, stat.size));

      // Copied by hand rather than with pipeline(): piping many sources into
      // one destination stacks a fresh set of listeners on it per member, and
      // an OVA can have a dozen. Awaiting each write gives the same backpressure.
      for await (const chunk of fs.createReadStream(input.sourcePath, { highWaterMark: 4 * 1024 * 1024 })) {
        await write(chunk as Buffer);
      }

      const remainder = stat.size % 512;
      if (remainder !== 0) await write(Buffer.alloc(512 - remainder));
    }
    // Two zero blocks terminate the archive.
    await write(Buffer.alloc(1024));
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("000644 \0", 100, 8, "latin1");           // mode
  header.write("000000 \0", 108, 8, "latin1");           // uid
  header.write("000000 \0", 116, 8, "latin1");           // gid
  header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "latin1");
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")} `, 136, 12, "latin1");
  header.write("        ", 148, 8, "latin1");            // checksum placeholder: spaces
  header.write("0", 156, 1, "latin1");                   // type: regular file
  header.write("ustar\0" + "00", 257, 8, "latin1");

  // Checksum is the sum of all header bytes with the checksum field read as spaces.
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function readRange(filePath: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, Math.max(0, start));
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function cstr(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf8").trim();
}

function parseOctal(buf: Buffer): number {
  // GNU tar switches to base-256 for sizes over 8 GiB: high bit of byte 0 set,
  // remaining bytes are a big-endian integer.
  if (buf.length > 0 && (buf[0] & 0x80) !== 0) {
    let value = 0;
    for (let i = 1; i < buf.length; i++) value = value * 256 + buf[i];
    return value;
  }
  const text = cstr(buf).replace(/[^0-7]/g, "");
  return text ? parseInt(text, 8) : 0;
}
