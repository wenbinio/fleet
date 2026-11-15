import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vibeRun, vibeArgs, vibeProbeArgs, parseVibeModelIds, classifyVibe } from '../core/lib/runners.mjs';
import { signInStatus, resolveTool } from '../core/lib/toolkit.mjs';
import { ADAPTERS } from '../runner/lib/adapters.mjs';
import { validateAsk } from '../runner/lib/jobs.mjs';
import { inspectBackend } from '../install.mjs';
import { callTool, eventBeat } from '../mcp/fleet-mcp.mjs';
import { accounts } from '../runner/lib/accounts.mjs';
import { injectRuntime } from '../runner/lib/runtime.mjs';
import * as toolkit from '../core/lib/toolkit.mjs';

const read = name => fs.readFileSync(new URL(`./fixtures/vibe-real/${name}`, import.meta.url), 'utf8');
function captured(name) {
  let exportData;
  try { exportData = JSON.parse(read(`${name}.export.json`)); } catch {}
  return { code: exportData?.exit_code ?? 1, stdout: exportData ? read(`${name}.stdout.jsonl`) : '', stderr: read(`${name}.stderr.txt`), exportData };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-vibe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, USERPROFILE: root, FLEET_HOME: path.join(root, 'home'), PATH: '', Path: '', VIBE_EXE: 'fake-vibe' };
  const prompt = path.join(root, 'prompt.txt'); fs.writeFileSync(prompt, 'fixture prompt');
  return { root, env, prompt };
}
for (const [name, outcome] of [['plain', 'done'], ['readonly-denied', 'done'], ['turn-limit', 'failed'], ['bad-model', 'failed'], ['missing-key', 'signed_out']]) {
  test(`Vibe real ${name} output through runner`, async t => {
    const f = fixture(t), raw = captured(name), events = path.join(f.root, 'events.jsonl');
    let output = '', errors = '', args, exportDir;
    const code = await vibeRun([f.prompt, '--cwd', f.root, '--json', '--events', events, ...(name === 'readonly-denied' ? ['--read-only'] : [])], {
      env: f.env, tempRoot: f.root, stdout: text => { output += text; }, stderr: text => { errors += text; },
      run: async (exe, argv, options) => {
        assert.equal(exe, 'fake-vibe'); args = argv;
        assert.equal(options.input, ''); assert.equal(options.timeout, 1260_000);
        exportDir = args[args.indexOf('--output-dir') + 1];
        if (raw.exportData) fs.writeFileSync(path.join(exportDir, 'export.json'), JSON.stringify(raw.exportData));
        return raw;
      },
    });
    const result = JSON.parse(output);
    assert.equal(result.outcome, outcome); assert.equal(code, outcome === 'done' ? 0 : 1);
    assert.equal(fs.readFileSync(events, 'utf8'), raw.stdout); assert.equal(fs.existsSync(exportDir), false);
    assert.doesNotMatch(errors, /Reading API keys/);
    if (raw.exportData) { assert.equal(result.sessionId, raw.exportData.session_id); assert.deepEqual(result.usage, raw.exportData.usage); }
    if (name === 'plain') assert.equal(result.answer, 'OK');
    if (name === 'readonly-denied') {
      assert.match(result.denials[0], /^Tool call denied: file_system.write_file/);
      assert.deepEqual(args.filter((arg, i) => args[i - 1] === '--enabled-tools'), ['read_file', 'grep']);
      assert.ok(!args.includes('--agent'));
      assert.deepEqual(result.tools, ['file_system.read_file', 'file_system.write_file']);
    }
    if (name === 'turn-limit') {
      assert.equal(result.error, 'stopped at the turn limit (1 turns)');
      assert.equal(result.answer, ''); // The captured limit has an edit effect, but no assistant message.
      assert.equal(args[args.indexOf('--agent') + 1], 'accept-edits');
    }
    if (name === 'bad-model') assert.equal(result.error, 'unknown vibe model no-such-model-xyz; available: mistral-medium-3.5, zai-glm-5-3-flash');
    if (name === 'missing-key') assert.equal(result.error, 'run yourself: vibe --setup');
  });
}
test('Vibe catalogue parsing and headless resume arguments', () => {
  assert.deepEqual(parseVibeModelIds(read('bad-model.stderr.txt')), ['mistral-medium-3.5', 'zai-glm-5-3-flash']);
  assert.deepEqual(parseVibeModelIds('Available: a, b, a\nnoise'), ['a', 'b']);
  assert.deepEqual(parseVibeModelIds('no catalogue'), []);
  assert.deepEqual(vibeProbeArgs('work'), ['-p', 'x', '--model', '__fleet_list_models__', '--workdir', 'work', '--trust']);
  const args = vibeArgs({ promptFile: 'prompt', cwd: 'work', model: 'ignored', resume: 'session', exportDir: 'out' });
  assert.ok(!args.includes('--model')); assert.equal(args[args.indexOf('--resume') + 1], 'session');
  assert.equal(args[args.indexOf('--time-limit') + 1], '1200');
});
test('Vibe preserves partial answers and classifies limits and errors', () => {
  const raw = captured('turn-limit');
  const stdout = JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }] }) + '\n' + raw.stdout;
  assert.equal(classifyVibe({ ...raw, stdout }).answer, 'partial');
  assert.equal(classifyVibe({ code: 0 }).outcome, 'empty');
  assert.equal(classifyVibe({ code: 3, exportData: { outcome: 'time_limit' } }).error, 'stopped at the time limit');
  assert.equal(classifyVibe({ code: 0, timedOut: true }).outcome, 'failed');
  assert.equal(classifyVibe({ code: 1, stderr: '429 rate limit' }).outcome, 'rate_limited');
  assert.equal(classifyVibe({ code: 1, stderr: '401 unauthorized' }).outcome, 'signed_out');
});
test('Vibe finished runs ignore error-like stderr warnings', () => {
  for (const stderr of ['429 Too Many Requests', 'authentication', 'time limit']) {
    const raw = captured('plain');
    const result = classifyVibe({ ...raw, stderr });
    assert.equal(result.outcome, 'done'); assert.equal(result.answer, 'OK'); assert.equal(result.error, undefined);
    assert.equal(classifyVibe({ ...raw, stdout: '', stderr }).outcome, 'empty');
  }
});
test('Vibe transcript renders assistant messages, tools, reasoning and export details', async t => {
  const f = fixture(t), runId = 'vibe-transcript', directory = path.join(f.root, 'runs', runId);
  const raw = captured('readonly-denied'), result = classifyVibe(raw);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ kind: 'ask', backend: 'vibe', runId, status: 'done', denials: result.denials, usage: result.usage }));
  fs.writeFileSync(path.join(directory, 'events.jsonl'), raw.stdout);
  const transcript = await callTool('fleet_transcript', { runId }, { env: f.env, dataDir: f.root });
  assert.ok(transcript.value.includes(result.answer.replace(/\s+/g, ' ')));
  assert.match(transcript.value, /tool: file_system.read_file/);
  assert.ok(transcript.value.includes(result.denials[0]));
  assert.ok(transcript.value.includes(JSON.stringify(result.usage)));
  assert.match(transcript.value, /reasoning: Read note.txt/);
  assert.doesNotMatch(transcript.value, /Read note.txt and tell me the secret word/);
  assert.equal(eventBeat({ type: 'message', sessionId: 's', role: 'assistant', content: [{ text: 'one ' }, { text: 'two' }] }), 'agent: one two');
  assert.equal(eventBeat({ type: 'agentMessage', text: 'unchanged' }), 'agent: unchanged');
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ kind: 'ask', backend: 'deepseek', runId, denials: ['do not append'], usage: { total_tokens: 99 } }));
  fs.writeFileSync(path.join(directory, 'events.jsonl'), '{"type":"final","text":"unchanged"}\n');
  assert.equal((await callTool('fleet_transcript', { runId }, { env: f.env, dataDir: f.root })).value, 'agent: unchanged');
});
test('Vibe resumes preserve the recorded model and leave unknown models unknown', () => {
  const adapter = ADAPTERS.vibe;
  for (const model of ['mistral-medium-3.5', undefined]) {
    const run = { ...adapter.defaults, ...adapter.prepare({ model: 'ignored-request' }, { resumed: { session: 's', model } }) };
    assert.equal(run.model, model);
    const result = adapter.parse({ stdout: JSON.stringify(classifyVibe(captured('plain'))), exitCode: 0, run });
    assert.equal(result.metadata.model, model);
  }
});
test('Vibe adapter validates options, parses failed answers and resumes sessions', t => {
  const f = fixture(t), adapter = ADAPTERS.vibe, opts = { backend: 'vibe', prompt: 'hello', cwd: f.root };
  assert.throws(() => validateAsk({ backend: 'vibe', prompt: 'hello' }, { env: f.env }), /cwd/);
  for (const maxTurns of [0, 201, 1.5, '2']) assert.throws(() => validateAsk({ ...opts, maxTurns }, { env: f.env }), /maxTurns/);
  for (const maxTurns of [1, 200]) validateAsk({ ...opts, maxTurns }, { env: f.env });
  for (const timeout of [0, -1, NaN]) assert.throws(() => adapter.validate({ timeout }), /timeout/);
  const initial = adapter.command({ ...opts, ...adapter.defaults }, { directory: f.root, repo: f.root });
  assert.equal(initial.args[initial.args.indexOf('--model') + 1], 'zai-glm-5-3-flash');
  const previous = { kind: 'ask', backend: 'vibe', session: 'old-session' };
  adapter.resume({ resume: 'old-run' }, previous, []);
  assert.throws(() => adapter.resume({ resume: 'old-run' }, { ...previous, backend: 'grok' }, []), /earlier vibe/);
  assert.throws(() => adapter.resume({ resume: 'old-run' }, previous, [{ ...previous, status: 'running' }]), /still running/);
  const run = { ...opts, ...adapter.defaults, ...adapter.prepare({}, { resumed: { session: 'old-session' } }), readOnly: true, maxTurns: 7, timeout: 3 };
  const command = adapter.command(run, { directory: f.root, repo: f.root });
  assert.ok(command.args.includes('vibe-run')); assert.ok(command.args.includes('--events')); assert.ok(command.args.includes('--read-only'));
  assert.ok(!command.args.includes('--model')); assert.equal(command.args.at(-1), 'old-session');
  const data = classifyVibe(captured('turn-limit')), parsed = adapter.parse({ stdout: JSON.stringify(data), exitCode: 1, run });
  assert.equal(parsed.status, 'failed'); assert.equal(parsed.metadata.session, data.sessionId); assert.equal(parsed.metadata.model, run.model);
  assert.deepEqual(parsed.metadata.usage, data.usage);
  assert.throws(() => adapter.parse({ stdout: '{"outcome":"bogus"}', exitCode: 0 }), /invalid vibe outcome/);
  assert.deepEqual(adapter.transcript(parsed.metadata, { directory: f.root }).details, { denials: [], usage: data.usage });
});
test('Vibe sign-in probe distinguishes catalogue, missing key and unknown status', async t => {
  const f = fixture(t);
  for (const [stderr, expected] of [[read('bad-model.stderr.txt'), true], [read('missing-key.stderr.txt'), false], ['unexpected error', null]]) {
    const result = await signInStatus('vibe', { env: f.env, run: async (exe, args, opts) => {
      assert.equal(exe, 'fake-vibe'); assert.equal(opts.timeout, 30_000); assert.ok(args.includes('__fleet_list_models__'));
      const directory = path.join(os.tmpdir(), 'fleet-vibe-probe');
      assert.equal(args[args.indexOf('--workdir') + 1], directory); assert.equal(opts.cwd, directory);
      assert.ok(fs.statSync(directory).isDirectory());
      return { code: 1, stdout: '', stderr };
    } });
    assert.equal(result.signedIn, expected);
    assert.equal(result.detail, expected === true ? 'signed in (model catalogue reachable)' : expected === false ? 'run yourself: vibe --setup' : 'sign-in not confirmed');
  }
  assert.equal((await signInStatus('vibe', { env: { ...f.env, MISTRAL_API_KEY: 'fixture' }, run: () => assert.fail('key presence needs no probe') })).signedIn, true);
  const missing = await signInStatus('vibe', { env: { ...f.env, VIBE_EXE: '' } });
  assert.equal(missing.found, false); assert.match(missing.detail, /own terminal.*uv tool install mistral-vibe/);
  const inspected = await inspectBackend('vibe', { env: f.env, config: {}, run: async (exe, args) => args[0] === '--version' ? { code: 0, stdout: 'vibe 3.1.2' } : captured('bad-model') });
  assert.equal(inspected.signedIn, true); assert.equal(inspected.version, 'vibe 3.1.2');
});
test('Vibe account discovery trusts only the neutral probe directory', async t => {
  const f = fixture(t), shared = path.join(f.env.FLEET_HOME, 'fleet');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'profile.json'), JSON.stringify({ name: 'minimal', backends: { codex: false, api: false, vibe: true } }));
  let probes = 0;
  injectRuntime(f.env, { toolkit: { ...toolkit, signInStatus: async () => ({ found: true, signedIn: true }), capture: async (exe, args, opts) => {
    probes++;
    const directory = path.join(os.tmpdir(), 'fleet-vibe-probe');
    assert.equal(exe, 'fake-vibe'); assert.equal(opts.cwd, directory); assert.equal(opts.timeout, 30_000);
    assert.deepEqual(args, vibeProbeArgs(directory)); assert.ok(fs.statSync(directory).isDirectory());
    return captured('bad-model');
  } } });
  const rows = await accounts({ env: f.env, dataDir: shared });
  assert.equal(probes, 1); assert.deepEqual(rows.map(row => row.backend), ['vibe']);
  assert.deepEqual(rows[0].models.map(model => model.id), ['mistral-medium-3.5', 'zai-glm-5-3-flash']);
});
test('Vibe resolves the local launcher after PATH', t => {
  const f = fixture(t), dir = path.join(f.root, '.local', 'bin'); fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, 'vibe.exe'); fs.writeFileSync(local, '');
  const env = { ...f.env, VIBE_EXE: '' };
  assert.equal(resolveTool('vibe', { env, platform: 'win32' }), local);
  const onPath = path.join(f.root, 'vibe.exe'); fs.writeFileSync(onPath, '');
  assert.equal(resolveTool('vibe', { env: { ...env, PATH: f.root }, platform: 'win32' }), onPath);
});
test('Vibe runner missing executable reports manual install without launching', async t => {
  const f = fixture(t); let errors = '';
  const code = await vibeRun([f.prompt], { env: { ...f.env, VIBE_EXE: '' }, run: () => assert.fail('must not launch'), stderr: text => { errors += text; } });
  assert.equal(code, 1); assert.match(errors, /own terminal.*uv tool install mistral-vibe.*vibe --setup/);
});
