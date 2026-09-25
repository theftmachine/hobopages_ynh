// HoboPages — deploy pipeline.

import {
  clampReleases,
  isJunkPath,
  type Release,
  rewriteCss,
  rewriteHtml,
  safeRelativePath,
  type Site,
  type Storage,
} from "./core.ts";
import { extractZip, ZipError } from "./zip.ts";
import { checkSpaceFor } from "./disk.ts";

export const ARCHIVE_NAME = "__hobopages_upload.zip";

export interface DeploySession {
  id: string;
  site: string;
  dir: string;
  note: string;
  createdAt: number;
  bytesReceived: number;
  /** Timestamp of the last free-space check, to avoid running df per chunk. */
  lastSpaceCheck: number;
}

export class DeployError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DeployError";
    this.status = status;
  }
}

export interface WalkedFile {
  rel: string;
  size: number;
}

/** Recursively list files under `dir`, returning paths relative to it. */
export async function walk(dir: string, prefix = ""): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      out.push(...(await walk(full, rel)));
    } else if (entry.isFile) {
      const stat = await Deno.stat(full);
      out.push({ rel, size: stat.size });
    }
    // Symlinks in an upload are ignored deliberately.
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function listEntries(dir: string): Promise<Deno.DirEntry[]> {
  const out: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) out.push(entry);
  return out;
}

/**
 * Zips and folder pickers commonly nest the site one level deep
 * (`dist/index.html`). Lift the contents up so the site root is the real root.
 */
export async function hoistRoot(dir: string): Promise<string[]> {
  const hoisted: string[] = [];
  for (let depth = 0; depth < 4; depth++) {
    if (await pathExists(`${dir}/index.html`)) break;
    const entries = await listEntries(dir);
    const dirs = entries.filter((e) => e.isDirectory);
    const files = entries.filter((e) => !e.isDirectory);
    if (dirs.length !== 1 || files.length !== 0) break;

    const inner = `${dir}/${dirs[0].name}`;
    const innerEntries = await listEntries(inner);
    // Move each child up one level, then remove the now-empty wrapper.
    for (const child of innerEntries) {
      await Deno.rename(`${inner}/${child.name}`, `${dir}/${child.name}`);
    }
    await Deno.remove(inner);
    hoisted.push(dirs[0].name);
  }
  return hoisted;
}

/** Rewrite root-absolute URLs in HTML and CSS to sit under /<site>. */
export async function applyRewrites(
  dir: string,
  prefix: string,
): Promise<number> {
  const files = await walk(dir);
  let changed = 0;
  for (const file of files) {
    const lower = file.rel.toLowerCase();
    const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
    const isCss = lower.endsWith(".css");
    if (!isHtml && !isCss) continue;
    // Guard against pathological files; 32 MB of HTML is not a real site.
    if (file.size > 32 * 1024 * 1024) continue;

    const full = `${dir}/${file.rel}`;
    const original = await Deno.readTextFile(full);
    const rewritten = isHtml
      ? rewriteHtml(original, prefix)
      : rewriteCss(original, prefix);
    if (rewritten !== original) {
      await Deno.writeTextFile(full, rewritten);
      changed++;
    }
  }
  return changed;
}

async function removeJunk(dir: string): Promise<number> {
  const files = await walk(dir);
  let removed = 0;
  for (const file of files) {
    if (isJunkPath(file.rel)) {
      await Deno.remove(`${dir}/${file.rel}`).catch(() => {});
      removed++;
    }
  }
  return removed;
}

export class DeployManager {
  private sessions = new Map<string, DeploySession>();

  constructor(
    private storage: Storage,
    private diskReserveBytes: number,
  ) {}

  /**
   * Refuse an upload that would eat into the reserved free space.
   * Returns an error message, or null when there is room (or when free space
   * cannot be determined).
   */
  async spaceCheck(incomingBytes: number): Promise<string | null> {
    const verdict = await checkSpaceFor(
      this.storage.dataDir,
      incomingBytes,
      this.diskReserveBytes,
    );
    return verdict.ok ? null : verdict.message;
  }

