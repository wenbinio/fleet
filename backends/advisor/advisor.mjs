#!/usr/bin/env node
// advisor.mjs — consult Gemini (Argon) on gemini.google.com from the command line.
//
// Drives the user's installed Chrome with its own profile folder over the DevTools protocol on a private pipe
// (--remote-debugging-pipe: no network port is opened). The Google sign-ins live only inside that Chrome profile;
// this script never reads cookies or tokens. Files are attached with real uploads, the prompt is typed, and the
// answer is printed as Markdown.
//
//   node advisor.mjs login                       open the profile's Chrome so the user can sign in (once)
//   node advisor.mjs check                       report which configured accounts are signed in, and their model
//   node advisor.mjs ask <prompt.md> [...more prompts] [--files a b c] [--out answer.md|dir]
//                     [--account email] [--model Argon] [--thinking High] [--timeout 900] [--show]
//   node advisor.mjs probe [--account email]     dump Gemini's controls (for fixing selectors when the page changes)
//
// Several prompt files run in parallel tabs on the same account. On a usage-limit reply the script moves to the
// next account in config.json and tries again. Status goes to stderr as one JSON line; answers go to stdout or --out.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig as loadToolkitConfig, resolveTool } from "../../core/lib/toolkit.mjs";

import { Browser, launchLogin, parseAdvisorArgs, markdownExpression, handOverChallenge as handOverWebChallenge } from "../../core/lib/webchat/engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.ADVISOR_HOME || loadToolkitConfig().advisorHome;
const CONFIG_FILE = path.join(HOME, "config.json");
const PROFILE = path.join(HOME, "profile");

const DEFAULTS = {
  chrome: resolveTool('chrome'),
  accounts: [],
  model: "Argon",
  thinking: "High",
  timeoutSec: 900,
};

function loadConfig() {
  return { ...DEFAULTS, ...(fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, '')) : {}) };
}

const parseArgs = parseAdvisorArgs;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (obj) => process.stderr.write(JSON.stringify(obj) + "\n");

// ---------------------------------------------------------------- Chrome over a DevTools pipe

// ---------------------------------------------------------------- Gemini page knowledge (all selectors live here)

