import { spawnWorker as spawn, workerEnv } from "../worker.mjs";
import fs from "node:fs";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function processExit(proc, timeoutMs = 5000) {
  if (typeof proc.exitCode === "number" || proc.signalCode != null || proc.spawnfile && !proc.pid) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => finish(true), errored = () => finish(!proc.pid), timedOut = () => finish(false);
    const finish = exited => { clearTimeout(timer); proc.removeListener("exit", done); proc.removeListener("error", errored); resolve(exited); };
    const timer = setTimeout(timedOut, timeoutMs);
    proc.once("exit", done); proc.once("error", errored);
  });
}

export function launchLogin(chrome, profile, url, { detached = false, spawnChrome = spawn } = {}) {
  fs.mkdirSync(profile, { recursive: true });
  return spawnChrome(chrome, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url], { env: workerEnv(), detached, stdio: "ignore", ...(!detached ? { windowsHide: false } : {}) });
}

export function parseAdvisorArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === "show") { out.show = true; continue; }
    if (key === "files") {
      out.files = [];
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) out.files.push(argv[++i]);
      continue;
    }
    out[key] = argv[++i];
  }
  return out;
}

export class Browser {
  static async launch(cfg, { show = false, headless = false, profile = cfg.profile, menuText = "''", profileLabel = "advisor", spawnChrome = spawn } = {}) {
    fs.mkdirSync(profile, { recursive: true });
    const args = [
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      ...(headless ? ["--headless=new"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
      show ? "--window-position=80,80" : "--window-position=-2400,-2400",
      "about:blank",
    ];
    const proc = spawnChrome(cfg.chrome, args, { env: workerEnv(), stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: false });
    let b;
    try { b = new Browser(proc, { menuText }); }
    catch (error) { const exited = processExit(proc); try { proc.kill(); } catch {} error.chromeStillRunning = !await exited; throw error; }
    b.show = show;
    let launchTimer;
    const early = await Promise.race([
      new Promise((r) => proc.once("exit", (code) => r({ exited: code }))),
      new Promise((r) => proc.once("error", error => r({ error }))),
      b.send("Browser.getVersion").then((v) => ({ ok: v }), error => ({ error })),
      new Promise(r => { launchTimer = setTimeout(() => r({ timeout: true }), 20000); }),
    ]);
    clearTimeout(launchTimer);
    if (!early.ok) {
      const exited = early.error && !proc.pid ? Promise.resolve(true) : processExit(proc);
      try { proc.kill(); } catch {}
      const confirmedExit = await exited;
      throw Object.assign(new Error(
        early.exited !== undefined
          ? `Chrome exited at once: the ${profileLabel} profile is probably already open in another Chrome window. Close it and retry.`
          : "Chrome did not answer on the DevTools pipe within 20 s."
      ), { chromeStillRunning: !confirmedExit });
    }
    return b;
  }

  constructor(proc, { menuText = "''" } = {}) {
    this.menuText = menuText;
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.writer = proc.stdio[3];
    let buf = Buffer.alloc(0);
    proc.stdio[4].on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) >= 0) {
        const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
        buf = buf.subarray(i + 1);
        this.dispatch(msg);
      }
    });
    proc.on("exit", () => {
      for (const { rej } of this.pending.values()) rej(new Error("Chrome closed"));
      this.pending.clear();
    });
    proc.on("error", error => { for (const { rej } of this.pending.values()) rej(error); this.pending.clear(); });
  }

  dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} ${msg.error.data || ""}`.trim()));
      else res(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.writer.write(JSON.stringify(msg) + "\0");
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }

  waitEvent(method, sessionId, timeoutMs) {
    return new Promise((res, rej) => {
      const fn = (m) => {
        if (m.method === method && m.sessionId === sessionId) {
          this.listeners.delete(fn);
          clearTimeout(t);
          res(m.params);
        }
      };
      const t = setTimeout(() => { this.listeners.delete(fn); rej(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      this.listeners.add(fn);
    });
  }

  // Each chat gets its own window: a background tab neither takes clicks reliably nor renders at full speed.
  async newTab(url) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const { windowId } = await this.send("Browser.getWindowForTarget", { targetId });
    const left = this.show ? 80 + 40 * (this.windows = (this.windows || 0) + 1) : -2400;
    await this.send("Browser.setWindowBounds", { windowId, bounds: { left, top: this.show ? 80 : -2400, width: 1280, height: 900 } });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(this, sessionId, targetId);
    tab.windowId = windowId;
    await tab.send("Page.enable");
    await tab.send("Runtime.enable");
    await tab.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await tab.send("Page.navigate", { url });
    return tab;
  }

  async close() {
    let timer;
    try { await Promise.race([this.send("Browser.close"), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); } catch {}
    finally { clearTimeout(timer); }
    const exited = processExit(this.proc);
    try { this.proc.kill(); } catch {}
    return await exited;
  }
}

export class Tab {
  constructor(browser, sessionId, targetId) {
    this.b = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.b.send(method, params, this.sessionId);
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page script failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }

  async waitFor(expression, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await this.eval(expression).catch(() => null);
      if (v) return v;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${label || expression}`);
  }

  // Real (trusted) mouse click at the centre of the element the expression returns.
  // Retries for a few seconds, since menus animate open.
  async click(elementExpr, label) {
    let box = null;
    for (let i = 0; i < 12 && !(box && box.w); i++) {
      if (i) await sleep(300);
      box = await this.eval(`(() => { const e = ${elementExpr}; if (!e) return null;
        e.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`).catch((err) => ({ err: err.message }));
    }
    if (!box || !box.w) {
      const menu = await this.eval(this.b.menuText).catch(() => "?");
      throw new Error(`could not find ${label || elementExpr} (${box?.err || (box ? "zero size" : "absent")}; open menu: ${menu.replace(/\n/g, " | ") || "none"})`);
    }
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  }

  async key(key, code, keyCode) {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  }
}


