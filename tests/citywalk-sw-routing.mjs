/**
 * Root service worker must not answer nested citywalk/final navigations
 * with the legacy Gotanda shell.
 *
 * Covers:
 * - clean client (no worker): network HTML is the citywalk page
 * - worker installed from the current service-worker.js
 * - upgrade from the pre-fix worker in tests/fixtures (old installed SW)
 *
 * Run from the repo root: node tests/citywalk-sw-routing.mjs
 * Requires Google Chrome and tests/node_modules (npm install --prefix tests).
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "/tokyo-trip";
const FIXTURE = path.join(ROOT, "tests/fixtures/legacy-root-service-worker.js");
const CURRENT_SW = path.join(ROOT, "service-worker.js");
const CHROME = process.env.CHROME_PATH || "/usr/local/bin/google-chrome";
const SHOTS = process.env.SCREENSHOT_DIR || "";

const SWALLOW = 'if(req.mode==="navigate"||u.href===IDX||u.href===BASE.href){e.respondWith(swrIndex(e));return}';

const failures = [];
function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("  ok", msg);
}
async function section(name, fn) {
  try {
    console.log("\n==", name);
    await fn();
    console.log("PASS", name);
  } catch (err) {
    console.error("FAIL", name, err && err.stack || err);
    failures.push(name + ": " + (err && err.message));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function staticContent() {
  const legacy = fs.readFileSync(FIXTURE, "utf8");
  check(legacy.includes(SWALLOW), "fixture still has the pre-fix navigation swallow");
  check(!legacy.includes("isShellDocument"), "fixture is not the repaired worker");

  const sat = read("citywalk/sat/index.html");
  const sun = read("citywalk/sun/index.html");
  const finalHtml = read("final/index.html");
  const finalSw = read("final/service-worker.js");
  const rootHtml = read("index.html");
  for (const s of ["PREMIER MAI", "代代木", "NANGA", "三喜", "ものとアート", "GR8", "BEAMS", "BATONER", "YOKE", "1LDK", "川上庵", "14:00", "COMOLI", "AURALEE", "新井屋", "18:00", "mont-bell", "ロフト"]) {
    check(sat.includes(s), "saturday citywalk contains " + s);
  }
  check(!sat.includes("SHIBUYA SKY") && !sat.includes("Blue Bottle"), "saturday citywalk has no SKY or Blue Bottle");
  for (const s of ["1LDK", "13:20", "COVERCHORD", "14:00", "14:18", "Jieda"]) {
    check(sun.includes(s), "sunday citywalk contains " + s);
  }
  for (const s of ["浜松町", "纸票 ¥520", "IC ¥519", "建议 17:15 出发", "18:00–18:20", "不晚于 19:30", 'VER="d12rev-20261117a"', "tkfinal-"]) {
    const hay = s.startsWith("VER=") || s === "tkfinal-" ? finalSw : finalHtml;
    check(hay.includes(s), "final guide keeps " + s);
  }
  check(finalSw.includes('if(req.mode==="navigate"||u.href===IDX||u.href===BASE){e.respondWith(swrIndex(e));return}'), "final worker still shells its own scope");
  check(rootHtml.includes("三井ガーデンホテル五反田") && rootHtml.includes("SHIBUYA SKY"), "legacy root guide content kept");
  check(!rootHtml.includes("citywalk"), "root guide was not rewritten into the citywalk");
}

let swMode = "current";
let imgFetches = 0;
function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(u.pathname);
    if (pathname.includes("/img/")) imgFetches++;
    if (pathname === PREFIX + "/service-worker.js") {
      const body = fs.readFileSync(swMode === "legacy" ? FIXTURE : CURRENT_SW);
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404");
      return;
    }
    let rel = pathname.slice(PREFIX.length);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403).end("403");
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>404</title><h1>NOT FOUND</h1>");
      return;
    }
    const ext = path.extname(file);
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "application/javascript; charset=utf-8"
      : ext === ".json" ? "application/json"
      : ext === ".webp" ? "image/webp"
      : ext === ".png" ? "image/png"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}${PREFIX}`;
      resolve({ server, origin });
    });
  });
}

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    userDataDir: path.join("/tmp", "tokyo-sw-" + Math.random().toString(16).slice(2)),
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

async function bodyText(page) {
  return page.evaluate(() => document.body ? document.body.innerText : "");
}

async function waitText(page, needle, timeout) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeout) {
    try {
      const title = await page.title();
      const text = await bodyText(page);
      last = title + " | " + text.slice(0, 160).replace(/\s+/g, " ");
      if (title.includes(needle) || text.includes(needle)) return { title, text };
    } catch (_) { /* navigation replaced the document */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timed out waiting for " + JSON.stringify(needle) + " last=" + last);
}

