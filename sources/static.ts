// HoboPages — static file serving.

import {
  cacheControlFor,
  isCompressible,
  mimeFor,
  safeRelativePath,
  type Site,
} from "./core.ts";

export interface ResolvedFile {
  path: string;
  stat: Deno.FileInfo;
  status: number;
}

async function statFile(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (err) {
    if (
      err instanceof Deno.errors.NotFound ||
      err instanceof Deno.errors.PermissionDenied
    ) {
      return null;
    }
    // A path component that is not a directory surfaces as a generic error.
    return null;
  }
}

export type Resolution =
  | { kind: "file"; file: ResolvedFile }
  | { kind: "redirect"; location: string }
  | { kind: "notFound" };

/**
 * Map a request path within a site to a file on disk.
 * `rel` is the path after the site prefix, without a leading slash.
 */
export async function resolvePath(
  root: string,
  rel: string,
  site: Site,
  urlPathname: string,
): Promise<Resolution> {
  // Empty path means the site root.
  if (rel === "") {
    const index = await statFile(`${root}/index.html`);
    if (index?.isFile) {
      return {
        kind: "file",
        file: { path: `${root}/index.html`, stat: index, status: 200 },
      };
    }
    return await notFoundResolution(root, site);
  }

  const safe = safeRelativePath(rel);
  if (!safe) return { kind: "notFound" };

  const full = `${root}/${safe}`;
  const direct = await statFile(full);

  if (direct?.isFile) {
    return { kind: "file", file: { path: full, stat: direct, status: 200 } };
  }

  if (direct?.isDirectory) {
    if (!urlPathname.endsWith("/")) {
      return { kind: "redirect", location: `${urlPathname}/` };
    }
    const index = await statFile(`${full}/index.html`);
    if (index?.isFile) {
      return {
        kind: "file",
        file: { path: `${full}/index.html`, stat: index, status: 200 },
      };
    }
    return await notFoundResolution(root, site);
  }

  // /about -> about.html
  if (site.cleanUrls && !safe.includes(".")) {
    const html = await statFile(`${full}.html`);
    if (html?.isFile) {
      return {
        kind: "file",
        file: { path: `${full}.html`, stat: html, status: 200 },
      };
    }
    // /about -> about/index.html, normalised to a trailing slash
    const nested = await statFile(`${full}/index.html`);
    if (nested?.isFile) {
      return { kind: "redirect", location: `${urlPathname}/` };
    }
  }

  return await notFoundResolution(root, site);
}

async function notFoundResolution(
  root: string,
  site: Site,
): Promise<Resolution> {
  if (site.spaFallback) {
    const index = await statFile(`${root}/index.html`);
    if (index?.isFile) {
      return {
        kind: "file",
        file: { path: `${root}/index.html`, stat: index, status: 200 },
      };
    }
  }
  const custom = await statFile(`${root}/404.html`);
  if (custom?.isFile) {
    return {
      kind: "file",
      file: { path: `${root}/404.html`, stat: custom, status: 404 },
    };
  }
  return { kind: "notFound" };
}

function etagFor(stat: Deno.FileInfo, suffix = ""): string {
  const mtime = stat.mtime?.getTime() ?? 0;
  return `"${stat.size.toString(16)}-${mtime.toString(16)}${suffix}"`;
}

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength === 0) {
      return "unsatisfiable";
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

/** ReadableStream over a byte range of a file, closing the handle when done. */
function fileRangeStream(
  file: Deno.FsFile,
  start: number,
  length: number,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let position = start;
  let remaining = length;
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    try {
      file.close();
    } catch { /* already closed */ }
  };

  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (remaining <= 0) {
        closeOnce();
        controller.close();
        return;
      }
      try {
        const size = Math.min(remaining, 128 * 1024);
        const buf = new Uint8Array(size);
        await file.seek(position, Deno.SeekMode.Start);
        const n = await file.read(buf);
        if (n === null || n === 0) {
          closeOnce();
          controller.close();
          return;
        }
        position += n;
        remaining -= n;
        controller.enqueue(buf.subarray(0, n));
      } catch (err) {
        closeOnce();
        controller.error(err);
      }
    },
    cancel() {
      closeOnce();
    },
  });
}

export async function serveFile(
  req: Request,
  file: ResolvedFile,
  relPathForCaching: string,
): Promise<Response> {
  const contentType = mimeFor(file.path);
  const size = file.stat.size;
  const isHead = req.method === "HEAD";

  const rangeHeader = req.headers.get("range");
  const acceptEncoding = req.headers.get("accept-encoding") ?? "";
  const wantsGzip = /\bgzip\b/.test(acceptEncoding);
  const useGzip = !rangeHeader && wantsGzip && isCompressible(contentType) &&
    size >= 1024 && file.status === 200;

  const etag = etagFor(file.stat, useGzip ? "-gz" : "");
  const lastModified = file.stat.mtime?.toUTCString();

  const headers = new Headers({
    "content-type": contentType,
    "etag": etag,
    "cache-control": cacheControlFor(relPathForCaching, contentType),
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "vary": "Accept-Encoding",
  });
  if (lastModified) headers.set("last-modified", lastModified);

  // Conditional requests.
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch) {
    const tags = ifNoneMatch.split(",").map((t) => t.trim());
    if (tags.includes(etag) || tags.includes("*")) {
      return new Response(null, { status: 304, headers });
    }
  } else {
    const ifModifiedSince = req.headers.get("if-modified-since");
    if (ifModifiedSince && file.stat.mtime) {
      const since = Date.parse(ifModifiedSince);
      if (
        Number.isFinite(since) &&
        Math.floor(file.stat.mtime.getTime() / 1000) <=
          Math.floor(since / 1000)
      ) {
        return new Response(null, { status: 304, headers });
      }
    }
  }

  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (range === "unsatisfiable") {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const length = range.end - range.start + 1;
      headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
      headers.set("content-length", String(length));
      if (isHead) return new Response(null, { status: 206, headers });
      const handle = await Deno.open(file.path, { read: true });
      return new Response(fileRangeStream(handle, range.start, length), {
        status: 206,
        headers,
      });
    }
  }

  if (isHead) {
    if (!useGzip) headers.set("content-length", String(size));
    return new Response(null, { status: file.status, headers });
  }

  const handle = await Deno.open(file.path, { read: true });
  if (useGzip) {
    headers.set("content-encoding", "gzip");
    const stream = fileRangeStream(handle, 0, size).pipeThrough(
      new CompressionStream("gzip"),
    );
    return new Response(stream, { status: file.status, headers });
  }

  headers.set("content-length", String(size));
  return new Response(fileRangeStream(handle, 0, size), {
    status: file.status,
    headers,
  });
}
