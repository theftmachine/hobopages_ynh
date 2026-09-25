// HoboPages — disk space awareness.
//
// Deno has no statvfs binding, so free space comes from `df -P -k`, which is
// POSIX-specified output and stable across coreutils/busybox. If df is
// unavailable or not permitted, every function degrades to "unknown" rather
// than failing: a missing gauge is acceptable, a blocked deploy is not.

export interface DiskInfo {
  /** Bytes free on the filesystem holding the data directory. */
  availableBytes: number;
  /** Total size of that filesystem. */
  totalBytes: number;
  /** Bytes currently used by HoboPages itself. */
  usedByAppBytes: number;
  /** False when df could not be read; the numbers are then meaningless. */
  known: boolean;
}

const DF_PATHS = ["/usr/bin/df", "/bin/df", "df"];

/** Read filesystem stats for the given path. Never throws. */
export async function filesystemStats(
  path: string,
): Promise<{ availableBytes: number; totalBytes: number; known: boolean }> {
  for (const df of DF_PATHS) {
    try {
      const command = new Deno.Command(df, {
        args: ["-P", "-k", path],
        stdout: "piped",
        stderr: "null",
      });
      const { code, stdout } = await command.output();
      if (code !== 0) continue;

      const text = new TextDecoder().decode(stdout);
      const lines = text.trim().split("\n");
      if (lines.length < 2) continue;

      // POSIX layout: Filesystem 1024-blocks Used Available Capacity Mounted
      // The device name may contain spaces, so count columns from the right.
      const columns = lines[lines.length - 1].trim().split(/\s+/);
      if (columns.length < 6) continue;

      const availableKb = Number(columns[columns.length - 3]);
      const totalKb = Number(columns[columns.length - 5]);
      if (!Number.isFinite(availableKb) || !Number.isFinite(totalKb)) continue;

      return {
        availableBytes: availableKb * 1024,
        totalBytes: totalKb * 1024,
        known: true,
      };
    } catch {
      // Not found, or --allow-run not granted. Try the next candidate.
      continue;
    }
  }
  return { availableBytes: 0, totalBytes: 0, known: false };
}

/** Recursively total the bytes under a directory. Never throws. */
export async function directorySize(path: string): Promise<number> {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    try {
      for await (const entry of Deno.readDir(dir)) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          stack.push(full);
        } else if (entry.isFile) {
          try {
            const stat = await Deno.stat(full);
            total += stat.size;
          } catch {
            // Removed mid-walk; skip.
          }
        }
      }
    } catch {
      // Unreadable or removed mid-walk; skip.
    }
  }
  return total;
}

export async function diskInfo(dataDir: string): Promise<DiskInfo> {
  const [fs, used] = await Promise.all([
    filesystemStats(dataDir),
    directorySize(dataDir),
  ]);
  return {
    availableBytes: fs.availableBytes,
    totalBytes: fs.totalBytes,
    usedByAppBytes: used,
    known: fs.known,
  };
}

export interface SpaceVerdict {
  ok: boolean;
  message: string;
  availableBytes: number;
  known: boolean;
}

export function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${
    units[i]
  }`;
}

/**
 * Decide whether an incoming upload of `incomingBytes` may proceed while
 * keeping `reserveBytes` free on the filesystem.
 */
export async function checkSpaceFor(
  dataDir: string,
  incomingBytes: number,
  reserveBytes: number,
): Promise<SpaceVerdict> {
  const fs = await filesystemStats(dataDir);
  if (!fs.known) {
    return {
      ok: true,
      message: "",
      availableBytes: 0,
      known: false,
    };
  }
  const needed = incomingBytes + reserveBytes;
  if (fs.availableBytes >= needed) {
    return {
      ok: true,
      message: "",
      availableBytes: fs.availableBytes,
      known: true,
    };
  }
  return {
    ok: false,
    known: true,
    availableBytes: fs.availableBytes,
    message: `Not enough disk space. This upload needs ${
      formatBytes(incomingBytes)
    } and the server keeps ${
      formatBytes(reserveBytes)
    } free for everything else, but only ${
      formatBytes(fs.availableBytes)
    } is available. Free some space, or reduce how many releases each site keeps.`,
  };
}
