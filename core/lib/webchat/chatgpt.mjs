#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isMain, loadConfig, resolveTool } from '../toolkit.mjs';
import { Browser, handOverChallenge, markdownExpression, sleep } from './engine.mjs';
import { CHATGPT_DEFAULTS, chatgptHome, settings, readState, writeState, acquireLock, pace, recordSent, activeLimit } from './state.mjs';

// Probed ChatGPT selectors, with one compatibility fallback per control.
export const C = {
  url: 'https://chatgpt.com/',
  temporaryUrl: 'https://chatgpt.com/?temporary-chat=true',
  slider: `document.querySelector('[data-reasoning-slider] [role="slider"]') || document.querySelector('[role="menu"] [role="slider"]')`,
  pageReady: `location.hostname === 'chatgpt.com' && document.readyState !== 'loading' && !!document.body`,
  composer: `document.querySelector('[contenteditable="true"][aria-label="Ask ChatGPT"]') || document.querySelector('#prompt-textarea')`,
  send: `document.querySelector('button[aria-label="Send"]') || document.querySelector('[data-testid="send-button"]')`,
  stop: `document.querySelector('button[aria-label="Stop"]') || document.querySelector('[data-testid="stop-button"]')`,
  picker: `document.querySelector('button[aria-label="Select ChatGPT model"]') || document.querySelector('[data-testid="model-switcher-dropdown-button"]')`,
  items: `(() => { const visible = selector => [...document.querySelectorAll(selector)].filter(e => e.offsetWidth && e.offsetHeight); const scoped = visible('[role="menu"] [role="menuitemradio"]'); return scoped.length ? scoped : visible('[role="menuitemradio"]'); })()`,
  nonModelLabel: /^(?:upgrade\b|view plans\b|manage\b|learn more\b|settings\b|compare plans\b)/i,
  attach: `document.querySelector('[data-testid="composer-plus-btn"]') || document.querySelector('button[aria-label*="Attach" i], button[aria-label*="Add photos" i]')`,
  uploadItem: `[...document.querySelectorAll('[role="menuitem"], [role="menu"] button')].find(e => e.offsetWidth && /upload|add files|photos.*files/i.test(e.innerText || e.getAttribute('aria-label') || ''))`,
  fileInput: `document.querySelector('input[type="file"][multiple]') || document.querySelector('input[type="file"]')`,
  assistant: `([...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')].length ? [...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')] : [...document.querySelectorAll('[data-message-author-role="assistant"] .markdown')]).at(-1)`,
  userCount: `document.querySelectorAll('[data-message-author-role="user"]').length`,
  notices: `[...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [data-testid*="toast"], [class*="banner" i]')].filter(e => e.offsetWidth && e.offsetHeight).map(e => e.innerText.trim()).filter(Boolean)`,
  signedOut: `[...document.querySelectorAll('button')].some(e => e.offsetWidth && e.offsetHeight && /^(Log in|Sign up for free)$/i.test((e.innerText || '').trim())) || !!document.querySelector('textarea#mobile-composer-prompt[aria-label="Chat with ChatGPT"]')`,
  signedIn: `!!document.querySelector('button[aria-label="Open profile menu"]') || !!document.querySelector('[data-testid="accounts-profile-button"]')`,
  challenge: `/verify you are human|unusual activity|checking your browser|just a moment|complete the security check/i.test(document.title + '\\n' + (document.body?.innerText || '').slice(0, 4000)) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-running')`,
  plan: `document.querySelector('[data-testid="account-plan"], [data-testid="subscription-plan"]')?.innerText?.trim() || null`,
  uploading: `!![...document.querySelectorAll('[role="progressbar"], [data-testid*="upload-progress"], [aria-label*="uploading" i]')].find(e => e.offsetWidth)`,
  fileNames: `document.body?.innerText || ''`,
  limit: /(?:you['’]ve|you have)\s+reached\b.{0,150}(?:limit|usage|messages)|(?:usage|message|model)\s+limit.{0,80}(?:reached|exceeded)|limit resets?\b|out of messages/i,
  resetRelative: /(?:resets?|try again|available again)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i,
  resetIso: /\b(?:resets?|try again|available again)\s+(?:at|on|after)?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))/i,
  resetClock: /\b(?:resets?|try again|available again)\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/i,
};
C.modelLabel = `(() => { const e = ${C.picker}; return (e?.innerText || e?.getAttribute('aria-label') || '').trim(); })()`;
C.labels = `${C.items}.map(e => (e.innerText || e.getAttribute('aria-label') || '').trim().split('\\n')[0]).filter(label => label && !${C.nonModelLabel}.test(label))`;
C.selected = `(() => { const e = ${C.items}.find(e => e.getAttribute('aria-checked') === 'true' || e.getAttribute('data-model-selected') === 'true'); return (e?.innerText || '').trim().split('\\n')[0]; })()`;
C.power = `(() => { const e = ${C.slider}; return e ? { now: Number(e.getAttribute('aria-valuenow') ?? NaN), max: Number(e.getAttribute('aria-valuemax') ?? NaN) } : null; })()`;
C.assistantCount = `document.querySelectorAll('[data-markdown-text-style="assistant-message"]').length || document.querySelectorAll('[data-message-author-role="assistant"] .markdown').length`;
C.state = `(${C.challenge}) ? 'blocked' : (${C.signedOut}) ? 'signin' : ((${C.signedIn}) && (${C.composer}) ? 'ready' : null)`;
C.finished = `(() => { const last = ${C.assistant}; return !!last && !(${C.stop}) && last.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') === 'complete'; })()`;
C.markdownRoot = C.assistant;
C.responseText = `(${C.assistant})?.innerText?.trim() || ''`;
C.probe = `(() => { const attrs = e => e ? Object.fromEntries([...e.attributes].map(a => [a.name, a.value])) : null;
  const describe = e => e ? ({ tag: e.tagName, attributes: attrs(e), text: (e.innerText || '').slice(0, 500) }) : null;
  return { composerCandidates: [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].map(describe),
    buttons: [...document.querySelectorAll('button')].map(e => ({ text: (e.innerText || '').slice(0, 150), ariaLabel: e.getAttribute('aria-label'), testId: e.getAttribute('data-testid') })),
    picker: describe(${C.picker}) , fileInputs: [...document.querySelectorAll('input[type="file"]')].map(describe),
    assistant: attrs(${C.assistant}), notices: ${C.notices} }; })()`;
