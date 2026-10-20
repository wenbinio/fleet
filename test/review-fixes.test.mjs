import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { spawn as spawnNode } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { saveConfig } from "../core/lib/toolkit.mjs";
import * as toolkit from "../core/lib/toolkit.mjs";
import { localRoot, localProvider, localDefaults, localStatus, ensureLocalReady, gpuGuard, QWEN_FOLDER, QWEN_MODEL, QWEN_LOADED } from "../core/lib/local.mjs";
import { chat, provider } from "../core/lib/api.mjs";
import { quotaLimited } from "../core/lib/quota.mjs";
import { classifyGrok, classifyAgy, grokRun, apiRun } from "../core/lib/runners.mjs";
import { reviewPrompt, FINDINGS_SCHEMA } from "../core/lib/review.mjs";
import { withFreshBrowser, deployWait } from "../core/lib/browser-tasks.mjs";
import { Browser, processExit } from "../core/lib/webchat/engine.mjs";
import { inspectBackend, setupToolkitFleet, localSetupCommand } from "../install.mjs";
import { accounts } from "../runner/lib/accounts.mjs";
import { ADAPTERS } from "../runner/lib/adapters.mjs";
import { startAsk, atomicJson, readJson, runDirectory, validateAsk } from "../runner/lib/jobs.mjs";
import { startOperation, runOperation } from "../runner/lib/operations.mjs";
import { reviewChildState } from "../runner/lib/job-recovery.mjs";
import { persistTerminal, runAskJob } from "../runner/ask-job.mjs";
import { CORE_ROOT, injectRuntime } from "../runner/lib/runtime.mjs";
import { callTool, TOOLS } from "../mcp/fleet-mcp.mjs";

