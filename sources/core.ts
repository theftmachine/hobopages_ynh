// HoboPages — core: config, storage, auth, path safety, zip, rewriting.
// Deno 2.x. No third-party dependencies.

export const VERSION = "1.4.0";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  adminPassword: string;
  baseUrl: string;
  defaultMaxReleases: number;
  diskReserveBytes: number;
  cookieSecure: boolean;
  sessionHours: number;
  maxUploadBytes: number;
}

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be a boolean, got: ${raw}`);
}

function readPasswordFile(path: string): string {
  let contents: string;
  try {
    contents = Deno.readTextFileSync(path);
  } catch (err) {
    throw new Error(
      `Cannot read HOBOPAGES_ADMIN_PASSWORD_FILE at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Strip only a trailing newline; a password may legitimately end in spaces.
  return contents.replace(/\r?\n$/, "");
}

export function loadConfig(): Config {
  const passwordFile = Deno.env.get("HOBOPAGES_ADMIN_PASSWORD_FILE");
  const adminPassword = passwordFile && passwordFile.trim() !== ""
    ? readPasswordFile(passwordFile.trim())
    : Deno.env.get("HOBOPAGES_ADMIN_PASSWORD") ?? "";

  if (adminPassword.length < 8) {
    throw new Error(
      "The admin password must be at least 8 characters. Set HOBOPAGES_ADMIN_PASSWORD or HOBOPAGES_ADMIN_PASSWORD_FILE.",
    );
  }
  const baseUrl =
    (Deno.env.get("HOBOPAGES_BASE_URL") ?? "http://localhost:8787")
      .replace(/\/+$/, "");

  return {
    dataDir: Deno.env.get("HOBOPAGES_DATA_DIR") ?? "/var/www/hobopages/data",
    host: Deno.env.get("HOBOPAGES_HOST") ?? "127.0.0.1",
    port: envInt("HOBOPAGES_PORT", 8787),
    adminPassword,
    baseUrl,
    defaultMaxReleases: envInt("HOBOPAGES_MAX_RELEASES", 2),
    diskReserveBytes: envInt(
      "HOBOPAGES_DISK_RESERVE_BYTES",
      2 * 1024 * 1024 * 1024,
    ),
    cookieSecure: envBool(
      "HOBOPAGES_COOKIE_SECURE",
      baseUrl.startsWith("https"),
    ),
    sessionHours: envInt("HOBOPAGES_SESSION_HOURS", 24 * 14),
    maxUploadBytes: envInt("HOBOPAGES_MAX_UPLOAD_BYTES", 8 * 1024 * 1024),
  };
}

// ---------------------------------------------------------------------------
// Site metadata
// ---------------------------------------------------------------------------

export interface Release {
  id: string;
  createdAt: number;
  fileCount: number;
  bytes: number;
  note: string;
  source: "folder" | "zip";
}

export interface Site {
  name: string;
  createdAt: number;
  updatedAt: number;
  currentRelease: string | null;
  releases: Release[];
  /** Prefix root-absolute URLs in HTML/CSS with /<site> at deploy time. */
  rewriteRootPaths: boolean;
  /** Serve index.html for unmatched paths (single-page apps). */
  spaFallback: boolean;
  /** Recover root-absolute asset requests using the Referer header. */
  refererRescue: boolean;
  /** Serve clean URLs: /about resolves to about.html. */
  cleanUrls: boolean;
  /**
   * How many releases to keep for this site, including the live one.
   * 2 means "the current build and the one before it".
   */
  maxReleases: number;
  /** When set, the site is behind HTTP basic auth with this password. */
  password: string | null;
  enabled: boolean;
}

export interface Store {
  version: number;
  sites: Record<string, Site>;
}

