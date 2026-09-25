// Tests for release retention and disk-space guards. Run: deno run -A test-retention.ts

const PORT = 8933;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "retention-test-password";
const dataDir = await Deno.makeTempDir({ prefix: "hobopages_ret_" });

Deno.env.set("HOBOPAGES_DATA_DIR", dataDir);
Deno.env.set("HOBOPAGES_PORT", String(PORT));
Deno.env.set("HOBOPAGES_HOST", "127.0.0.1");
Deno.env.set("HOBOPAGES_ADMIN_PASSWORD", PASSWORD);
Deno.env.set("HOBOPAGES_BASE_URL", BASE);
Deno.env.set("HOBOPAGES_COOKIE_SECURE", "false");
// Deliberately not setting HOBOPAGES_MAX_RELEASES: the built-in default of 2
// is what we want to verify.
Deno.env.delete("HOBOPAGES_MAX_RELEASES");

const { HoboPages } = await import("./sources/server.ts");
const { loadConfig, clampReleases } = await import("./sources/core.ts");
const { directorySize, formatBytes } = await import("./sources/disk.ts");

const config = loadConfig();
const app = new HoboPages(config);
await app.init();
let server = app.serve();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) passed++;
  else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

let cookie = "";

async function api(path: string, init: any = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-hobopages", "1");
  if (cookie) headers.set("cookie", cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers, body });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function deploy(site: string, content: string, sizePadding = 0) {
  const payload = content + "x".repeat(sizePadding);
  const started = await api(`/__api/sites/${site}/deploys`, {
    method: "POST",
    json: { note: "", totalBytes: payload.length },
  });
  if (started.status !== 201) return started;
  const id = started.body.deployId;
  const res = await fetch(`${BASE}/__api/deploys/${id}/file`, {
    method: "PUT",
    headers: {
      "x-hobopages": "1",
      cookie,
      "x-file-path": "index.html",
      "x-offset": "0",
    },
    body: payload,
  });
  await res.body?.cancel();
  return await api(`/__api/deploys/${id}/finalize`, {
    method: "POST",
    json: { unzip: false },
  });
}

async function releasesOf(site: string) {
  const state = await api("/__api/state");
  return state.body.sites.find((s: any) => s.name === site);
}

function releaseDirCount(site: string): number {
  try {
    return [...Deno.readDirSync(`${dataDir}/sites/${site}/releases`)]
      .filter((e) => e.isDirectory).length;
  } catch {
    return 0;
  }
}

await api("/__api/login", { method: "POST", json: { password: PASSWORD } });

section("Default is two releases");

{
  check(
    "config default is 2",
    config.defaultMaxReleases === 2,
    `got ${config.defaultMaxReleases}`,
  );

  await api("/__api/sites", { method: "POST", json: { name: "blog" } });
  const fresh = await releasesOf("blog");
  check(
    "new site defaults to keeping 2",
    fresh.maxReleases === 2,
    `got ${fresh.maxReleases}`,
  );

  for (let i = 1; i <= 5; i++) {
    await deploy("blog", `<h1>build ${i}</h1>`);
  }

  const site = await releasesOf("blog");
  check(
    "only 2 releases in metadata",
    site.releases.length === 2,
    `got ${site.releases.length}`,
  );
  check(
    "only 2 release dirs on disk",
    releaseDirCount("blog") === 2,
    `got ${releaseDirCount("blog")}`,
  );

  const live = await fetch(`${BASE}/blog/`);
  check("newest build is live", (await live.text()).includes("build 5"));

  // The previous build must still be rollback-able.
  const previous = site.releases[1].id;
  const rb = await api("/__api/sites/blog/rollback", {
    method: "POST",
    json: { releaseId: previous },
  });
  check("rollback to previous works", rb.status === 200, `got ${rb.status}`);
  const rolled = await fetch(`${BASE}/blog/`);
  check(
    "previous build serves after rollback",
    (await rolled.text()).includes("build 4"),
  );

  // Roll forward again for later tests.
  await api("/__api/sites/blog/rollback", {
    method: "POST",
    json: { releaseId: site.releases[0].id },
  });
}