C.menuProbe = `${C.items}.map(e => ({text: e.innerText, attributes: Object.fromEntries([...e.attributes].map(a => [a.name, a.value]))}))`;

export function chooseLabel(labels, current, { requested = 'strongest', strongest = CHATGPT_DEFAULTS.strongest, state = {}, now = Date.now() } = {}) {
  if (requested !== 'strongest') {
    const label = labels.find(label => label.toLowerCase() === requested.toLowerCase());
    if (!label) throw new Error(`C.items: model label not found: ${requested}`);
    return { model: label };
  }
  for (const word of strongest) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const label = labels.find(label => pattern.test(label) && !activeLimit(state, label, now));
    if (label) return { model: label };
  }
  if (!current) throw new Error('C.selected: current radio model is missing');
  return { model: current, note: 'No available strongest-label match; kept the current model' };
}
export function parseLimit(notice, now = Date.now()) {
  if (typeof notice !== 'string' || !C.limit.test(notice)) return null;
  let next;
  const iso = notice.match(C.resetIso), relative = notice.match(C.resetRelative), clock = notice.match(C.resetClock);
  if (iso) next = Date.parse(iso[1]);
  else if (relative) next = now + Number(relative[1]) * (/^h/i.test(relative[2]) ? 3_600_000 : /^m/i.test(relative[2]) ? 60_000 : 1000);
  else if (clock) {
    const date = new Date(now), hour = Number(clock[1]), minute = Number(clock[2]);
    if (minute < 60 && hour < 24 && (!clock[3] || hour >= 1 && hour <= 12)) {
      date.setHours(clock[3] ? hour % 12 + (/pm/i.test(clock[3]) ? 12 : 0) : hour, minute, 0, 0);
      if (date.getTime() <= now) date.setDate(date.getDate() + 1);
      next = date.getTime();
    }
  }
  return { notice, ...(Number.isFinite(next) && next > now ? { nextAt: new Date(next).toISOString() } : {}) };
}
class SiteOutcome extends Error {
  constructor(outcome, notice, extra = {}) { super(notice); this.outcome = outcome; Object.assign(this, extra); }
}
export class ChatGPTSite {
  constructor(tab, { log, now = Date.now, sleep: pause = sleep } = {}) { this.tab = tab; this.log = log; this.now = now; this.pause = pause; }
  async read(key) {
    try { return await this.tab.eval(C[key]); }
    catch (error) { throw new Error(`C.${key}: ${error.message}`); }
  }
  async guard() {
    let state = await this.read('state');
    if (state === 'blocked') state = await handOverChallenge(this.tab, {
      stateExpression: C.state, notice: 'A ChatGPT human verification check is waiting in a Chrome window for Lok',
      error: () => new Error('C.challenge: verification was shown to Lok but not completed within 20 minutes'),
      log: this.log, now: this.now, sleep: this.pause,
    });
    return state;
  }
  async requireReady() {
    if (await this.guard() === 'signin') throw new SiteOutcome('signed_out', 'C.signedOut: sign in with bin/chatgpt-web login');
  }
  async ready() {
    await this.tab.waitFor(C.state, 60_000, 'C.composer / C.signedIn / C.signedOut / C.challenge');
    return await this.guard() !== 'signin';
  }
  async inspect({ keepOpen = false } = {}) {
    const signedIn = await this.ready();
    if (!signedIn) return { signedIn: false, models: [] };
    await this.requireReady();
    await this.tab.click(C.picker, 'C.picker');
    this.menuOpen = true;
    await this.tab.waitFor(`${C.items}.length > 0`, 10_000, 'C.items');
    const info = { signedIn: true, models: [...new Set(await this.read('labels'))], current: await this.read('selected'), power: await this.read('power'), label: await this.read('modelLabel'), plan: await this.read('plan') };
    if (!keepOpen) await this.closeMenu();
    return info;
  }
  async closeMenu() {
    if (this.menuOpen) { await this.tab.key('Escape', 'Escape', 27); this.menuOpen = false; }
  }
  async select(label) {
    await this.requireReady();
    if (!this.menuOpen) throw new Error('C.items: inspect must open the model menu before selection');
    const item = `${C.items}.find(e => (e.innerText || e.getAttribute('aria-label') || '').trim().split('\\n')[0] === ${JSON.stringify(label)})`;
    await this.tab.waitFor(`!!(${item})`, 10_000, 'C.items');
    let disabled;
    try { disabled = await this.tab.eval(`(() => { const e = ${item}; return e?.getAttribute('aria-disabled') === 'true' || e?.hasAttribute('disabled'); })()`); }
    catch (error) { throw new Error(`C.items: ${error.message}`); }
    if (disabled) {
      const limit = await this.notice();
      if (limit) throw new SiteOutcome('limit', limit.notice, limit);
      throw new Error(`C.items: ${label} is disabled; no model fallback`);
    }
    if (await this.read('selected') !== label) await this.tab.click(item, 'C.items');
    await this.tab.waitFor(`(${C.selected}) === ${JSON.stringify(label)}`, 10_000, 'C.selected');
    let power = await this.read('power');
    const valid = value => value && Number.isSafeInteger(value.now) && Number.isSafeInteger(value.max) && value.now >= 0 && value.max >= value.now && value.max <= 100;
    if (!valid(power)) throw new Error('C.slider: missing or invalid power bounds');
    // Focus the slider without changing its value. Only real key events adjust it.
    await this.tab.eval(`(() => { const e = ${C.slider}; if (!e) throw new Error('C.slider: missing'); e.focus(); })()`);
    while (power.now < power.max) {
      const previous = power;
      await this.tab.key('ArrowRight', 'ArrowRight', 39);
      await this.tab.waitFor(`(${C.power})?.now > ${previous.now}`, 2000, 'C.slider (power did not advance)');
      power = await this.read('power');
      if (!valid(power) || power.max !== previous.max || power.now <= previous.now) throw new Error('C.slider: invalid power progress');
    }
    const id = await this.read('selected'), mode = await this.read('modelLabel');
    if (id !== label) throw new Error('C.selected: selected model changed while setting power');
    if (!mode) throw new Error('C.modelLabel: picker mode label is missing');
    await this.closeMenu();
    return { id, power, label: mode, model: `${id} · power ${power.now}/${power.max} (${mode})` };
  }
  async attach(files) {
    if (!files.length) return;
    await this.requireReady();
    if (!await this.tab.eval(`!!(${C.fileInput})`)) {
      await this.tab.click(C.attach, 'C.attach');
      const chooser = this.tab.b.waitEvent('Page.fileChooserOpened', this.tab.sessionId, 10_000).then(value => ({ value }), error => ({ error }));
      await this.tab.click(C.uploadItem, 'C.uploadItem');
      const chosen = await chooser;
      if (chosen.error) throw new Error(`C.fileInput: ${chosen.error.message}`);
      const { backendNodeId } = chosen.value;
      await this.tab.send('DOM.setFileInputFiles', { files, backendNodeId });
    } else {
      const evaluated = await this.tab.send('Runtime.evaluate', { expression: C.fileInput, returnByValue: false });
      const objectId = evaluated.result?.objectId;
      if (!objectId) throw new Error('C.fileInput: file input not found');
      await this.tab.send('DOM.setFileInputFiles', { files, objectId });
    }
    await this.tab.waitFor(`!(${C.uploading}) && ${JSON.stringify(files.map(file => path.basename(file)))}.every(name => (${C.fileNames}).includes(name))`, 60_000, 'C.uploading / C.fileNames');
  }
  async notice() {
    const notices = await this.read('notices');
    return notices.map(text => parseLimit(text, this.now())).find(Boolean);
  }
  async send(text) {
    await this.requireReady();
    const limit = await this.notice();
    if (limit) throw new SiteOutcome('limit', limit.notice, limit);
    await this.tab.click(C.composer, 'C.composer');
    await this.tab.eval(`(() => { const e = ${C.composer}; if (!e) throw new Error('C.composer: missing'); e.focus(); document.execCommand('selectAll'); document.execCommand('delete'); if (!document.execCommand('insertText', false, ${JSON.stringify(text)})) throw new Error('C.composer: insertText failed'); })()`);
    const before = await this.read('userCount');
    this.beforeAssistantCount = await this.read('assistantCount');
    const stoppedBefore = !!await this.tab.eval(C.stop);
    await this.tab.waitFor(`(() => { const e = ${C.send}; return e && !e.disabled && e.getAttribute('aria-disabled') !== 'true'; })()`, 60_000, 'C.send');
    await this.requireReady();
    await this.tab.click(C.send, 'C.send');
    // Never retry an uncertain send. Count only a new turn or generation signal.
    await this.tab.waitFor(`(${C.userCount}) > ${before} || (${C.assistantCount}) > ${this.beforeAssistantCount} || (${!stoppedBefore} && !!(${C.stop}))`, 20_000, 'C.userCount / C.assistantCount / C.stop (send confirmation)');
  }
  async answer(timeoutMs) {
    const started = this.now();
    while (this.now() - started < timeoutMs) {
      await this.pause(2000);
      if (await this.guard() === 'signin') throw new SiteOutcome('signed_out', 'C.signedOut: sign in with bin/chatgpt-web login');
      const newer = await this.read('assistantCount') > this.beforeAssistantCount;
      const limit = await this.notice() || (newer && parseLimit(await this.read('responseText'), this.now()));
      if (limit) return { outcome: 'limit', ...limit };
      if (newer && await this.read('finished')) {
        let answer;
        try { answer = await this.tab.eval(markdownExpression(C.markdownRoot)); }
        catch (error) { throw new Error(`C.assistant / C.markdownRoot: ${error.message}`); }
        if (!answer.trim()) throw new Error('C.assistant: completed answer was empty');
        return { outcome: 'done', answer };
      }
    }
    throw new Error('C.finished: answer timed out');
  }
  async probe() {
    // Probe must work even when normal readiness selectors need fixing.
    await this.tab.waitFor(C.pageReady, 60_000, 'C.pageReady');
    const state = await this.guard();
    const info = await this.read('probe');
    if (state !== 'signin') {
      try {
        await this.tab.click(C.picker, 'C.picker');
        await this.tab.waitFor(`${C.items}.length > 0`, 10_000, 'C.items');
        info.menuItems = await this.read('menuProbe');
        await this.tab.key('Escape', 'Escape', 27);
      } catch (error) { info.pickerError = `C.picker / C.items: ${error.message}`; }
    }
    return info;
  }
}