const G = {
  url: (email) => `https://gemini.google.com/app?authuser=${encodeURIComponent(email)}`,
  editor: `document.querySelector('rich-textarea .ql-editor')`,
  account: `document.querySelector('[aria-label^="Google Account:"]')?.getAttribute('aria-label') || ''`,
  modelLabel: `document.querySelector('[aria-label^="Open mode picker"]')?.getAttribute('aria-label') || ''`,
  picker: `document.querySelector('[aria-label^="Open mode picker"]')`,
  // An item in an open menu/overlay whose first line of text matches the pattern.
  // Items of whichever menu is open: Gemini's own gem-menu (model picker) or the shared overlay (upload menu).
  menuItem: (pattern) => `[...document.querySelectorAll('gem-menu [role="menuitem"], gem-menu-item, [role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], .cdk-overlay-container [role="menuitem"], .cdk-overlay-container button, .cdk-overlay-container [role="option"]')]
    .find(e => e.offsetWidth && ${pattern}.test((e.innerText || '').trim().split('\\n')[0].trim()))`,
  menuText: `[...document.querySelectorAll('gem-menu-item, [role="menu"] [role="menuitem"], .cdk-overlay-container [role="menuitem"], .cdk-overlay-container button')]
    .filter(e => e.offsetWidth).map(e => e.innerText.trim().replace(/\\s*\\n+\\s*/g, ' / ')).join('\\n')`,
  uploadMenu: `document.querySelector('button[aria-label="Upload & tools"], button[aria-label^="Upload"], button[aria-label*="upload" i]')`,
  uploadItem: `[...document.querySelectorAll('.cdk-overlay-container [role="menuitem"], .cdk-overlay-container button')]
    .find(e => e.offsetWidth && /^(Upload )?files/i.test((e.getAttribute('aria-label') || e.innerText || '').trim()))`,
  send: `document.querySelector('button[aria-label="Send message"]')`,
  stop: `document.querySelector('button[aria-label*="Stop" i]')`,
  queries: `document.querySelectorAll('user-query').length`,
  lastResponse: `[...document.querySelectorAll('model-response')].pop()`,
  // A finished response carries its action row (copy, rate, redo...).
  finished: `(() => { const l = [...document.querySelectorAll('model-response')].pop(); if (!l) return false;
    if (document.querySelector('button[aria-label*="Stop" i]')) return false;
    return !![...l.querySelectorAll('button')].find(b => /copy|good response|bad response|redo|share|more options/i.test(b.getAttribute('aria-label') || '')); })()`,
  responseText: `(() => { const l = [...document.querySelectorAll('model-response')].pop(); return l ? (l.querySelector('.markdown') || l).innerText.trim() : ''; })()`,
  // Usage limits are recognised three ways, because the exact wording has never been seen live:
  //   1. the reply (or a short reply) uses limit wording;
  //   2. a banner, snackbar or dialog outside the reply uses it;
  //   3. Gemini quietly switched models (the picker no longer says the model we chose), or refused to select it.
  limit: /(reached|hit|used up|exceeded) (your|the|all( of)? your) [\w\s]{0,30}(limit|quota|prompts)|usage limit|limit (for|on) (this model|today|\w+ Argon|Argon)|out of (prompts|quota)|resets? (at|on|in|tomorrow)|come back (later|tomorrow)|upgrade to (Google AI )?Ultra/i,
  limitHint: /limit|quota|upgrade|try again|resets?/i,
  notices: `[...document.querySelectorAll('mat-snack-bar-container, simple-snack-bar, [role="alert"], [role="status"], [role="dialog"], mat-dialog-container, [class*="banner" i], [class*="limit" i], [class*="quota" i], [class*="upsell" i], [class*="warning" i]')]
    .filter(e => e.offsetWidth && !e.closest('model-response, user-query')).map(e => e.innerText.trim().replace(/\\s+/g, ' ')).filter(t => t && t.length < 500)`,
  markdown: markdownExpression(`[...document.querySelectorAll('model-response')].pop()?.querySelector('.markdown')`),
};

// Google's "unusual traffic" check. Never solved or dodged by the script: the window comes on screen in front, the
// challenge stays as it is for Lok to complete, and the consult carries on once Gemini loads. Closing the moment a
// challenge appears would look more like a bot, not less.
async function handOverChallenge(tab) {
  return handOverWebChallenge(tab, {
    stateExpression: `location.pathname.startsWith('/sorry') ? 'blocked' : location.host.startsWith('accounts.') ? 'signin' : (${G.editor} ? 'ready' : null)`,
    notice: "Google's robot check is showing in a Chrome window on screen. Complete it there; the consult continues by itself.",
    error: () => new BlockedError(), log,
  });
}

async function openGemini(browser, email) {
  const tab = await browser.newTab(G.url(email));
  let state;
  try {
    state = await tab.waitFor(
      `(() => location.pathname.startsWith('/sorry') ? 'blocked' : location.host.startsWith('accounts.') ? 'signin' : (${G.editor} ? 'ready' : null))()`,
      60000, "the Gemini page");
    if (state === "blocked") state = await handOverChallenge(tab);
  } catch (e) {
    if (e instanceof BlockedError) throw e;
    const seen = await tab.eval(`({ url: location.href.slice(0, 120), title: document.title, text: (document.body?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 300) })`).catch((err) => ({ err: err.message }));
    throw new Error(`${e.message}; the page shows: ${JSON.stringify(seen)}`);
  }
  if (state === "signin") throw new Error(`${email} is not signed in to the advisor profile. Run: node advisor.mjs login`);
  const acct = await tab.waitFor(
    `${G.account} || ([...document.querySelectorAll('button, a')].some(b => /^sign in$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())) ? 'SIGNED-OUT' : '')`,
    20000, "the account menu");
  if (acct === "SIGNED-OUT") throw new Error(`${email} is not signed in to the advisor profile. Run: node advisor.mjs login`);
  if (!acct.includes(email)) throw new Error(`asked for ${email} but Gemini opened as: ${acct.replace(/\s+/g, " ")}`);
  await tab.waitFor(`!!${G.picker}`, 20000, "the model picker");
  return tab;
}