  /** Remove staging directories left behind by a crash or abandoned upload. */
  async cleanupStale(maxAgeMs = 2 * 60 * 60 * 1000): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > maxAgeMs) {
        this.sessions.delete(id);
        await Deno.remove(session.dir, { recursive: true }).catch(() => {});
      }
    }
    try {
      for await (const entry of Deno.readDir(this.storage.tmpDir)) {
        if (!entry.isDirectory) continue;
        if (this.sessions.has(entry.name)) continue;
        const full = `${this.storage.tmpDir}/${entry.name}`;
        const stat = await Deno.stat(full);
        const mtime = stat.mtime?.getTime() ?? 0;
        if (now - mtime > maxAgeMs) {
          await Deno.remove(full, { recursive: true }).catch(() => {});
        }
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  async begin(site: string, note: string): Promise<DeploySession> {
    const id = `d_${Date.now().toString(36)}_${
      crypto.randomUUID().slice(0, 8)
    }`;
    const dir = `${this.storage.tmpDir}/${id}`;
    await Deno.mkdir(dir, { recursive: true });
    const session: DeploySession = {
      id,
      site,
      dir,
      note,
      createdAt: Date.now(),
      bytesReceived: 0,
      lastSpaceCheck: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): DeploySession | undefined {
    return this.sessions.get(id);
  }

  async abort(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await Deno.remove(session.dir, { recursive: true }).catch(() => {});
  }

  /**
   * Guard against the disk filling mid-upload, whether because the browser
   * under-declared the size or another process consumed the space. Throttled
   * so df runs at most once every few seconds per deploy.
   */
  async guardSpaceDuringUpload(session: DeploySession): Promise<void> {
    const now = Date.now();
    if (now - session.lastSpaceCheck < 4000) return;
    session.lastSpaceCheck = now;
    const problem = await this.spaceCheck(0);
    if (problem) {
      throw new DeployError(problem, 507);
    }
  }

  /** Write a chunk of an uploaded file at the given byte offset. */
  async writeChunk(
    session: DeploySession,
    relPath: string,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<number> {
    const safe = safeRelativePath(relPath);
    if (!safe) throw new DeployError(`Unsafe file path: ${relPath}`);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new DeployError("Invalid chunk offset.");
    }

    const full = `${session.dir}/${safe}`;
    const parent = full.slice(0, full.lastIndexOf("/"));
    await Deno.mkdir(parent, { recursive: true });

    const file = await Deno.open(full, {
      write: true,
      create: true,
      truncate: offset === 0,
    });
    let written = 0;
    try {
      await file.seek(offset, Deno.SeekMode.Start);
      if (body) {
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            let pos = 0;
            while (pos < value.byteLength) {
              const n = await file.write(value.subarray(pos));
              pos += n;
            }
            written += value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      file.close();
    }

    session.bytesReceived += written;
    return written;
  }

  /**
   * Turn a staged upload into the live release: extract, hoist, rewrite,
   * move into place, then point the site at it.
   */
  async finalize(
    session: DeploySession,
    site: Site,
    opts: { unzip: boolean },
  ): Promise<{ release: Release; warnings: string[] }> {
    const warnings: string[] = [];

    if (opts.unzip) {
      const archive = `${session.dir}/${ARCHIVE_NAME}`;
      if (!(await pathExists(archive))) {
        throw new DeployError("The archive did not finish uploading.");
      }
      const staging = `${session.dir}__unzip`;
      await Deno.mkdir(staging, { recursive: true });
      try {
        const extracted = await extractZip(archive, staging);
        if (extracted.skipped.length > 0) {
          warnings.push(
            `Skipped ${extracted.skipped.length} system file${
              extracted.skipped.length === 1 ? "" : "s"
            } from the archive.`,
          );
        }
      } catch (err) {
        await Deno.remove(staging, { recursive: true }).catch(() => {});
        if (err instanceof ZipError) throw new DeployError(err.message);
        throw err;
      }
      await Deno.remove(session.dir, { recursive: true }).catch(() => {});
      await Deno.rename(staging, session.dir);
    }

    const removed = await removeJunk(session.dir);
    if (removed > 0) {
      warnings.push(
        `Skipped ${removed} system file${removed === 1 ? "" : "s"}.`,
      );
    }

    const hoisted = await hoistRoot(session.dir);
    if (hoisted.length > 0) {
      warnings.push(`Used ${hoisted.join("/")}/ as the site root.`);
    }

    const files = await walk(session.dir);
    if (files.length === 0) {
      throw new DeployError("No files were uploaded.");
    }
    if (!(await pathExists(`${session.dir}/index.html`))) {
      warnings.push(
        "No index.html at the site root — visiting the site root will return 404.",
      );
    }

    if (site.rewriteRootPaths) {
      const changed = await applyRewrites(session.dir, `/${site.name}`);
      if (changed > 0) {
        warnings.push(
          `Rewrote root-absolute links in ${changed} file${
            changed === 1 ? "" : "s"
          }.`,
        );
      }
    }

    const releaseId = `r_${Date.now().toString(36)}_${
      crypto.randomUUID().slice(0, 6)
    }`;
    const releasesDir = `${this.storage.siteDir(site.name)}/releases`;
    await Deno.mkdir(releasesDir, { recursive: true });
    const target = `${releasesDir}/${releaseId}`;

    // Same filesystem (both under dataDir), so this rename is atomic.
    await Deno.rename(session.dir, target);
    this.sessions.delete(session.id);

    const totals = await walk(target);
    const release: Release = {
      id: releaseId,
      createdAt: Date.now(),
      fileCount: totals.length,
      bytes: totals.reduce((sum, f) => sum + f.size, 0),
      note: session.note,
      source: opts.unzip ? "zip" : "folder",
    };

    await this.storage.update((store) => {
      const target = store.sites[site.name];
      if (!target) throw new DeployError("Site no longer exists.", 404);
      target.releases.unshift(release);
      target.currentRelease = releaseId;
      target.updatedAt = Date.now();
    });

    const pruned = await this.prune(site.name);
    if (pruned.length > 0) {
      warnings.push(
        `Removed ${pruned.length} old release${
          pruned.length === 1 ? "" : "s"
        } to save space.`,
      );
    }
    return { release, warnings };
  }

  /**
   * Drop old releases beyond this site's retention limit. The live release is
   * always kept, even when it is older than the ones being discarded.
   */
  async prune(siteName: string): Promise<string[]> {
    const toDelete = await this.storage.update((store) => {
      const site = store.sites[siteName];
      if (!site) return [] as string[];
      const limit = clampReleases(site.maxReleases);
      const keep: Release[] = [];
      const drop: string[] = [];
      for (const release of site.releases) {
        if (
          release.id === site.currentRelease || keep.length < limit
        ) {
          keep.push(release);
        } else {
          drop.push(release.id);
        }
      }
      site.releases = keep;
      return drop;
    });

    for (const releaseId of toDelete) {
      await Deno.remove(this.storage.releaseDir(siteName, releaseId), {
        recursive: true,
      }).catch(() => {});
    }
    return toDelete;
  }
}