const RESERVED_NAMES = new Set([
  "__api",
  "__admin",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  ".well-known",
  "health",
  // Claimed by YunoHost on every domain.
  "yunohost",
  "ynh",
]);

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSiteName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return "Use 1–63 characters: lowercase letters, numbers and hyphens, not starting or ending with a hyphen.";
  }
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved.`;
  return null;
}

export const MIN_RELEASES = 1;
export const MAX_RELEASES_LIMIT = 20;

export function clampReleases(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.min(
    MAX_RELEASES_LIMIT,
    Math.max(MIN_RELEASES, Math.floor(value)),
  );
}

export function defaultSite(name: string, maxReleases = 2): Site {
  const now = Date.now();
  return {
    name,
    createdAt: now,
    updatedAt: now,
    currentRelease: null,
    releases: [],
    rewriteRootPaths: true,
    spaFallback: false,
    refererRescue: true,
    cleanUrls: true,
    maxReleases: clampReleases(maxReleases),
    password: null,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Storage — atomic JSON with a write queue
// ---------------------------------------------------------------------------

export class Storage {
  readonly dataDir: string;
  readonly sitesDir: string;
  readonly tmpDir: string;
  private storePath: string;
  private store: Store = { version: 1, sites: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sitesDir = `${dataDir}/sites`;
    this.tmpDir = `${dataDir}/tmp`;
    this.storePath = `${dataDir}/sites.json`;
  }

  async init(): Promise<void> {
    await Deno.mkdir(this.sitesDir, { recursive: true });
    await Deno.mkdir(this.tmpDir, { recursive: true });
    try {
      const raw = await Deno.readTextFile(this.storePath);
      const parsed = JSON.parse(raw) as Store;
      if (parsed && typeof parsed === "object" && parsed.sites) {
        // Backfill fields added after a store was first written.
        for (const [name, site] of Object.entries(parsed.sites)) {
          parsed.sites[name] = { ...defaultSite(name), ...site };
        }
        this.store = { version: 1, sites: parsed.sites };
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  snapshot(): Store {
    return structuredClone(this.store);
  }

  get(name: string): Site | undefined {
    return this.store.sites[name];
  }

  list(): Site[] {
    return Object.values(this.store.sites).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  has(name: string): boolean {
    return Object.hasOwn(this.store.sites, name);
  }

  /** Apply a mutation and persist. Serialised through a promise chain. */
  update<T>(fn: (store: Store) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      const result = fn(this.store);
      await this.persist();
      return result;
    });
    // Keep the chain alive even if this write rejects.
    this.writeChain = run.then(() => {}, () => {});
    return run;
  }

  private async persist(): Promise<void> {
    const tmp = `${this.storePath}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(this.store, null, 2));
    await Deno.rename(tmp, this.storePath);
  }

  siteDir(name: string): string {
    return `${this.sitesDir}/${name}`;
  }

  releaseDir(name: string, releaseId: string): string {
    return `${this.sitesDir}/${name}/releases/${releaseId}`;
  }

  currentDir(site: Site): string | null {
    if (!site.currentRelease) return null;
    return this.releaseDir(site.name, site.currentRelease);
  }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Normalise a relative path from untrusted input.
 * Returns null if the path escapes its root or contains illegal segments.
 */
export function safeRelativePath(input: string): string | null {
  if (input.includes("\0")) return null;
  const unified = input.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const rawSegment of unified.split("/")) {
    if (rawSegment === "" || rawSegment === ".") continue;
    if (rawSegment === "..") return null;
    if (rawSegment.length > 255) return null;
    segments.push(rawSegment);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

const JUNK_SEGMENTS = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".gitignore",
  ".gitattributes",
]);

const JUNK_DIRS = new Set([
  "__MACOSX",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".cache",
]);

