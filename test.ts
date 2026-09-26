// End-to-end test for HoboPages. Run: deno run -A test.ts

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "correct-horse-battery";
const dataDir = await Deno.makeTempDir({ prefix: "hobopages_test_" });

Deno.env.set("HOBOPAGES_DATA_DIR", dataDir);
Deno.env.set("HOBOPAGES_PORT", String(PORT));
Deno.env.set("HOBOPAGES_HOST", "127.0.0.1");
Deno.env.set("HOBOPAGES_ADMIN_PASSWORD", PASSWORD);
Deno.env.set("HOBOPAGES_BASE_URL", BASE);
Deno.env.set("HOBOPAGES_COOKIE_SECURE", "false");
Deno.env.set("HOBOPAGES_MAX_RELEASES", "3");

const { HoboPages } = await import("./sources/server.ts");
const { loadConfig } = await import("./sources/core.ts");

const app = new HoboPages(loadConfig());
await app.init();
const server = app.serve();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

let cookie = "";

async function api(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers);
  headers.set("x-hobopages", "1");
  headers.set("connection", "close");
  if (cookie) headers.set("cookie", cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers, body });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function uploadFiles(
  site: string,
  files: Array<{ path: string; data: Uint8Array | string }>,
  opts: { unzip?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const started = await api(`/__api/sites/${site}/deploys`, {
    method: "POST",
    json: { note: "test deploy" },
  });
  if (started.status !== 201) return started;
  const deployId = started.body.deployId;

  const CHUNK = 6 * 1024 * 1024;
  for (const file of files) {
    const bytes = typeof file.data === "string"
      ? new TextEncoder().encode(file.data)
      : file.data;
    if (bytes.length === 0) {
      await fetch(`${BASE}/__api/deploys/${deployId}/file`, {
        method: "PUT",
        headers: {
          "x-hobopages": "1",
          "cookie": cookie,
          "x-file-path": encodeURIComponent(file.path),
          "x-offset": "0",
        },
        body: new Uint8Array(0),
      });
      continue;
    }
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const slice = bytes.slice(offset, Math.min(offset + CHUNK, bytes.length));
      const res = await fetch(`${BASE}/__api/deploys/${deployId}/file`, {
        method: "PUT",
        headers: {
          "x-hobopages": "1",
          "cookie": cookie,
          "x-file-path": encodeURIComponent(file.path),
          "x-offset": String(offset),
        },
        body: slice,
      });
      if (!res.ok) {
        const text = await res.text();
        return { status: res.status, body: text };
      }
      await res.body?.cancel();
    }
  }

  return await api(`/__api/deploys/${deployId}/finalize`, {
    method: "POST",
    json: { unzip: opts.unzip === true },
  });
}

// ---------------------------------------------------------------------------

section("Auth");

