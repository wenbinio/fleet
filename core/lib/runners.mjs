import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI, capture, isMain, loadConfig, resolveTool } from './toolkit.mjs';
import * as api from './api.mjs';

export const aliases = { astra: 'gpt-6-astra', sol: 'gpt-6.1-sol', luna: 'gpt-6-luna' };
const effortValue = value => { if (!['low', 'medium', 'high', 'xhigh'].includes(value)) throw new Error('effort must be low, medium, high or xhigh'); return value; };
const positive = (value, label) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`); return n; };
export function codexArgs(opts, { cwd, last, session } = {}) {
  const mode = opts['read-only'] ? 'read-only' : 'workspace-write';
  const args = ['exec'];
  if (session) args.push('resume', session);
  args.push('--skip-git-repo-check', '--ignore-user-config', '-c', 'windows.sandbox="unelevated"', '--json', '-m', aliases[opts.model ?? 'astra'] ?? opts.model,
    '-c', `model_reasoning_effort=${JSON.stringify(effortValue(opts.effort ?? 'high'))}`);
  if (session) {
    args.push('-c', `sandbox_mode=${JSON.stringify(mode)}`);
    if (opts['add-dir']?.length) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(opts['add-dir'].map(d => path.resolve(d)))}`);
  } else {
    args.push('-s', mode, '-C', cwd);
    for (const dir of opts['add-dir'] ?? []) args.push('--add-dir', path.resolve(dir));
  }
  if (last) args.push('-o', last);
  // Put '-' before the variadic images; prompts always arrive on stdin.
  args.push('-');
  for (const file of opts.image ?? []) args.push('-i', path.resolve(file));
  return args;
}
export async function codexRun(argv) {
  const opts = CLI('codex-run <id> <prompt-file> [--cwd DIR] [--model astra|sol|luna|ID] [--effort low|medium|high|xhigh] [--add-dir DIR]... [--resume SESSION|last] [--image PNG]... [--read-only]', argv,
    { values: ['cwd', 'model', 'effort', 'resume'], repeat: ['add-dir', 'image'], booleans: ['read-only'] });
  if (!opts) return 0;
  const [id, promptFile] = opts._;
  if (opts._.length !== 2 || !/^[\w.-]+$/.test(id) || id === '.' || id === '..') throw new Error('Provide a safe run id and a prompt file');
  const prompt = fs.readFileSync(promptFile, 'utf8'), cwd = path.resolve(opts.cwd || process.cwd());
  const dir = path.join(loadConfig().runsDir, 'codex', id);
  let session = opts.resume;
  if (session === 'last') {
    try { session = fs.readFileSync(path.join(dir, 'session.txt'), 'utf8').trim(); } catch { throw new Error(`No saved session for ${id}`); }
    if (!session) throw new Error(`No saved session for ${id}`);
  }
  // Reserve each round atomically so two invocations cannot overwrite one another.
  fs.mkdirSync(dir, { recursive: true });
  let round = 1, fd;
  for (;;) { try { fd = fs.openSync(path.join(dir, `r${round}.events.jsonl`), 'wx'); break; } catch (e) { if (e.code !== 'EEXIST') throw e; round++; } }
  const last = path.join(dir, `r${round}.last.txt`), err = path.join(dir, `r${round}.stderr.txt`);
  fs.writeFileSync(last, ''); fs.writeFileSync(err, '');
  let result;
  try {
    result = await capture(resolveTool('codex'), codexArgs(opts, { cwd, last, session }), { cwd, input: prompt, timeout: 24 * 60 * 60 * 1000,
      onStdout: s => fs.writeSync(fd, s), onStderr: s => fs.appendFileSync(err, s) });
  } catch (e) { result = { code: 1, stdout: '', stderr: e.message }; fs.appendFileSync(err, e.message + '\n'); }
  finally { fs.closeSync(fd); }
  const savedMessage = fs.readFileSync(last, 'utf8');
  let message = savedMessage;
  for (const line of result.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && event.thread_id) session = event.thread_id;
      if (!savedMessage && event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text || '';
    } catch {}
  }
  if (session) fs.writeFileSync(path.join(dir, 'session.txt'), session + '\n');
  if (!fs.readFileSync(last, 'utf8') && message) fs.writeFileSync(last, message);
  console.log(`[${id}] round ${round} exit ${result.code}, session ${session || 'unknown'}`);
  if (message) console.log(message.slice(-3000));
  return result.code;
}
export async function codexImage(argv) {
  const opts = CLI('codex-image <dir> [ref.png ...] [--model sol] [--effort high]', argv, { values: ['model', 'effort'] });
  if (!opts) return 0;
  if (!opts._.length) throw new Error('Provide an image job directory containing prompt.txt');
  const dir = path.resolve(opts._[0]), prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  const args = codexArgs({ ...opts, model: opts.model ?? 'sol', image: opts._.slice(1) }, { cwd: dir });
  const log = path.join(dir, 'log.txt'); fs.writeFileSync(log, '');
  let code = 1;
  try { ({ code } = await capture(resolveTool('codex'), args, { cwd: dir, input: prompt, timeout: 24 * 60 * 60 * 1000, onStdout: s => fs.appendFileSync(log, s), onStderr: s => fs.appendFileSync(log, s) })); }
  catch (e) { fs.appendFileSync(log, e.message + '\n'); }
  fs.appendFileSync(log, `\nexit ${code}\n`); return code;
}
export const preamble = 'Use only your file-reading tool to open files. Never run shell or terminal commands.';
export function classifyAgy(result, schema = false) {
  let data;
  try { data = JSON.parse(result.stdout); } catch {}
  if (data?.denied_actions?.length || /no output produced/i.test(result.stderr)) return { code: 3, out: '', err: `denied: ${data?.denied_actions?.map(a => a.display_name || a.action || String(a)).join(', ') || 'no output produced'}\n` };
  const structured = data?.structured_output;
  const hasStructured = structured != null && (typeof structured !== 'object' ? String(structured).trim().length > 0 : Object.keys(structured).length > 0);
  const response = typeof data?.response === 'string' ? data.response.trim() : '';
  if (result.code !== 0 || result.timedOut || data?.status !== 'SUCCESS' || data?.error || !(schema ? hasStructured : response || hasStructured)) {
    return { code: 1, out: '', err: `${result.timedOut ? 'agy timed out' : data?.error || result.stderr || 'agy failed: expected SUCCESS with non-empty output'}\n` };
  }
  return { code: 0, out: (schema || !response ? JSON.stringify(structured) : data.response).trimEnd() + '\n', err: '' };
}
export async function agyJob(prompt, opts = {}) {
  const timeout = positive(opts.timeout ?? 600, 'timeout');
  const args = ['-p', opts['no-preamble'] ? prompt : `${preamble}\n\n${prompt}`, '--mode', 'plan', '--output-format', 'json', '--print-timeout', `${timeout}s`];
  if (opts.model) args.push('--model', opts.model);
  if (opts['json-schema']) args.push('--json-schema', opts['json-schema']);
  for (const dir of opts['add-dir'] ?? []) args.push('--add-dir', path.resolve(dir));
  try { return classifyAgy(await capture(resolveTool('agy'), args, { timeout: timeout * 1000 }), Boolean(opts['json-schema'])); }
  catch (e) { return { code: 1, out: '', err: e.message + '\n' }; }
}
export async function agyRun(argv) {
  const opts = CLI('agy-run <prompt-file> [--model M] [--add-dir D]... [--json-schema S] [--timeout 600] [--no-preamble]', argv,
    { values: ['model', 'json-schema', 'timeout'], repeat: ['add-dir'], booleans: ['no-preamble'] });
  if (!opts) return 0;
  if (opts._.length !== 1) throw new Error('Provide one prompt file');
  const result = await agyJob(fs.readFileSync(opts._[0], 'utf8'), opts);
  process.stdout.write(result.out); process.stderr.write(result.err); return result.code;
}
export const grokPreamble = "Read files only. Never edit files or run shell commands: this session can't, and trying ends the job.";
export function classifyGrok(result) {
  let data;
  try { data = JSON.parse(result.stdout); } catch {}
  const fail = error => ({ code: 1, out: '', err: String(error || 'grok failed') + '\n' });
  if (result.timedOut) return fail('grok timed out');
  if (result.code !== 0 || data?.type === 'error') return fail(data?.message || result.stderr || `grok exit ${result.code}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('grok failed: stdout is not JSON');
  const details = { answer: '', sessionId: data.sessionId ?? null, stopReason: data.stopReason ?? null, usage: data.usage ?? null };
  if (data.stopReason === 'cancelled') return { code: 3, out: '', err: 'denied: grok cancelled a tool call that needs approval (edit or shell); nothing was changed\n', json: details };
  if (data.stopReason !== 'end_turn') return fail(`stopped: ${data.stopReason}`);
  if (typeof data.text !== 'string' || !data.text.trim()) return fail('empty answer');
  return { code: 0, out: data.text.trimEnd() + '\n', err: '', json: { ...details, answer: data.text } };
}
export async function grokRun(argv, { env = process.env, run = capture, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text), tempRoot = os.tmpdir() } = {}) {
  const opts = CLI('grok-run <prompt-file> [--model M] [--cwd DIR] [--effort E] [--resume SESSION] [--timeout 600] [--no-preamble] [--json]', argv,
    { values: ['model', 'cwd', 'effort', 'resume', 'timeout'], booleans: ['no-preamble', 'json'] });
  if (!opts) return 0;
  if (opts._.length !== 1) throw new Error('Provide one prompt file');
  const cwd = path.resolve(opts.cwd ?? process.cwd()), source = path.resolve(opts._[0]);
  const timeout = positive(opts.timeout ?? 600, 'timeout');
  let temporary;
  try {
    let file = source;
    if (!opts['no-preamble']) {
      temporary = fs.mkdtempSync(path.join(tempRoot, 'toolkit-grok-'));
      file = path.join(temporary, 'prompt.txt');
      fs.writeFileSync(file, `${grokPreamble}\n\n${fs.readFileSync(source, 'utf8')}`);
    }
    const args = ['--prompt-file', file, '--output-format', 'json', '--no-auto-update', '--permission-mode', 'dontAsk', '--disallowed-tools', 'run_terminal_command,search_replace,write', '--cwd', cwd];
    for (const [key, flag] of [['model', '-m'], ['effort', '--effort'], ['resume', '-r']]) if (opts[key]) args.push(flag, opts[key]);
    let result;
    try { result = classifyGrok(await run(resolveTool('grok', { env }), args, { env, cwd, timeout: timeout * 1000, input: '' })); }
    catch (error) { result = { code: 1, out: '', err: error.message + '\n' }; }
    if (opts.json && result.json) stdout(JSON.stringify(result.json) + '\n');
    else if (!opts.json) stdout(result.out);
    stderr(result.err); return result.code;
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
}
export async function apiRun(argv, { env = process.env, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text), ...dependencies } = {}) {
  const opts = CLI('api-run <prompt-file> [--provider P] [--model M] [--max-tokens N] [--max-cost USD] [--system FILE] [--json] | --free-models [--provider P] [--n N]', argv,
    { values: ['provider', 'model', 'max-tokens', 'max-cost', 'system', 'n'], booleans: ['json', 'free-models'] });
  if (!opts) return 0;
  const options = { env, ...dependencies }, service = api.provider(opts.provider, options);
  if (opts['free-models']) {
    if (opts._.length) throw new Error('--free-models does not accept a prompt file');
    stdout((await api.pickFree(positive(opts.n ?? 4, 'n'), service, options)).join('\n') + '\n');
    return 0;
  }
  if (opts._.length !== 1 || opts.n !== undefined) throw new Error('Provide one prompt file');
  const result = await api.chat(service, {
    prompt: fs.readFileSync(opts._[0], 'utf8'), model: opts.model,
    ...(opts.system ? { system: fs.readFileSync(opts.system, 'utf8') } : {}),
    ...(opts['max-tokens'] !== undefined ? { maxTokens: positive(opts['max-tokens'], 'max-tokens') } : {}),
    ...(opts['max-cost'] !== undefined ? { maxCostUsd: Number(opts['max-cost']) } : {}),
  }, options);
  if (opts.json) stdout(JSON.stringify({ ...result, reasoning: result.reasoning.slice(0, 20_000) }) + '\n');
  else if (result.answer) stdout(result.answer.trimEnd() + '\n');
  if (result.error) stderr(result.error + '\n');
  return { done: 0, failed: 1, denied: 3, empty: 4, rate_limited: 5, daily_limit: 5 }[result.outcome] ?? 1;
}
export async function agyFan(argv) {
  const opts = CLI('agy-fan <prompt-file> (--target MODEL... | --n N [--model M]) [--max 4] [--timeout 600] [--add-dir D] [--json-schema S] [--no-preamble]', argv,
    { values: ['n', 'model', 'max', 'timeout', 'json-schema'], repeat: ['target', 'add-dir'], booleans: ['no-preamble'] });
  if (!opts) return 0;
  if (opts._.length !== 1 || Boolean(opts.target) === Boolean(opts.n) || (opts.target && opts.model)) throw new Error('Provide one prompt file and either repeated --target MODEL or --n N [--model M]');
  const targets = opts.target ?? Array(positive(opts.n, 'n')).fill(opts.model);
  const cap = positive(opts.max ?? 4, 'max'), prompt = fs.readFileSync(opts._[0], 'utf8');
  const root = path.join(loadConfig().runsDir, 'agy'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  console.log(`Runs: ${dir}`);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(cap, targets.length) }, async () => {
    while (next < targets.length) {
      const i = next++, start = Date.now(), result = await agyJob(prompt, { ...opts, model: targets[i] });
      for (const [ext, value] of [['out', result.out], ['err', result.err], ['rc', `${result.code}\n`]]) fs.writeFileSync(path.join(dir, `${i + 1}.${ext}`), value);
      console.log(`${i + 1}: model ${targets[i] || 'default'}, rc ${result.code}, seconds ${((Date.now() - start) / 1000).toFixed(2)}`);
      failed ||= result.code !== 0;
    }
  }));
  return failed ? 1 : 0;
}
export async function main() {
  try { const command = process.argv[2], fn = { 'codex-run': codexRun, 'codex-image': codexImage, 'agy-run': agyRun, 'agy-fan': agyFan, 'grok-run': grokRun, 'api-run': apiRun }[command]; if (!fn) throw new Error(`Unknown runner: ${command}`); process.exitCode = await fn(process.argv.slice(3)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

if (isMain(import.meta.url)) await main();
