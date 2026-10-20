import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { saveConfig } from "../core/lib/toolkit.mjs";
import { chat, provider } from "../core/lib/api.mjs";
import { localProvider, localStatus, gpuGuard } from "../core/lib/local.mjs";
import { reviewDiff, routeReviewers, privateReview, parseFindings, parseChangedLines, anchorFindings, mergeFindings, FINDINGS_SCHEMA } from "../core/lib/review.mjs";
import { shot, staticHandler, withFreshBrowser, pollDeploy, deployWait, githubChecks, validateShot, validateDeploy } from "../core/lib/browser-tasks.mjs";
import { Browser } from "../core/lib/webchat/engine.mjs";
import { apiRun } from "../core/lib/runners.mjs";
import { ADAPTERS } from "../runner/lib/adapters.mjs";
import { startOperation, runOperation } from "../runner/lib/operations.mjs";
import { startAsk, readAsk, runDirectory, atomicJson, listRuns, waitRuns } from "../runner/lib/jobs.mjs";
import { callTool, TOOLS, toolsFor } from "../mcp/fleet-mcp.mjs";
import { cli } from "../runner/fleet.mjs";
import { readProfile } from "../runner/lib/profile.mjs";
import { accounts } from "../runner/lib/accounts.mjs";
import { injectRuntime, CORE_ROOT } from "../runner/lib/runtime.mjs";
import * as toolkit from "../core/lib/toolkit.mjs";
import { inspectBackend, localSetupCommand, install, parseArgs } from "../install.mjs";