section("Changing the limit");

{
  const lower = await api("/__api/sites/blog", {
    method: "PATCH",
    json: { maxReleases: 1 },
  });
  check("limit lowered to 1", lower.status === 200, `got ${lower.status}`);
  check(
    "patch reports what it pruned",
    lower.body.pruned === 1,
    `got ${lower.body.pruned}`,
  );
  check(
    "disk cleaned immediately",
    releaseDirCount("blog") === 1,
    `got ${releaseDirCount("blog")}`,
  );

  const site = await releasesOf("blog");
  check(
    "only the live release remains",
    site.releases.length === 1 && site.releases[0].id === site.currentRelease,
  );

  const stillServing = await fetch(`${BASE}/blog/`);
  check(
    "site still serves on 1",
    stillServing.status === 200,
    `got ${stillServing.status}`,
  );
  await stillServing.body?.cancel();

  // Raising the limit should not resurrect anything, but should retain going forward.
  await api("/__api/sites/blog", { method: "PATCH", json: { maxReleases: 3 } });
  await deploy("blog", "<h1>build 6</h1>");
  await deploy("blog", "<h1>build 7</h1>");
  check(
    "retains up to the new limit",
    releaseDirCount("blog") === 3,
    `got ${releaseDirCount("blog")}`,
  );

  const clamped = await api("/__api/sites/blog", {
    method: "PATCH",
    json: { maxReleases: 9999 },
  });
  check(
    "absurd limit clamped",
    clamped.body.site.maxReleases === 20,
    `got ${clamped.body.site.maxReleases}`,
  );

  const zero = await api("/__api/sites/blog", {
    method: "PATCH",
    json: { maxReleases: 0 },
  });
  check(
    "zero clamped up to 1",
    zero.body.site.maxReleases === 1,
    `got ${zero.body.site.maxReleases}`,
  );

  const nan = await api("/__api/sites/blog", {
    method: "PATCH",
    json: { maxReleases: "lots" },
  });
  check("non-numeric limit rejected", nan.status === 400, `got ${nan.status}`);

  check("clampReleases(0)==1", clampReleases(0) === 1);
  check("clampReleases(2.7)==2", clampReleases(2.7) === 2);
  check("clampReleases(NaN)==2", clampReleases(NaN) === 2);
  check("clampReleases(-5)==1", clampReleases(-5) === 1);
}

section("Per-site independence");

{
  await api("/__api/sites", { method: "POST", json: { name: "archive" } });
  await api("/__api/sites/archive", {
    method: "PATCH",
    json: { maxReleases: 5 },
  });
  for (let i = 1; i <= 6; i++) await deploy("archive", `arc ${i}`);
  for (let i = 1; i <= 6; i++) await deploy("blog", `blg ${i}`);

  check(
    "archive keeps 5",
    releaseDirCount("archive") === 5,
    `got ${releaseDirCount("archive")}`,
  );
  check(
    "blog still keeps 1",
    releaseDirCount("blog") === 1,
    `got ${releaseDirCount("blog")}`,
  );
}

section("Storage reporting");

{
  const site = await releasesOf("archive");
  check(
    "totalBytes reported",
    typeof site.totalBytes === "number" && site.totalBytes > 0,
    `got ${site.totalBytes}`,
  );
  check(
    "totalBytes covers all releases",
    site.totalBytes >= site.bytes,
    `${site.totalBytes} vs ${site.bytes}`,
  );

  const state = await api("/__api/state");
  check("disk info present", state.body.disk !== undefined);
  check("disk info known here", state.body.disk.known === true);
  check("disk reports free space", state.body.disk.availableBytes > 0);
  check("disk reports app usage", state.body.disk.usedByAppBytes > 0);
  check("reserve exposed", state.body.diskReserveBytes > 0);

  const measured = await directorySize(`${dataDir}/sites`);
  check(
    "usedByApp roughly matches a walk of the data dir",
    state.body.disk.usedByAppBytes >= measured,
    `${state.body.disk.usedByAppBytes} vs ${measured}`,
  );
}

section("Disk guard");