export function parseArgs(argv) {
  const [command, ...args] = argv, opts = { command, files: [], model: 'strongest', timeout: 1200 };
  if (!['login', 'check', 'probe', 'ask'].includes(command)) throw new Error('usage: chatgpt-web login|check|probe|ask <prompt-file> [--files F ...] [--model LABEL] [--timeout SECONDS] [--keep-chat] --out FILE');
  if (command !== 'ask' && args.length) throw new Error(`${command} takes no arguments`);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { if (opts.promptFile) throw new Error('ask takes one prompt file'); opts.promptFile = arg; continue; }
    if (!['--files', '--model', '--timeout', '--out', '--keep-chat'].includes(arg) || seen.has(arg)) throw new Error(`invalid or duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--keep-chat') { opts.keepChat = true; continue; }
    if (arg === '--files') {
      while (args[i + 1] && !args[i + 1].startsWith('--')) opts.files.push(args[++i]);
      if (!opts.files.length) throw new Error('--files needs paths');
    } else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = args[++i];
    }
  }
  if (command === 'ask') {
    if (!opts.promptFile || !opts.out) throw new Error('ask requires a prompt file and --out FILE');
    opts.timeout = Number(opts.timeout);
    if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('timeout must be positive seconds');
    if (!opts.model.trim()) throw new Error('model must be nonempty');
    opts.files = opts.files.map(file => path.resolve(file));
  }
  return opts;
}
export const exitCode = outcome => ({ done: 0, failed: 1, signed_out: 3, limit: 4, paced: 5 })[outcome] ?? 1;
export async function execute(opts, {
  env = process.env, config = loadConfig(env), now = Date.now, sleep: pause = sleep,
  launch = (cfg, options) => Browser.launch(cfg, options),
  createSite = (tab, options) => new ChatGPTSite(tab, options),
  login, log = value => process.stderr.write(JSON.stringify(value) + '\n'),
} = {}) {
  const home = chatgptHome(env), profile = path.join(home, 'profile'), cfg = settings(config);
  let release, browser, model = opts.model, radioId, note;
  let state;
  const result = (outcome, extra = {}) => ({ outcome, ...(model ? { model } : {}), answerChars: 0, ...(note ? { note } : {}), ...extra });
  try {
    let prompt;
    if (opts.command === 'ask') {
      prompt = fs.readFileSync(opts.promptFile, 'utf8');
      if (!prompt.trim()) throw new Error('prompt file is empty');
      for (const file of opts.files) if (!fs.statSync(file).isFile()) throw new Error(`attachment is not a file: ${file}`);
    }
    release = acquireLock(home);
    state = readState(home);
    if (opts.command === 'ask') await pace(state, cfg, { now, sleep: pause });
    const chrome = resolveTool('chrome', { env, config });
    if (!chrome) throw new Error('Chrome not found; run node setup.mjs');
    if (opts.command === 'login') {
      if (login) await login(chrome, profile);
      else {
        const { launchLogin } = await import('./engine.mjs');
        const child = launchLogin(chrome, profile, C.url);
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code ? reject(new Error(`Chrome exited ${code}`)) : resolve()); });
      }
      return result('done');
    }
    browser = await launch({ chrome }, { profile, profileLabel: 'ChatGPT web', menuText: `${C.labels}.join('\\n')` });
    const site = createSite(await browser.newTab(opts.command === 'ask' && !opts.keepChat ? C.temporaryUrl : C.url), { log, now, sleep: pause });
    if (opts.command === 'probe') return await site.probe();
    const info = await site.inspect({ keepOpen: opts.command === 'ask' });
    state.signedIn = info.signedIn; state.checkedAt = new Date(now()).toISOString(); state.models = info.models;
    if (info.plan) state.plan = info.plan; else delete state.plan;
    for (const key of ['current', 'power', 'label']) {
      if (info[key] !== undefined) state[key] = info[key]; else delete state[key];
    }
    writeState(home, state);
    if (opts.command === 'check') return {
      signedIn: info.signedIn, ...(info.plan ? { plan: info.plan } : {}), models: info.models,
      ...Object.fromEntries(['current', 'power', 'label'].filter(key => info[key] !== undefined).map(key => [key, info[key]])),
    };
    if (!info.signedIn) return result('signed_out', { notice: 'C.signedOut: run bin/chatgpt-web login, then check' });
    ({ model, note } = chooseLabel(info.models, info.current, { requested: opts.model, strongest: cfg.strongest, state, now: now() }));
    radioId = model;
    const limited = activeLimit(state, radioId, now());
    if (limited) return result('limit', limited);
    const selected = await site.select(radioId);
    radioId = selected.id; model = selected.model;
    const actualLimit = activeLimit(state, radioId, now());
    if (actualLimit) return result('limit', actualLimit);
    await site.attach(opts.files);
    await site.send(prompt);
    recordSent(home, state, now);
    const answer = await site.answer(opts.timeout * 1000);
    if (answer.outcome === 'limit') {
      state.limits = { ...state.limits, [radioId]: { notice: answer.notice, ...(answer.nextAt ? { nextAt: answer.nextAt } : {}) } };
      writeState(home, state);
      return result('limit', { ...(answer.model ? { model: answer.model } : {}), notice: answer.notice, ...(answer.nextAt ? { nextAt: answer.nextAt } : {}) });
    }
    fs.writeFileSync(opts.out, answer.answer);
    return result('done', { answerChars: answer.answer.length });
  } catch (error) {
    if (error.outcome === 'signed_out' && state) { state.signedIn = false; state.checkedAt = new Date(now()).toISOString(); writeState(home, state); }
    if (error.outcome === 'limit' && state && radioId) {
      state.limits = { ...state.limits, [radioId]: { notice: error.message, ...(error.nextAt ? { nextAt: error.nextAt } : {}) } };
      writeState(home, state);
    }
    return result(error.outcome ?? 'failed', { notice: error.message, ...(error.nextAt ? { nextAt: error.nextAt } : {}) });
  } finally {
    try { if (browser) await browser.close(); } finally { release?.(); }
  }
}
export async function cli(argv, options = {}) {
  const print = options.print ?? console.log;
  try {
    const opts = parseArgs(argv);
    if (opts.command === 'login') print('Sign in to ChatGPT in this Chrome window, then close it.');
    const result = await execute(opts, options);
    if (opts.command !== 'login' || result.outcome !== 'done') print(JSON.stringify(result));
    return opts.command === 'check' && result.signedIn !== undefined ? result.signedIn ? 0 : 3 : opts.command === 'probe' && !result.outcome ? 0 : exitCode(result.outcome);
  } catch (error) { print(JSON.stringify({ outcome: 'failed', answerChars: 0, notice: error.message })); return 1; }
}
if (isMain(import.meta.url)) process.exitCode = await cli(process.argv.slice(2));