async function chooseModel(tab, model, thinking) {
  const want = (label) => label.includes(model) && (!thinking || label.includes(thinking));
  let label = await tab.eval(G.modelLabel);
  if (want(label)) return label;
  const modelItem = G.menuItem(new RegExp(`(^|\\s)${model}$`));
  const thinkingItem = G.menuItem(new RegExp(`^${thinking}$`));
  const levelHeader = G.menuItem(/^Thinking level$/);
  // Gemini sometimes pops its model menu open by itself on a fresh page and then closes it, so never trust a menu
  // we did not open: close whatever is open, then open the picker ourselves.
  const openPicker = async () => {
    await tab.key("Escape", "Escape", 27);
    await tab.waitFor(`!${levelHeader}`, 3000, "the menu to close").catch(() => {});
    await tab.click(G.picker, "the model picker");
    await tab.waitFor(`!!${levelHeader}`, 8000, "the model menu");
  };
  for (let attempt = 1; !label.includes(model); attempt++) {
    try {
      await openPicker();
      const disabled = await tab.eval(`(() => { const e = ${modelItem}; return !!e && (e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('disabled') || /disabled|locked/i.test(e.className)); })()`);
      if (disabled) throw new LimitError(`${model} is greyed out in the model menu`, await tab.eval(G.menuText));
      await tab.click(modelItem, `the ${model} menu item`);
      await tab.waitFor(`${G.modelLabel}.includes(${JSON.stringify(model)})`, 8000, `${model} to be selected`);
    } catch (e) {
      if (e instanceof LimitError) throw e;
      if (attempt >= 3) {
        const notices = await tab.eval(G.notices).catch(() => []);
        throw new LimitError(`Gemini would not switch to ${model} after 3 tries (${e.message})`, notices.join(" | "));
      }
      await sleep(1000);
    }
    label = await tab.eval(G.modelLabel);
  }
  for (let attempt = 1; thinking && !label.includes(thinking); attempt++) {
    try {
      await openPicker();
      // The header toggles the level list, so only click it when no level is showing.
      if (!(await tab.eval(`!!${G.menuItem(/^(Low|Medium|High)$/)}`))) {
        await tab.click(levelHeader, "Thinking level");
        await tab.waitFor(`!!${thinkingItem}`, 5000, `the ${thinking} item`);
      }
      await tab.click(thinkingItem, `thinking level ${thinking}`);
      await tab.waitFor(`${G.modelLabel}.includes(${JSON.stringify(thinking)})`, 8000, `thinking ${thinking} to be selected`);
    } catch (e) {
      if (attempt >= 3) {
        const items = await tab.eval(`[...document.querySelectorAll('gem-menu-item')].map(e => JSON.stringify((e.innerText || '').trim().slice(0, 30)) + (e.offsetWidth ? '' : '(hidden)')).join(', ')`).catch(() => "?");
        throw new Error(`${e.message}; menu items: ${items}`);
      }
      await sleep(1000);
    }
    label = await tab.eval(G.modelLabel);
  }
  await tab.key("Escape", "Escape", 27);
  label = await tab.eval(G.modelLabel);
  if (!label.includes(model)) throw new Error(`could not select ${model}; the picker says: ${label}`);
  return label;
}

