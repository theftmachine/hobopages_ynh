// Minimal ZIP reader for HoboPages.
// Supports store (method 0) and deflate (method 8). Rejects ZIP64 and encryption
// with a clear error rather than producing corrupt output.

import { isJunkPath, safeRelativePath } from "./core.ts";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
  flags: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

async function readAt(
  file: Deno.FsFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const buf = new Uint8Array(length);
  let read = 0;
  await file.seek(offset, Deno.SeekMode.Start);
  while (read < length) {
    const n = await file.read(buf.subarray(read));
    if (n === null) break;
    read += n;
  }
  if (read !== length) {
    throw new ZipError("Unexpected end of archive.");
  }
  return buf;
}

/** Locate and parse the central directory. */
async function readCentralDirectory(
  file: Deno.FsFile,
  size: number,
): Promise<ZipEntry[]> {
  const maxComment = 0xffff;
  const tailLength = Math.min(size, maxComment + 22);
  const tail = await readAt(file, size - tailLength, tailLength);
  const tailView = new DataView(
    tail.buffer,
    tail.byteOffset,
    tail.byteLength,
  );

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new ZipError("Not a ZIP file (no end-of-archive record found).");
  }

  // ZIP64 archives place a locator immediately before the EOCD record.
  if (eocd >= 20 && tailView.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG) {
    throw new ZipError(
      "ZIP64 archives are not supported. Re-zip without ZIP64, or upload the folder directly.",
    );
  }

  const entryCount = tailView.getUint16(eocd + 10, true);
  const cdSize = tailView.getUint32(eocd + 12, true);
  const cdOffset = tailView.getUint32(eocd + 16, true);

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError(
      "ZIP64 archives are not supported. Re-zip without ZIP64, or upload the folder directly.",
    );
  }
  if (cdOffset + cdSize > size) {
    throw new ZipError("Archive is truncated or corrupt.");
  }

  const cd = await readAt(file, cdOffset, cdSize);
  const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const decoder = new TextDecoder("utf-8");

  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > cd.length) {
      throw new ZipError("Central directory is truncated.");
    }
    if (cdView.getUint32(pos, true) !== CD_SIG) {
      throw new ZipError("Central directory entry is corrupt.");
    }
    const flags = cdView.getUint16(pos + 8, true);
    const method = cdView.getUint16(pos + 10, true);
    const compressedSize = cdView.getUint32(pos + 20, true);
    const uncompressedSize = cdView.getUint32(pos + 24, true);
    const nameLen = cdView.getUint16(pos + 28, true);
    const extraLen = cdView.getUint16(pos + 30, true);
    const commentLen = cdView.getUint16(pos + 32, true);
    const localHeaderOffset = cdView.getUint32(pos + 42, true);
    const name = decoder.decode(cd.subarray(pos + 46, pos + 46 + nameLen));

    if (
      compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipError(
        "ZIP64 archives are not supported. Re-zip without ZIP64, or upload the folder directly.",
      );
    }

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
      flags,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Build a ReadableStream over a byte range of an open file. */
function rangeStream(
  file: Deno.FsFile,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  let position = start;
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const chunkSize = Math.min(remaining, 256 * 1024);
      const buf = new Uint8Array(chunkSize);
      await file.seek(position, Deno.SeekMode.Start);
      const n = await file.read(buf);
      if (n === null || n === 0) {
        controller.close();
        return;
      }
      position += n;
      remaining -= n;
      controller.enqueue(buf.subarray(0, n));
    },
  });
}

export interface ExtractResult {
  fileCount: number;
  bytes: number;
  skipped: string[];
}

/**
 * Extract `zipPath` into `destDir`. Junk paths are skipped; unsafe paths abort.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
): Promise<ExtractResult> {
  const stat = await Deno.stat(zipPath);
  if (stat.size < 22) throw new ZipError("File is too small to be a ZIP.");

  const file = await Deno.open(zipPath, { read: true });
  try {
    const entries = await readCentralDirectory(file, stat.size);
    const result: ExtractResult = { fileCount: 0, bytes: 0, skipped: [] };

    for (const entry of entries) {
      if (entry.name.endsWith("/")) continue; // directory record
      if ((entry.flags & 0x1) !== 0) {
        throw new ZipError(
          `Encrypted archives are not supported (${entry.name}).`,
        );
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw new ZipError(
          `Unsupported compression in ${entry.name}. Re-zip using standard deflate.`,
        );
      }

      const rel = safeRelativePath(entry.name);
      if (!rel) {
        throw new ZipError(`Unsafe path in archive: ${entry.name}`);
      }
      if (isJunkPath(rel)) {
        result.skipped.push(rel);
        continue;
      }

      // The local header repeats name/extra lengths, which may differ from the
      // central directory, so read it to find where the data actually starts.
      const local = await readAt(file, entry.localHeaderOffset, 30);
      const localView = new DataView(
        local.buffer,
        local.byteOffset,
        local.byteLength,
      );
      if (localView.getUint32(0, true) !== LOCAL_SIG) {
        throw new ZipError(`Corrupt local header for ${entry.name}.`);
      }
      const nameLen = localView.getUint16(26, true);
      const extraLen = localView.getUint16(28, true);
      const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
      if (dataStart + entry.compressedSize > stat.size) {
        throw new ZipError(`Archive is truncated at ${entry.name}.`);
      }

      const outPath = `${destDir}/${rel}`;
      const parent = outPath.slice(0, outPath.lastIndexOf("/"));
      await Deno.mkdir(parent, { recursive: true });

      let source = rangeStream(file, dataStart, entry.compressedSize);
      if (entry.method === 8) {
        source = source.pipeThrough(new DecompressionStream("deflate-raw"));
      }

      const out = await Deno.open(outPath, {
        write: true,
        create: true,
        truncate: true,
      });
      let written = 0;
      try {
        const writer = out.writable.getWriter();
        const reader = source.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            written += value.byteLength;
            await writer.write(value);
          }
          await writer.close();
        } catch (err) {
          await writer.abort(err).catch(() => {});
          throw err;
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        try {
          out.close();
        } catch { /* already closed by the writer */ }
        if (err instanceof ZipError) throw err;
        throw new ZipError(
          `Failed to extract ${entry.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (entry.uncompressedSize !== 0 && written !== entry.uncompressedSize) {
        throw new ZipError(
          `Size mismatch extracting ${entry.name} (expected ${entry.uncompressedSize}, got ${written}).`,
        );
      }

      result.fileCount++;
      result.bytes += written;
    }

    if (result.fileCount === 0) {
      throw new ZipError("The archive contains no usable files.");
    }
    return result;
  } finally {
    try {
      file.close();
    } catch { /* already closed */ }
  }
}