function notLegacy(title, text, where) {
  check(!title.includes("东京 3 天 2 晚"), where + " title is not the legacy shell: " + title);
  check(!text.includes("三井ガーデンホテル五反田"), where + " body is not the Gotanda guide");
  check(!text.includes("SHIBUYA SKY"), where + " does not show SHIBUYA SKY");
}

async function installRoot(page, origin) {
  const resp = await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  check(resp && resp.ok(), "root document loaded");
  await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.endsWith("/service-worker.js"), { timeout: 30000 });
  const info = await page.evaluate(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    return {
      title: document.title,
      scope: rs.map((r) => r.scope),
      script: navigator.serviceWorker.controller.scriptURL,
    };
  });
  check(info.title.includes("东京 3 天 2 晚"), "root guide still renders under its own URL");
  check(info.scope.some((s) => s.endsWith("/tokyo-trip/")), "root worker scope is the site root: " + info.scope.join(","));
  return info;
}

async function expectSaturday(page, where) {
  const got = await waitText(page, "PREMIER MAI", 40000);
  check(got.title.includes("瘦身主线"), where + " title: " + got.title);
  notLegacy(got.title, got.text, where);
  for (const s of ["PREMIER MAI", "NANGA", "三喜", "ものとアート", "川上庵", "AURALEE", "新井屋", "mont-bell"]) {
    check(got.text.includes(s), where + " shows " + s);
  }
  check(!got.text.includes("Blue Bottle"), where + " has no Blue Bottle morning");
  return got;
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

await section("static content untouched", async () => { staticContent(); });

const { server, origin } = await startServer();
console.log("origin", origin);

await section("clean client serves citywalk HTML", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const sat = await page.goto(origin + "/citywalk/sat/", { waitUntil: "domcontentloaded", timeout: 30000 });
    check(sat && sat.status() === 200, "sat status " + (sat && sat.status()));
    check(sat && sat.fromServiceWorker() === false, "clean sat is not from a service worker");
    await expectSaturday(page, "clean sat");
    const sun = await page.goto(origin + "/citywalk/sun/", { waitUntil: "domcontentloaded", timeout: 30000 });
    check(sun && sun.fromServiceWorker() === false, "clean sun is not from a service worker");
    const sunGot = await waitText(page, "COVERCHORD", 10000);
    check(sunGot.text.includes("13:20") && sunGot.text.includes("14:18"), "clean sun has COVERCHORD times");
    notLegacy(sunGot.title, sunGot.text, "clean sun");
    const fri = await page.goto(origin + "/citywalk/fri/", { waitUntil: "domcontentloaded", timeout: 15000 });
    check(fri && fri.status() === 404, "clean fri is a real 404, status " + (fri && fri.status()));
    check(!(await bodyText(page)).includes("三井ガーデンホテル五反田"), "clean fri is not the legacy guide");
  } finally {
    await browser.close();
  }
});

