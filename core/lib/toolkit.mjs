import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnWorker as spawn } from "./worker.mjs";
import { isDeepStrictEqual } from 'node:util';

export const toolNames = ['node', 'git', 'codex', 'agy', 'dsh', 'grok', 'claude', 'gh', 'python', 'ffmpeg', 'chrome', 'gemini'];
const overrides = { codex: 'CODEX_EXE', agy: 'AGY_EXE', dsh: 'DSH_CMD', grok: 'GROK_EXE', claude: 'CLAUDE_EXE', chrome: 'CHROME_EXE' };
export const userHome = (env = process.env) => env.HOME || env.USERPROFILE || os.homedir();
export const toolkitHome = (env = process.env) => env.FLEET_HOME || env.AGENT_TOOLKIT_HOME || path.join(userHome(env), '.agent-toolkit');
export function readConfig(env = process.env) {
  try { return JSON.parse(fs.readFileSync(path.join(toolkitHome(env), 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export function loadConfig(env = process.env) {
  return { runsDir: path.join(toolkitHome(env), 'runs'), advisorHome: path.join(toolkitHome(env), 'gemini-advisor'), ...readConfig(env), ...(env.ADVISOR_HOME ? { advisorHome: env.ADVISOR_HOME } : {}) };
}
export function saveConfig(config, env = process.env) {
  const file = path.join(toolkitHome(env), 'config.json');
  const body = JSON.stringify(config, null, 2) + '\n';
  if (fs.existsSync(file) && isDeepStrictEqual(readConfig(env), JSON.parse(body))) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try { fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return true;
}
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export function onPath(name, env = process.env, platform = process.platform) {
  // npm installs extensionless POSIX shims alongside the launchable Windows shims.
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').toLowerCase().split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.resolve(dir.replace(/^"|"$/g, ''), name + ext);
      if (isFile(candidate)) {
        try { fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return candidate; } catch {}
      }
    }
  }
  return null;
}
export function resolveTool(name, { env = process.env, config = loadConfig(env), platform = process.platform } = {}) {
  if (!toolNames.includes(name)) throw new Error(`Unknown tool: ${name}`);
  if (overrides[name] && env[overrides[name]]) return env[overrides[name]];
  const configured = config.tools?.[name] ?? config[name];
  if (typeof configured === 'string' && configured !== 'auto') return configured;
  // { strategy: 'discover' } deliberately re-evaluates the changing Codex hash directory.
  const local = env.LOCALAPPDATA;
  if (name === 'codex' && local) {
    const root = path.join(local, 'OpenAI', 'Codex', 'bin');
    let candidates = [];
    try { candidates = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => ({ file: path.join(root, d.name, 'codex.exe'), directoryMtime: fs.statSync(path.join(root, d.name)).mtimeMs })).filter(d => isFile(d.file)).map(d => ({ ...d, mtime: fs.statSync(d.file).mtimeMs })); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    candidates.sort((a, b) => b.mtime - a.mtime || b.directoryMtime - a.directoryMtime || a.file.localeCompare(b.file));
    if (candidates.length) return candidates[0].file;
  }
  if (name === 'dsh') return local ? [path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')].find(isFile) ?? onPath(name, env, platform) : onPath(name, env, platform);
  if (name === 'chrome') {
    return [env.ProgramFiles, env['ProgramFiles(x86)'], local].filter(Boolean).map(p => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(isFile)
      ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(isFile) ?? onPath('google-chrome', env, platform) ?? onPath('chromium', env, platform);
  }
  const found = onPath(name, env, platform);
  if (found) return found;
  if (name === 'agy' && local) return [path.join(local, 'agy', 'bin', 'agy.exe')].find(isFile) ?? null;
  if (name === 'grok' && platform === 'win32') return [path.join(env.USERPROFILE || userHome(env), '.grok', 'bin', 'grok.exe')].find(isFile) ?? null;
  if (name === 'claude') return (platform === 'win32' ? ['claude.exe', 'claude'] : ['claude']).map(file => path.join(userHome(env), '.local', 'bin', file)).find(isFile) ?? null;
  return null;
}
export async function signInStatus(name, { env = process.env, run = capture, readAuth = file => fs.readFileSync(file, 'utf8') } = {}) {
  if (!['codex', 'agy', 'dsh', 'grok'].includes(name)) throw new Error(`Unknown backend: ${name}`);
  const backend = name === 'dsh' ? 'deepseek' : name;
  const exe = resolveTool(name, { env });
  if (!exe) return { backend, found: false, signedIn: null, detail: name === 'grok' ? 'install from https://docs.x.ai/build/overview, only with Lok\'s ok' : 'not found; run node setup.mjs' };
  if (name === 'dsh') return { backend, found: true, signedIn: null, detail: 'account status is not inspected' };
  if (name === 'grok') {
    if (typeof env.XAI_API_KEY === 'string' && env.XAI_API_KEY.trim()) return { backend, found: true, signedIn: true, detail: 'XAI_API_KEY set' };
    try {
      const auth = JSON.parse(readAuth(path.join(env.GROK_HOME || path.join(userHome(env), '.grok'), 'auth.json')));
      const hasLogin = value => value && typeof value === 'object' && (
        ['refresh_token', 'key'].some(key => typeof value[key] === 'string' && value[key].trim()) ||
        Object.values(value).some(hasLogin)
      );
      if (hasLogin(auth)) return { backend, found: true, signedIn: true, detail: 'cached login (not verified)' };
    } catch { /* Missing, malformed and unreadable auth files never disclose contents. */ }
    return { backend, found: true, signedIn: false, detail: 'run yourself: grok login' };
  }
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => run(exe, name === 'codex' ? ['login', 'status'] : ['models'], { env, timeout: 30_000 })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 30_000); }),
    ]);
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const signedIn = result.code === 0 && (name !== 'agy' || /gemini|claude|gpt|"models"\s*:\s*\[\s*[^\]]/i.test(text)) && !/not logged|not signed|unauthenticated|please.*log.?in/i.test(text);
    return { backend, found: true, signedIn, detail: signedIn ? 'signed in' : `sign-in not confirmed; run yourself: ${name === 'codex' ? 'codex login' : 'agy'}` };
  } catch {
    return { backend, found: true, signedIn: false, detail: 'status check failed or timed out' };
  } finally { clearTimeout(timer); }
}
export function CLI(usage, argv = process.argv.slice(2), { values = [], repeat = [], booleans = [] } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage); return null; }
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { opts._.push(arg); continue; }
    const key = arg.slice(2);
    if (booleans.includes(key)) { opts[key] = true; continue; }
    if (!values.includes(key) && !repeat.includes(key)) throw new Error(`Unknown option: ${arg}\n${usage}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (repeat.includes(key)) (opts[key] ??= []).push(value); else opts[key] = value;
  }
  return opts;
}
export const isMain = url => process.argv[1] && url === pathToFileURL(path.resolve(process.argv[1])).href;

// cmd shims require two parsing layers (cmd itself, then the shim's command).
// Escape metacharacters even inside quotes; never interpolate arguments into PowerShell source.
function cmdArg(value) {
  return ('"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1') + '"').replace(/([()%!^"<>&|;, *?])/g, '^$1').replace(/([()%!^"<>&|;, *?])/g, '^$1');
}
export function launch(exe, args, options = {}) {
  if (!exe) throw new Error('Executable not found; run node setup.mjs');
  if (/\.[cm]?js$/i.test(exe)) return spawn(process.execPath, [exe, ...args], { windowsHide: true, ...options });
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    const command = exe.replace(/([()%!^"<>&|;, *?])/g, '^$1');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command} ${args.map(cmdArg).join(' ')}"`], { windowsHide: true, ...options, windowsVerbatimArguments: true });
  }
  return spawn(exe, args, { windowsHide: true, ...options });
}
export async function capture(exe, args, { input = '', timeout = 600000, cwd, env = process.env, onStdout, onStderr } = {}) {
  let stdout = '', stderr = '', timedOut = false;
  // An ask worker owns the runner's process group; keep CLI descendants in it
  // so interruption reaches both the runner and its actual backend.
  const attachedGroup = env.AGENT_TOOLKIT_CAPTURE_ATTACHED === '1';
  const child = launch(exe, args, { cwd, env, detached: process.platform !== 'win32' && !attachedGroup, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', s => { stdout += s; onStdout?.(s); });
  child.stderr.on('data', s => { stderr += s; onStderr?.(s); });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else { try { process.kill(attachedGroup ? -process.pid : -child.pid, 'SIGKILL'); } catch { child.kill(); } }
  }, timeout);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
    return { code: timedOut ? 1 : code, stdout, stderr, timedOut };
  } finally { clearTimeout(timer); }
}

export function main() {
  try {
    const opts = CLI('node lib/toolkit.mjs <tool> | --config', process.argv.slice(2), { booleans: ['config'] });
    if (opts) { const value = opts.config ? JSON.stringify(loadConfig()) : resolveTool(opts._[0]); if (!value) throw new Error(`Tool not found: ${opts._[0]}`); console.log(value); }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

if (isMain(import.meta.url)) main();
