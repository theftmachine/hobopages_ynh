// HoboPages — HTTP server.
// A small static-site host: upload a built folder, serve it at /<site>.

import {
  clampReleases,
  type Config,
  defaultSite,
  loadConfig,
  loadSecret,
  sha256,
  signSession,
  type Site,
  Storage,
  timingSafeEqual,
  toBase64Url,
  validateSiteName,
  verifySession,
  VERSION,
} from "./core.ts";
import { DeployError, DeployManager, walk } from "./deploy.ts";
import { resolvePath, serveFile } from "./static.ts";
import { diskInfo } from "./disk.ts";
import { RoomService } from "./rooms.js";
import { openRoomSocket } from "./room-socket.ts";

const SESSION_COOKIE = "hobopages_session";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json; charset=utf-8");
  merged.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: merged });
}

function errorJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function clientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const addr = info.remoteAddr;
  return addr.transport === "tcp" || addr.transport === "udp"
    ? addr.hostname
    : "local";
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* fall through */ }
  throw new DeployError("Expected a JSON object.");
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

class LoginThrottle {
  private attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit = 10, private windowMs = 15 * 60 * 1000) {}

  check(ip: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now > entry.resetAt) return true;
    return entry.count < this.limit;
  }

  record(ip: string): void {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count++;
  }

  clear(ip: string): void {
    this.attempts.delete(ip);
  }

  sweep(): void {
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      if (now > entry.resetAt) this.attempts.delete(ip);
    }
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export class HoboPages {
  private rooms = new RoomService();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private storage: Storage;
  private deploys: DeployManager;
  private throttle = new LoginThrottle();
  private secret!: CryptoKey;
  private adminHash!: Uint8Array;
  private ui = "";

  constructor(private config: Config) {
    this.storage = new Storage(config.dataDir);
    this.deploys = new DeployManager(this.storage, config.diskReserveBytes);
  }

  async init(): Promise<void> {
    await Deno.mkdir(this.config.dataDir, { recursive: true });
    await this.storage.init();
    this.secret = await loadSecret(this.config.dataDir);
    this.adminHash = await sha256(this.config.adminPassword);

    const uiPath = new URL("./ui.html", import.meta.url);
    this.ui = await Deno.readTextFile(uiPath);

    await this.deploys.cleanupStale(0);

    this.maintenanceTimer = setInterval(() => {
      this.throttle.sweep();
      this.deploys.cleanupStale().catch(() => console.error({ event: "stale-upload-cleanup-failed" }));
    }, 30 * 60 * 1000);
  }

  close(): void {
    if (this.maintenanceTimer !== null) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.rooms.close();
  }

  serve(): Deno.HttpServer {
    return Deno.serve(
      { hostname: this.config.host, port: this.config.port },
      (req, info) => this.handle(req, info),
    );
  }

  // -------------------------------------------------------------- routing

  private async handle(
    req: Request,
    info: Deno.ServeHandlerInfo,
  ): Promise<Response> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return errorJson("Bad request.", 400);
    }

    try {
      if (url.pathname === "/__api/hello") {
        return json({ version: VERSION, baseUrl: this.config.baseUrl });
      }
      if (url.pathname === "/health") {
        return new Response("ok", {
          headers: {
            "content-type": "text/plain",
            "cache-control": "no-store",
          },
        });
      }
      if (url.pathname.startsWith("/__api/")) {
        return await this.handleApi(req, url, info);
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(this.ui, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "same-origin",
          },
        });
      }
      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /__api/\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return await this.handleSite(req, url);
    } catch (err) {
      if (err instanceof DeployError) {
        return errorJson(err.message, err.status);
      }
      console.error(`[hobopages] ${req.method} ${url.pathname}:`, err);
      return errorJson("Something went wrong on the server.", 500);
    }
  }

  // -------------------------------------------------------------- auth

  private async isAuthed(req: Request): Promise<boolean> {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    return await verifySession(this.secret, token);
  }

  private sessionCookie(value: string, maxAgeSeconds: number): string {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.config.cookieSecure) parts.push("Secure");
    return parts.join("; ");
  }

  // -------------------------------------------------------------- API

  private async handleApi(
    req: Request,
    url: URL,
    info: Deno.ServeHandlerInfo,
  ): Promise<Response> {
    const path = url.pathname.slice("/__api".length);

    // CSRF: browsers cannot set this header cross-origin without a preflight,
    // and no CORS headers are ever sent, so a preflight will fail.
    if (req.method !== "GET" && req.headers.get("x-hobopages") !== "1") {
      return errorJson("Missing request header.", 400);
    }

    if (path === "/login" && req.method === "POST") {
      const ip = clientIp(req, info);
      if (!this.throttle.check(ip)) {
        return errorJson("Too many attempts. Try again in 15 minutes.", 429);
      }
      const body = await readJson(req);
      const password = typeof body.password === "string" ? body.password : "";
      const candidate = await sha256(password);
      if (!timingSafeEqual(candidate, this.adminHash)) {
        this.throttle.record(ip);
        return errorJson("That password is not right.", 401);
      }
      this.throttle.clear(ip);
      const maxAge = this.config.sessionHours * 3600;
      const token = await signSession(this.secret, Date.now() + maxAge * 1000);
      return json({ ok: true }, 200, {
        "set-cookie": this.sessionCookie(token, maxAge),
      });
    }

    if (path === "/logout" && req.method === "POST") {
      return json({ ok: true }, 200, {
        "set-cookie": this.sessionCookie("", 0),
      });
    }

    if (!(await this.isAuthed(req))) {
      return errorJson("Sign in first.", 401);
    }

    if (path === "/state" && req.method === "GET") {
      const disk = await diskInfo(this.config.dataDir);
      return json({
        version: VERSION,
        baseUrl: this.config.baseUrl,
        defaultMaxReleases: this.config.defaultMaxReleases,
        diskReserveBytes: this.config.diskReserveBytes,
        disk,
        sites: this.storage.list().map((site) => this.publicSite(site)),
      });
    }

    if (path === "/sites" && req.method === "POST") {
      return await this.createSite(req);
    }

    // /sites/:name…
    const siteMatch = /^\/sites\/([^/]+)(\/.*)?$/.exec(path);
    if (siteMatch) {
      const name = decodeURIComponent(siteMatch[1]);
      const rest = siteMatch[2] ?? "";
      return await this.siteRoutes(req, name, rest);
    }

    // /deploys/:id…
    const deployMatch = /^\/deploys\/([^/]+)(\/.*)?$/.exec(path);
    if (deployMatch) {
      const id = decodeURIComponent(deployMatch[1]);
      const rest = deployMatch[2] ?? "";
      return await this.deployRoutes(req, id, rest);
    }

    return errorJson("Unknown endpoint.", 404);
  }

  private publicSite(site: Site) {
    const current = site.releases.find((r) => r.id === site.currentRelease);
    return {
      name: site.name,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
      currentRelease: site.currentRelease,
      releases: site.releases,
      rewriteRootPaths: site.rewriteRootPaths,
      spaFallback: site.spaFallback,
      refererRescue: site.refererRescue,
      cleanUrls: site.cleanUrls,
      maxReleases: site.maxReleases,
      enabled: site.enabled,
      hasPassword: site.password !== null,
      fileCount: current?.fileCount ?? 0,
      bytes: current?.bytes ?? 0,
      totalBytes: site.releases.reduce((sum, r) => sum + r.bytes, 0),
    };
  }

  private async createSite(req: Request): Promise<Response> {
    const body = await readJson(req);
    const name = typeof body.name === "string"
      ? body.name.trim().toLowerCase()
      : "";
    const problem = validateSiteName(name);
    if (problem) return errorJson(problem, 400);
    if (this.storage.has(name)) {
      return errorJson(`A site called "${name}" already exists.`, 409);
    }
    await this.storage.update((store) => {
      store.sites[name] = defaultSite(name, this.config.defaultMaxReleases);
    });
    await Deno.mkdir(`${this.storage.siteDir(name)}/releases`, {
      recursive: true,
    });
    return json({ site: this.publicSite(this.storage.get(name)!) }, 201);
  }

  private async siteRoutes(
    req: Request,
    name: string,
    rest: string,
  ): Promise<Response> {
    const site = this.storage.get(name);
    if (!site) return errorJson("No such site.", 404);

    if (rest === "" && req.method === "PATCH") {
      const body = await readJson(req);
      const booleans = [
        "rewriteRootPaths",
        "spaFallback",
        "refererRescue",
        "cleanUrls",
        "enabled",
      ] as const;
      await this.storage.update((store) => {
        const target = store.sites[name];
        for (const key of booleans) {
          if (typeof body[key] === "boolean") {
            target[key] = body[key] as boolean;
          }
        }
        if ("maxReleases" in body) {
          const value = Number(body.maxReleases);
          if (!Number.isFinite(value)) {
            throw new DeployError("Releases to keep must be a number.");
          }
          target.maxReleases = clampReleases(value);
        }
        if ("password" in body) {
          const value = body.password;
          if (value === null) {
            target.password = null;
          } else if (typeof value === "string" && value.length >= 4) {
            target.password = value;
          } else {
            throw new DeployError("A visitor password needs 4+ characters.");
          }
        }
        target.updatedAt = Date.now();
      });
      if (body.enabled === false || "password" in body) this.rooms.closeScope(name);
      // Lowering the retention limit should free the space straight away.
      const pruned = await this.deploys.prune(name);
      return json({
        site: this.publicSite(this.storage.get(name)!),
        pruned: pruned.length,
      });
    }

    if (rest === "" && req.method === "DELETE") {
      await this.storage.update((store) => {
        delete store.sites[name];
      });
      this.rooms.closeScope(name);
      await Deno.remove(this.storage.siteDir(name), { recursive: true })
        .catch(() => {});
      return json({ ok: true });
    }

    if (rest === "/deploys" && req.method === "POST") {
      const body = await readJson(req);
      const note = typeof body.note === "string" ? body.note.slice(0, 200) : "";

      // Refuse before a single byte is uploaded when there is not room.
      const declared = Number(body.totalBytes);
      if (Number.isFinite(declared) && declared > 0) {
        const problem = await this.deploys.spaceCheck(declared);
        if (problem) return errorJson(problem, 507);
      }

      const session = await this.deploys.begin(name, note);
      return json({ deployId: session.id }, 201);
    }

    if (rest === "/rollback" && req.method === "POST") {
      const body = await readJson(req);
      const releaseId = typeof body.releaseId === "string"
        ? body.releaseId
        : "";
      if (!site.releases.some((r) => r.id === releaseId)) {
        return errorJson("No such release.", 404);
      }
      await this.storage.update((store) => {
        store.sites[name].currentRelease = releaseId;
        store.sites[name].updatedAt = Date.now();
      });
      return json({ site: this.publicSite(this.storage.get(name)!) });
    }

    const releaseMatch = /^\/releases\/([^/]+)$/.exec(rest);
    if (releaseMatch && req.method === "DELETE") {
      const releaseId = decodeURIComponent(releaseMatch[1]);
      if (site.currentRelease === releaseId) {
        return errorJson(
          "That release is live. Make another one live first.",
          409,
        );
      }
      if (!site.releases.some((r) => r.id === releaseId)) {
        return errorJson("No such release.", 404);
      }
      await this.storage.update((store) => {
        const target = store.sites[name];
        target.releases = target.releases.filter((r) => r.id !== releaseId);
      });
      await Deno.remove(this.storage.releaseDir(name, releaseId), {
        recursive: true,
      }).catch(() => {});
      return json({ ok: true });
    }

    return errorJson("Unknown endpoint.", 404);
  }

  private async deployRoutes(
    req: Request,
    id: string,
    rest: string,
  ): Promise<Response> {
    const session = this.deploys.get(id);
    if (!session) {
      return errorJson("This upload has expired. Start again.", 404);
    }

    if (rest === "/file" && req.method === "PUT") {
      const rawPath = req.headers.get("x-file-path");
      if (!rawPath) return errorJson("Missing file path.", 400);
      let relPath: string;
      try {
        relPath = decodeURIComponent(rawPath);
      } catch {
        return errorJson("Malformed file path.", 400);
      }
      const offset = Number(req.headers.get("x-offset") ?? "0");

      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > this.config.maxUploadBytes) {
        return errorJson(
          `Chunk too large (max ${this.config.maxUploadBytes} bytes).`,
          413,
        );
      }

      await this.deploys.guardSpaceDuringUpload(session);

      const written = await this.deploys.writeChunk(
        session,
        relPath,
        offset,
        req.body,
      );
      return json({ written });
    }

    if (rest === "/finalize" && req.method === "POST") {
      const body = await readJson(req);
      const site = this.storage.get(session.site);
      if (!site) {
        await this.deploys.abort(id);
        return errorJson("That site was deleted.", 404);
      }
      const result = await this.deploys.finalize(session, site, {
        unzip: body.unzip === true,
      });
      return json(result);
    }

    if (rest === "" && req.method === "DELETE") {
      await this.deploys.abort(id);
      return json({ ok: true });
    }

    return errorJson("Unknown endpoint.", 404);
  }

  // -------------------------------------------------------------- sites

  private async handleSite(req: Request, url: URL): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "allow": "GET, HEAD" },
      });
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return this.plainNotFound();
    }

    const segments = decodedPath.split("/").filter((s) => s !== "");
    const siteName = segments[0] ?? "";
    const site = this.storage.get(siteName);

    if (site && site.enabled && site.currentRelease) {
      const authFailure = this.checkSitePassword(req, site);
      if (authFailure) return authFailure;

      // A bare /site with no trailing slash is normalised so relative links resolve.
      if (segments.length === 1 && !url.pathname.endsWith("/")) {
        return Response.redirect(
          `${url.origin}${url.pathname}/${url.search}`,
          301,
        );
      }

      if (segments.length === 2 && segments[1] === "__rooms") {
        return openRoomSocket(req, siteName, this.config.baseUrl, this.rooms);
      }

      const root = this.storage.currentDir(site)!;
      const rel = segments.slice(1).join("/");
      const resolution = await resolvePath(root, rel, site, url.pathname);

      if (resolution.kind === "file") {
        return await serveFile(req, resolution.file, rel);
      }
      if (resolution.kind === "redirect") {
        return Response.redirect(
          `${url.origin}${resolution.location}${url.search}`,
          301,
        );
      }
      // Fall through to the rescue below, then 404.
    }

    const rescued = await this.rescueByReferer(req, url, decodedPath);
    if (rescued) return rescued;

    if (site && !site.enabled) {
      return this.plainMessage(
        "This site is switched off.",
        503,
      );
    }
    if (site && !site.currentRelease) {
      return this.plainMessage(
        "Nothing has been deployed to this site yet.",
        404,
      );
    }
    return this.plainNotFound();
  }

  /**
   * A build that assumes it lives at the domain root will request /assets/app.js.
   * The Referer tells us which site the page came from, so serve it from there.
   */
  private async rescueByReferer(
    req: Request,
    url: URL,
    decodedPath: string,
  ): Promise<Response | null> {
    const referer = req.headers.get("referer");
    if (!referer) return null;

    let refUrl: URL;
    try {
      refUrl = new URL(referer);
    } catch {
      return null;
    }
    if (refUrl.host !== url.host) return null;

    const refSegments = refUrl.pathname.split("/").filter((s) => s !== "");
    const siteName = refSegments[0];
    if (!siteName) return null;

    const site = this.storage.get(siteName);
    if (!site || !site.enabled || !site.refererRescue || !site.currentRelease) {
      return null;
    }
    // Do not rescue a path that already starts with this site's own prefix.
    if (decodedPath.split("/").filter((s) => s !== "")[0] === siteName) {
      return null;
    }

    const authFailure = this.checkSitePassword(req, site);
    if (authFailure) return authFailure;

    const root = this.storage.currentDir(site)!;
    const rel = decodedPath.replace(/^\/+/, "");
    if (!rel) return null;

    const resolution = await resolvePath(
      root,
      rel,
      { ...site, spaFallback: false },
      url.pathname,
    );
    if (resolution.kind === "file" && resolution.file.status === 200) {
      return await serveFile(req, resolution.file, rel);
    }
    return null;
  }

  private checkSitePassword(req: Request, site: Site): Response | null {
    if (site.password === null) return null;
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      try {
        const decoded = atob(header.slice(6));
        const colon = decoded.indexOf(":");
        const supplied = colon === -1 ? decoded : decoded.slice(colon + 1);
        const a = new TextEncoder().encode(supplied);
        const b = new TextEncoder().encode(site.password);
        if (a.length === b.length && timingSafeEqual(a, b)) return null;
      } catch { /* fall through to challenge */ }
    }
    return new Response("Password required.", {
      status: 401,
      headers: {
        "www-authenticate": `Basic realm="${site.name}", charset="UTF-8"`,
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private plainNotFound(): Response {
    return this.plainMessage("Not found.", 404);
  }

  private plainMessage(message: string, status: number): Response {
    const body =
      `<!doctype html><meta charset="utf-8"><title>${status}</title>` +
      `<style>body{background:#0B0F14;color:#D6E0E8;font:14px ui-monospace,monospace;` +
      `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
      `b{color:#F0A02A}</style><div><b>${status}</b> — ${message}</div>`;
    return new Response(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(
      `[hobopages] Configuration error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    Deno.exit(1);
  }

  const app = new HoboPages(config);
  await app.init();
  app.serve();
  console.log(
    `[hobopages] v${VERSION} listening on http://${config.host}:${config.port} — public base ${config.baseUrl}`,
  );
}

export { loadConfig, toBase64Url, walk };