{
  await server.shutdown();
  // Reserve more than the machine could possibly have free.
  Deno.env.set("HOBOPAGES_DISK_RESERVE_BYTES", String(900 * 1024 ** 4));
  const guarded = new HoboPages(loadConfig());
  await guarded.init();
  server = guarded.serve();

  const refused = await api("/__api/sites/blog/deploys", {
    method: "POST",
    json: { note: "", totalBytes: 1024 },
  });
  check(
    "deploy refused when space is short",
    refused.status === 507,
    `got ${refused.status}`,
  );
  check(
    "refusal explains itself",
    typeof refused.body?.error === "string" &&
      refused.body.error.includes("disk space"),
    String(refused.body?.error).slice(0, 80),
  );

  const existing = await fetch(`${BASE}/blog/`);
  check(
    "existing sites still served while full",
    existing.status === 200,
    `got ${existing.status}`,
  );
  await existing.body?.cancel();

  // A deploy that does not declare its size is still stopped mid-upload.
  const undeclared = await api("/__api/sites/blog/deploys", {
    method: "POST",
    json: { note: "" },
  });
  check(
    "undeclared deploy may start",
    undeclared.status === 201,
    `got ${undeclared.status}`,
  );
  if (undeclared.status === 201) {
    const id = undeclared.body.deployId;
    // First chunk passes (guard is throttled), then wait past the throttle.
    const first = await fetch(`${BASE}/__api/deploys/${id}/file`, {
      method: "PUT",
      headers: {
        "x-hobopages": "1",
        cookie,
        "x-file-path": "a.txt",
        "x-offset": "0",
      },
      body: "hello",
    });
    await first.body?.cancel();
    await new Promise((r) => setTimeout(r, 4200));
    const second = await fetch(`${BASE}/__api/deploys/${id}/file`, {
      method: "PUT",
      headers: {
        "x-hobopages": "1",
        cookie,
        "x-file-path": "b.txt",
        "x-offset": "0",
      },
      body: "world",
    });
    check(
      "mid-upload guard stops it",
      second.status === 507,
      `got ${second.status}`,
    );
    await second.body?.cancel();
    await api(`/__api/deploys/${id}`, { method: "DELETE" });
  }

  await server.shutdown();
  Deno.env.delete("HOBOPAGES_DISK_RESERVE_BYTES");
  const normal = new HoboPages(loadConfig());
  await normal.init();
  server = normal.serve();

  const ok = await deploy("blog", "<h1>after recovery</h1>");
  check(
    "deploys resume once there is room",
    ok.status === 200,
    `got ${ok.status}`,
  );
  const back = await fetch(`${BASE}/blog/`);
  check(
    "recovered deploy serves",
    (await back.text()).includes("after recovery"),
  );
}

section("Upgrade migration");

{
  // Simulate a store written by 1.0.x, where sites had no maxReleases field.
  await server.shutdown();
  const raw = JSON.parse(await Deno.readTextFile(`${dataDir}/sites.json`));
  for (const name of Object.keys(raw.sites)) delete raw.sites[name].maxReleases;
  await Deno.writeTextFile(
    `${dataDir}/sites.json`,
    JSON.stringify(raw, null, 2),
  );

  const migrated = new HoboPages(loadConfig());
  await migrated.init();
  server = migrated.serve();

  const state = await api("/__api/state");
  const allTwo = state.body.sites.every((s: any) => s.maxReleases === 2);
  check(
    "sites from an older version migrate to 2",
    allTwo,
    JSON.stringify(state.body.sites.map((s: any) => [s.name, s.maxReleases])),
  );

  const serving = await fetch(`${BASE}/blog/`);
  check(
    "migrated sites still serve",
    serving.status === 200,
    `got ${serving.status}`,
  );
  await serving.body?.cancel();
}

console.log(`\n${"=".repeat(52)}`);
console.log(`PASSED: ${passed}   FAILED: ${failed}`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`\n(data dir used ${formatBytes(await directorySize(dataDir))})`);

await server.shutdown();
await Deno.remove(dataDir, { recursive: true }).catch(() => {});
Deno.exit(failed === 0 ? 0 : 1);