const real = name => fs.readFileSync(new URL(`./fixtures/review-real/${name}`, import.meta.url), "utf8");
const response = (data, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(data) });
const offline = () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); };
function fixture(t) {
  const scratch = fileURLToPath(new URL("../.test-tmp/", import.meta.url)); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "review-fixes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const folder = path.join(root, "Qwen"), env = { HOME: root, USERPROFILE: root, FLEET_HOME: path.join(root, "home"), AGENT_TOOLKIT_HOME: "", PATH: "", Path: "", FLEET_WORKER: "", CHATGPT_WEB_HOME: path.join(root, "web") };
  fs.mkdirSync(path.join(folder, "checks"), { recursive: true }); fs.writeFileSync(path.join(folder, "Start-Qwen.ps1"), "# fixture; never executed");
  atomicJson(path.join(folder, "checks/model.json"), { verified: true });
  const config = localDefaults({ local: { root: folder }, providers: [], tools: { chrome: "fake", grok: "fake" } }, { env }); saveConfig(config, env);
  injectRuntime(env, { repo: CORE_ROOT, toolkit: { ...toolkit, capture: async () => ({ code: 1 }), signInStatus: async () => ({ found: false, signedIn: null }) } });
  return { root, folder, env, config, dataDir: path.join(env.FLEET_HOME, "fleet") };
}
const health = async url => response(url.endsWith("/health") ? { status: "ok" } : { is_sleeping: true });
const spawnJob = () => { const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child; };
const starterProcess = () => { const child = new EventEmitter(); child.unref = () => {}; return child; };
test("local root precedence is environment, config root, legacy folder, then Windows-only default", async t => {
  const f = fixture(t), config = { local: { root: f.folder, folder: "legacy" } }, env = { ...f.env, FLEET_LOCAL_ROOT: path.join(f.root, "override") };
  assert.equal(localRoot(config, { env, platform: "linux" }), env.FLEET_LOCAL_ROOT);
  assert.equal(localRoot(config, { env: {}, platform: "linux" }), f.folder);
  assert.equal(localRoot({ local: { folder: "legacy" } }, { env: {}, platform: "linux" }), "legacy");
  assert.equal(localRoot({}, { env: {}, platform: "win32" }), QWEN_FOLDER);
  for (const platform of ["linux", "darwin"]) {
    assert.equal(localRoot({}, { env: {}, platform }), null);
    assert.equal(localProvider({}, undefined, { env: {}, platform }).start, undefined);
    assert.deepEqual(localDefaults({}, { env: {}, platform, exists: () => assert.fail("no implicit filesystem root") }), {});
    const status = await inspectBackend("local", { config: {}, env: {}, platform, apiOptions: { exists: () => assert.fail(), fetch: () => assert.fail() } });
    assert.equal(status.found, false); assert.equal(status.ready, false);
    assert.match(localSetupCommand(status), /local\.root.*FLEET_LOCAL_ROOT/);
    assert.ok(!localSetupCommand(status).includes("D:"));
  }
  const resolved = localProvider(f.config, undefined, { env, platform: "linux" });
  assert.equal(resolved.start.file, path.join(env.FLEET_LOCAL_ROOT, "Start-Qwen.ps1"));
  assert.equal(provider("local", { config: f.config, env, platform: "linux" }).start.file, resolved.start.file);
  const defaults = localDefaults(f.config, { env, platform: "linux", exists: file => file === env.FLEET_LOCAL_ROOT });
  assert.equal(defaults.providers.find(row => row.name === "local").start.file, resolved.start.file);
  assert.ok(localSetupCommand({ engine: "llama.cpp", executable: resolved.start.file }).includes(env.FLEET_LOCAL_ROOT));
});
test("environment root replaces a setup-saved starter for status and startup", async t => {
  const f = fixture(t), root = path.join(f.root, "relocated"), env = { ...f.env, FLEET_LOCAL_ROOT: root };
  fs.mkdirSync(path.join(root, "checks"), { recursive: true });
  fs.writeFileSync(path.join(root, "Start-Qwen.ps1"), "# fixture");
  atomicJson(path.join(root, "checks/model.json"), { verified: true });
  assert.equal((await localStatus({ env, config: f.config, platform: "linux", probe: false })).ready, true);
  let started = false;
  await ensureLocalReady({ env, runDir: f.root, config: f.config, platform: "linux",
    fetch: async () => started ? response({ status: "ok" }) : offline(),
    spawnStarter: (exe, args) => { assert.equal(exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"); assert.equal(args.at(-1), path.join(root, "Start-Qwen.ps1")); started = true; return starterProcess(); },
  });
  assert.equal(started, true);
});
test("Qwen setup migrates old default Ollama without importing or losing its configuration", t => {
  const f = fixture(t), old = { name: "local", kind: "openai", local: true, baseUrl: "http://localhost:11434/v1" };
  const config = localDefaults({ local: { folder: f.folder, default: "old:model" }, providers: [old] }, { env: f.env });
  assert.equal(config.local.default, QWEN_MODEL); assert.equal(config.local.provider, "local");
  assert.equal(localProvider(config, undefined, { env: f.env }).baseUrl, "http://127.0.0.1:8088/v1");
  assert.equal(localProvider(config, undefined, { env: f.env }).start.shell, "powershell");
  assert.equal(localProvider(config, "ollama", { env: f.env }).baseUrl, old.baseUrl);
  assert.equal(localProvider(config, "ollama", { env: f.env }).engine, "ollama");
  assert.deepEqual(localDefaults(config, { env: f.env }), config);
  const absent = { local: { folder: path.join(f.root, "missing") }, providers: [old] };
  assert.deepEqual(localDefaults(absent, { env: f.env }), absent);
});
test("Qwen found/ready uses folder, start script and verified receipt; menu and setup never start it", async t => {
  const f = fixture(t), noHTTP = { fetch: () => assert.fail("files-only inspection must not call HTTP") };
  let status = await inspectBackend("local", { env: f.env, config: f.config, apiOptions: noHTTP, run: () => assert.fail("no startup during setup") });
  assert.equal(status.found, true); assert.equal(status.ready, true);
  atomicJson(path.join(f.folder, "checks/model.json"), { verified: false });
  status = await localStatus({ env: f.env, config: f.config, probe: false, ...noHTTP });
  assert.equal(status.ready, false); assert.equal(status.models[0].id, QWEN_MODEL);
  const [menu] = await accounts({ backend: "local", env: f.env, apiOptions: noHTTP, discover: async () => ({ code: 1 }) });
  assert.equal(menu.ready, false); assert.equal(menu.models[0].id, QWEN_MODEL);
  assert.ok(menu.notes.includes("effort: low|medium|high")); assert.ok(menu.notes.some(note => note.includes("five idle minutes")));
  fs.rmSync(path.join(f.folder, "Start-Qwen.ps1"));
  assert.equal((await localStatus({ env: f.env, config: f.config, probe: false })).found, false);
});
test("root setup delegation configures Qwen with dry-run and idempotent reporting", async t => {
  const f = fixture(t), rows = [], minimal = { local: { folder: f.folder }, providers: [] };
  saveConfig(minimal, f.env);
  const options = { env: f.env, dryRun: true, report: (...row) => rows.push(row) };
  await setupToolkitFleet(options, { setup: async () => {} });
  assert.equal(readJson(path.join(f.env.FLEET_HOME, "config.json")).providers.length, 0);
  assert.ok(rows.some(row => row[0] === "local Qwen" && row[1] === "skipped"));
  options.dryRun = false; rows.length = 0;
  await setupToolkitFleet(options, { setup: async () => {} });
  assert.equal(readJson(path.join(f.env.FLEET_HOME, "config.json")).local.default, QWEN_MODEL);
  assert.ok(rows.some(row => row[1] === "installed"));
  rows.length = 0; await setupToolkitFleet(options, { setup: async () => {} });
  assert.equal(rows.length, 0);
});
test("Qwen health-first startup uses file stdio and an independent 240-second deadline", async t => {
  const f = fixture(t), calls = []; let started = false, clock = 0;
  await ensureLocalReady({ env: f.env, runDir: f.root, fetch: async () => { if (!started) return offline(); return response({ status: "ok" }); },
    spawnStarter: (exe, args, options) => { calls.push({ exe, args }); assert.deepEqual(options.stdio, ['ignore', options.stdio[1], options.stdio[1]]); assert.equal(typeof options.stdio[1], 'number'); assert.equal(options.windowsHide, true); assert.equal(options.env.FLEET_WORKER, '1'); started = true; return starterProcess(); }, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.deepEqual(calls[0], { exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(f.folder, "Start-Qwen.ps1")] });
  assert.equal(calls.length, 1);
  fs.rmSync(path.join(f.folder, "checks/model.json"));
  await ensureLocalReady({ env: f.env, runDir: f.root, fetch: async () => response({ status: "ok" }), spawnStarter: () => assert.fail("healthy server must be reused") });
  await ensureLocalReady({ env: f.env, runDir: f.root, fetch: async () => response({ status: "no slot available" }, 503), spawnStarter: () => assert.fail("busy healthy server must be reused") });
  atomicJson(path.join(f.folder, "checks/model.json"), { verified: true });
  await assert.rejects(ensureLocalReady({ env: f.env, runDir: f.root, fetch: offline, spawnStarter: starterProcess, now: () => clock, sleep: async ms => { assert.ok(ms <= 1000); clock += ms; } }), { message: `local server did not become ready (see ${path.join(f.folder, 'logs')})` });
  assert.equal(clock, 240_000);
});
test("starter readiness never waits for close or inherited-pipe EOF and includes slow probes in its deadline", async t => {
  const f = fixture(t), phases = [], starter = starterProcess();
  // This fake represents a starter whose descendant retains the inherited pipes:
  // neither EOF nor close will arrive until the test explicitly cleans it up.
  starter.stdout = new PassThrough(); starter.stderr = new PassThrough();
  let clock = 0, launched = false, polls = 0;
  try {
    await ensureLocalReady({ env: f.env, runDir: f.root, now: () => clock, sleep: async ms => { clock += ms; }, onPhase: phase => phases.push(phase),
      spawnStarter: (exe, args, options) => { assert.deepEqual(options.stdio, ['ignore', options.stdio[1], options.stdio[1]]); assert.equal(typeof options.stdio[1], 'number'); launched = true; return starter; },
      fetch: async () => { if (!launched) return offline(); return ++polls < 3 ? response({ status: 'loading model' }, 503) : response({ status: 'no slot available' }, 503); },
    });
    assert.equal(starter.stdout.readableEnded, false); assert.equal(starter.stderr.readableEnded, false);
    assert.equal(clock, 2000); assert.deepEqual(phases, ['starting-server', 'waiting-ready']);
  } finally { starter.stdout.destroy(); starter.stderr.destroy(); }
  clock = 0;
  await assert.rejects(ensureLocalReady({ env: f.env, runDir: f.root, now: () => clock, spawnStarter: starterProcess, sleep: async ms => { clock += ms; },
    fetch: async () => { clock += Math.min(5000, 240_000 - clock); return response({ status: 'loading model' }); },
  }), /local server did not become ready/);
  assert.equal(clock, 240_000);
});
test("starter preserves environment, resolves absolute PowerShell and uses platform-specific detachment", async t => {
  const f = fixture(t);
  for (const platform of ['win32', 'linux']) {
    const env = { ...f.env, SystemRoot: 'M:\\FixtureWindows', PATH: 'fixture-path', TEMP: f.root, retained: 'unchanged' }, original = { ...env };
    let started = false, descriptor;
    await ensureLocalReady({ env, platform, runDir: path.join(f.root, platform),
      fetch: async () => started ? response({ status: 'ok' }) : offline(),
      spawnStarter: (exe, args, options) => {
        assert.equal(exe, 'M:\\FixtureWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.deepEqual(options.env, { ...original, FLEET_WORKER: '1' }); assert.deepEqual(env, original);
        assert.equal(options.detached, platform !== 'win32'); assert.equal(options.windowsHide, true);
        assert.equal(options.stdio[0], 'ignore'); assert.equal(options.stdio[1], options.stdio[2]); descriptor = options.stdio[1];
        fs.writeSync(descriptor, 'starter diagnostic\n'); started = true; return starterProcess();
      },
    });
    assert.equal(fs.readFileSync(path.join(f.root, platform, 'local-start.log'), 'utf8'), 'starter diagnostic\n');
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  }
});
test("missing and failed starters fail promptly with notes and last 1000 log characters; exit zero remains in timeout failure", async t => {
  const f = fixture(t), tail = 'x'.repeat(990) + 'FINAL-TAIL';
  for (const mode of ['sync', 'async', 'nonzero', 'zero']) {
    const notes = [], runDir = path.join(f.root, mode); let clock = 0;
    await assert.rejects(ensureLocalReady({ env: f.env, runDir, fetch: offline, now: () => clock, sleep: async ms => { clock += ms; }, onNote: note => notes.push(note),
      spawnStarter: (exe, args, options) => {
        fs.writeSync(options.stdio[1], 'EXCLUDED-PREFIX' + tail);
        const error = Object.assign(new Error('fixture executable unavailable'), { code: mode === 'sync' ? 'ENOENT' : 'EACCES' });
        if (mode === 'sync') throw error;
        const child = starterProcess();
        queueMicrotask(() => mode === 'async' ? child.emit('error', error) : child.emit('exit', mode === 'zero' ? 0 : 7, null));
        return child;
      },
    }), error => {
      assert.match(error.message, /local server did not become ready/);
      assert.ok(error.message.endsWith(('EXCLUDED-PREFIX' + tail).slice(-1000)));
      assert.ok(!error.message.includes('EXCLUDED-PREFIX'));
      assert.match(error.message, mode === 'sync' ? /ENOENT/ : mode === 'async' ? /EACCES/ : new RegExp(`exited with code ${mode === 'zero' ? 0 : 7}`));
      return true;
    });
    assert.equal(notes.length, 1); assert.equal(clock, mode === 'zero' ? 240_000 : 0);
  }
});
test("real fake launcher can exit while its inherited-stdio server stays alive without blocking readiness", { timeout: 300_000 }, async t => {
  const f = fixture(t), file = fileURLToPath(new URL('./fixtures/local-starter.mjs', import.meta.url));
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, FLEET_HOME: f.env.FLEET_HOME, AGENT_TOOLKIT_HOME: '', FLEET_LOCAL_ROOT: f.folder, TEMP: f.root, TMP: f.root, TMPDIR: f.root };
  let starter, spawnError, serverPid, starterDone;
  const fixtureDeadline = Date.now() + 60_000;
  try {
    await ensureLocalReady({ env, runDir: f.root,
      spawnStarter: (exe, args, options) => {
        assert.deepEqual(options.stdio, ['ignore', options.stdio[1], options.stdio[1]]); assert.equal(typeof options.stdio[1], 'number'); assert.equal(options.windowsHide, true);
        starter = spawnNode(process.execPath, [file, 'starter', f.root], options);
        starter.on('error', error => { spawnError = error; });
        starterDone = new Promise(resolve => { starter.once('exit', code => resolve(code)); starter.once('error', () => resolve(null)); });
        assert.equal(starter.stdout, null); assert.equal(starter.stderr, null);
        return starter;
      },
      sleep: async () => { if (Date.now() >= fixtureDeadline) throw new Error(`fake launcher did not publish readiness: ${fs.readFileSync(path.join(f.root, 'local-start.log'), 'utf8')}`); await delay(25); },
      fetch: async () => {
        if (fs.existsSync(path.join(f.root, 'spawn-error'))) spawnError = Object.assign(new Error('fixture descendant failed to spawn'), { code: fs.readFileSync(path.join(f.root, 'spawn-error'), 'utf8') });
        if (!fs.existsSync(path.join(f.root, 'server-pid'))) return offline();
        serverPid = Number(fs.readFileSync(path.join(f.root, 'server-pid'), 'utf8'));
        return response({ status: 'ok' });
      },
    });
    let exitTimer;
    try { assert.equal(await Promise.race([starterDone, new Promise((resolve, reject) => { exitTimer = setTimeout(() => reject(new Error('fake starter did not exit after readiness handshake')), 30_000); })]), 0); }
    finally { clearTimeout(exitTimer); }
    assert.ok(serverPid > 0); process.kill(serverPid, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'stop-server')), false);
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(spawnError?.code ?? error.code)) t.skip(`child processes unavailable: ${spawnError?.code ?? error.code}`);
    else throw error;
  } finally {
    fs.writeFileSync(path.join(f.root, 'stop-server'), '');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!serverPid && fs.existsSync(path.join(f.root, 'server-pid'))) serverPid = Number(fs.readFileSync(path.join(f.root, 'server-pid'), 'utf8'));
      let serverLive = false;
      if (serverPid) try { process.kill(serverPid, 0); serverLive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (!serverLive && (!starter?.pid || starter.exitCode !== null || starter.signalCode !== null)) break;
      await delay(50);
    }
    if (serverPid) try { process.kill(serverPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (starter?.pid && starter.exitCode === null && starter.signalCode === null) starter.kill();
  }
});
test("local chat timeout defaults to 20 minutes, accepts job overrides and covers response body reads", async t => {
  const f = fixture(t), service = localProvider(f.config, undefined, { env: f.env });
  for (const timeout of [undefined, 45]) {
    const seen = [];
    const result = await chat(service, { prompt: 'x', model: QWEN_MODEL, ...(timeout !== undefined ? { timeout } : {}) }, {
      timeoutSignal: ms => { seen.push(ms); return new AbortController().signal; }, fetch: async () => response({ choices: [{ message: { content: 'ok' } }] }),
    });
    assert.equal(result.outcome, 'done'); assert.deepEqual(seen, [timeout === undefined ? 1_200_000 : 45_000]);
  }
  const controller = new AbortController();
  const timedOut = await chat(service, { prompt: 'x', model: QWEN_MODEL, timeout: 1 }, {
    timeoutSignal: () => controller.signal,
    fetch: async (url, { signal }) => ({ status: 200, ok: true, text: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      queueMicrotask(() => controller.abort(new DOMException('deadline', 'TimeoutError')));
    }) }),
  });
  assert.equal(timedOut.outcome, 'failed'); assert.match(timedOut.error, /request timed out/);
  for (const timeout of [0, -1, NaN]) assert.throws(() => validateAsk({ backend: 'local', prompt: 'x', timeout }, { env: f.env }), /timeout/);
  assert.equal(TOOLS.find(tool => tool.name === 'fleet_ask').inputSchema.properties.timeout.type, 'number');
});
test("local runner phases persist through the worker and are exposed by fleet_status with custom timeout", async t => {
  const f = fixture(t), phases = [], statuses = [], timeouts = [];
  const job = await startAsk({ backend: 'local', prompt: 'x', timeout: 45 }, { env: f.env, spawnJob,
    gpuOptions: { fetch: health, run: async () => ({ code: 0, stdout: '16384,0,16384' }) } });
  const directory = runDirectory(f.dataDir, job.runId);
  atomicJson(path.join(directory, 'run.json'), { ...readJson(path.join(directory, 'run.json')), notes: ['retained diagnostic'] });
  const completed = await runAskJob(directory, { env: f.env, spawnBackend: (exe, args, options) => {
    assert.ok(args.includes('--timeout')); assert.equal(args[args.indexOf('--timeout') + 1], '45');
    const child = new EventEmitter(); child.pid = process.pid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(async () => {
      let started = false;
      try {
        const code = await apiRun(args.slice(2), { env: options.env,
          spawnStarter: () => { started = true; const starter = starterProcess(); queueMicrotask(() => starter.emit('exit', 0, null)); return starter; },
          fetch: async url => {
            // Let MCP finish reading the current persisted phase before advancing.
            await Promise.all(statuses);
            return url.endsWith('/health') ? started ? response({ status: 'no slot available' }, 503) : offline() : response({ choices: [{ message: { content: 'ok' } }] });
          },
          timeoutSignal: ms => { timeouts.push(ms); return new AbortController().signal; },
          stdout: text => child.stdout.write(text), stderr: text => {
            // Split chunks exercise the worker's line buffering.
            child.stderr.write(text.slice(0, 8)); child.stderr.write(text.slice(8));
            const phase = JSON.parse(text).fleetLocalPhase;
            if (phase) {
              phases.push(readJson(path.join(directory, 'run.json')).phase);
              statuses.push(callTool('fleet_status', { runId: job.runId }, { env: f.env }).then(result => { assert.equal(result.value.phase, phase); }));
            }
          },
        });
        child.stdout.end(); child.stderr.end(); child.emit('close', code);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  } });
  await Promise.all(statuses);
  assert.deepEqual(phases, ['starting-server', 'waiting-ready', 'generating']);
  assert.deepEqual(timeouts, [45_000]); assert.equal(completed.timeout, 45); assert.equal(completed.phase, 'generating'); assert.equal(completed.status, 'done');
  assert.deepEqual(completed.notes, ['retained diagnostic', 'local starter exited with code 0']);
});
test("local worker stores starter spawn failure notes and bounded log tail without sending inference", async t => {
  const f = fixture(t);
  const job = await startAsk({ backend: 'local', prompt: 'x' }, { env: f.env, spawnJob,
    gpuOptions: { fetch: health, run: async () => ({ code: 0, stdout: '16384,0,16384' }) } });
  const directory = runDirectory(f.dataDir, job.runId);
  const completed = await runAskJob(directory, { env: f.env, spawnBackend: (exe, args, options) => {
    const child = new EventEmitter(); child.pid = process.pid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(async () => {
      try {
        await apiRun(args.slice(2), { env: options.env, stdout: text => child.stdout.write(text), stderr: text => child.stderr.write(text),
          fetch: async url => { assert.ok(url.endsWith('/health')); return offline(); },
          spawnStarter: (command, argv, opts) => { fs.writeSync(opts.stdio[2], 'starter log evidence'); throw Object.assign(new Error('missing starter'), { code: 'ENOENT' }); },
        });
        child.emit('error', new Error('startup unexpectedly succeeded'));
      } catch (error) { child.stderr.end(error.message); child.stdout.end(); child.emit('close', 1); }
    });
    return child;
  } });
  assert.equal(completed.status, 'failed'); assert.ok(completed.notes.some(note => note.includes('ENOENT')));
  assert.match(completed.error, /local server did not become ready/); assert.match(completed.error, /starter log evidence/);
  assert.equal(fs.readFileSync(path.join(directory, 'local-start.log'), 'utf8'), 'starter log evidence');
});
test("llama.cpp requests map optional effort, omit keep_alive and never retry through a different engine", async t => {
  const f = fixture(t), service = localProvider(f.config, undefined, { env: f.env });
  for (const effort of [undefined, "low", "medium", "high"]) {
    const calls = [];
    const result = await chat(service, { prompt: "private", model: QWEN_MODEL, effort }, { keyReader: () => assert.fail(), fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return response({ choices: [{ message: { content: "answer" } }], usage: { cost: 99 } }); } });
    assert.equal(result.costUsd, 0); assert.equal(calls.length, 1); assert.match(calls[0].url, /127\.0\.0\.1:8088\/v1\/chat\/completions$/);
    assert.equal(calls[0].body.reasoning_effort, effort); assert.equal(Object.hasOwn(calls[0].body, "reasoning_effort"), effort !== undefined);
    assert.equal(calls[0].body.keep_alive, undefined); assert.equal(calls[0].body.reasoning, undefined);
  }
  for (const effort of ["", "xhigh"]) assert.throws(() => validateAsk({ backend: "local", prompt: "x", effort }, { env: f.env }), /effort/);
});
test("Qwen GPU guard warns on partial offload and sound waits for sleep, with persistent final note", async t => {
  const f = fixture(t), options = { env: f.env, fetch: health, run: async () => ({ code: 0, stdout: "16384,8192,8192" }) };
  assert.deepEqual(await gpuGuard("local", options), { notice: "partial CPU offload likely: free 8.0 GB < model 12 GB" });
  await gpuGuard("local", { ...options, fetch: async url => response(url.endsWith("/health") ? { status: "ok" } : { is_sleeping: false }), run: () => assert.fail("already loaded") });
  await assert.rejects(gpuGuard("local", { ...options, existing: [{ backend: "sound", status: "running" }] }), /gpu busy/);
  await assert.rejects(gpuGuard("sound", { ...options, existing: [{ backend: "local", status: "running" }] }), { message: QWEN_LOADED });
  await assert.rejects(gpuGuard("sound", { ...options, fetch: async url => response(url.endsWith("/health") ? { status: "ok" } : { is_sleeping: false }) }), { message: QWEN_LOADED });
  await gpuGuard("sound", options); await gpuGuard("sound", { ...options, fetch: offline });
  const job = await startAsk({ backend: "local", prompt: "x", effort: "medium" }, { env: f.env, gpuOptions: options, spawnJob });
  const directory = runDirectory(f.dataDir, job.runId);
  const completed = await runAskJob(directory, { env: f.env, spawnBackend: () => {
    const child = new EventEmitter(); child.pid = process.pid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end('{"outcome":"done","answer":"ok","reasoning":"","costUsd":0}'); child.stderr.end(); child.emit("close", 0); });
    return child;
  } });
  assert.equal(completed.status, "done"); assert.equal(completed.effort, "medium"); assert.equal(completed.note, job.notice);
});
function fakeBrowser() {
  return { listeners: new Set(), close: async () => true, send: async method => method === "Target.getTargets" ? { targetInfos: [{ type: "page", targetId: "p", url: "about:blank" }] } : method === "Target.attachToTarget" ? { sessionId: "s" } : {} };
}
test("temporary Chrome cleanup waits for exit, retries ten times and reports without failing the result", async t => {
  const f = fixture(t), browser = fakeBrowser(), events = []; let release, profile;
  browser.close = () => new Promise(resolve => { release = () => { events.push("exit"); resolve(true); }; });
  const pending = withFreshBrowser(f.root, async () => ({ found: true }), { chrome: "fake", tempRoot: f.root,
    launch: async cfg => { profile = cfg.profile; assert.match(path.basename(profile), /^fleet-chrome-/); return browser; },
    remove: async file => { events.push("remove"); assert.equal(file, profile); fs.rmSync(file, { recursive: true }); }, note() {} });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, []); release(); await pending; assert.deepEqual(events, ["exit", "remove"]);
  let removes = 0, sleeps = 0;
  const result = await withFreshBrowser(f.root, async () => ({ found: true }), { chrome: "fake", tempRoot: f.root, launch: async () => fakeBrowser(),
    remove: async () => { removes++; throw Object.assign(new Error("locked"), { code: "EBUSY" }); }, sleep: async ms => { assert.equal(ms, 300); sleeps++; }, note() {} });
  assert.equal(result.found, true); assert.equal(removes, 10); assert.equal(sleeps, 9); assert.match(result.notices[0], /cleanup incomplete/);
  const notExited = fakeBrowser(); notExited.close = async () => false;
  const kept = await withFreshBrowser(f.root, async () => ({}), { chrome: "fake", tempRoot: f.root, launch: async () => notExited, remove: () => assert.fail("live profile must stay"), note() {} });
  assert.match(kept.notices[0], /exit unconfirmed/);
  const failed = await startOperation("shot", { url: "https://fake.invalid" }, { env: f.env, browserOptions: {
    browser: (directory, action) => withFreshBrowser(directory, async () => { throw new Error("original capture failure"); }, { chrome: "fake", tempRoot: f.root, launch: async () => fakeBrowser(), remove: async () => { throw new Error("locked"); }, sleep: async () => {}, note() {} }),
  } });
  const record = readJson(path.join(runDirectory(f.dataDir, failed.runId), "run.json"));
  assert.equal(record.error, "original capture failure"); assert.match(record.notices[0], /cleanup incomplete/);
});
test("process exit confirmation distinguishes exit from timeout and failed kill", async () => {
  const proc = new EventEmitter(); proc.pid = 123;
  const exited = processExit(proc); queueMicrotask(() => proc.emit("exit", 0)); assert.equal(await exited, true);
  const failed = processExit(proc); queueMicrotask(() => proc.emit("error", new Error("kill failed"))); assert.equal(await failed, false);
  assert.equal(await processExit(proc, 1), false);
});
test("deploy polling reuses one temporary browser profile until its final poll", async t => {
  const f = fixture(t), browser = fakeBrowser(); let launches = 0, polls = 0, clock = 0, removed = false;
  const original = browser.send;
  browser.send = async (method, params, sessionId) => {
    if (method === "Page.navigate") { queueMicrotask(() => { for (const listener of browser.listeners) listener({ method: "Page.loadEventFired", sessionId }); }); return {}; }
    if (method === "Runtime.evaluate") { assert.equal(removed, false); return { result: { value: ++polls === 3 ? "marker" : "old" } }; }
    return original(method, params, sessionId);
  };
  const result = await deployWait({ url: "https://fixture.invalid", path: "/app.js", marker: "marker", intervalSec: 1 }, f.root, {
    now: () => clock, sleep: async ms => { clock += ms; },
    browser: (directory, action) => withFreshBrowser(directory, action, { chrome: "fake", tempRoot: f.root,
      launch: async () => { launches++; return browser; }, remove: async file => { assert.equal(polls, 3); removed = true; fs.rmSync(file, { recursive: true }); }, note() {} }),
  });
  assert.equal(result.found, true); assert.equal(launches, 1); assert.equal(polls, 3); assert.equal(removed, true);
});
test("review prompts avoid schema copying; agy disables its file-reading preamble", () => {
  const prompt = reviewPrompt("inline diff", "spec");
  assert.equal(prompt.split("\n")[0], "Everything you need is in this message. Do not use any tools.");
  assert.ok(prompt.includes('{"findings":[{"file":"cart.js","line":4,"claim":"…","severity":"major","failure":"…"}]}'));
  assert.ok(prompt.includes('If you find nothing, return {"findings":[]}')); assert.ok(!prompt.includes('"properties"'));
  const command = ADAPTERS.agy.command({ model: "fake", noPreamble: true, jsonSchema: JSON.stringify(FINDINGS_SCHEMA) }, { directory: "/fixture", repo: CORE_ROOT });
  assert.ok(command.args.includes("--no-preamble")); assert.deepEqual(JSON.parse(command.args[command.args.indexOf("--json-schema") + 1]), FINDINGS_SCHEMA);
});
test("real Grok 402 fixture becomes limit/exit 4, while successful quota discussions remain answers", async t => {
  const f = fixture(t), stdout = real("grok-402-stdout.txt"), stderr = real("grok-402-stderr.txt");
  assert.equal(classifyGrok({ code: 1, stdout, stderr }).code, 4);
  for (const diagnostic of ["quota exceeded", "quota exhausted", "usage balance exhausted", "insufficient credits", "insufficient balance", "credit limit", '{"http_status":402}']) assert.equal(classifyGrok({ code: 1, stdout: "", stderr: diagnostic }).code, 4);
  for (const diagnostic of ["quota unavailable", "rate limit reached", "quota", "rate-limited", "HTTP 400", "HTTP 429", "HTTP 500"]) assert.equal(classifyGrok({ code: 1, stdout: "", stderr: diagnostic }).code, 1);
  assert.equal(classifyGrok({ code: 0, stdout: JSON.stringify({ stopReason: "end_turn", text: "Handle quota and rate limit errors." }), stderr: "" }).code, 0);
  assert.equal(classifyAgy({ code: 1, stdout: "{}", stderr: "quota unavailable" }).code, 1);
  assert.equal(classifyAgy({ code: 0, stdout: '{"error":{"message":"quota exhausted"}}', stderr: "" }).code, 4);
  assert.equal(classifyGrok({ code: 0, stdout: '{"http_status":402,"message":"Payment Required"}', stderr: "" }).code, 4);
  const file = path.join(f.root, "prompt.txt"); fs.writeFileSync(file, "inline"); const lines = [];
  const code = await grokRun([file, "--json", "--no-preamble"], { env: f.env, run: async () => ({ code: 1, stdout, stderr }), stdout: text => lines.push(text), stderr() {} });
  assert.equal(code, 4); assert.equal(ADAPTERS.grok.parse({ stdout: lines.join(""), stderr, exitCode: code }).status, "limit");
});
test("API quota errors classify chat and account/catalog failures as limit and runner exit 4", async t => {
  const f = fixture(t), service = { name: "openrouter", kind: "openai", baseUrl: "https://fixture.invalid/v1", keyEnv: "FIXTURE_KEY" };
  f.env.FIXTURE_KEY = randomUUID();
  const keyReader = () => f.env.FIXTURE_KEY;
  for (const endpoint of ["/key", "/models", "/chat/completions"]) {
    const result = await chat(service, { prompt: "x", model: endpoint === "/models" ? "fixture/paid" : "openrouter/free", ...(endpoint === "/models" ? { maxCostUsd: 1 } : {}) }, {
      env: f.env, keyReader, fetch: async url => url.endsWith(endpoint) ? response({ error: { message: `quota exhausted ${f.env.FIXTURE_KEY}` } }, 402) : response({ data: {} }),
    });
    assert.equal(result.outcome, "limit"); assert.ok(!JSON.stringify(result).includes(f.env.FIXTURE_KEY));
  }
  saveConfig({ ...f.config, providers: [service] }, f.env);
  const prompt = path.join(f.root, "prompt.txt"); fs.writeFileSync(prompt, "x"); const lines = [];
  const code = await apiRun([prompt, "--model", "openrouter/free", "--json"], { env: f.env, keyReader, stdout: line => lines.push(line), stderr() {}, fetch: async () => response({ error: { message: "quota exhausted" } }, 402) });
  assert.equal(code, 4); assert.equal(JSON.parse(lines.join("")).outcome, "limit");
});
test("quota messages use the narrow exhaustion signals and leave ordinary errors unchanged", async t => {
  const f = fixture(t), service = { name: "fixture", kind: "openai", baseUrl: "https://fixture.invalid/v1", keyEnv: "FIXTURE_KEY" };
  f.env.FIXTURE_KEY = randomUUID();
  const positive = ["usage balance exhausted", "quota exceeded", "QUOTA EXHAUSTED", "insufficient credits", "insufficient balance", "credit limit"];
  const negative = ["quota unavailable", "rate limit reached", "rate-limit", "quota", "HTTP 400", "HTTP 429", "HTTP 500"];
  for (const message of positive) assert.equal(quotaLimited(message), true, message);
  for (const message of negative) assert.equal(quotaLimited(message), false, message);
  for (const [message, outcome] of [...positive.map(text => [text, "limit"]), ...negative.map(text => [text, "failed"])]) {
    const result = await chat(service, { model: "fixture:free", prompt: "x" }, { env: f.env, keyReader: () => f.env.FIXTURE_KEY,
      fetch: async () => response({ error: { message } }, 400) });
    assert.equal(result.outcome, outcome, message);
  }
});
test("API worker preserves explicit 429 outcomes despite exhaustion text in stderr", async t => {
  const f = fixture(t);
  saveConfig({ ...f.config, providers: [{ name: "fixture", kind: "openai", baseUrl: "https://fixture.invalid/v1", keyEnv: "FIXTURE_KEY" }] }, f.env);
  for (const outcome of ["rate_limited", "daily_limit"]) {
    const job = await startAsk({ backend: "api", provider: "fixture", prompt: "x", model: "fixture:free" }, { env: f.env, spawnJob });
    const result = await runAskJob(runDirectory(f.dataDir, job.runId), { env: f.env, spawnBackend: () => {
      const child = new EventEmitter(); child.pid = process.pid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout.end(JSON.stringify({ outcome, answer: "", error: "quota exceeded" })); child.stderr.end("quota exceeded"); child.emit("close", 1); });
      return child;
    } });
    assert.equal(result.status, outcome);
  }
});
function dead() { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }
function lostFixture(f, suffix = "") {
  const directory = path.join(f.root, "lost" + suffix); fs.mkdirSync(directory);
  const run = JSON.parse(real("api-lost-run.json"));
  atomicJson(path.join(directory, "run.json"), run);
  fs.writeFileSync(path.join(directory, "stdout.txt"), real("api-lost-stdout.txt"));
  fs.writeFileSync(path.join(directory, "stderr.txt"), real("api-lost-stderr.txt"));
  return { directory, run };
}
test("real complete API output recovers only after dead processes and persisted terminal-state grace", async t => {
  const f = fixture(t), { directory, run } = lostFixture(f);
  const recovered = await reviewChildState(directory, { kill: dead, graceMs: 0 });
  assert.equal(recovered.status, "done"); assert.equal(recovered.exitCode, null); assert.match(recovered.recovery, /legacy API output/);
  assert.match(fs.readFileSync(path.join(directory, "answer.txt"), "utf8"), /cart\.js/);
  assert.equal(readJson(path.join(directory, "run.json")).status, "done");
  const live = lostFixture(f, "-live"); atomicJson(path.join(live.directory, "run.json"), { ...live.run, backendPid: 999 });
  assert.equal((await reviewChildState(live.directory, { graceMs: 0, kill: pid => { if (pid !== 999) dead(); } })).status, "running");
  assert.equal(fs.existsSync(path.join(live.directory, "answer.txt")), false);
  const delayed = lostFixture(f, "-delayed"); let clock = 0;
  const completed = await reviewChildState(delayed.directory, { kill: dead, graceMs: 100, now: () => clock, sleep: async ms => { clock += ms; atomicJson(path.join(delayed.directory, "run.json"), { ...run, status: "failed", error: "actual terminal status" }); } });
  assert.equal(completed.status, "failed"); assert.equal(completed.error, "actual terminal status");
  for (const [suffix, exitCode, interrupted, expected] of [["bad-exit", 1, false, "failed"], ["stopped", 0, true, "interrupted"]]) {
    const item = lostFixture(f, suffix);
    atomicJson(path.join(item.directory, "backend-exit.json"), { runId: item.run.runId, startedAt: item.run.startedAt, exitCode, interrupted });
    assert.equal((await reviewChildState(item.directory, { kill: dead, graceMs: 0 })).status, expected);
  }
  const flagged = lostFixture(f, "-flag"); fs.writeFileSync(path.join(flagged.directory, "interrupt.flag"), "");
  assert.equal((await reviewChildState(flagged.directory, { kill: dead, graceMs: 0 })).status, "interrupted");
});
test("terminal persistence retries transient Windows rename failures", async () => {
  let attempts = 0, sleeps = 0;
  await persistTerminal("unused", { status: "done" }, { write: () => { if (++attempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" }); }, sleep: async ms => { assert.equal(ms, 200); sleeps++; } });
  assert.equal(attempts, 3); assert.equal(sleeps, 2);
});
test("review preserves quota status and reports insufficient agreement with bounded unconfirmed findings", async t => {
  const f = fixture(t), diffFile = path.join(f.root, "diff.patch"); fs.writeFileSync(diffFile, "change");
  const job = await startOperation("review", { repo: f.root, diffFile, reviewers: ["agy", "grok"] }, { env: f.env, spawnJob, reviewOptions: { run: async () => ({ code: 0, stdout: ".git" }) } });
  const result = await runOperation(runDirectory(f.dataDir, job.runId), { env: f.env, executeReviewer: async reviewer => {
    if (reviewer.backend === "grok") throw Object.assign(new Error("quota exhausted"), { status: "limit" });
    return JSON.stringify({ findings: Array.from({ length: 12 }, (_, n) => ({ file: `${n}.js`, line: 1, claim: "bug", severity: "major", failure: "x".repeat(2000) })) });
  } });
  assert.equal(result.result.note, "only 1 reviewers answered; agreement impossible");
  assert.deepEqual(result.result.agreed, []); assert.equal(result.result.unconfirmed.length, 10);
  assert.ok(result.result.unconfirmed.every(item => item.failure.length <= 1000));
  assert.equal(result.result.reviewers[1].status, "limit");
});
test("review drains a started child through transient reads and interruption before completing", async t => {
  const f = fixture(t), diffFile = path.join(f.root, "diff.patch"); fs.writeFileSync(diffFile, "change");
  const job = await startOperation("review", { repo: f.root, diffFile, reviewers: ["agy"] }, { env: f.env, spawnJob, reviewOptions: { run: async () => ({ code: 0, stdout: ".git" }) } });
  const directory = runDirectory(f.dataDir, job.runId), child = path.join(f.dataDir, "runs", "fake-child"); let polls = 0;
  const completed = await runOperation(directory, { env: f.env, pollMs: 0,
    startChild: async () => { fs.mkdirSync(child); return { runId: "fake-child" }; },
    waitChild: async () => {
      polls++;
      if (polls === 1) throw Object.assign(new Error("temporary read failure"), { code: "EACCES" });
      if (polls === 2) { fs.writeFileSync(path.join(directory, "interrupt.flag"), ""); return [{ status: "running" }]; }
      assert.equal(fs.existsSync(path.join(child, "interrupt.flag")), true);
      return [{ status: "interrupted" }];
    },
  });
  assert.equal(polls, 3); assert.equal(completed.status, "interrupted");
});