await section("current root worker does not swallow nested URLs", async () => {
  swMode = "current";
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await installRoot(page, origin);
    const sat = await page.goto(origin + "/citywalk/sat/", { waitUntil: "domcontentloaded", timeout: 30000 });
    check(sat && sat.fromServiceWorker() === false, "sat navigation was not rewritten by the root worker");
    await expectSaturday(page, "controlled sat");
    const queried = await page.goto(origin + "/citywalk/sat/?from=final", { waitUntil: "domcontentloaded", timeout: 30000 });
    check(queried && queried.fromServiceWorker() === false, "query string is not required to escape the shell");
    await expectSaturday(page, "queried sat");
    await page.goto(origin + "/citywalk/sun/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const sunGot = await waitText(page, "COVERCHORD", 10000);
    check(sunGot.text.includes("1LDK") && sunGot.text.includes("14:00"), "controlled sun keeps 1LDK and COVERCHORD");
    notLegacy(sunGot.title, sunGot.text, "controlled sun");
    const fri = await page.goto(origin + "/citywalk/fri/", { waitUntil: "domcontentloaded", timeout: 15000 });
    check(fri && fri.status() === 404 && fri.fromServiceWorker() === false, "fri under the root worker stays a network 404");
    check(!(await page.title()).includes("东京 3 天 2 晚"), "fri was not replaced by the legacy shell");

    await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    check((await page.title()).includes("东京 3 天 2 晚"), "shell URL still opens the legacy guide");
    await page.goto(origin + "/?src=citywalk", { waitUntil: "domcontentloaded", timeout: 30000 });
    check((await page.title()).includes("东京 3 天 2 晚"), "a query on the shell URL does not leave the legacy guide");

    await page.goto(origin + "/final/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const finalGot = await waitText(page, "d12rev-20261117a", 20000);
    notLegacy(finalGot.title, finalGot.text, "final");
    check(finalGot.text.includes("浜松町") && finalGot.text.includes("¥520") && finalGot.text.includes("¥519"), "final keeps monorail fare");
    await page.evaluate(() => setDay(2));
    const sunFinal = await waitText(page, "建议 17:15 出发", 10000);
    check(sunFinal.text.includes("18:00–18:20") && sunFinal.text.includes("19:30"), "final Sunday keeps departure 17:15, counter 18:00–18:20, Air China 19:30");
    await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.includes("/final/service-worker.js"), { timeout: 30000 });
    await page.evaluate(() => setDay(1));
    await page.waitForSelector("a[href*='citywalk/sat']", { timeout: 10000 });
    const satHref = await page.$eval("a[href*='citywalk/sat']", (a) => a.getAttribute("href"));
    check(satHref.includes("../citywalk/sat"), "final Saturday chip href " + satHref);
    await page.evaluate(() => setDay(2));
    await page.waitForSelector("a[href*='citywalk/sun']", { timeout: 10000 });
    const sunHref = await page.$eval("a[href*='citywalk/sun']", (a) => a.getAttribute("href"));
    check(sunHref.includes("../citywalk/sun"), "final Sunday chip href " + sunHref);
    await page.evaluate(() => setDay(1));
    await page.waitForSelector("a[href*='citywalk/sat']", { timeout: 10000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.click("a[href*='citywalk/sat']"),
    ]);
    check(page.url().includes("/citywalk/sat"), "final chip navigates to " + page.url());
    await expectSaturday(page, "link from final");

    await page.goto(origin + "/final/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.includes("/final/service-worker.js"), { timeout: 20000 });
    await page.setOfflineMode(true);
    const offFinal = await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    check(offFinal && offFinal.fromServiceWorker() === true, "offline final is served by its worker");
    check((await bodyText(page)).includes("d12rev-20261117a"), "offline final content survives");
    await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    check((await page.title()).includes("东京 3 天 2 晚"), "offline root shell still opens");
    let nestedOffline = "loaded";
    try {
      await page.goto(origin + "/citywalk/sat/", { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (err) {
      nestedOffline = String(err.message || err);
    }
    if (page.url().includes("/citywalk/")) {
      const offTitle = await page.title().catch(() => "");
      check(!offTitle.includes("东京 3 天 2 晚"), "offline citywalk URL rendered the legacy shell (" + offTitle + ")");
    } else {
      check(true, "offline citywalk was not replaced by the legacy shell (" + nestedOffline + ")");
    }
    await page.setOfflineMode(false);
  } finally {
    await browser.close();
  }
});

await section("old installed root worker upgrades and releases citywalk", async () => {
  swMode = "legacy";
  imgFetches = 0;
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await installRoot(page, origin);
    const poisoned = await page.goto(origin + "/citywalk/sat/", { waitUntil: "domcontentloaded", timeout: 30000 });
    check(poisoned && poisoned.fromServiceWorker() === true, "pre-fix worker served the citywalk navigation");
    check((await page.title()).includes("东京 3 天 2 晚"), "pre-fix worker shows the legacy shell at the citywalk URL");
    imgFetches = 0;
    swMode = "current";
    await page.goto(origin + "/citywalk/sun/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const sunGot = await waitText(page, "COVERCHORD", 40000);
    notLegacy(sunGot.title, sunGot.text, "upgraded sun");
    check(sunGot.text.includes("14:18"), "upgraded sun shows COVERCHORD 14:18");
    check(imgFetches < 30, "upgrade did not re-download the legacy image precache (" + imgFetches + " img requests)");
    await page.goto(origin + "/citywalk/sat/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const satGot = await expectSaturday(page, "upgraded sat");
    check(page.url().includes("/citywalk/sat"), "URL stays on citywalk/sat");
    check(satGot.text.includes("GR8") && satGot.text.includes("ロフト"), "upgraded sat shows GR8 and Loft");
    await page.setViewport({ width: 1280, height: 800 });
    await shot(page, "citywalk-sat-desktop");
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await shot(page, "citywalk-sat-mobile");
    await page.goto(origin + "/citywalk/sun/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitText(page, "COVERCHORD", 10000);
    await shot(page, "citywalk-sun-mobile");
    await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: false });
    await shot(page, "citywalk-sun-desktop");
  } finally {
    await browser.close();
  }
});

await new Promise((resolve) => server.close(resolve));
if (failures.length) {
  console.error("\n" + failures.length + " failed\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nall passed");