/** True when a relative path should be silently dropped from a deploy. */
export function isJunkPath(relPath: string): boolean {
  const parts = relPath.split("/");
  if (JUNK_SEGMENTS.has(parts[parts.length - 1])) return true;
  if (parts[parts.length - 1].startsWith("._")) return true;
  return parts.slice(0, -1).some((p) => JUNK_DIRS.has(p));
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

export function fromBase64Url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Load the HMAC secret, generating and persisting one on first run. */
export async function loadSecret(dataDir: string): Promise<CryptoKey> {
  const fromEnv = Deno.env.get("HOBOPAGES_SECRET");
  let raw: Uint8Array;
  if (fromEnv && fromEnv.trim().length >= 16) {
    raw = new TextEncoder().encode(fromEnv.trim());
  } else {
    const path = `${dataDir}/secret.key`;
    try {
      raw = await Deno.readFile(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      raw = crypto.getRandomValues(new Uint8Array(48));
      await Deno.writeFile(path, raw, { mode: 0o600 });
    }
  }
  return await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(
  key: CryptoKey,
  expiresAt: number,
): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(String(expiresAt)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return `${payload}.${toBase64Url(sig)}`;
}

export async function verifySession(
  key: CryptoKey,
  token: string,
): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  const sig = fromBase64Url(sigPart);
  if (!sig) return false;
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  if (!timingSafeEqual(sig, expected)) return false;
  const decoded = fromBase64Url(payload);
  if (!decoded) return false;
  const expiresAt = Number(new TextDecoder().decode(decoded));
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  opus: "audio/opus",
  pdf: "application/pdf",
  zip: "application/zip",
  wasm: "application/wasm",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  gz: "application/gzip",
  br: "application/brotli",
};

export function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

const COMPRESSIBLE =
  /^(text\/|application\/(json|xml|javascript|manifest\+json|wasm)|image\/svg)/;

export function isCompressible(contentType: string): boolean {
  return COMPRESSIBLE.test(contentType);
}

/** Filenames with a content hash can be cached forever. */
const HASHED = /[.-][0-9a-fA-F]{8,}\.[a-z0-9]+$/;

export function cacheControlFor(path: string, contentType: string): string {
  if (contentType.startsWith("text/html")) return "no-cache";
  if (HASHED.test(path)) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

// ---------------------------------------------------------------------------
// Root-absolute path rewriting for sub-path hosting
// ---------------------------------------------------------------------------

function rewriteSrcset(value: string, prefix: string): string {
  return value
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return null;
      const spaceIdx = trimmed.search(/\s/);
      const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx);
      if (url.startsWith("/") && !url.startsWith("//")) {
        return `${prefix}${url}${rest}`;
      }
      return trimmed;
    })
    .filter((entry): entry is string => entry !== null)
    .join(", ");
}

function rewriteCssText(css: string, prefix: string): string {
  let out = css.replace(
    /url\(\s*(["']?)(\/(?!\/)[^"')]*)\1\s*\)/gi,
    (_m, quote: string, url: string) => `url(${quote}${prefix}${url}${quote})`,
  );
  out = out.replace(
    /@import\s+(["'])(\/(?!\/)[^"']*)\1/gi,
    (_m, quote: string, url: string) =>
      `@import ${quote}${prefix}${url}${quote}`,
  );
  return out;
}

export function rewriteCss(css: string, prefix: string): string {
  return rewriteCssText(css, prefix);
}

const ATTR_RE =
  /(\s(?:href|src|action|poster|data-src|data-href|formaction)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi;
const SRCSET_RE = /(\s(?:srcset|imagesrcset)\s*=\s*)(["'])([^"']*)\2/gi;
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const STYLE_ATTR_RE = /(\sstyle\s*=\s*)(["'])([^"']*)\2/gi;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;

export function rewriteHtml(html: string, prefix: string): string {
  // Protect <script> bodies: attribute syntax inside JS strings must not be touched.
  // The sentinel is random per call so it cannot collide with document content.
  const sentinel = `hpx${crypto.randomUUID().replace(/-/g, "")}`;
  const scripts: string[] = [];
  let out = html.replace(SCRIPT_BLOCK_RE, (match) => {
    scripts.push(match);
    return `${sentinel}${scripts.length - 1}${sentinel}`;
  });

  out = out.replace(
    ATTR_RE,
    (_m, attr: string, quote: string, url: string) =>
      `${attr}${quote}${prefix}${url}${quote}`,
  );
  out = out.replace(
    SRCSET_RE,
    (_m, attr: string, quote: string, value: string) =>
      `${attr}${quote}${rewriteSrcset(value, prefix)}${quote}`,
  );
  out = out.replace(
    STYLE_BLOCK_RE,
    (_m, open: string, body: string, close: string) =>
      `${open}${rewriteCssText(body, prefix)}${close}`,
  );
  out = out.replace(
    STYLE_ATTR_RE,
    (_m, attr: string, quote: string, body: string) =>
      `${attr}${quote}${rewriteCssText(body, prefix)}${quote}`,
  );

  // Restore scripts, rewriting only their src attribute if present.
  const restoreRe = new RegExp(`${sentinel}(\\d+)${sentinel}`, "g");
  out = out.replace(restoreRe, (_m, idx: string) => {
    const original = scripts[Number(idx)];
    return original.replace(
      /(<script\b[^>]*?\ssrc\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/i,
      (_mm, attr: string, quote: string, url: string) =>
        `${attr}${quote}${prefix}${url}${quote}`,
    );
  });

  return out;
}