export function markdownExpression(rootExpression, { skipSelector = ".code-block-decoration, .header-formatted, button, mat-icon, .cdk-visually-hidden" } = {}) {
  return `(() => { const R = ${rootExpression}; if (!R) return '';
    const md = n => { if (n.nodeType === 3) return n.textContent; if (n.nodeType !== 1) return '';
      const t = n.tagName, c = () => [...n.childNodes].map(md).join('');
      if (n.matches(${JSON.stringify(skipSelector)})) return '';
      const tex = n.getAttribute('data-math') || (n.matches('.katex, .katex-display, .math-inline, .math-block') ? n.querySelector('annotation[encoding="application/x-tex"]')?.textContent : null);
      if (tex != null) return n.matches('.katex-display, .math-block') || n.querySelector('.katex-display') ? '\\n$$' + tex.trim() + '$$\\n' : '$' + tex.trim() + '$';
      if (t === 'PRE') { const k = n.querySelector('code'); const l = ((k?.className.match(/language-(\\S+)/) || [])[1] || n.closest('code-block, .code-block')?.querySelector('.code-block-decoration')?.innerText.trim().split('\\n')[0] || '').toLowerCase().replace(/[^a-z0-9+#-]/g, '');
        return '\\n\\x60\\x60\\x60' + l + '\\n' + (k || n).textContent.replace(/\\n$/, '') + '\\n\\x60\\x60\\x60\\n'; }
      if (t === 'CODE') return '\\x60' + n.textContent + '\\x60';
      if (/^H[1-6]$/.test(t)) return '\\n' + '#'.repeat(+t[1]) + ' ' + c().trim() + '\\n\\n';
      if (t === 'LI') { const ol = n.parentElement?.tagName === 'OL'; const i = [...n.parentElement.children].indexOf(n) + 1;
        return (ol ? i + '. ' : '- ') + c().trim().replace(/\\n/g, '\\n  ') + '\\n'; }
      if (t === 'UL' || t === 'OL') return '\\n' + c() + '\\n';
      if (t === 'P') return c().trim() + '\\n\\n';
      if (t === 'BR') return '\\n';
      if (t === 'HR') return '\\n---\\n';
      if (t === 'BLOCKQUOTE') return c().trim().split('\\n').map(s => '> ' + s).join('\\n') + '\\n\\n';
      if (t === 'STRONG' || t === 'B') return '**' + c() + '**';
      if (t === 'EM' || t === 'I') return '*' + c() + '*';
      if (t === 'A') return '[' + c() + '](' + n.href + ')';
      if (t === 'TABLE') { const rows = [...n.querySelectorAll('tr')].map(r => '| ' + [...r.children].map(x => md(x).trim().replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ')).join(' | ') + ' |');
        if (rows.length) rows.splice(1, 0, '|' + ' --- |'.repeat(n.querySelector('tr').children.length)); return '\\n' + rows.join('\\n') + '\\n\\n'; }
      return c(); };
    return md(R).replace(/\\n{3,}/g, '\\n\\n').trim(); })()`;
}

export const CHALLENGE_WAIT_MS = 20 * 60 * 1000;
let challengeShown = 0;

export async function handOverChallenge(tab, { stateExpression, notice, error, log = value => process.stderr.write(JSON.stringify(value) + "\n"), sleep: pause = sleep, now = Date.now, timeoutMs = CHALLENGE_WAIT_MS } = {}) {
  const n = challengeShown++;
  await tab.b.send("Browser.setWindowBounds", { windowId: tab.windowId, bounds: { windowState: "normal" } }).catch(() => {});
  await tab.b.send("Browser.setWindowBounds", { windowId: tab.windowId, bounds: { left: 120 + 40 * n, top: 80 + 40 * n, width: 1100, height: 850 } });
  await tab.send("Page.bringToFront");
  log({ waitingForLok: notice, waitMinutes: timeoutMs / 60000 });
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    await pause(3000);
    const s = await tab.eval(stateExpression).catch(() => null);
    if (s === "ready" || s === "signin") {
      if (!tab.b.show) await tab.b.send("Browser.setWindowBounds", { windowId: tab.windowId, bounds: { left: -2400, top: -2400 } }).catch(() => {});
      log({ challenge: "cleared", afterSecs: Math.round((now() - t0) / 1000) });
      return s;
    }
  }
  throw error();
}