async function attachFiles(tab, files) {
  if (!files?.length) return;
  const abs = files.map((f) => path.resolve(f));
  for (const f of abs) if (!fs.existsSync(f)) throw new Error(`no such file: ${f}`);
  await tab.click(G.uploadMenu, "the upload menu");
  await tab.waitFor(`!!${G.uploadItem}`, 8000, "the Upload files item");
  const chooser = tab.b.waitEvent("Page.fileChooserOpened", tab.sessionId, 10000);
  await tab.click(G.uploadItem, "the Upload files item");
  const { backendNodeId } = await chooser;
  await tab.send("DOM.setFileInputFiles", { files: abs, backendNodeId });
  // Wait until every file name shows in the composer and nothing is still uploading.
  const names = JSON.stringify(abs.map((f) => path.basename(f)));
  const diag = `(() => { const area = document.querySelector('input-area-v2') || document.body;
    const busy = [...area.querySelectorAll('[role="progressbar"], mat-progress-spinner, mat-progress-bar, .uploading, [class*="loading" i], [class*="progress" i]')].filter(e => e.offsetWidth);
    return { names: ${names}.map(n => [n, document.body.innerText.includes(n)]), busy: busy.map(e => e.tagName + '.' + (e.className + '').slice(0, 50)),
      chips: [...area.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(a => /\\.|file|remove|preview/i.test(a)).slice(0, 10) }; })()`;
  try {
    await tab.waitFor(`(() => { const d = ${diag}; return d.chips.some(c => ${names}.some(n => c.includes(n))) || d.names.every(x => x[1]) ? !d.busy.length : false; })()`,
      45000, "the uploads to finish");
  } catch (e) {
    throw new Error(`${e.message}: ${JSON.stringify(await tab.eval(diag).catch(() => null))}`);
  }
  await sleep(800);
}

async function sendPrompt(tab, text) {
  await tab.click(G.editor, "the prompt box");
  await tab.send("Input.insertText", { text });
  await sleep(300);
  const typed = await tab.eval(`(${G.editor}).innerText.length`);
  if (typed < Math.min(text.length, 20) * 0.8) throw new Error("the prompt did not reach the input box");
  const before = await tab.eval(G.queries);
  await tab.waitFor(`(() => { const b = ${G.send}; return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; })()`, 60000, "the Send button");
  await tab.click(G.send, "the Send button");
  try {
    await tab.waitFor(`${G.queries} > ${before}`, 10000, "the message to send");
  } catch {
    await tab.key("Enter", "Enter", 13);
    await tab.waitFor(`${G.queries} > ${before}`, 10000, "the message to send");
  }
}

class LimitError extends Error {
  constructor(message, evidence) { super(message); this.evidence = evidence; }
}

// Raised only when Google's "unusual traffic" check was handed to Lok and not completed within the wait. It covers
// the whole network, so switching accounts cannot help; stop everything.
class BlockedError extends Error {
  constructor() {
    super("Google's 'unusual traffic' check was shown on screen for Lok but not completed in time. Stopped; " +
      "switching accounts would not help. Ask Lok before the next consult.");
  }
}

async function awaitAnswer(tab, timeoutMs, model) {
  const t0 = Date.now();
  let last = "", stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    const text = await tab.eval(G.responseText).catch(() => "");
    const notices = await tab.eval(G.notices).catch(() => []);
    const notice = notices.find((t) => G.limit.test(t));
    if (notice) return { limit: "notice", text: notice };
    if (G.limit.test(text) && text.length < 800) return { limit: "reply", text };
    if (await tab.eval(G.finished).catch(() => false)) {
      if (text === last && ++stable >= 1) break;
    } else stable = 0;
    last = text;
  }
  const md = await tab.eval(G.markdown).catch(() => last);
  if (Date.now() - t0 >= timeoutMs) return { timeout: true, text: md };
  const label = await tab.eval(G.modelLabel).catch(() => "");
  if (label && !label.includes(model)) return { limit: "downgraded", text: `Gemini switched to ${label.replace(/^Open mode picker, currently /, "")} while answering`, answer: md };
  // Short replies that only hint at a limit are kept as answers but flagged, so the wording can be added to G.limit.
  const suspect = md.length < 800 && G.limitHint.test(md);
  return { text: md, ...(suspect ? { suspectLimit: true } : {}) };
}