{
  const anon = await fetch(`${BASE}/__api/state`, {
    headers: { "x-hobopages": "1" },
  });
  check("state requires auth", anon.status === 401, `got ${anon.status}`);
  await anon.body?.cancel();

  const bad = await api("/__api/login", {
    method: "POST",
    json: { password: "wrong" },
  });
  check("bad password rejected", bad.status === 401, `got ${bad.status}`);
  cookie = "";

  const noHeader = await fetch(`${BASE}/__api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check(
    "CSRF header required",
    noHeader.status === 400,
    `got ${noHeader.status}`,
  );
  await noHeader.body?.cancel();

  const good = await api("/__api/login", {
    method: "POST",
    json: { password: PASSWORD },
  });
  check("login succeeds", good.status === 200, `got ${good.status}`);
  check(
    "session cookie issued",
    cookie.startsWith("hobopages_session="),
    cookie,
  );

  const state = await api("/__api/state");
  check("state readable when signed in", state.status === 200);
  check("state has no sites yet", state.body?.sites?.length === 0);
}

section("Site creation");

{
  const badName = await api("/__api/sites", {
    method: "POST",
    json: { name: "Bad Name!" },
  });
  check(
    "invalid name rejected",
    badName.status === 400,
    `got ${badName.status}`,
  );

  const reserved = await api("/__api/sites", {
    method: "POST",
    json: { name: "__api" },
  });
  check(
    "reserved name rejected",
    reserved.status === 400,
    `got ${reserved.status}`,
  );

  const ok = await api("/__api/sites", {
    method: "POST",
    json: { name: "portfolio" },
  });
  check("site created", ok.status === 201, `got ${ok.status}`);

  const dup = await api("/__api/sites", {
    method: "POST",
    json: { name: "portfolio" },
  });
  check("duplicate rejected", dup.status === 409, `got ${dup.status}`);

  const undeployed = await fetch(`${BASE}/portfolio/`);
  check(
    "undeployed site says so",
    undeployed.status === 404,
    `got ${undeployed.status}`,
  );
  await undeployed.body?.cancel();
}

section("Folder deploy + path rewriting");

const bigFile = new Uint8Array(7 * 1024 * 1024);
crypto.getRandomValues(bigFile.subarray(0, 65536));
for (let i = 65536; i < bigFile.length; i++) bigFile[i] = i & 0xff;

{
  const html = [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="/styles/main.css">',
    "<style>body{background:url(/img/bg.png)}</style>",
    "</head><body>",
    "<h1>Portfolio</h1>",
    '<img src="/img/logo.png" srcset="/img/logo.png 1x, /img/logo@2x.png 2x">',
    '<a href="/about">About</a>',
    '<a href="https://example.com/keep">External</a>',
    '<a href="//cdn.example.com/keep">Protocol relative</a>',
    '<script src="/js/app.js"></script>',
    '<script>const path = "/api/data.json"; console.log("<a href=\\"/nope\\">");</script>',
    "</body></html>",
  ].join("");

  const result = await uploadFiles("portfolio", [
    { path: "dist/index.html", data: html },
    { path: "dist/about.html", data: "<h1>About</h1>" },
    {
      path: "dist/styles/main.css",
      data:
        "body{color:red;background:url(/img/bg.png)}\n@import '/styles/extra.css';",
    },
    { path: "dist/js/app.js", data: 'fetch("/api/data.json");' },
    { path: "dist/img/logo.png", data: "PNGDATA" },
    { path: "dist/api/data.json", data: '{"ok":true}' },
    { path: "dist/big.bin", data: bigFile },
    {
      path: "dist/notes.txt",
      data: "the quick brown fox jumps over the lazy dog. ".repeat(200),
    },
    { path: "dist/empty.txt", data: "" },
    { path: "dist/.DS_Store", data: "junk" },
    { path: "dist/404.html", data: "<h1>Custom missing</h1>" },
  ]);

  check(
    "deploy finalized",
    result.status === 200,
    JSON.stringify(result.body).slice(0, 200),
  );
  check(
    "root hoisted out of dist/",
    (result.body?.warnings ?? []).some((w: string) => w.includes("dist/")),
    JSON.stringify(result.body?.warnings),
  );
  check(
    "junk skipped",
    (result.body?.warnings ?? []).some((w: string) =>
      w.includes("system file")
    ),
  );
  check(
    "file count correct",
    result.body?.release?.fileCount === 10,
    `got ${result.body?.release?.fileCount}`,
  );

  const page = await fetch(`${BASE}/portfolio/`);
  const text = await page.text();
  check("site root serves index", page.status === 200, `got ${page.status}`);
  check(
    "stylesheet href rewritten",
    text.includes('href="/portfolio/styles/main.css"'),
  );
  check("img src rewritten", text.includes('src="/portfolio/img/logo.png"'));
  check("srcset rewritten", text.includes("/portfolio/img/logo@2x.png 2x"));
  check("anchor rewritten", text.includes('href="/portfolio/about"'));
  check(
    "inline style url rewritten",
    text.includes("url(/portfolio/img/bg.png)"),
  );
  check("script src rewritten", text.includes('src="/portfolio/js/app.js"'));
  check(
    "external URL untouched",
    text.includes('href="https://example.com/keep"'),
  );
  check(
    "protocol-relative untouched",
    text.includes('href="//cdn.example.com/keep"'),
  );
  check(
    "script body untouched",
    text.includes('const path = "/api/data.json"'),
  );
  check("html inside script untouched", text.includes('<a href=\\"/nope\\">'));

  const css = await fetch(`${BASE}/portfolio/styles/main.css`);
  const cssText = await css.text();
  check("css url() rewritten", cssText.includes("url(/portfolio/img/bg.png)"));
  check(
    "css @import rewritten",
    cssText.includes("'/portfolio/styles/extra.css'"),
  );
  check(
    "css content type",
    (css.headers.get("content-type") ?? "").startsWith("text/css"),
  );

  const js = await fetch(`${BASE}/portfolio/js/app.js`);
  const jsText = await js.text();
  check(
    "js body untouched",
    jsText.includes('fetch("/api/data.json")'),
    jsText,
  );
}

section("Serving behaviour");

{
  const clean = await fetch(`${BASE}/portfolio/about`);
  check("clean URL resolves", clean.status === 200, `got ${clean.status}`);
  await clean.body?.cancel();

  const missing = await fetch(`${BASE}/portfolio/nope.html`);
  const missingText = await missing.text();
  check(
    "custom 404 used",
    missing.status === 404 && missingText.includes("Custom missing"),
    `got ${missing.status}`,
  );

  const noSlash = await fetch(`${BASE}/portfolio`, { redirect: "manual" });
  check(
    "bare site path redirects",
    noSlash.status === 301,
    `got ${noSlash.status} -> ${noSlash.headers.get("location")}`,
  );
  await noSlash.body?.cancel();

  const empty = await fetch(`${BASE}/portfolio/empty.txt`);
  check(
    "empty file served",
    empty.status === 200 && (await empty.text()) === "",
  );

  // ETag / 304
  const first = await fetch(`${BASE}/portfolio/styles/main.css`);
  const etag = first.headers.get("etag")!;
  await first.body?.cancel();
  const second = await fetch(`${BASE}/portfolio/styles/main.css`, {
    headers: { "if-none-match": etag },
  });
  check(
    "conditional GET returns 304",
    second.status === 304,
    `got ${second.status}`,
  );
  await second.body?.cancel();

  // gzip (only applied above 1KB)
  const gz = await fetch(`${BASE}/portfolio/notes.txt`, {
    headers: { "accept-encoding": "gzip" },
  });
  // Read the wire directly: fetch removes content-encoding when decompressing.
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: PORT });
  let wire = "";
  try {
    const request = new TextEncoder().encode(
      "GET /portfolio/notes.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
    );
    let sent = 0;
    while (sent < request.length) {
      sent += await conn.write(request.subarray(sent));
    }
    const buffer = new Uint8Array(8192);
    const decoder = new TextDecoder();
    while (!wire.includes("\r\n\r\n")) {
      const count = await conn.read(buffer);
      if (count === null) break;
      wire += decoder.decode(buffer.subarray(0, count));
    }
  } finally {
    conn.close();
  }
  check(
    "text compressed",
    /content-encoding: gzip/i.test(wire),
    wire.split("\r\n\r\n")[0],
  );
  const gzBody = await gz.text();
  check(
    "compressed body intact",
    gzBody.length === 45 * 200 && gzBody.startsWith("the quick brown fox"),
    `got ${gzBody.length}`,
  );

  const small = await fetch(`${BASE}/portfolio/styles/main.css`, {
    headers: { "accept-encoding": "gzip" },
  });
  check(
    "small file left uncompressed",
    small.headers.get("content-encoding") === null,
  );
  await small.body?.cancel();

  const noGzip = await fetch(`${BASE}/portfolio/notes.txt`, {
    headers: { "accept-encoding": "identity" },
  });
  check(
    "identity encoding respected",
    noGzip.headers.get("content-encoding") === null,
  );
  check("uncompressed body intact", (await noGzip.text()).length === 45 * 200);

  const binary = await fetch(`${BASE}/portfolio/big.bin`, {
    headers: { "accept-encoding": "gzip" },
  });
  check(
    "binary not compressed",
    binary.headers.get("content-encoding") === null,
  );
  await binary.body?.cancel();

  // range
  const range = await fetch(`${BASE}/portfolio/big.bin`, {
    headers: { range: "bytes=100-199" },
  });
  const rangeBytes = new Uint8Array(await range.arrayBuffer());
  check("range status 206", range.status === 206, `got ${range.status}`);
  check(
    "range length correct",
    rangeBytes.length === 100,
    `got ${rangeBytes.length}`,
  );
  check(
    "range content correct",
    rangeBytes[0] === bigFile[100] && rangeBytes[99] === bigFile[199],
  );
  check(
    "content-range header",
    range.headers.get("content-range") === `bytes 100-199/${bigFile.length}`,
    String(range.headers.get("content-range")),
  );

  const suffix = await fetch(`${BASE}/portfolio/big.bin`, {
    headers: { range: "bytes=-50" },
  });
  const suffixBytes = new Uint8Array(await suffix.arrayBuffer());
  check(
    "suffix range works",
    suffix.status === 206 && suffixBytes.length === 50,
    `${suffix.status}/${suffixBytes.length}`,
  );

  const bad = await fetch(`${BASE}/portfolio/big.bin`, {
    headers: { range: `bytes=${bigFile.length + 10}-` },
  });
  check("unsatisfiable range 416", bad.status === 416, `got ${bad.status}`);
  await bad.body?.cancel();

  // Large file integrity end to end
  const whole = await fetch(`${BASE}/portfolio/big.bin`);
  const wholeBytes = new Uint8Array(await whole.arrayBuffer());
  check(
    "7MB file intact",
    wholeBytes.length === bigFile.length &&
      wholeBytes[0] === bigFile[0] &&
      wholeBytes[6 * 1024 * 1024] === bigFile[6 * 1024 * 1024] &&
      wholeBytes[wholeBytes.length - 1] === bigFile[bigFile.length - 1],
    `got ${wholeBytes.length}`,
  );

  const head = await fetch(`${BASE}/portfolio/styles/main.css`, {
    method: "HEAD",
  });
  check(
    "HEAD works",
    head.status === 200 && head.headers.has("content-length"),
  );
  await head.body?.cancel();
}

section("Path traversal");

{
  for (
    const attempt of [
      "/portfolio/../../../etc/passwd",
      "/portfolio/%2e%2e%2f%2e%2e%2fetc/passwd",
      "/portfolio/..%2F..%2Fetc%2Fpasswd",
      "/portfolio/....//....//etc/passwd",
    ]
  ) {
    const res = await fetch(`${BASE}${attempt}`, { redirect: "manual" });
    const body = await res.text();
    check(
      `traversal blocked: ${attempt}`,
      !body.includes("root:") && res.status !== 200,
      `status ${res.status}`,
    );
  }

  const deployBad = await api("/__api/sites/portfolio/deploys", {
    method: "POST",
    json: { note: "" },
  });
  const evil = await fetch(
    `${BASE}/__api/deploys/${deployBad.body.deployId}/file`,
    {
      method: "PUT",
      headers: {
        "x-hobopages": "1",
        "cookie": cookie,
        "x-file-path": encodeURIComponent("../../../../tmp/pwned.txt"),
        "x-offset": "0",
      },
      body: "pwned",
    },
  );
  check(
    "traversal in upload path rejected",
    evil.status === 400,
    `got ${evil.status}`,
  );
  await evil.body?.cancel();
  await api(`/__api/deploys/${deployBad.body.deployId}`, { method: "DELETE" });
}

section("Referer rescue");

{
  await api("/__api/sites", { method: "POST", json: { name: "raw" } });
  await api("/__api/sites/raw", {
    method: "PATCH",
    json: { rewriteRootPaths: false },
  });

  await uploadFiles("raw", [
    { path: "index.html", data: '<script src="/assets/app.js"></script>' },
    { path: "assets/app.js", data: "console.log('rescued');" },
  ]);

  const direct = await fetch(`${BASE}/raw/`);
  const directText = await direct.text();
  check(
    "rewriting off leaves link alone",
    directText.includes('src="/assets/app.js"'),
    directText,
  );

  const rescued = await fetch(`${BASE}/assets/app.js`, {
    headers: { referer: `${BASE}/raw/` },
  });
  const rescuedText = await rescued.text();
  check(
    "root-absolute asset rescued",
    rescued.status === 200 && rescuedText.includes("rescued"),
    `got ${rescued.status}`,
  );

  const noReferer = await fetch(`${BASE}/assets/app.js`);
  check(
    "no rescue without referer",
    noReferer.status === 404,
    `got ${noReferer.status}`,
  );
  await noReferer.body?.cancel();

  await api("/__api/sites/raw", {
    method: "PATCH",
    json: { refererRescue: false },
  });
  const disabled = await fetch(`${BASE}/assets/app.js`, {
    headers: { referer: `${BASE}/raw/` },
  });
  check(
    "rescue respects the toggle",
    disabled.status === 404,
    `got ${disabled.status}`,
  );
  await disabled.body?.cancel();
}

section("SPA fallback");

{
  await api("/__api/sites", { method: "POST", json: { name: "app" } });
  await uploadFiles("app", [
    { path: "index.html", data: "<div id=root>SPA</div>" },
  ]);

  const before = await fetch(`${BASE}/app/deep/route`);
  check(
    "no fallback by default",
    before.status === 404,
    `got ${before.status}`,
  );
  await before.body?.cancel();

  await api("/__api/sites/app", {
    method: "PATCH",
    json: { spaFallback: true },
  });
  const after = await fetch(`${BASE}/app/deep/route`);
  const afterText = await after.text();
  check(
    "SPA fallback serves index",
    after.status === 200 && afterText.includes("SPA"),
    `got ${after.status}`,
  );
}

section("ZIP deploy");

{
  await api("/__api/sites", { method: "POST", json: { name: "zipped" } });

  const zipDir = await Deno.makeTempDir();
  await Deno.mkdir(`${zipDir}/build/css`, { recursive: true });
  await Deno.writeTextFile(
    `${zipDir}/build/index.html`,
    '<link href="/css/x.css" rel="stylesheet">Zip site',
  );
  await Deno.writeTextFile(`${zipDir}/build/css/x.css`, "body{margin:0}");
  await Deno.writeTextFile(
    `${zipDir}/build/big.txt`,
    "padding ".repeat(200000),
  );
  const zipCmd = new Deno.Command("zip", {
    args: ["-q", "-r", `${zipDir}/site.zip`, "build"],
    cwd: zipDir,
  });
  const zipOut = await zipCmd.output();
  check("zip fixture built", zipOut.success);

  const zipBytes = await Deno.readFile(`${zipDir}/site.zip`);
  const result = await uploadFiles("zipped", [
    { path: "__hobopages_upload.zip", data: zipBytes },
  ], { unzip: true });

  check(
    "zip deploy finalized",
    result.status === 200,
    JSON.stringify(result.body).slice(0, 200),
  );
  check("zip source recorded", result.body?.release?.source === "zip");

  const page = await fetch(`${BASE}/zipped/`);
  const text = await page.text();
  check(
    "zip site serves",
    page.status === 200 && text.includes("Zip site"),
    `got ${page.status}`,
  );
  check("zip site rewritten", text.includes('href="/zipped/css/x.css"'), text);

  const big = await fetch(`${BASE}/zipped/big.txt`);
  const bigText = await big.text();
  check(
    "deflated file intact",
    bigText.length === 8 * 200000,
    `got ${bigText.length}`,
  );

  const notZip = await uploadFiles("zipped", [
    { path: "__hobopages_upload.zip", data: "this is not a zip file at all" },
  ], { unzip: true });
  check(
    "bad zip rejected cleanly",
    notZip.status === 400,
    `got ${notZip.status}`,
  );

  await Deno.remove(zipDir, { recursive: true });
}

section("Releases, rollback, retention");

{
  for (let i = 2; i <= 5; i++) {
    await uploadFiles("app", [{
      path: "index.html",
      data: `<div>version ${i}</div>`,
    }]);
  }

  const state = await api("/__api/state");
  const site = state.body.sites.find((s: any) => s.name === "app");
  check(
    "retention capped at 3",
    site.releases.length === 3,
    `got ${site.releases.length}`,
  );

  const live = await fetch(`${BASE}/app/`);
  check("latest release live", (await live.text()).includes("version 5"));

  const older = site.releases[1].id;
  const rollback = await api("/__api/sites/app/rollback", {
    method: "POST",
    json: { releaseId: older },
  });
  check("rollback accepted", rollback.status === 200, `got ${rollback.status}`);

  const rolled = await fetch(`${BASE}/app/`);
  check(
    "rollback serves older release",
    (await rolled.text()).includes("version 4"),
  );

  const deleteLive = await api(`/__api/sites/app/releases/${older}`, {
    method: "DELETE",
  });
  check(
    "cannot delete live release",
    deleteLive.status === 409,
    `got ${deleteLive.status}`,
  );

  const other = site.releases[0].id;
  const deleteOther = await api(`/__api/sites/app/releases/${other}`, {
    method: "DELETE",
  });
  check(
    "can delete non-live release",
    deleteOther.status === 200,
    `got ${deleteOther.status}`,
  );
}

section("Visitor password + disable");

{
  await api("/__api/sites/zipped", {
    method: "PATCH",
    json: { password: "letmein" },
  });

  const locked = await fetch(`${BASE}/zipped/`);
  check(
    "password challenge issued",
    locked.status === 401,
    `got ${locked.status}`,
  );
  check(
    "basic auth header present",
    (locked.headers.get("www-authenticate") ?? "").startsWith("Basic"),
  );
  await locked.body?.cancel();

  const wrong = await fetch(`${BASE}/zipped/`, {
    headers: { authorization: "Basic " + btoa("x:nope") },
  });
  check("wrong password rejected", wrong.status === 401, `got ${wrong.status}`);
  await wrong.body?.cancel();

  const right = await fetch(`${BASE}/zipped/`, {
    headers: { authorization: "Basic " + btoa("x:letmein") },
  });
  check("right password admitted", right.status === 200, `got ${right.status}`);
  await right.body?.cancel();

  const shortPw = await api("/__api/sites/zipped", {
    method: "PATCH",
    json: { password: "ab" },
  });
  check(
    "short password rejected",
    shortPw.status === 400,
    `got ${shortPw.status}`,
  );

  await api("/__api/sites/zipped", {
    method: "PATCH",
    json: { password: null },
  });
  const open = await fetch(`${BASE}/zipped/`);
  check("password removed", open.status === 200, `got ${open.status}`);
  await open.body?.cancel();

  await api("/__api/sites/zipped", {
    method: "PATCH",
    json: { enabled: false },
  });
  const off = await fetch(`${BASE}/zipped/`);
  check("disabled site returns 503", off.status === 503, `got ${off.status}`);
  await off.body?.cancel();
  await api("/__api/sites/zipped", {
    method: "PATCH",
    json: { enabled: true },
  });
}

section("Persistence across restart");

{
  const before = await api("/__api/state");
  const namesBefore = before.body.sites.map((s: any) => s.name).sort().join(
    ",",
  );

  await server.shutdown();
  const app2 = new HoboPages(loadConfig());
  await app2.init();
  const server2 = app2.serve();

  const after = await api("/__api/state");
  const namesAfter = after.body.sites.map((s: any) => s.name).sort().join(",");
  check(
    "sites survive restart",
    namesBefore === namesAfter,
    `${namesBefore} vs ${namesAfter}`,
  );

  const stillServing = await fetch(`${BASE}/portfolio/`);
  check(
    "content survives restart",
    stillServing.status === 200,
    `got ${stillServing.status}`,
  );
  await stillServing.body?.cancel();

  await server2.shutdown();
}

section("Site deletion");

{
  const app3 = new HoboPages(loadConfig());
  await app3.init();
  const server3 = app3.serve();

  const del = await api("/__api/sites/raw", { method: "DELETE" });
  check("site deleted", del.status === 200, `got ${del.status}`);

  const gone = await fetch(`${BASE}/raw/`);
  check("deleted site 404s", gone.status === 404, `got ${gone.status}`);
  await gone.body?.cancel();

  let dirGone = false;
  try {
    await Deno.stat(`${dataDir}/sites/raw`);
  } catch {
    dirGone = true;
  }
  check("release files removed from disk", dirGone);

  await server3.shutdown();
}

// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(52)}`);
console.log(`PASSED: ${passed}   FAILED: ${failed}`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
await Deno.remove(dataDir, { recursive: true }).catch(() => {});
Deno.exit(failed === 0 ? 0 : 1);