function fixture(t) {
  const scratch = fileURLToPath(new URL("../.test-tmp/", import.meta.url)); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "operations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const env = { HOME: root, USERPROFILE: root, FLEET_HOME: path.join(root, "home"), AGENT_TOOLKIT_HOME: "", CHATGPT_WEB_HOME: path.join(root, "web"), FLEET_WORKER: "", PATH: "", Path: "" };
  const config = { local: { default: "fixture:small", folder: path.join(root, "absent-qwen") }, tools: { chrome: "fake-chrome", ollama: "fake-ollama" }, providers: [localProvider({ providers: [{ name: "local", kind: "openai", baseUrl: "http://localhost:11434/v1", local: true, engine: "ollama" }] }, undefined, { env })] };
  saveConfig(config, env);
  const dataDir = path.join(env.FLEET_HOME, "fleet");
  injectRuntime(env, { repo: CORE_ROOT, toolkit: { ...toolkit, signInStatus: async () => ({ found: false, signedIn: null }), capture: async () => ({ code: 1, stdout: "", stderr: "" }) } });
  return { root, env, dataDir, config };
}
const response = (data, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(data) });
const nativeFetch = async url => response(url.endsWith("/api/version") ? { version: "fake" } : url.endsWith("/api/ps") ? { models: [] } : { models: [{ name: "fixture:small", size: 2 * 1024 ** 3 }] });
const gpuOptions = { fetch: nativeFetch, run: async () => ({ code: 0, stdout: "16384, 3072, 13312\n" }) };
function fakeSpawn(calls = []) {
  return (exe, args, opts) => {
    calls.push({ exe, args, opts }); assert.equal(opts.env.FLEET_WORKER, "1");
    const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
    queueMicrotask(() => child.emit("spawn")); return child;
  };
}
const finding = (changes = {}) => ({ file: "app.js", line: 10, claim: "missing null check crashes request", severity: "major", failure: "Null input crashes the handler.", ...changes });
// Synthetic source diff for the documented planted bugs, not a captured live artifact.
const cartDiff = () => fs.readFileSync(new URL("./fixtures/review-real/cart-planted.synthetic.diff", import.meta.url), "utf8");
test("changed-line parsing follows hunk counts, renames, blank additions and pure deletions", () => {
  const diff = ['diff --git "a/old name.js" "b/new name.js"', 'rename from old name.js', 'rename to new name.js',
    '--- "a/old name.js"', '+++ "b/new name.js"', '@@ -2,3 +2,4 @@ section', ' context', '-removed replacement', '+replacement', '+', ' tail',
    '@@ -10,2 +11,0 @@', '-deleted one', '\\ No newline at end of file', '-deleted two',
    '@@ -20 +20 @@', '--- old header-shaped text', '+++ added header-shaped text', '\\ No newline at end of file',
    'diff --git a/gone.js b/gone.js', 'deleted file mode 100644', '--- a/gone.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-first', '-second',
    'diff --git a/empty.js b/empty.js', 'new file mode 100644', '--- /dev/null', '+++ b/empty.js', '@@ -0,0 +1 @@', '+',
    '+++ stray metadata without hunk', '+not a change', ''].join('\r\n');
  assert.deepEqual([...parseChangedLines(diff)], [
    ['new name.js', [{ line: 3, text: 'replacement' }, { line: 4, text: '' }, { line: 12, text: 'deleted one\ndeleted two' }, { line: 20, text: '++ added header-shaped text' }]],
    ['gone.js', [{ line: 1, text: 'first\nsecond' }]], ['empty.js', [{ line: 1, text: '' }]],
  ]);
  assert.deepEqual([...parseChangedLines('--- a/fake.js\n+++ b/fake.js\n+outside hunk')], []);
});
test("findings anchor to identifier, number and operator overlap with nearest-line fallback", () => {
  const changed = parseChangedLines(cartDiff());
  const originals = [finding({ file: 'cart.js', line: 100, claim: 'items.length <= permits an extra iteration', failure: 'items.length is accessed' }),
    finding({ file: 'cart.js', line: 16, claim: 'percent / 10 scales incorrectly', failure: 'percent divided by 10' }),
    finding({ file: 'cart.js', line: 8, claim: 'unrelated zebra', failure: 'purple cloud' }),
    finding({ file: 'other.js', line: 100 })];
  const result = anchorFindings(originals, changed);
  assert.deepEqual(result.map(item => [item.line, item.reportedLine]), [[4, 100], [9, 16], [9, 8], [100, undefined]]);
  assert.equal(originals[0].line, 100);
  assert.equal(anchorFindings([finding({ file: 'cart.js', line: 6, claim: 'foo', failure: 'foo' })], new Map([['cart.js', [{ line: 4, text: 'foo' }, { line: 9, text: 'foo' }]]]))[0].line, 4);
  assert.deepEqual(anchorFindings([finding({ file: 'cart.js', line: 4 })], changed), [finding({ file: 'cart.js', line: 4 })]);
});
test("anchoring scores already-changed lines and resolves overlap ties by reported line then proximity", () => {
  const move = finding({ file: 'cart.js', line: 9, claim: 'i <= items.length', failure: 'items.length is out of bounds' });
  assert.deepEqual(anchorFindings([move], parseChangedLines(cartDiff())), [{ ...move, line: 4, reportedLine: 9 }]);
  const changed = new Map([['app.js', [{ line: 4, text: 'alpha beta' }, { line: 8, text: 'alpha beta' }]]]);
  for (const line of [4, 8]) {
    const original = finding({ line, claim: 'alpha beta', failure: 'unknown' });
    assert.deepEqual(anchorFindings([original], changed), [original]);
  }
  assert.equal(anchorFindings([finding({ line: 7, claim: 'alpha beta', failure: 'unknown' })], changed)[0].line, 8);
  assert.equal(anchorFindings([finding({ line: 6, claim: 'alpha beta', failure: 'unknown' })], changed)[0].line, 4);
});
test("review parser accepts fenced JSON and braces in strings but rejects malformed findings", () => {
  const data = { findings: [finding({ failure: 'Input "}" crashes.' })] };
  assert.deepEqual(parseFindings("Here:\n```json\n" + JSON.stringify(data) + "\n```"), data.findings);
  for (const value of ['{"findings":{}}', '{"findings":[{}]}', '{"findings":[{"line":0}]}', '{"broken":', "nothing"]) assert.throws(() => parseFindings(value), /reviewer|finding/);
});
test("review grouping retains severity/scenario and caps claims while separating repeated reviewers", () => {
  const rows = [
    { id: "a", findings: [finding({ line: 10 }), finding({ line: 11 })] },
    { id: "b", findings: [finding({ line: 15, severity: "blocker", failure: "A much longer concrete scenario that crashes every request." })] },
    { id: "c", findings: [finding({ line: 20, claim: "missing null check request crashes " + "crashes ".repeat(90) }), finding({ file: "other.js" })] },
  ];
  const [group] = mergeFindings(rows, 3);
  assert.deepEqual(group.by, ["a", "b", "c"]); assert.equal(group.severity, "blocker"); assert.match(group.failure, /much longer/); assert.ok(group.claim.length <= 300);
  assert.deepEqual(mergeFindings([rows[0]], 2), []);
  assert.deepEqual(mergeFindings([{ id: "a", findings: [finding()] }, { id: "b", findings: [finding({ line: 13, claim: "incorrect currency rounding inflates billing", failure: "Invoices overcharge customers." })] }], 2), []);
});
for (const name of ['reviewers-two-agree.json', 'reviewers-chained.json']) test(`recorded ${name} anchors to exactly two agreed bugs with strongest severity`, () => {
  const original = JSON.parse(fs.readFileSync(new URL(`./fixtures/review-real/${name}`, import.meta.url), "utf8"));
  const rows = original.map(row => ({ ...row, findings: anchorFindings(row.findings ?? [], parseChangedLines(cartDiff())) }));
  const groups = mergeFindings(rows), successful = rows.filter(row => row.status === "done").map(row => row.id);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => [group.file, group.line, group.severity]), [["cart.js", 4, "blocker"], ["cart.js", 9, name === 'reviewers-chained.json' ? 'blocker' : 'major']]);
  for (const group of groups) assert.deepEqual(group.by, successful);
  if (name === 'reviewers-chained.json') {
    assert.deepEqual(rows.find(row => row.id === 'api:free').findings.map(item => [item.line, item.reportedLine]), [[4, 9], [9, 16]]);
    assert.deepEqual(original.find(row => row.id === 'api:free').findings.map(item => item.line), [9, 16]);
  }
});
test("review matching uses inclusive line and claim-plus-failure similarity boundaries", () => {
  const left = finding({ line: 10, claim: "alpha beta gamma delta epsilon", failure: "shared apple banana cherry date" });
  const unrelated = finding({ claim: "violet indigo orange purple pink", failure: "rocket comet planet meteor moon" });
  const matching = finding({ claim: unrelated.claim, failure: "shared apple banana kiwi mango melon plum peach" }); // 3 / 20 = .15, entirely from failure text.
  const below = finding({ claim: unrelated.claim, failure: "shared apple lemon kiwi mango" }); // 2 / 18 < .15.
  const merged = right => mergeFindings([{ id: "a", findings: [left] }, { id: "b", findings: [right] }]);
  for (const line of [8, 10, 12]) assert.equal(merged({ ...unrelated, line }).length, 1);
  assert.equal(merged({ ...unrelated, line: 13 }).length, 0);
  for (const line of [2, 18]) assert.equal(merged({ ...matching, line }).length, 1);
  assert.equal(merged({ ...below, line: 18 }).length, 0);
  assert.equal(merged({ ...left, line: 19 }).length, 0);
  assert.equal(merged({ ...left, file: "different.js" }).length, 0);
});
test("duplicate findings and duplicate rows from one reviewer never manufacture quorum", () => {
  const rows = [{ id: "a", findings: [finding(), finding({ line: 11 })] }, { id: "a", findings: [finding({ line: 12 })] }];
  assert.deepEqual(mergeFindings(rows, 2), []);
  rows.push({ id: "b", findings: [finding()] });
  assert.deepEqual(mergeFindings(rows, 2)[0].by, ["a", "b"]);
  assert.deepEqual(mergeFindings(rows, 3), []);
});
test("review assignment sorts by file/line and chooses the nearest matching member without joining groups", () => {
  const rows = [
    { id: "c", findings: [finding({ line: 17 })] },
    { id: "b", findings: [finding({ line: 15 })] },
    { id: "a", findings: [finding({ line: 14 }), finding({ line: 10 })] },
  ];
  const groups = mergeFindings(rows, 1);
  assert.deepEqual(groups.map(group => [group.line, group.by]), [[10, ["a"]], [14, ["a", "b", "c"]]]);
  assert.equal(mergeFindings(rows, 3).length, 1);
});
test("review assignment uses nearest matching member rather than representative line and keeps stable group ties", () => {
  const rows = [
    { id: "a", findings: [finding({ line: 1, severity: "blocker" })] },
    { id: "b", findings: [finding({ line: 5, claim: "currency rounding inflates billing", failure: "Invoices overcharge customers." }), finding({ line: 7 })] },
    { id: "c", findings: [finding({ line: 8, claim: "currency rounding inflates billing" })] },
  ];
  const groups = mergeFindings(rows, 1);
  assert.deepEqual(groups.map(group => [group.line, group.by]), [[1, ["a", "b", "c"]], [5, ["b"]]]);
  const tied = mergeFindings([
    { id: "a", findings: [finding({ claim: "first group" }), finding({ claim: "second group" })] },
    { id: "b", findings: [finding({ line: 11 })] },
  ], 1);
  assert.deepEqual(tied.map(group => [group.claim, group.by]), [["first group", ["a", "b"]], ["second group", ["a"]]]);
});
test("review representative line and claim come from the most severe member, ties use lowest line", () => {
  const groups = mergeFindings([
    { id: "a", findings: [finding({ line: 20, claim: "later major" })] },
    { id: "b", findings: [finding({ line: 18, claim: "earlier major" })] },
    { id: "c", findings: [finding({ line: 19, severity: "minor" })] },
  ]);
  assert.equal(groups[0].line, 18); assert.equal(groups[0].claim, "earlier major");
  const severe = mergeFindings([
    { id: "a", findings: [finding({ line: 18, claim: "earlier major" })] },
    { id: "b", findings: [finding({ line: 20, claim: "later blocker", severity: "blocker" })] },
  ]);
  assert.equal(severe[0].line, 20); assert.equal(severe[0].claim, "later blocker");
});
test("private review routing covers deleted/renamed paths and never sends private diffs to free API", async t => {
  const f = fixture(t), profile = readProfile({ env: f.env });
  assert.equal(privateReview({ repo: f.root }, "--- a/secrets/deleted.txt\n+++ /dev/null", ["**/secrets/**"]), true);
  assert.equal(privateReview({ repo: f.root }, "rename from private/old.js\nrename to public/new.js", ["**/private/**"]), true);
  assert.equal(privateReview({ repo: "D:\\PRIVATE\\app" }, "", ["d:/private/**"]), true);
  const ready = await routeReviewers({ private: true }, profile, { localReady: async () => true });
  assert.ok(ready.reviewers.some(row => row.backend === "local")); assert.ok(!ready.reviewers.some(row => row.backend === "api")); assert.match(ready.notices[0], /replaced/);
  const unavailable = await routeReviewers({ private: true }, profile, { localReady: async () => false });
  assert.ok(!unavailable.reviewers.some(row => row.backend === "api")); assert.match(unavailable.notices[0], /dropped/);
  assert.ok((await routeReviewers({}, profile)).reviewers.some(row => row.backend === "api"), "ordinary public review retains its default API reviewer");
  await assert.rejects(routeReviewers({ reviewers: ["api:vendor/paid"] }, profile), /maxCostUsd/);
  assert.equal((await routeReviewers({ reviewers: ["api:vendor/paid"], private: true, maxCostUsd: 0.2 }, profile)).reviewers[0].maxCostUsd, 0.2);
});
test("review input caps files and resolves branch default without hardcoded main or option injection", async t => {
  const f = fixture(t), diffFile = path.join(f.root, "change.patch"); fs.writeFileSync(diffFile, "x".repeat(60001));
  const calls = [], run = async (exe, args) => {
    calls.push(args);
    if (args.includes("--git-dir")) return { code: 0, stdout: ".git" };
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/trunk" };
    if (args.includes("--verify")) return { code: 0, stdout: "a".repeat(40) };
    return { code: 0, stdout: "--- a/app.js\n+++ b/app.js\n+change\n" };
  };
  await assert.rejects(reviewDiff({ repo: f.root, diffFile }, { run }), { message: "diff too large: narrow the range or review per file" });
  await assert.rejects(reviewDiff({ repo: f.root, diffFile, range: "A..B" }, { run }), /exactly one/);
  const diff = await reviewDiff({ repo: f.root, branch: "feature" }, { run });
  assert.match(diff, /change/);
  assert.ok(calls.some(args => args.includes("refs/remotes/origin/trunk^{commit}")));
  assert.ok(calls.filter(args => args.includes("--verify")).every(args => args.includes("--end-of-options")));
  assert.ok(calls.find(args => args.includes("diff")).includes("--no-ext-diff"));
});
test("local transport uses no key, pricing or remote routing and always unloads", async t => {
  const f = fixture(t), service = provider("local", { env: f.env }), requests = [];
  assert.equal(service.local, true);
  const result = await chat(service, { prompt: "private", model: "fixture:small", responseFormat: "json" }, {
    env: f.env, keyReader: () => assert.fail("local must not read keys"),
    fetch: async (url, init) => { requests.push({ url, init }); return response({ choices: [{ message: { content: '{"findings":[]}' } }], usage: { cost: 999 } }); },
  });
  assert.equal(result.outcome, "done"); assert.equal(result.costUsd, 0); assert.equal(result.free, false);
  assert.equal(requests.length, 1); assert.match(requests[0].url, /^http:\/\/localhost:11434\/v1\/chat\/completions$/);
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body).response_format, { type: "json_object" }); assert.equal(JSON.parse(requests[0].init.body).keep_alive, 0);
  await assert.rejects(chat(service, { prompt: "x", model: "fixture:small", effort: "xhigh" }, { keyReader: () => assert.fail() }), /effort/);
  assert.throws(() => localProvider({ providers: [{ local: true, baseUrl: "https://outside.invalid/v1" }] }, undefined, { env: {} }), /loopback/);
  const native = [];
  const fallback = await chat(service, { prompt: "x", model: "fixture:small" }, { fetch: async (url, init) => {
    native.push({ url, body: JSON.parse(init.body) });
    return native.length === 1 ? response({ error: { message: "unknown field keep_alive" } }, 400) : response({ message: { content: "local answer" } });
  } });
  assert.equal(fallback.answer, "local answer"); assert.match(native[1].url, /\/api\/chat$/); assert.equal(native[1].body.keep_alive, 0);
});
test("API entry points cannot bypass local GPU reservations", async t => {
  const f = fixture(t), prompt = path.join(f.root, "prompt.txt"); fs.writeFileSync(prompt, "private");
  await assert.rejects(startAsk({ backend: "api", provider: "local", model: "fixture:small", prompt: "private" }, {
    env: f.env, spawnJob: () => assert.fail("must reject before spawning"),
  }), /use backend local/);
  for (const args of [[prompt, "--provider", "local"], [prompt, "--local"]]) {
    await assert.rejects(apiRun(args, { env: f.env, fetch: () => assert.fail("must reject before HTTP") }), /use backend local/);
  }
});
test("API and local adapter commands forward structured output through the runner", async t => {
  const f = fixture(t), directory = path.join(f.root, "job"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "prompt.txt"), "inline");
  for (const backend of ["api", "local"]) {
    const command = ADAPTERS[backend].command({ backend, provider: backend === "api" ? "openrouter" : "local", model: "fixture:small", responseFormat: "json" }, { directory, repo: CORE_ROOT });
    assert.equal(command.args[command.args.indexOf("--response-format") + 1], "json");
    assert.equal(command.args.includes("--local"), backend === "local");
    if (backend === "local") {
      const output = [], requests = [];
      const promptIndex = command.args.indexOf(path.join(directory, "prompt.txt"));
      const code = await apiRun(command.args.slice(promptIndex), {
        env: { ...f.env, FLEET_WORKER: "1" }, stdout: text => output.push(text), stderr() {},
        keyReader: () => assert.fail("local worker must not read credentials"),
        fetch: async (url, init) => { requests.push(JSON.parse(init.body)); return response({ choices: [{ message: { content: '{"findings":[]}' } }] }); },
      });
      assert.equal(code, 0); assert.equal(JSON.parse(output.join("")).costUsd, 0);
      assert.deepEqual(requests[0].response_format, { type: "json_object" }); assert.equal(requests[0].keep_alive, 0);
    }
  }
});
test("local GPU math and sound guard reject both directions without guessing on unavailable telemetry", async t => {
  const f = fixture(t), options = { ...gpuOptions, env: f.env, model: "fixture:small" };
  await gpuGuard("local", options);
  await assert.rejects(gpuGuard("local", { ...options, run: async () => ({ code: 0, stdout: "16384, 15360, 1024" }) }), /need ~3.4 GB, free 1.0 GB/);
  for (const [backend, other] of [["local", "sound"], ["sound", "local"]]) await assert.rejects(gpuGuard(backend, { ...options, existing: [{ backend: other, status: "running" }] }), /gpu busy/);
  await assert.rejects(gpuGuard("sound", { ...options, fetch: async () => response({ models: [{ name: "loaded" }] }) }), /gpu busy/);
  await assert.rejects(gpuGuard("sound", { ...options, fetch: async () => { throw new Error("timeout"); } }), /cannot verify/);
  await gpuGuard("sound", { ...options, fetch: async () => { throw Object.assign(new Error("offline"), { cause: { code: "ECONNREFUSED" } }); } });
});
test("local and sound reservations serialize and gpu_busy is visible in shared history", async t => {
  const f = fixture(t), options = { env: f.env, dataDir: f.dataDir, gpuOptions, spawnJob: fakeSpawn() };
  const first = await startAsk({ backend: "local", prompt: "private" }, options);
  await assert.rejects(startAsk({ backend: "sound", prompt: "bell", seconds: 1 }, options), /gpu busy/);
  const rows = await listRuns(f.dataDir); assert.ok(rows.runs.some(row => row.backend === "sound" && row.status === "gpu_busy"));
  const run = readAsk(runDirectory(f.dataDir, first.runId)); assert.equal(run.model, "fixture:small"); assert.equal(run.free, false);
  atomicJson(path.join(runDirectory(f.dataDir, first.runId), "run.json"), { ...run, status: "done" });
  await startAsk({ backend: "sound", prompt: "bell", seconds: 1 }, options);
  await assert.rejects(startAsk({ backend: "local", prompt: "private" }, options), /gpu busy/);
});
test("simultaneous local and sound admission permits exactly one GPU job", async t => {
  const f = fixture(t), options = { env: f.env, dataDir: f.dataDir, gpuOptions, spawnJob: fakeSpawn() };
  const results = await Promise.allSettled([
    startAsk({ backend: "local", prompt: "private" }, options),
    startAsk({ backend: "sound", prompt: "bell", seconds: 1 }, options),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /gpu busy/);
});
test("local menu and installer inspect injected HTTP and paths without launching GUI or installing models", async t => {
  const f = fixture(t);
  const status = await localStatus({ ...gpuOptions, env: f.env }); assert.equal(status.ready, true);
  const [menu] = await accounts({ backend: "local", env: f.env, dataDir: f.dataDir, discover: async () => ({ code: 1 }), apiOptions: { fetch: nativeFetch, keyReader: () => assert.fail("local menu key") } });
  assert.deepEqual(menu.models.map(model => model.id), ["fixture:small"]); assert.ok(menu.notes.some(note => note.includes("no API key")));
  const inspected = await inspectBackend("local", { env: f.env, config: f.config, apiOptions: { fetch: nativeFetch }, run: () => assert.fail("never execute Ollama/Chrome during inspection") });
  assert.equal(inspected.ready, true);
  const empty = await inspectBackend("local", { env: f.env, config: f.config, apiOptions: { fetch: async url => response(url.endsWith("/version") ? { version: "fake" } : { models: [] }) } });
  assert.equal(empty.ready, false);
  const planned = await install(parseArgs(["--plan", "--host", "generic"]), {
    env: f.env, run: async () => ({ code: 0, stdout: "fixture version" }),
    inspect: async backend => backend === "local" ? empty : { found: true, signedIn: true },
  });
  assert.equal(planned.steps.find(step => step.id === "backend:local").status, "needs-you");
  assert.match(planned.steps.find(step => step.id === "backend:local").command, /Choose a local model/);
  const command = localSetupCommand({ engine: "ollama", executable: "fake", found: true }, ["first:small", "second:small"]);
  assert.match(command, /^ollama pull "first:small"\nollama pull "second:small"/);
  assert.match(command, /OLLAMA_MODELS.*never changes/);
  assert.equal(localSetupCommand({ engine: "ollama", executable: "fake", found: false }), "ollama serve");
  assert.match(localSetupCommand({ engine: "ollama", found: false }), /Install Ollama/);
});
function browserFake({ firstUrl = "about:blank", failCapture = false } = {}) {
  const browser = { listeners: new Set(), commands: [], closed: false };
  browser.send = async (method, params = {}, sessionId) => {
    browser.commands.push({ method, params });
    if (method === "Target.getTargets") return { targetInfos: [{ type: "page", targetId: "page", url: firstUrl }] };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Page.navigate") {
      queueMicrotask(() => {
        for (const listener of browser.listeners) listener({ sessionId, method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: "fixture console" }] } });
        for (const listener of browser.listeners) listener({ sessionId, method: "Network.requestWillBeSent", params: { requestId: "r", request: { url: "https://site.invalid/missing.js" } } });
        for (const listener of browser.listeners) listener({ sessionId, method: "Network.loadingFailed", params: { requestId: "r", errorText: "not found" } });
        for (const listener of browser.listeners) listener({ sessionId, method: "Page.loadEventFired", params: {} });
      });
      return {};
    }
    if (method === "Runtime.evaluate") return { result: { value: true } };
    if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 1440, height: 1600 } };
    if (method === "Page.captureScreenshot") { if (failCapture) throw new Error("capture failed"); return { data: Buffer.from("fixture PNG bytes").toString("base64") }; }
    return {};
  };
  browser.close = async () => { browser.closed = true; };
  return browser;
}
test("screenshots use responsive metrics, paths only, error reporting and fresh profile cleanup", async t => {
  const f = fixture(t), browser = browserFake(), profiles = [];
  const result = await shot({ url: "https://site.invalid", waitFor: "main", waitMs: 1 }, f.root, {
    browser: (directory, action) => withFreshBrowser(directory, action, { chrome: "fake", tempRoot: f.root, launch: async (cfg, opts) => {
      assert.equal(opts.headless, true); profiles.push(cfg.profile); return browser;
    } }), sleep: async () => {},
  });
  assert.deepEqual(result.files.map(file => [file.width, file.height, file.consoleErrors, file.failedRequests]), [[390, 1600, 1, 1], [1440, 1600, 1, 1]]);
  assert.deepEqual(browser.commands.filter(command => command.method === "Emulation.setDeviceMetricsOverride").map(command => command.params.mobile), [true, false]);
  assert.ok(result.files.every(file => fs.readFileSync(file.path, "utf8") === "fixture PNG bytes"));
  assert.ok(!JSON.stringify(result).includes(Buffer.from("fixture PNG bytes").toString("base64")));
  assert.match(result.errors.join("\n"), /missing\.js/);
  assert.equal(browser.closed, true); assert.ok(profiles.every(profile => !fs.existsSync(profile)));
});
test("screenshots reject a nonblank first tab and close profiles/static servers on failures", async t => {
  const f = fixture(t);
  for (const options of [{ firstUrl: "https://existing.invalid" }, { failCapture: true }]) {
    const browser = browserFake(options); let closed = false, profile;
    await assert.rejects(shot({ dir: f.root }, f.root, {
      serve: async () => ({ url: "http://127.0.0.1:40000", close: async () => { closed = true; } }),
      browser: (directory, action) => withFreshBrowser(directory, action, { chrome: "fake", tempRoot: f.root, launch: async cfg => { profile = cfg.profile; return browser; } }),
    }), /about:blank|capture failed/);
    assert.equal(closed, true); assert.equal(browser.closed, true); assert.equal(fs.existsSync(profile), false);
  }
  let profile;
  await assert.rejects(withFreshBrowser(f.root, () => assert.fail(), { chrome: "fake", tempRoot: f.root, launch: async cfg => { profile = cfg.profile; throw new Error("launch failed"); } }), /launch failed/);
  assert.equal(fs.existsSync(profile), false);
});
test("headless engine uses only pipes and kills its own process when launch fails", async t => {
  const f = fixture(t), calls = [];
  let killed = 0;
  await assert.rejects(Browser.launch({ chrome: "fake", tempRoot: f.root, profile: path.join(f.root, "profile") }, {
    headless: true, spawnChrome: (exe, args, opts) => {
      calls.push({ exe, args, opts });
      const proc = new EventEmitter(); proc.stdio = [null, null, null, new PassThrough(), new PassThrough()];
      proc.kill = () => { killed++; };
      queueMicrotask(() => proc.emit("error", new Error("fake spawn error")));
      return proc;
    },
  }), /Chrome/);
  assert.equal(killed, 1); assert.ok(calls[0].args.includes("--headless=new")); assert.ok(calls[0].args.includes("--remote-debugging-pipe"));
  assert.ok(!calls[0].args.some(arg => arg.includes("debugging-port"))); assert.equal(calls[0].args.at(-1), "about:blank");
});
test("static server refuses traversal and symlinks outside its directory", t => {
  const f = fixture(t), folder = path.join(f.root, "site"); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, "index.html"), "site");
  fs.writeFileSync(path.join(f.root, "secret.txt"), "outside");
  const request = url => {
    let code, body; staticHandler(folder)({ method: "GET", url }, { writeHead: value => { code = value; }, end: value => { body = value?.toString(); } });
    return { code, body };
  };
  assert.deepEqual(request("/"), { code: 200, body: "site" });
  for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt", "/%00", "/%zz"]) assert.equal(request(url).code, 404);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "index.html"), "private");
  try { fs.symlinkSync(outside, path.join(folder, "link"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; return; }
  assert.equal(request("/link/").code, 404);
});
test("deploy polling cache-busts, uses a fake clock, times out, interrupts, and filters GitHub checks", async () => {
  let time = 0, calls = 0;
  const urls = [];
  const result = await pollDeploy({ url: "https://site.invalid", path: "/app.js", marker: "new-sha", intervalSec: 1, timeoutMin: 1 }, {
    now: () => time, sleep: async ms => { time += ms; },
    fetchText: async (url, timeout) => { urls.push(url); assert.ok(timeout > 0 && timeout <= 15000); return ++calls === 3 ? "new-sha" : "old"; },
  });
  assert.equal(result.found, true); assert.equal(result.minutes, 2 / 60); assert.equal(new Set(urls).size, 3);
  const timeout = await pollDeploy({ url: "https://site.invalid", path: "/", marker: "missing", timeoutMin: 0.05, intervalSec: 1 }, {
    now: () => time, sleep: async ms => { time += ms; }, fetchText: async () => "old",
  });
  assert.equal(timeout.found, false); assert.equal(timeout.minutes, 0.05);
  await assert.rejects(pollDeploy({ url: "https://site.invalid", path: "/", marker: "x" }, { interrupted: () => true }), /interrupted/);
  assert.deepEqual(githubChecks({ check_runs: [{ name: "Workers Builds", status: "completed", conclusion: "success", html_url: "https://checks.invalid/1" }, { name: "unrelated", status: "completed" }] }), [
    { name: "Workers Builds", status: "completed", conclusion: "success", url: "https://checks.invalid/1" },
  ]);
  for (const opts of [{}, { url: "file:///secret", path: "/", marker: "x" }, { url: "https://site.invalid", path: "//other.invalid/x", marker: "x" }]) assert.throws(() => validateDeploy(opts));
  for (const opts of [{}, { url: "file:///secret" }, { url: "https://site.invalid", widths: [0] }]) assert.throws(() => validateShot(opts));
});
test("deploy fetch uses browser abort bounds and gh reporting only", async t => {
  const f = fixture(t), browser = browserFake(), commands = [], expressions = [];
  const originalSend = browser.send;
  browser.send = async (method, params, session) => {
    if (method === "Runtime.evaluate") { expressions.push(params.expression); return { result: { value: "marker" } }; }
    return originalSend(method, params, session);
  };
  const result = await deployWait({ url: "https://site.invalid", path: "/app.js", marker: "marker", repo: "owner/repo", sha: "abcdef123" }, f.root, {
    browser: (directory, action) => withFreshBrowser(directory, action, { chrome: "fake", tempRoot: f.root, launch: async () => browser }),
    run: async (exe, args) => { commands.push([exe, ...args]); return { code: 0, stdout: '{"check_runs":[{"name":"Workers Builds","status":"in_progress"}]}' }; },
  });
  assert.equal(result.found, true); assert.equal(result.checks[0].name, "Workers Builds");
  assert.match(expressions[0], /AbortSignal\.timeout/);
  assert.deepEqual(commands, [["gh", "api", "repos/owner/repo/commits/abcdef123/check-runs"]]);
});
test("review jobs return immediately and expose compact results, raw transcript and one reviewer failure", async t => {
  const f = fixture(t), diffFile = path.join(f.root, "change.patch"); fs.writeFileSync(diffFile, "--- a/app.js\n+++ b/app.js\n+change");
  const calls = [], result = await startOperation("review", { repo: f.root, diffFile, reviewers: ["agy", "grok", "api:free"] }, {
    env: f.env, dataDir: f.dataDir, spawnJob: fakeSpawn(calls), reviewOptions: { run: async () => ({ code: 0, stdout: ".git" }) },
  });
  assert.match(result.wait, / wait review-/); assert.equal(calls.length, 1);
  const directory = runDirectory(f.dataDir, result.runId);
  assert.equal(readAsk(directory).kind, "review"); assert.ok(fs.existsSync(path.join(directory, "launch.ready")));
  await runOperation(directory, { env: { ...f.env, FLEET_WORKER: "1" }, executeReviewer: async (reviewer, prompt) => {
    assert.ok(prompt.includes("+change")); assert.ok(prompt.includes("no repository access"));
    if (reviewer.backend === "api") return "not JSON";
    return JSON.stringify({ findings: [finding()] });
  } });
  const compact = (await callTool("fleet_run", { runId: result.runId }, { env: f.env })).value;
  assert.equal(compact.agreed.length, 1); assert.deepEqual(compact.reviewers.map(row => row.status), ["done", "done", "failed"]);
  const transcript = (await callTool("fleet_transcript", { runId: result.runId }, { env: f.env })).value;
  assert.match(transcript, /not JSON/); assert.match(transcript, /Null input/);
  assert.equal((await listRuns(f.dataDir)).runs[0].kind, "review");
  const [waited] = await waitRuns([result.runId], { env: f.env });
  assert.equal(waited.status, "done"); assert.deepEqual(waited.agreed, compact.agreed); assert.equal(waited.answer, undefined);
  assert.equal(await cli(["wait", result.runId], { env: f.env, print() {} }), 0);
});
test("review coordinator persists anchored findings before agreed and unconfirmed grouping while retaining raw answers", async t => {
  const f = fixture(t), diffFile = path.join(f.root, 'cart.patch'); fs.writeFileSync(diffFile, cartDiff());
  const answer = JSON.stringify({ findings: [
    finding({ file: 'cart.js', line: 100, claim: 'items.length <= permits an extra iteration', failure: 'items.length access fails' }),
    finding({ file: 'cart.js', line: 16, claim: 'percent / 10 scales incorrectly', failure: 'percent divided by 10' }),
  ] });
  for (const minAgree of [2, 3]) {
    const job = await startOperation('review', { repo: f.root, diffFile, reviewers: ['agy', 'api:free'], minAgree }, {
      env: f.env, spawnJob: fakeSpawn(), reviewOptions: { run: async () => ({ code: 0, stdout: '.git' }) },
    });
    const directory = runDirectory(f.dataDir, job.runId);
    const run = await runOperation(directory, { env: f.env, executeReviewer: async () => answer });
    const rows = JSON.parse(fs.readFileSync(path.join(directory, 'reviewers.json'), 'utf8'));
    for (const row of rows) {
      assert.equal(row.answer, answer);
      assert.deepEqual(row.findings.map(item => [item.line, item.reportedLine]), [[4, 100], [9, 16]]);
    }
    const groups = minAgree === 2 ? run.result.agreed : run.result.unconfirmed;
    assert.deepEqual(groups.map(item => [item.line, item.reportedLine]), [[4, 100], [9, 16]]);
    assert.ok(groups.every(item => item.by.length === 2));
    if (minAgree === 3) { assert.deepEqual(run.result.agreed, []); assert.match(run.result.note, /agreement impossible/); }
  }
});
for (const name of ['reviewers-two-agree.json', 'reviewers-chained.json']) test(`review coordinator anchors recorded ${name} before persisting and grouping`, async t => {
  const f = fixture(t), source = JSON.parse(fs.readFileSync(new URL(`./fixtures/review-real/${name}`, import.meta.url), 'utf8'));
  const diffFile = path.join(f.root, 'cart.synthetic.patch'); fs.writeFileSync(diffFile, cartDiff());
  const job = await startOperation('review', { repo: f.root, diffFile, reviewers: source.map(row => row.id) }, {
    env: f.env, spawnJob: fakeSpawn(), reviewOptions: { run: async () => ({ code: 0, stdout: '.git' }) },
  });
  const directory = runDirectory(f.dataDir, job.runId);
  const run = await runOperation(directory, { env: f.env, executeReviewer: async reviewer => {
    const row = source.find(item => item.id === reviewer.id);
    if (row.status !== 'done') throw Object.assign(new Error(row.error), { status: row.status });
    return row.answer;
  } });
  const expected = source.filter(row => row.status === 'done').map(row => row.id);
  assert.deepEqual(run.result.agreed.map(group => [group.file, group.line, group.severity]), [
    ['cart.js', 4, 'blocker'], ['cart.js', 9, name === 'reviewers-chained.json' ? 'blocker' : 'major'],
  ]);
  for (const group of run.result.agreed) assert.deepEqual(group.by, expected);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'reviewers.json'), 'utf8'));
  for (const row of stored.filter(item => item.status === 'done')) {
    assert.equal(row.answer, source.find(item => item.id === row.id).answer);
    assert.deepEqual(row.findings.map(item => item.line), [4, 9]);
  }
  assert.equal(stored.find(row => row.id === 'grok').status, 'limit');
  if (name === 'reviewers-chained.json') assert.deepEqual(stored.find(row => row.id === 'api:free').findings.map(item => item.reportedLine), [9, 16]);
});
test("operation CLI help and arguments remain specific to each command", async t => {
  const f = fixture(t), lines = [];
  await cli(["help"], { env: f.env, print: line => lines.push(line) });
  for (const command of ["review", "shot", "deploy-wait"]) assert.match(lines.join("\n"), new RegExp(`fleet ${command}`));
  for (const args of [
    ["shot", "--range", "A..B"], ["review", "--full-page"], ["deploy-wait", "--widths", "390"],
    ["shot", "--url", "https://site.invalid", "--url", "https://other.invalid"],
    ["review", "--private", "--no-private"],
  ]) await assert.rejects(cli(args, { env: f.env }), /invalid option|duplicate option/);
});
test("new work tools are short, unapproved, and unavailable to recursive workers", async t => {
  const f = fixture(t), names = ["fleet_review", "fleet_shot", "fleet_deploy_wait"], env = { ...f.env, FLEET_WORKER: "1" };
  for (const name of names) {
    const tool = TOOLS.find(tool => tool.name === name); assert.ok(tool.description.length < 120); assert.equal(tool.annotations?.readOnlyHint, undefined);
    assert.ok(!toolsFor({ env }).some(tool => tool.name === name));
    await assert.rejects(callTool(name, {}, { env }), /FLEET_WORKER/);
  }
  for (const command of ["review", "shot", "deploy-wait"]) await assert.rejects(cli([command], { env }), /FLEET_WORKER/);
});
test("review coordinator passes inline schemas and prompts with scratch-only Codex access", async t => {
  const f = fixture(t), diffFile = path.join(f.root, "diff.patch"); fs.writeFileSync(diffFile, "inline diff");
  const result = await startOperation("review", { repo: f.root, diffFile, reviewers: ["agy", "api:free", "local", "codex"] }, {
    env: f.env, spawnJob: fakeSpawn(), reviewOptions: { run: async () => ({ code: 0, stdout: ".git" }) },
  });
  const directory = runDirectory(f.dataDir, result.runId), targets = [], env = { ...f.env, FLEET_WORKER: "1" };
  const run = await runOperation(directory, {
    env,
    startChild: async (opts, options) => {
      assert.equal(options.env.FLEET_WORKER, "1"); assert.equal(options.reviewDirectory, directory);
      targets.push(opts);
      const runId = `child-${targets.length}`, folder = path.join(f.dataDir, "runs", runId); fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "answer.txt"), '{"findings":[]}');
      return { runId };
    },
    waitChild: async () => [{ status: "done" }],
  });
  assert.equal(run.status, "done");
  assert.deepEqual(JSON.parse(targets[0].jsonSchema), FINDINGS_SCHEMA);
  for (const target of targets.slice(1, 3)) assert.equal(target.responseFormat, "json");
  assert.equal(targets[3].readOnly, true); assert.ok(targets[3].cwd.startsWith(directory)); assert.notEqual(targets[3].cwd, f.root);
  assert.ok(targets.every(target => target.prompt.includes("inline diff") && !target.addDirs));
});
test("shot and deploy jobs share durable run/history/wait and interruption paths", async t => {
  const f = fixture(t), browser = browserFake();
  const browserOptions = { browser: (directory, action) => withFreshBrowser(directory, action, { chrome: "fake", tempRoot: f.root, launch: async () => browser }) };
  const captured = await startOperation("shot", { url: "https://site.invalid", widths: [390], fullPage: false }, { env: f.env, browserOptions });
  assert.equal(captured.files[0].height, 900); assert.equal(readAsk(runDirectory(f.dataDir, captured.runId)).kind, "shot");
  const deployed = await startOperation("deploy_wait", { url: "https://site.invalid", path: "/", marker: "x" }, { env: f.env, spawnJob: fakeSpawn() });
  await callTool("fleet_interrupt", { runId: deployed.runId }, { env: f.env });
  await runOperation(runDirectory(f.dataDir, deployed.runId), { env: f.env, browserOptions: { browser: () => assert.fail("interrupted job must not launch") } });
  const rows = await waitRuns([captured.runId, deployed.runId], { env: f.env });
  assert.deepEqual(rows.map(row => row.status), ["done", "interrupted"]);
  assert.deepEqual(new Set((await listRuns(f.dataDir)).runs.map(row => row.kind)), new Set(["shot", "deploy_wait"]));
});