function recordLimit(email, r) {
  const line = { at: new Date().toISOString(), account: email, how: r.limit || "suspect", text: (r.text || "").slice(0, 600) };
  try { fs.appendFileSync(path.join(HOME, "limits.jsonl"), JSON.stringify(line) + "\n"); } catch {}
  log({ account: email, limit: line.how, text: line.text.slice(0, 160) });
}

// ---------------------------------------------------------------- commands

async function ask(cfg, opts) {
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length || cfg.accounts.some(a => typeof a !== 'string' || !a.trim())) {
    throw new Error(`No accounts configured in ${CONFIG_FILE}. Run advisor.mjs login, then add the configured accounts to config.json.`);
  }
  if (opts.account && !cfg.accounts.includes(opts.account)) throw new Error(`Account is not configured in ${CONFIG_FILE}`);
  const prompts = opts._.slice(1);
  if (!prompts.length) throw new Error("usage: ask <prompt.md> [...] [--files ...] [--out file|dir]");
  const texts = prompts.map((p) => fs.readFileSync(p, "utf8"));
  const accounts = opts.account ? [opts.account] : cfg.accounts;
  const model = opts.model || cfg.model;
  const thinking = opts.thinking === "none" ? "" : opts.thinking || cfg.thinking;
  const timeoutMs = Number(opts.timeout || cfg.timeoutSec) * 1000;
  const t0 = Date.now();
  const browser = await Browser.launch(cfg, { show: opts.show, profile: PROFILE, menuText: G.menuText });
  try {
    let pending = texts.map((prompt, i) => ({ i, prompt }));
    const results = [];
    for (const email of accounts) {
      if (!pending.length) break;
      const round = await Promise.all(pending.map(async (job) => {
        let tab;
        try {
          tab = await openGemini(browser, email);
          if (process.env.ADVISOR_FAKE_LIMIT === email) throw new LimitError("fake limit for testing (ADVISOR_FAKE_LIMIT)");
          const label = await chooseModel(tab, model, thinking);
          await attachFiles(tab, opts.files);
          await sendPrompt(tab, job.prompt);
          const r = await awaitAnswer(tab, timeoutMs, model);
          return { ...job, ...r, account: email, model: label.replace(/^Open mode picker, currently /, "") };
        } catch (e) {
          if (e instanceof BlockedError) return { ...job, blocked: true, error: e.message, account: email };
          if (e instanceof LimitError) return { ...job, limit: "picker", text: `${e.message}${e.evidence ? ": " + e.evidence : ""}`, account: email };
          return { ...job, error: e.message, account: email };
        } finally {
          if (tab) await browser.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
        }
      }));
      pending = [];
      if (round.some((r) => r.blocked)) {
        for (const r of round) results.push(r.blocked || r.text ? r : { ...r, error: new BlockedError().message });
        break;
      }
      for (const r of round) {
        if (r.limit) { recordLimit(email, r); pending.push({ i: r.i, prompt: texts[r.i], lastLimit: r }); continue; }
        if (r.suspectLimit) recordLimit(email, r);
        results.push(r);
      }
    }
    // Out of accounts: hand back what the last one produced (e.g. a downgraded model's answer) rather than nothing.
    for (const p of pending) {
      const r = p.lastLimit;
      results.push(r?.answer ? { ...r, text: r.answer, limit: undefined, error: undefined, exhausted: true }
        : { i: p.i, error: "every configured account hit its usage limit" });
    }
    results.sort((a, b) => a.i - b.i);
    writeAnswers(results, prompts, opts.out);
    log({
      secs: Math.round((Date.now() - t0) / 1000),
      results: results.map((r) => ({ prompt: path.basename(prompts[r.i]), account: r.account, model: r.model,
        chars: r.text?.length || 0, ...(r.timeout ? { timeout: true } : {}), ...(r.suspectLimit ? { suspectLimit: true } : {}),
        ...(r.exhausted ? { exhausted: "all accounts limited; this is the downgraded model's answer" } : {}), ...(r.error ? { error: r.error } : {}) })),
    });
    if (results.some((r) => r.error)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

function writeAnswers(results, prompts, out) {
  if (results.length === 1 && !(out && fs.existsSync(out) && fs.statSync(out).isDirectory())) {
    const r = results[0];
    const body = r.error ? `ADVISOR ERROR: ${r.error}\n` : r.text + "\n";
    if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
    return;
  }
  const dir = out || ".";
  fs.mkdirSync(dir, { recursive: true });
  for (const r of results) {
    const file = path.join(dir, path.basename(prompts[r.i]).replace(/\.[^.]*$/, "") + ".answer.md");
    fs.writeFileSync(file, r.error ? `ADVISOR ERROR: ${r.error}\n` : r.text + "\n");
  }
}

async function check(cfg) {
  const browser = await Browser.launch(cfg, { profile: PROFILE, menuText: G.menuText });
  try {
    for (const email of cfg.accounts) {
      try {
        const tab = await openGemini(browser, email);
        log({ account: email, signedIn: true, model: (await tab.eval(G.modelLabel)).replace(/^Open mode picker, currently /, "") });
        await browser.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
      } catch (e) {
        log({ account: email, signedIn: false, error: e.message });
      }
    }
  } finally {
    await browser.close();
  }
}

async function probe(cfg, opts) {
  const browser = await Browser.launch(cfg, { show: opts.show, profile: PROFILE, menuText: G.menuText });
  try {
    const tab = await openGemini(browser, opts.account || cfg.accounts[0]);
    await sleep(5000);
    const info = await tab.eval(`({
      url: location.href,
      viewport: innerWidth + 'x' + innerHeight,
      pickerish: [...document.querySelectorAll('[aria-label*="mode" i], [aria-label*="model" i], [data-test-id*="mode" i]')].map(e => e.tagName + ' ' + e.getAttribute('aria-label')).slice(0, 10),
      model: ${G.modelLabel},
      buttons: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(a => a && !/^More options for /.test(a)).slice(0, 40),
      fileInputs: document.querySelectorAll('input[type=file]').length,
    })`);
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    await tab.click(G.picker, "the model picker");
    await sleep(1500);
    info.modelMenu = (await tab.eval(G.menuText)).split("\n").filter(Boolean);
    info.menuDiag = await tab.eval(`({ expanded: ${G.picker}?.getAttribute('aria-expanded'),
      items: [...document.querySelectorAll('gem-menu-item')].map(e => ({ text: e.innerText.trim().replace(/\\s*\\n+\\s*/g, ' / ').slice(0, 40), w: e.offsetWidth, vis: getComputedStyle(e).visibility })),
      pickerBox: (() => { const r = ${G.picker}.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
      atPoint: (() => { const r = ${G.picker}.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e?.tagName + '.' + (e?.className + '').slice(0, 40); })() })`);
    await tab.key("Escape", "Escape", 27);
    await sleep(300);
    await tab.click(G.uploadMenu, "the upload menu").catch((e) => (info.uploadMenuError = e.message));
    await sleep(800);
    info.uploadMenu = (await tab.eval(G.menuText)).split("\n").filter(Boolean);
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

function login(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = launchLogin(cfg.chrome, PROFILE, "https://accounts.google.com/AddSession?continue=https%3A%2F%2Fgemini.google.com%2Fapp", { detached: true });
  child.unref();
  console.log(`Opened the advisor's Chrome (profile ${PROFILE}).\nSign in to each account listed in ${CONFIG_FILE}` +
    ` (use "Add another account" for the rest), open Gemini once on each, then close that Chrome window.`);
}

const opts = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const cmd = opts._[0];
const commands = { ask, check, probe, login };
if (!commands[cmd]) {
  console.error(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
Promise.resolve(commands[cmd](cfg, opts)).catch((e) => { log({ error: e.message }); process.exit(1); });
