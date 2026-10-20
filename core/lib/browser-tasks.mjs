import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { Browser, Tab, sleep } from "./webchat/engine.mjs";
import { resolveTool, capture } from "./toolkit.mjs";

const inside = (root, target) => { const rel = path.relative(root, target); return rel === "" || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
export function staticHandler(directory) {
  const root = fs.realpathSync(directory);
  return (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const decoded = decodeURIComponent(request.url.split("?")[0]).replaceAll("\\", "/");
      if (decoded.includes("\0") || decoded.split("/").includes("..")) throw new Error("traversal");
      let file = path.resolve(root, "." + decoded);
      if (!inside(root, file)) throw new Error("traversal");
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      file = fs.realpathSync(file);
      if (!inside(root, file) || !fs.statSync(file).isFile()) throw new Error("outside folder");
      const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".wasm": "application/wasm" };
      response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : fs.readFileSync(file));
    } catch { response.writeHead(404); response.end("Not found"); }
  };
}
export async function staticServer(directory) {
  const server = http.createServer(staticHandler(directory));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }) };
}
function validUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error("url must be HTTP(S)"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("url must be HTTP(S) without credentials");
  return url;
}
export function validateShot(opts) {
  if ((opts.url !== undefined) === (opts.dir !== undefined)) throw new Error("provide exactly one of url or dir");
  if (opts.url !== undefined) validUrl(opts.url);
  if (opts.dir !== undefined && (!path.isAbsolute(opts.dir) || !fs.statSync(opts.dir).isDirectory())) throw new Error("dir must be an absolute folder");
  if (opts.widths !== undefined && (!Array.isArray(opts.widths) || !opts.widths.length || opts.widths.length > 20 || opts.widths.some(n => !Number.isInteger(n) || n < 1 || n > 7680))) throw new Error("invalid widths");
  if (opts.waitMs !== undefined && (!Number.isFinite(opts.waitMs) || opts.waitMs < 0 || opts.waitMs > 120_000)) throw new Error("waitMs must be 0..120000");
  if (opts.waitFor !== undefined && (typeof opts.waitFor !== "string" || !opts.waitFor.trim())) throw new Error("waitFor must be a CSS selector");
  if (opts.fullPage !== undefined && typeof opts.fullPage !== "boolean") throw new Error("fullPage must be boolean");
}
export function validateDeploy(opts) {
  const url = validUrl(opts.url);
  if (typeof opts.path !== "string" || !opts.path.startsWith("/") || new URL(opts.path, url).origin !== url.origin) throw new Error("path must be on the same site");
  if (typeof opts.marker !== "string" || !opts.marker) throw new Error("marker must be non-empty");
  for (const [key, value] of [["timeoutMin", opts.timeoutMin ?? 75], ["intervalSec", opts.intervalSec ?? 60]]) if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be positive`);
  if ((opts.repo !== undefined) !== (opts.sha !== undefined)) throw new Error("repo and sha must be supplied together");
  if (opts.repo !== undefined && (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo) || !/^[a-f0-9]{7,64}$/i.test(opts.sha))) throw new Error("repo must be owner/repo and sha must be a commit SHA");
}
export async function withFreshBrowser(directory, action, { env = process.env, launch = Browser.launch, chrome = resolveTool("chrome", { env }), tempRoot = os.tmpdir(), remove = fs.promises.rm, sleep: pause = sleep, note = text => console.error(text) } = {}) {
  if (!chrome) throw new Error("Chrome not found");
  const profile = fs.mkdtempSync(path.join(tempRoot, "fleet-chrome-"));
  let browser, result, actionError, exitConfirmed = true;
  try {
    browser = await launch({ chrome, profile }, { headless: true, profile, profileLabel: "fleet temporary" });
    const targets = await browser.send("Target.getTargets");
    const first = targets.targetInfos?.find(target => target.type === "page");
    if (!first || first.url !== "about:blank") throw new Error("fresh Chrome first tab is not about:blank");
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId: first.targetId, flatten: true });
    const tab = new Tab(browser, sessionId, first.targetId);
    await tab.send("Page.enable"); await tab.send("Runtime.enable"); await tab.send("Network.enable");
    result = await action(tab, browser);
    return result;
  } catch (error) { actionError = error; if (error.chromeStillRunning) exitConfirmed = false; throw error; }
  finally {
    const report = text => {
      if (result && typeof result === "object") (result.notices ??= []).push(text);
      if (actionError) (actionError.notices ??= []).push(text);
      note(text);
    };
    try { if (browser) exitConfirmed = await browser.close() !== false; } catch { exitConfirmed = false; }
    let error;
    for (let attempt = 0; exitConfirmed && attempt < 10; attempt++) {
      try { await remove(profile, { recursive: true, force: true }); error = undefined; break; }
      catch (caught) { error = caught; if (attempt < 9) await pause(300); }
    }
    if (error || !exitConfirmed) report(`Chrome temporary profile cleanup incomplete${exitConfirmed ? "" : "; process exit unconfirmed"}: ${profile}`);
  }
}
export async function navigate(tab, url) {
  let listener, timer;
  const loaded = new Promise((resolve, reject) => {
    listener = event => { if (event.method === "Page.loadEventFired" && event.sessionId === tab.sessionId) resolve(); };
    tab.b.listeners.add(listener);
    timer = setTimeout(() => reject(new Error("page load timed out")), 30_000);
  });
  loaded.catch(() => {});
  try {
    const response = await tab.send("Page.navigate", { url });
    if (response.errorText) throw new Error(response.errorText);
    await loaded;
  } finally { clearTimeout(timer); tab.b.listeners.delete(listener); }
}
export async function shot(opts, directory, { serve = staticServer, browser = withFreshBrowser, sleep: pause = sleep, ...options } = {}) {
  validateShot(opts);
  let server;
  try {
    if (opts.dir) server = await serve(opts.dir);
    return await browser(directory, async (tab, instance) => {
      const files = [], errors = [], requests = new Map();
      let active = [];
      const listener = event => {
        if (event.sessionId !== tab.sessionId) return;
        let text, kind = "console";
        if (event.method === "Network.requestWillBeSent") requests.set(event.params.requestId, event.params.request.url);
        if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error") text = event.params.args.map(arg => arg.value ?? arg.description ?? "").join(" ");
        if (event.method === "Runtime.exceptionThrown") text = event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text;
        if (event.method === "Network.loadingFailed") { kind = "request"; text = `request failed: ${requests.get(event.params.requestId) ?? ""} ${event.params.errorText}`; }
        if (event.method === "Network.responseReceived" && event.params.response.status >= 400) { kind = "request"; text = `HTTP ${event.params.response.status}: ${event.params.response.url}`; }
        if (text) { text = String(text).slice(0, 1000); active.push({ kind, text }); errors.push(text); }
      };
      instance.listeners.add(listener);
      try {
        for (const width of opts.widths ?? [390, 1440]) {
          active = [];
          await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
          await navigate(tab, opts.url ?? server.url);
          if (opts.waitFor) await tab.waitFor(`Boolean(document.querySelector(${JSON.stringify(opts.waitFor)}))`, 30_000, "waitFor selector");
          if (opts.waitMs) await pause(opts.waitMs);
          const metrics = await tab.send("Page.getLayoutMetrics");
          const height = opts.fullPage === false ? 900 : Math.ceil((metrics.cssContentSize ?? metrics.contentSize).height);
          const capture = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: opts.fullPage !== false, ...(opts.fullPage === false ? {} : { clip: { x: 0, y: 0, width, height, scale: 1 } }) });
          const file = path.join(directory, `shot-${width}-${files.length + 1}.png`);
          fs.writeFileSync(file, Buffer.from(capture.data, "base64"));
          files.push({ path: file, width, height, consoleErrors: active.filter(error => error.kind === "console").length, failedRequests: active.filter(error => error.kind === "request").length });
        }
        return { files, errors: errors.slice(0, 5) };
      } finally { instance.listeners.delete(listener); }
    }, options);
  } finally { if (server) await server.close(); }
}
export function githubChecks(data) {
  return (data.check_runs ?? []).filter(check => /workers?\s+builds?/i.test(check.name ?? "")).map(({ name, status, conclusion, html_url }) => ({ name, status, conclusion, url: html_url }));
}
export async function pollDeploy(opts, { fetchText, now = Date.now, sleep: pause = sleep, interrupted = () => false } = {}) {
  validateDeploy(opts);
  const start = now(), deadline = start + (opts.timeoutMin ?? 75) * 60_000;
  let found = false, lastError;
  do {
    if (interrupted()) throw new Error("interrupted");
    const url = new URL(opts.path, opts.url); url.searchParams.set("_fleet", `${now()}`);
    try { found = (await fetchText(url.href, Math.max(1, Math.min(15000, deadline - now())))).includes(opts.marker); lastError = undefined; } catch (error) { lastError = error.message; }
    if (found || now() >= deadline) break;
    const next = Math.min(now() + (opts.intervalSec ?? 60) * 1000, deadline);
    while (now() < next) { if (interrupted()) throw new Error("interrupted"); await pause(Math.min(1000, next - now())); }
  } while (now() <= deadline);
  return { found, minutes: (now() - start) / 60_000, ...(lastError ? { error: lastError } : {}) };
}
export async function deployWait(opts, directory, { browser = withFreshBrowser, run = capture, ...options } = {}) {
  return browser(directory, async tab => {
    await navigate(tab, opts.url);
    const result = await pollDeploy(opts, { ...options, fetchText: (url, timeout) => tab.eval(`fetch(${JSON.stringify(url)}, {cache:'no-store',signal:AbortSignal.timeout(${timeout})}).then(async r => {if(!r.ok) throw new Error('HTTP '+r.status); return r.text();})`) });
    if (opts.repo) {
      const response = await run("gh", ["api", `repos/${opts.repo}/commits/${opts.sha}/check-runs`], { env: options.env, timeout: 30_000 });
      try { result.checks = response.code === 0 ? githubChecks(JSON.parse(response.stdout)) : []; } catch { result.checks = []; }
    }
    return result;
  }, options);
}
