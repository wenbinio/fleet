import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ADAPTERS, ADVISOR_NOTICE } from "../runner/lib/adapters.mjs";
import { accounts, parseModelIds, parseGrokModelIds } from "../runner/lib/accounts.mjs";
import { atomicJson, startAsk, readAsk, runDirectory, liveStatus, waitRuns, validateAsk, listRuns, ASK_JOB } from "../runner/lib/jobs.mjs";
import { runAskJob, backendCommand } from "../runner/ask-job.mjs";
import { toolkitRepo, injectRuntime, CORE_ROOT } from "../runner/lib/runtime.mjs";
import { callTool, TOOLS, eventBeat } from "../mcp/fleet-mcp.mjs";
import { cli } from "../runner/fleet.mjs";
import { EFFORT_RULES, EFFORT_DESCRIPTION, effortNote } from "../core/lib/effort.mjs";

const grokModelsOutput = "You are not authenticated.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5";
const grokModelIds = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
function fixture(t) {
  const scratch = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "fleet-ask-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const repo = path.join(root, "toolkit"), dataDir = path.join(root, "home", "fleet"), runsDir = path.join(root, "toolkit-runs");
  const env = { ...process.env, FLEET_WORKER: "", FLEET_LOCAL_ROOT: path.join(root, "absent-qwen"), FLEET_HOME: "", HOME: root, USERPROFILE: root, AGENT_TOOLKIT_HOME: path.join(root, "home"), CHATGPT_WEB_HOME: path.join(root, "chatgpt"), CLAUDE_PLUGIN_DATA: dataDir, FLEET_FAKE_RUNS: runsDir };
  write(path.join(env.AGENT_TOOLKIT_HOME, "config.json"), JSON.stringify({ repo, local: { folder: path.join(root, "absent-qwen") }, providers: [{name:"openrouter",kind:"openai",baseUrl:"https://openrouter.invalid/api/v1",keyEnv:"FAKE_PROVIDER_KEY"}] }));
  write(path.join(repo, "lib/toolkit.mjs"), `
    import fs from "node:fs"; import path from "node:path";
    export const loadConfig = env => ({ ...JSON.parse(fs.readFileSync(path.join(env.AGENT_TOOLKIT_HOME,"config.json"),"utf8")), runsDir: env.FLEET_FAKE_RUNS });
    export const resolveTool = name => name;
    export const capture = async () => ({ code: 0, stdout: "grok-4.7\\ngemini-3.8-flash-low", stderr: "" });
    export const signInStatus = async (name, {env}) => ({ backend: name === "dsh" ? "deepseek" : name, found: true, signedIn: name === "dsh" ? null : env.FAKE_SIGNED_OUT !== "1", detail: "fixture current account" });
  `);
  write(path.join(repo, "lib/api.mjs"), `export * from ${JSON.stringify(new URL("../core/lib/api.mjs", import.meta.url).href)};`);
  write(path.join(repo, "lib/media.mjs"), `export * from ${JSON.stringify(new URL("../core/lib/media.mjs", import.meta.url).href)};`);
  write(path.join(repo, "lib/webchat/state.mjs"), `export * from ${JSON.stringify(new URL("../core/lib/webchat/state.mjs", import.meta.url).href)};`);
  write(path.join(repo, "..", "backends/advisor/advisor.mjs"), "// fake advisor; never executed");
  // A complete fake runner can also be launched by the detached integration test.
  write(path.join(repo, "lib/runners.mjs"), `
    import fs from "node:fs"; import path from "node:path";
    import {pathToFileURL} from "node:url";
    export {aliases} from ${JSON.stringify(new URL("../core/lib/runners.mjs", import.meta.url).href)};
    if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2), backend = args[0];
    if (backend === "codex-run") {
      const id=args[1], dir=path.join(process.env.FLEET_FAKE_RUNS,"codex",id);
      fs.mkdirSync(dir,{recursive:true}); let round=1; while(fs.existsSync(path.join(dir,"r"+round+".last.txt"))) round++;
      fs.writeFileSync(path.join(dir,"r"+round+".last.txt"),"complete fake Codex answer");
      fs.writeFileSync(path.join(dir,"r"+round+".events.jsonl"),JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"complete"}})+"\\n");
      console.log("["+id+"] round "+round+" exit 0, session fake-session");
    } else console.log("complete fake agy answer"); }
  `);
  write(path.join(repo, "bin/dsh-run.ps1"), `'{"type":"final","text":"complete fake DeepSeek answer","session_id":"fake-dsh"}'\nexit 0\n`);
  injectRuntime(env, { repo });
  return { root, repo, dataDir, runsDir, env };
}
function detachedFake(calls = []) {
  return (exe, args, opts) => {
    assert.equal(opts.env.FLEET_WORKER, "1");
    calls.push({ exe, args, opts });
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => { child.unreffed = true; };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}
function backendFake(action) {
  return (exe, args, opts) => {
    assert.equal(opts.env.FLEET_WORKER, "1", "every adapter subprocess is a fleet worker");
    const child = new EventEmitter();
    child.pid = 123456789; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => action({ exe, args, opts, child }));
    return child;
  };
}
async function reserve(f, opts = {}) {
  const result = await startAsk({ backend: "codex", prompt: "implement the thing", ...(["api", "image", "advisor", "chatgpt", "sound", "local"].includes(opts.backend) ? {} : { cwd: f.root }), ...opts }, { env: f.env, spawnJob: detachedFake(), gpuOptions: { fetch: async url => ({ status: 200, text: async () => url.endsWith("/health") ? '{"status":"ok"}' : url.endsWith("/props") ? '{"is_sleeping":true}' : '{"models":[]}' }) } });
  return { result, directory: runDirectory(f.dataDir, result.runId) };
}
function finish(child, stdout = "", stderr = "", code = 0) {
  child.stdout.end(stdout); child.stderr.end(stderr); child.emit("close", code);
}
test("fleet runtime is self-contained and explicit fake injection is isolated", t => {
  const f = fixture(t);
  assert.equal(toolkitRepo({ env: f.env }), f.repo);
  fs.unlinkSync(path.join(f.repo, "lib/runners.mjs"));
  assert.equal(toolkitRepo({ env: { ...f.env } }), CORE_ROOT);
});
test("ask validates backend options, prompt exclusivity and absolute directories", t => {
  const f = fixture(t), valid = { backend: "codex", prompt: "hello", cwd: f.root };
  for (const changes of [{ backend: "other" }, { promptFile: path.join(f.root, "missing") }, { prompt: undefined }, { cwd: "." }, { effort: "max" }, { readOnly: "yes" }, { addDirs: "dir" }, { jsonSchema: "{}" }, { unknown: true }]) assert.throws(() => validateAsk({ ...valid, ...changes }, { env: f.env }));
  for (const key of ["effort", "readOnly", "resume"]) assert.throws(() => validateAsk({ backend: "agy", prompt: "hello", [key]: "x" }, { env: f.env }), /only/);
  assert.throws(() => validateAsk({ backend: "deepseek", prompt: "hello", cwd: f.root, model: "other" }, { env: f.env }), /invalid deepseek model/);
  assert.throws(() => validateAsk({ backend: "deepseek", prompt: "hello", cwd: f.root, addDirs: [] }, { env: f.env }), /codex or agy only/);
  assert.doesNotThrow(() => validateAsk({ backend: "agy", prompt: "hello", jsonSchema: "{}" }, { env: f.env }));
});
test("effort validation and the MCP string schema share backend rules", async t => {
  const f = fixture(t);
  const expected = {
    codex: ["low", "medium", "high", "xhigh"], image: ["low", "medium", "high", "xhigh"],
    grok: ["low", "medium", "high", "xhigh", "future effort"], api: ["low", "medium", "high"], advisor: ["low", "medium", "high"], local: ["low", "medium", "high"],
  };
  assert.deepEqual(new Set(Object.keys(EFFORT_RULES)), new Set(Object.keys(expected)));
  for (const [backend, values] of Object.entries(expected)) {
    const opts = { backend, prompt: "hello", ...(backend === "codex" ? { cwd: f.root } : {}), ...(backend === "advisor" ? { lokAsked: true } : {}) };
    for (const effort of values) assert.doesNotThrow(() => validateAsk({ ...opts, effort }, { env: f.env }));
    for (const effort of ["", "  ", null, 0, true]) assert.throws(() => validateAsk({ ...opts, effort }, { env: f.env }), /effort/);
    if (backend !== "grok") assert.throws(() => validateAsk({ ...opts, effort: "future effort" }, { env: f.env }), /invalid effort/);
    if (["api", "advisor"].includes(backend)) assert.throws(() => validateAsk({ ...opts, effort: "xhigh" }, { env: f.env }), /invalid effort/);
    assert.ok(ADAPTERS[backend].allowed.includes("effort"));
  }
  for (const backend of ["agy", "deepseek", "sound"]) assert.throws(() => validateAsk({ backend, prompt: "hello", effort: "high" }, { env: f.env }), /effort.*only/);
  for (const effort of ["low", "", " ", null, false, 1]) assert.throws(
    () => validateAsk({ backend: "chatgpt", prompt: "hello", effort }, { env: f.env }),
    { message: "chatgpt always runs at full power" },
  );
  assert.deepEqual(TOOLS[0].inputSchema.properties.effort, { type: "string", description: EFFORT_DESCRIPTION });
  for (const backend of Object.keys(expected)) assert.ok(new RegExp(`(^|[ /])${backend}[/:]`).test(EFFORT_DESCRIPTION), backend);
  assert.ok(!EFFORT_DESCRIPTION.includes("\n"));
  // The exact ruling must also win when a ChatGPT-only profile slims effort
  // out of the advertised schema before direct MCP invocation.
  write(path.join(f.dataDir, "profile.json"), JSON.stringify({ name: "lok", backends: Object.fromEntries(Object.keys(ADAPTERS).map(name => [name, name === "chatgpt"])) }));
  await assert.rejects(callTool("fleet_ask", { backend: "chatgpt", prompt: "hello", effort: "" }, {
    env: f.env, start: () => assert.fail("must reject before starting a worker"),
  }), { message: "chatgpt always runs at full power" });
});
for (const backend of ["api", "advisor"]) test(`${backend} effort reaches the worker and remains in run.json`, async t => {
  const f = fixture(t);
  const { directory } = await reserve(f, { backend, effort: "medium", ...(backend === "advisor" ? { lokAsked: true } : {}) });
  assert.equal(readAsk(directory).effort, "medium");
  const completed = await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ args, child }) => {
    const flag = backend === "api" ? "--effort" : "--thinking";
    assert.equal(args[args.indexOf(flag) + 1], backend === "api" ? "medium" : "Medium");
    if (backend === "advisor") write(path.join(directory, "answer.md"), "fixture answer");
    finish(child, backend === "api" ? JSON.stringify({ outcome: "done", answer: "fixture answer" }) : "");
  }) });
  assert.equal(completed.status, "done"); assert.equal(completed.effort, "medium");
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "run.json"), "utf8")).effort, "medium");
  const defaults = await reserve(f, { backend, ...(backend === "advisor" ? { lokAsked: true } : {}) });
  const run = readAsk(defaults.directory), command = ADAPTERS[backend].command(run, { directory: defaults.directory, repo: f.repo });
  if (backend === "api") {
    assert.ok(!Object.hasOwn(run, "effort")); assert.ok(!command.args.includes("--effort"));
  } else {
    assert.equal(run.effort, "high"); assert.equal(command.args[command.args.indexOf("--thinking") + 1], "High");
    for (const [effort, thinking] of [["low", "Low"], ["medium", "Medium"], ["high", "High"]]) {
      const args = ADAPTERS.advisor.command({ ...run, effort }, { directory: defaults.directory, repo: f.repo }).args;
      assert.equal(args[args.indexOf("--thinking") + 1], thinking);
    }
  }
});
test("start returns immediately with durable prompt, detached worker and PID handoff", async t => {
  const f = fixture(t), calls = [];
  const promptFile = write(path.join(f.root, "prompt.txt"), "exact prompt\n");
  const result = await startAsk({ backend: "codex", promptFile, cwd: f.root }, { env: f.env, spawnJob: detachedFake(calls) });
  assert.match(result.runId, /^ask-codex-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(result.model, "astra"); assert.match(result.wait, /fleet\.mjs" wait ask-codex-/);
  const directory = runDirectory(f.dataDir, result.runId), run = readAsk(directory);
  assert.equal(run.pid, process.pid); assert.equal(run.effort, "high"); assert.equal(run.codexId, result.runId);
  assert.equal(fs.readFileSync(path.join(directory, "prompt.txt"), "utf8"), "exact prompt\n");
  assert.ok(fs.existsSync(path.join(directory, "launch.ready")));
  assert.equal(calls[0].args[0], ASK_JOB); assert.equal(calls[0].opts.detached, true); assert.equal(calls[0].opts.windowsHide, true); assert.equal(calls[0].opts.stdio, "ignore");
});
test("spawn failure records a terminal failed run", async t => {
  const f = fixture(t);
  await assert.rejects(startAsk({ backend: "agy", prompt: "hello" }, { env: f.env, spawnJob() {
    const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("spawn denied"))); return child;
  } }), /spawn denied/);
  const { runs: [run] } = await listRuns(f.dataDir);
  assert.equal(run.status, "failed");
});
test("Codex copies complete final answer, round and session; resume reuses codexId", async t => {
  const f = fixture(t), { result, directory } = await reserve(f, { readOnly: true, addDirs: [f.root] });
  const full = "complete final answer\n" + "x".repeat(9000);
  const run = await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ args, opts, child }) => {
    assert.ok(args.includes("--read-only")); assert.ok(args.includes("--add-dir")); assert.equal(opts.env.AGENT_TOOLKIT_CAPTURE_ATTACHED, "1");
    const root = path.join(f.runsDir, "codex", result.runId);
    write(path.join(root, "r2.last.txt"), full);
    write(path.join(root, "r2.events.jsonl"), '{"type":"item.completed","item":{"type":"command_execution","command":"node check","exit_code":0}}\n');
    finish(child, `[${result.runId}] round 2 exit 0, session session-2\ntruncated screen answer`);
  }) });
  assert.equal(run.status, "done"); assert.equal(run.codexRound, 2); assert.equal(run.session, "session-2");
  assert.equal(fs.readFileSync(path.join(directory, "answer.txt"), "utf8"), full);
  assert.match(run.eventsPath, /r2\.events\.jsonl$/);
  const resumed = await reserve(f, { resume: result.runId });
  assert.equal(readAsk(resumed.directory).codexId, result.runId);
  const command = backendCommand(readAsk(resumed.directory), resumed.directory, f.repo);
  assert.ok(command.args.includes(result.runId)); assert.deepEqual(command.args.slice(-2), ["--resume", "last"]);
  await assert.rejects(reserve(f, { resume: result.runId }), /still running/);
  const transcript = (await callTool("fleet_transcript", { runId: result.runId }, { env: f.env })).value;
  assert.match(transcript, /command: node check \(exit 0\)/);
  const rows = await waitRuns([result.runId], { env: f.env });
  assert.equal(rows[0].answer.length, 6000); assert.match(rows[0].answer, /showing the end/);
});
test("agy denied and empty success are failures, with capped stdout and stderr", async t => {
  const f = fixture(t);
  for (const [code, stdout, stderr, expected] of [[3, "", "tool denied", "denied"], [0, " ", "", "failed"], [0, "answer", "", "done"], [1, "x".repeat(2_200_000), "e".repeat(2_200_000), "failed"]]) {
    const { directory } = await reserve(f, { backend: "agy", jsonSchema: "{}" });
    const run = await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ args, child }) => { assert.ok(args.includes("--json-schema")); finish(child, stdout, stderr, code); }) });
    assert.equal(run.status, expected); assert.equal(run.exitCode, code);
    assert.ok(fs.statSync(path.join(directory, "stdout.txt")).size <= 2 * 1024 * 1024);
    assert.ok(fs.statSync(path.join(directory, "stderr.txt")).size <= 2 * 1024 * 1024);
    if (code === 3) assert.equal(run.error, "tool denied");
    if (code === 0 && !stdout.trim()) assert.equal(run.error, "empty answer");
    if (code === 1) assert.equal(run.error.length, 2000);
  }
});
test("DeepSeek collects final events and session while preserving NDJSON", async t => {
  const f = fixture(t), { directory } = await reserve(f, { backend: "deepseek" });
  const text = '{"type":"tool_call","name":"read"}\n{"type":"final","text":"first","session_id":"dsh-session"}\n{"type":"final","content":[{"text":"second"}]}\n';
  const run = await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ exe, args, child }) => {
    assert.equal(exe, "powershell"); assert.ok(args.includes(path.join(f.repo, "bin/dsh-run.ps1"))); finish(child, text);
  }) });
  assert.equal(run.status, "done"); assert.equal(run.session, "dsh-session");
  assert.equal(fs.readFileSync(path.join(directory, "answer.txt"), "utf8"), "first\nsecond");
  assert.equal(fs.readFileSync(path.join(directory, "events.jsonl"), "utf8"), text);
  assert.match((await callTool("fleet_transcript", { runId: directory }, { env: f.env })).value, /agent: second/);
});
test("interrupt polls durable flag and requests whole-tree termination", async t => {
  const f = fixture(t), { directory } = await reserve(f, { backend: "agy" });
  let stopped = false;
  const run = await runAskJob(directory, { env: f.env, pollMs: 5, spawnBackend: backendFake(() => {
    write(path.join(directory, "interrupt.flag"), "");
  }), stopTree(child) { stopped = true; child.emit("close", null); } });
  assert.ok(stopped); assert.equal(run.status, "interrupted");
  assert.ok(run.endedAt); assert.equal(typeof run.durationMs, "number");
});
test("lost liveness is read-only and permission errors do not mean dead", async t => {
  const f = fixture(t), { directory } = await reserve(f);
  const file = path.join(directory, "run.json"), run = readAsk(directory);
  run.pid = 2147483647; atomicJson(file, run);
  const before = fs.readFileSync(file, "utf8");
  assert.equal(readAsk(directory).status, "lost");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(liveStatus(run, () => { throw Object.assign(new Error(), { code: "EPERM" }); }).status, "running");
});
test("concurrent agy starts enforce the four-job cap", async t => {
  const f = fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserve(f, { backend: "agy" })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 4);
  assert.ok(results.filter(r => r.status === "rejected").every(r => /agy runs 4 jobs at once; wait for one/.test(r.reason.message)));
});
test("run paths reject traversal and junction escapes", async t => {
  const f = fixture(t), { directory } = await reserve(f);
  assert.throws(() => runDirectory(f.dataDir, "../elsewhere"), /directory name/);
  assert.throws(() => runDirectory(f.dataDir, f.root), /inside/);
  assert.equal(runDirectory(f.dataDir, directory), directory);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  const junction = path.join(f.dataDir, "runs", "escape");
  try { fs.symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.diagnostic("symlinks unavailable"); throw error; }
  assert.throws(() => runDirectory(f.dataDir, "escape"), /inside/);
  const batch = path.join(f.dataDir, "runs", "batch");
  write(path.join(outside, "transcript.md"), "outside content");
  const linked = path.join(batch, "transcripts");
  fs.mkdirSync(batch);
  fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  write(path.join(batch, "results.json"), JSON.stringify({ results: [{ taskId: "escape", transcriptPath: path.join(linked, "transcript.md") }] }));
  await assert.rejects(callTool("fleet_transcript", { runId: batch, taskId: "escape" }, { env: f.env }), /outside the plugin/);
  const secret = write(path.join(outside, "secret.txt"), "secret-token");
  fs.symlinkSync(secret, path.join(directory, "answer.txt"));
  await assert.rejects(callTool("fleet_run", { runId: directory }, { env: f.env }), /symlink/);
  fs.unlinkSync(path.join(directory, "answer.txt"));
  const poisoned = readAsk(directory);
  atomicJson(path.join(directory, "run.json"), { ...poisoned, eventsPath: secret });
  await assert.rejects(callTool("fleet_transcript", { runId: directory }, { env: f.env }), /outside the allowed directory/);
});
test("wait and CLI report terminal outcomes and timeout without mutating runs", async t => {
  const f = fixture(t), { result, directory } = await reserve(f, { backend: "agy" });
  const rows = await waitRuns([result.runId], { env: f.env, timeout: 0 });
  assert.equal(rows[0].status, "running"); assert.equal(rows[0].error, "wait timeout");
  await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ child }) => finish(child, "done")) });
  const printed = [];
  assert.equal(await cli(["wait", result.runId, "--timeout", "1"], { env: f.env, print: row => printed.push(JSON.parse(row)) }), 0);
  assert.equal(printed[0].answer, "done");
  assert.equal(await cli(["run", result.runId], { env: f.env, print: row => printed.push(JSON.parse(row)) }), 0);
  assert.equal(printed[1].status, "done");
  const run = readAsk(directory); atomicJson(path.join(directory, "run.json"), { ...run, status: "denied" });
  assert.equal(await cli(["wait", result.runId], { env: f.env, print() {} }), 1);
  await assert.rejects(waitRuns([], { env: f.env }), /at least one/);
});
test("MCP exposes eight concise tools and routes each kind including accounts and live events", async t => {
  const f = fixture(t), options = { env: f.env };
  assert.deepEqual(TOOLS.map(t => t.name), ["fleet_ask", "fleet_runs", "fleet_run", "fleet_transcript", "fleet_status", "fleet_steer", "fleet_interrupt", "fleet_accounts", "fleet_review", "fleet_shot", "fleet_deploy_wait"]);
  assert.ok(TOOLS.every(t => t.description.length < 120));
  for (const name of ["fleet_runs", "fleet_run", "fleet_transcript", "fleet_status", "fleet_accounts"]) assert.equal(TOOLS.find(t => t.name === name).annotations.readOnlyHint, true);
  const asked = await callTool("fleet_ask", { backend: "agy", prompt: "hello" }, { ...options, start: (opts, options) => startAsk(opts, { ...options, spawnJob: detachedFake() }) });
  const id = asked.value.runId, directory = runDirectory(f.dataDir, id);
  assert.equal((await callTool("fleet_runs", { backend: "agy", limit: 1 }, options)).value.runs[0].kind, "ask");
  assert.equal((await callTool("fleet_run", { runId: id }, options)).value.answer, "");
  assert.equal((await callTool("fleet_status", { runId: id }, options)).value.status, "running");
  assert.match((await callTool("fleet_transcript", { runId: id }, options)).value, /Prompt:\nhello/);
  await assert.rejects(callTool("fleet_steer", { runId: id, text: "continue" }, options), /fleet_ask with resume/);
  assert.equal((await callTool("fleet_interrupt", { runId: id }, options)).value.ok, true);
  assert.ok(fs.existsSync(path.join(directory, "interrupt.flag")));
  assert.equal((await callTool("fleet_accounts", {}, { ...options, apiOptions: { keyReader: async () => null, fetch: async () => { throw new Error("fake unavailable catalog"); } } })).value.length, 11);
  const delegate = path.join(f.dataDir, "runs", "delegate");
  write(path.join(delegate, "state.json"), '{"status":"awaiting-steer","turns":1}');
  write(path.join(delegate, "events.jsonl"), JSON.stringify({ type: "agentMessage", text: "old".repeat(100_000) }) + "\n" + Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: "agentMessage", text: `beat-${i}` })).join("\n"));
  assert.equal((await callTool("fleet_run", { runId: delegate }, options)).value.beats.length, 10);
  const delegateStatus = (await callTool("fleet_status", { runId: delegate }, options)).value;
  assert.equal(delegateStatus.state.status, "awaiting-steer");
  assert.equal(delegateStatus.beats[0], "agent: beat-2");
  assert.equal(delegateStatus.beats.at(-1), "agent: beat-11");
  assert.match((await callTool("fleet_transcript", { runId: delegate }, options)).value, /beat-0/);
  await callTool("fleet_steer", { runId: delegate, text: "new direction" }, options);
  assert.equal(fs.readdirSync(path.join(delegate, "steer.inbox")).length, 1);
  await callTool("fleet_interrupt", { runId: delegate }, options);
  assert.ok(fs.existsSync(path.join(delegate, "interrupt.flag")));
  const batch = path.join(f.dataDir, "runs", "batch"), transcript = path.join(batch, "task.md");
  write(transcript, "# full batch transcript");
  write(path.join(batch, "results.json"), JSON.stringify({ complete: true, results: [{ taskId: "task", driver: { status: "done", verifyPassed: true, transcriptPath: transcript } }] }));
  assert.equal((await callTool("fleet_run", { runId: batch }, options)).value.tasks[0].taskId, "task");
  assert.match((await callTool("fleet_transcript", { runId: batch, taskId: "task" }, options)).value, /full batch/);
  await assert.rejects(callTool("fleet_transcript", { runId: batch }, options), /taskId/);
  const runs = (await callTool("fleet_runs", {}, options)).value.runs;
  assert.deepEqual(new Set(runs.map(r => r.kind)), new Set(["ask", "batch", "delegate"]));
  assert.equal(runs.find(r => r.kind === "batch").taskCount, 1);
  const codex = await reserve(f);
  const run = readAsk(codex.directory);
  write(path.join(f.runsDir, "codex", run.codexId, "r1.events.jsonl"), '{"type":"item.completed","item":{"type":"reasoning","text":"live thought"}}\n');
  assert.match((await callTool("fleet_status", { runId: run.runId }, options)).value.beats[0], /reasoning: live thought/);
  assert.match(eventBeat({ item: { type: "file_change", changes: [{ path: "app.js" }] } }), /files: app.js/);
  await assert.rejects(callTool("fleet_runs", { limit: -1 }, options), /positive integer/);
});
test("adapter table is the single source of backend contracts", () => {
  assert.deepEqual(Object.keys(ADAPTERS), ["codex", "agy", "deepseek", "grok", "api", "image", "advisor", "chatgpt", "sound", "local"]);
  for (const adapter of Object.values(ADAPTERS)) {
    assert.equal(typeof adapter.defaults, "object"); assert.ok(Array.isArray(adapter.allowed));
    for (const operation of ["command", "parse", "transcript"]) assert.equal(typeof adapter[operation], "function");
  }
  assert.equal(TOOLS[0].inputSchema.properties.effort.type, "string");
  assert.deepEqual(TOOLS[0].inputSchema.properties.backend.enum, Object.keys(ADAPTERS));
  const descriptions = Object.fromEntries(Object.entries(TOOLS[0].inputSchema.properties).filter(([, schema]) => schema.description).map(([name, schema]) => [name, schema.description]));
  assert.deepEqual(descriptions, {
    cwd: "Absolute folder the worker runs in.",
    timeout: "Seconds; local default 1200, chatgpt 1800.",
    effort: "codex/image: low|medium|high|xhigh; grok: any; api/advisor/local: low|medium|high; not chatgpt.",
    resume: "Earlier runId to continue.",
    system: "System-prompt file path.",
    images: "Absolute reference images.",
    files: "Absolute paths sent to the advisor.",
    lokAsked: "True only when Lok asked for Argon.",
  });
});
test("wait and CLI expose the first 500 error characters for non-done runs and keep failure exit 1", async t => {
  const f = fixture(t), error = "Useful failure reason. " + "x".repeat(700), ids = [];
  for (const status of ["failed", "denied", "interrupted", "lost", "empty", "rate_limited", "daily_limit", "done"]) {
    const runId = `wait-${status}`; ids.push(runId);
    write(path.join(f.dataDir, "runs", runId, "run.json"), JSON.stringify({ kind: "ask", runId, backend: "api", status, error }));
  }
  const rows = await waitRuns(ids, { env: f.env });
  assert.ok(rows.slice(0, -1).every(row => row.error === error.slice(0, 500)));
  assert.equal(Object.hasOwn(rows.at(-1), "error"), false);
  const output = [];
  assert.equal(await cli(["wait", ...ids], { env: f.env, print: line => output.push(JSON.parse(line)) }), 1);
  assert.deepEqual(output, rows);
  assert.equal(await cli(["wait", ids.at(-1)], { env: f.env, print() {} }), 0);
  write(path.join(f.dataDir, "runs", "failed-delegate", "state.json"), JSON.stringify({ status: "failed", error }));
  assert.equal((await waitRuns(["failed-delegate"], { env: f.env }))[0].error, error.slice(0, 500));
});
test("Grok success, denied and resume preserve session and block duplicate live resumes", async t => {
  const f = fixture(t);
  const first = await reserve(f, { backend: "grok", effort: "custom-effort" });
  assert.equal(first.result.model, "grok-4.7");
  const run = await runAskJob(first.directory, { env: f.env, spawnBackend: backendFake(({ args, child }) => {
    assert.ok(args.includes("grok-run")); assert.ok(args.includes("--json")); assert.ok(args.includes("custom-effort"));
    finish(child, JSON.stringify({ answer: "read-only answer", sessionId: "grok-session", stopReason: "end_turn", usage: { total_tokens: 40 } }));
  }) });
  assert.equal(run.status, "done"); assert.equal(run.session, "grok-session"); assert.equal(run.usage.total_tokens, 40);
  const resumed = await reserve(f, { backend: "grok", resume: first.result.runId });
  const command = backendCommand(readAsk(resumed.directory), resumed.directory, f.repo);
  assert.equal(command.args[command.args.indexOf("--resume") + 1], "grok-session");
  await assert.rejects(reserve(f, { backend: "grok", resume: first.result.runId }), /still running/);
  const denied = await runAskJob(resumed.directory, { env: f.env, spawnBackend: backendFake(({ child }) => finish(child, JSON.stringify({ answer: "", sessionId: "grok-session", stopReason: "cancelled" }), "denied: fixture approval", 3)) });
  assert.equal(denied.status, "denied"); assert.equal(denied.session, "grok-session");
  assert.equal(fs.readFileSync(path.join(resumed.directory, "answer.txt"), "utf8"), "");
  assert.match((await callTool("fleet_transcript", { runId: first.result.runId }, { env: f.env })).value, /stopReason.*end_turn/);
  const codex = await reserve(f);
  await assert.rejects(reserve(f, { backend: "grok", resume: codex.result.runId }), /earlier grok/);
  for (const key of ["readOnly", "addDirs", "jsonSchema"]) assert.throws(() => validateAsk({ backend: "grok", prompt: "read", [key]: key === "readOnly" ? true : key === "addDirs" ? [] : "{}" }, { env: f.env }), /only/);
});
for (const [backend, cap] of [["grok", 4], ["api", 8]]) {
  test(`${backend} concurrent starts enforce cap ${cap}`, async t => {
    const f = fixture(t);
    const results = await Promise.allSettled(Array.from({ length: cap + 2 }, () => reserve(f, { backend })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, cap);
    assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason.message.includes(`runs ${cap} jobs at once`)));
  });
}
test("API ask records actual model, reasoning, spend and every terminal outcome", async t => {
  const f = fixture(t);
  for (const key of ["cwd", "readOnly", "addDirs", "jsonSchema", "resume"]) {
    assert.throws(() => validateAsk({ backend: "api", prompt: "hello", [key]: key === "cwd" ? f.root : "not-applicable" }, { env: f.env }), /only/);
  }
  await assert.rejects(reserve(f, { backend: "api", model: "paid/model" }), /needs maxCostUsd/);
  const ids = [];
  for (const [outcome, code] of [["done", 0], ["empty", 4], ["failed", 1], ["denied", 3], ["rate_limited", 5], ["daily_limit", 5]]) {
    const ask = await reserve(f, { backend: "api", maxTokens: 42 });
    ids.push(ask.result.runId);
    const run = await runAskJob(ask.directory, { env: f.env, spawnBackend: backendFake(({ args, child }) => {
      assert.ok(args.includes("api-run")); assert.ok(args.includes("--json"));
      assert.equal(args[args.indexOf("--provider") + 1], "openrouter");
      assert.equal(args[args.indexOf("--max-tokens") + 1], "42");
      finish(child, JSON.stringify({ outcome, answer: outcome === "done" ? "answer" : "", reasoning: "separate thinking", requestedModel: "openrouter/free", model: "vendor/actual:free", provider: "openrouter", free: true, usage: { cost: 0.01 }, costUsd: 0.01, overCap: false }), "", code);
    }) });
    assert.equal(run.status, outcome); assert.equal(run.model, "vendor/actual:free"); assert.equal(run.requestedModel, "openrouter/free");
    assert.equal(run.costUsd, 0.01); assert.equal(fs.readFileSync(path.join(ask.directory, "reasoning.txt"), "utf8"), "separate thinking");
    const [waited] = await waitRuns([ask.result.runId], { env: f.env, timeout: 0 }); assert.equal(waited.status, outcome);
    assert.equal(await cli(["wait", ask.result.runId], { env: f.env, print() {} }), outcome === "done" ? 0 : 1);
  }
  const history = (await callTool("fleet_runs", { limit: 1, backend: "codex" }, { env: f.env })).value;
  assert.equal(history.runs.length, 0); assert.ok(Math.abs(history.spendUsd - 0.06) < 1e-9);
  const apiHistory = (await callTool("fleet_runs", { backend: "api", limit: 1 }, { env: f.env })).value;
  assert.equal(apiHistory.runs[0].free, true); assert.equal(apiHistory.runs[0].costUsd, 0.01);
  const first = runDirectory(f.dataDir, ids[0]);
  atomicJson(path.join(first, "run.json"), { ...readAsk(first), provider: "other-provider" });
  f.env.FAKE_PROVIDER_KEY = randomUUID();
  const accounts = (await callTool("fleet_accounts", {}, { env: f.env, apiOptions: { keyReader: async () => f.env.FAKE_PROVIDER_KEY, fetch: async url => ({ status: 200, text: async () => url.endsWith("/models") ? '{"data":[]}' : '{"data":{"limit":10,"limit_remaining":9}}' }) } })).value;
  assert.ok(Math.abs(accounts.find(a => a.backend === "api").spendUsd - 0.05) < 1e-9);
  assert.ok(!JSON.stringify(accounts).includes(f.env.FAKE_PROVIDER_KEY));
  const badExit = await reserve(f, { backend: "api" });
  const failed = await runAskJob(badExit.directory, { env: f.env, spawnBackend: backendFake(({ child }) => finish(child, '{"outcome":"done","answer":"premature answer"}', "", 1)) });
  assert.equal(failed.status, "failed");
});
test("historical transcripts remain readable without toolkit config, and models CLI uses injected catalog", async t => {
  const f = fixture(t), done = await reserve(f, { backend: "grok" });
  await runAskJob(done.directory, { env: f.env, spawnBackend: backendFake(({ child }) => finish(child, '{"answer":"saved answer","sessionId":"saved-session","stopReason":"end_turn"}')) });
  const output = [];
  assert.equal(await cli(["models", "--free", "--n", "1"], { env: f.env, print: s => output.push(s), apiOptions: { fetch: async () => ({ status: 200, text: async () => '{"data":[{"id":"vendor/model:free","context_length":1000,"pricing":{"prompt":"0","completion":"0"},"architecture":{"output_modalities":["text"]}}]}' }) } }), 0);
  assert.deepEqual(output, ["vendor/model:free"]);
  fs.unlinkSync(path.join(f.env.AGENT_TOOLKIT_HOME, "config.json"));
  assert.match((await callTool("fleet_transcript", { runId: done.result.runId }, { env: f.env })).value, /saved answer/);
  assert.equal((await callTool("fleet_status", { runId: done.result.runId }, { env: f.env })).value.status, "done");
});
function installSound(f) {
  const configFile = path.join(f.env.AGENT_TOOLKIT_HOME, "config.json");
  const config = { ...JSON.parse(fs.readFileSync(configFile, "utf8")), soundVenv: path.join(f.root, "sao", "venv"), mossVenv: path.join(f.root, "moss", "venv"), soundDir: path.join(f.root, "sao"), mossTools: path.join(f.root, "moss", "tools") };
  for (const venv of [config.soundVenv, config.mossVenv]) for (const file of ["Scripts/python.exe", "bin/python"]) write(path.join(venv, file), "fake python");
  for (const file of ["gen.py", "finish.py"]) write(path.join(f.root, "sao", file), "# fake");
  for (const file of ["moss_gen.py", "peak_norm.py"]) write(path.join(f.root, "moss", "tools", file), "# fake");
  write(configFile, JSON.stringify(config));
  return config;
}
test("image validates refs, collects only new files with sizes, copies outputs and exposes them", async t => {
  const f = fixture(t), ref = write(path.join(f.root, "reference.png"), "reference"), outDir = path.join(f.root, "output");
  fs.mkdirSync(outDir);
  assert.throws(() => validateAsk({ backend: "image", prompt: "draw", images: ["relative.png"] }, { env: f.env }), /absolute existing/);
  assert.throws(() => validateAsk({ backend: "image", prompt: "draw", images: [path.join(f.root, "missing.png")] }, { env: f.env }), /absolute existing/);
  assert.throws(() => validateAsk({ backend: "image", prompt: "draw", outDir: "." }, { env: f.env }), /absolute existing/);
  const { directory, result } = await reserve(f, { backend: "image", images: [ref], outDir });
  write(path.join(directory, "old.jpg"), "old");
  const run = await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ args, opts, child }) => {
    assert.deepEqual(args.slice(1), ["codex-image", directory, ref, "--model", "sol", "--effort", "high"]);
    assert.equal(opts.cwd, directory);
    write(path.join(directory, "nested", "new.PNG"), "image bytes");
    write(path.join(directory, "log.txt"), "log".repeat(1500));
    finish(child);
  }) });
  assert.equal(run.status, "done"); assert.equal(run.files.length, 2);
  assert.deepEqual(run.files.map(file => file.bytes), [11, 11]);
  assert.ok(run.files.every(file => !file.path.endsWith("old.jpg")));
  assert.equal(fs.readFileSync(path.join(outDir, "nested", "new.PNG"), "utf8"), "image bytes");
  assert.equal(fs.readFileSync(path.join(directory, "answer.txt"), "utf8").length, 3000);
  assert.equal((await callTool("fleet_run", { runId: result.runId }, { env: f.env })).value.files.length, 2);
  assert.match((await callTool("fleet_transcript", { runId: result.runId }, { env: f.env })).value, /"files":.*new.PNG/);
  const empty = await reserve(f, { backend: "image" });
  const failed = await runAskJob(empty.directory, { env: f.env, spawnBackend: backendFake(({ child }) => finish(child)) });
  assert.equal(failed.status, "failed"); assert.equal(failed.error, "no images produced");
});
test("image answer uses the last JSON agent message instead of trailing event records", async t => {
  const f = fixture(t), { directory } = await reserve(f, { backend: "image" });
  const answer = "Created the requested image.\n" + "details ".repeat(500);
  const run = await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ child }) => {
    write(path.join(directory, "image.png"), "image");
    write(path.join(directory, "log.txt"), [
      "plain startup message", "{invalid json",
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "earlier message" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 300 } }),
      "{unfinished",
    ].join("\n"));
    finish(child);
  }) });
  assert.equal(run.status, "done");
  assert.equal(fs.readFileSync(path.join(directory, "answer.txt"), "utf8"), answer);
  const emptyMessage = await reserve(f, { backend: "image" });
  await runAskJob(emptyMessage.directory, { env: f.env, spawnBackend: backendFake(({ child }) => {
    write(path.join(emptyMessage.directory, "image.webp"), "image");
    write(path.join(emptyMessage.directory, "log.txt"), '{"type":"agent_message","text":""}\nplain trailing log');
    finish(child);
  }) });
  assert.equal(fs.readFileSync(path.join(emptyMessage.directory, "answer.txt"), "utf8"), "");
});
test("advisor requires Lok, buffers waiting stderr, clears on challenge signal, and never retries", async t => {
  const f = fixture(t);
  await assert.rejects(reserve(f, { backend: "advisor" }), /advisor runs only when Lok asks for Argon/);
  const attachment = write(path.join(f.root, "attachment.txt"), "context");
  const { directory, result } = await reserve(f, { backend: "advisor", lokAsked: true, files: [attachment] });
  let child, command;
  const running = runAskJob(directory, { env: f.env, spawnBackend: backendFake(value => { child = value.child; command = value; }) });
  while (!child) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(command.args.slice(1), ["ask", path.join(directory, "prompt.txt"), "--files", attachment, "--thinking", "High", "--out", path.join(directory, "answer.md")]);
  child.stderr.write('status {"waiting');
  assert.equal(readAsk(directory).status, "running");
  child.stderr.write('ForLok":"Google check"}\n');
  assert.equal(readAsk(directory).status, "waiting_for_lok");
  assert.equal((await callTool("fleet_status", { runId: result.runId }, { env: f.env })).value.notice, ADVISOR_NOTICE);
  assert.equal((await callTool("fleet_run", { runId: result.runId }, { env: f.env })).value.notice, ADVISOR_NOTICE);
  const notices = [];
  const waiting = waitRuns([result.runId], { env: f.env, pollMs: 1, warn: notice => notices.push(notice), timeout: 2 });
  // Let several waiter polls observe the same state.
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(notices.length, 1); assert.match(notices[0], /Chrome window for Lok/);
  child.stderr.write('{"challenge":"cle'); child.stderr.write('ared","afterSecs":2}\n');
  assert.equal(readAsk(directory).status, "running"); assert.equal(readAsk(directory).notice, undefined);
  write(path.join(directory, "answer.md"), "Argon's answer");
  finish(child);
  assert.equal((await running).status, "done"); assert.equal((await waiting)[0].answer, "Argon's answer"); assert.equal(notices.length, 1);
  const failed = await reserve(f, { backend: "advisor", lokAsked: true });
  let calls = 0;
  const failure = await runAskJob(failed.directory, { env: f.env, spawnBackend: backendFake(({ child }) => { calls++; finish(child, "", "challenge timeout", 1); }) });
  assert.equal(failure.status, "failed"); assert.equal(calls, 1);
});
test("ChatGPT adapter passes files/model/timeout and records every terminal outcome", async t => {
  const f = fixture(t), attachment = write(path.join(f.root, "context.txt"), "fixture context");
  for (const timeout of [0, -1, "30", Infinity]) assert.throws(() => validateAsk({ backend: "chatgpt", prompt: "hello", timeout }, { env: f.env }), /positive seconds/);
  for (const [outcome, code] of [["done", 0], ["failed", 1], ["signed_out", 3], ["limit", 4], ["paced", 5]]) {
    const { directory, result } = await reserve(f, { backend: "chatgpt", files: [attachment], timeout: 90, keepChat: true });
    assert.equal(result.model, "strongest");
    const run = await runAskJob(directory, { env: f.env, spawnBackend: backendFake(({ args, child }) => {
      assert.equal(args[0], path.join(f.repo, "lib", "webchat", "chatgpt.mjs"));
      assert.deepEqual(args.slice(1), ["ask", path.join(directory, "prompt.txt"), "--files", attachment, "--model", "strongest", "--timeout", "90", "--keep-chat", "--out", path.join(directory, "answer.md")]);
      if (outcome === "done") write(path.join(directory, "answer.md"), "Web answer");
      finish(child, JSON.stringify({ outcome, model: "GPT-6 · power 4/4 (Pro)", answerChars: outcome === "done" ? 10 : 0, ...(outcome === "done" ? {} : { notice: "fixture reason", nextAt: "2026-10-20T15:00:00Z" }) }), "", code);
    }) });
    assert.equal(run.status, outcome); assert.equal(run.model, "GPT-6 · power 4/4 (Pro)");
    if (outcome !== "done") { assert.equal(run.error, "fixture reason"); assert.equal(run.notice, "fixture reason"); assert.equal(run.nextAt, "2026-10-20T15:00:00Z"); }
    assert.equal((await waitRuns([result.runId], { env: f.env }))[0].status, outcome);
    assert.equal(await cli(["wait", result.runId], { env: f.env, print() {} }), outcome === "done" ? 0 : 1);
  }
  const received = [];
  await cli(["ask", "--backend", "chatgpt", "--prompt", "hi", "--timeout", "120", "--keep-chat"], { env: f.env, print() {}, start: async opts => { received.push(opts); return {}; } });
  assert.equal(received[0].timeout, 120); assert.equal(received[0].keepChat, true);
  assert.deepEqual(TOOLS[0].inputSchema.properties.keepChat, { type: "boolean" });
  for (const keepChat of ["true", 1, null]) assert.throws(() => validateAsk({ backend: "chatgpt", prompt: "hi", keepChat }, { env: f.env }), /keepChat must be a boolean/);
  assert.equal(ADAPTERS.chatgpt.defaults.timeout, 1800);
  const defaults = ADAPTERS.chatgpt.command({ ...ADAPTERS.chatgpt.defaults }, { directory: f.root, repo: f.repo });
  assert.equal(defaults.args[defaults.args.indexOf("--timeout") + 1], "1800");
  assert.ok(!defaults.args.includes("--keep-chat"));
  assert.equal(TOOLS[0].inputSchema.properties.timeout.type, "number");
});
test("ChatGPT challenge state is live, counts toward cap, clears and preserves its answer", async t => {
  const f = fixture(t), { directory, result } = await reserve(f, { backend: "chatgpt" });
  let child;
  const running = runAskJob(directory, { env: f.env, spawnBackend: backendFake(value => { child = value.child; }) });
  while (!child) await new Promise(resolve => setImmediate(resolve));
  child.stderr.write('{"waitingForLok":"Please verify');
  child.stderr.write(' in Chrome"}\n');
  assert.equal(readAsk(directory).status, "waiting_for_lok");
  assert.match((await callTool("fleet_status", { runId: result.runId }, { env: f.env })).value.notice, /ChatGPT.*Lok/);
  await assert.rejects(reserve(f, { backend: "chatgpt" }), /runs 1 jobs at once/);
  const notices = [];
  assert.equal((await waitRuns([result.runId], { env: f.env, timeout: 0, warn: line => notices.push(line) }))[0].status, "waiting_for_lok");
  assert.equal(notices.length, 1);
  child.stderr.write('{"challenge":"cleared","afterSecs":3}\n');
  assert.equal(readAsk(directory).status, "running");
  write(path.join(directory, "answer.md"), "complete answer");
  finish(child, '{"outcome":"done","model":"Pro","answerChars":15}');
  const completed = await running;
  assert.equal(completed.status, "done"); assert.equal(completed.notice, undefined);
  assert.equal((await callTool("fleet_run", { runId: result.runId }, { env: f.env })).value.answer, "complete answer");
});
test("waiting advisor jobs count against caps, timeout remains live and dead PID is lost", async t => {
  const f = fixture(t);
  const first = await reserve(f, { backend: "advisor", lokAsked: true });
  atomicJson(path.join(first.directory, "run.json"), { ...readAsk(first.directory), status: "waiting_for_lok", notice: ADVISOR_NOTICE });
  await reserve(f, { backend: "advisor", lokAsked: true });
  await assert.rejects(reserve(f, { backend: "advisor", lokAsked: true }), /runs 2 jobs at once/);
  const notices = [], rows = await waitRuns([first.result.runId], { env: f.env, timeout: 0, warn: line => notices.push(line) });
  assert.equal(rows[0].status, "waiting_for_lok"); assert.equal(rows[0].error, "wait timeout"); assert.equal(rows[0].notice, ADVISOR_NOTICE); assert.equal(notices.length, 1);
  const lost = liveStatus(readAsk(first.directory), () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  assert.equal(lost.status, "lost");
  for (let i = 0; i < 2; i++) await reserve(f, { backend: "image" });
  await assert.rejects(reserve(f, { backend: "image" }), /runs 2 jobs at once/);
});
for (const platform of ["win32", "linux"]) for (const engine of ["sao", "moss"]) {
  test(`sound ${engine} on ${platform} uses ordered commands, cue seeds and artifact copies`, async t => {
    const f = fixture(t), config = installSound(f), calls = [], outDir = path.join(f.root, "audio-output");
    fs.mkdirSync(outDir);
    const { directory, result } = await reserve(f, { backend: "sound", engine, seconds: 2.5, takes: 3, ...(engine === "sao" ? { music: true, seed: 20 } : {}), outDir });
    const run = await runAskJob(directory, { env: f.env, platform, spawnBackend: backendFake(({ exe, args, opts, child }) => {
      calls.push({ exe, args }); assert.equal(opts.cwd, directory);
      if (args[0].endsWith("finish.py")) {
        write(path.join(directory, "web", "take-1.ogg"), "ogg");
        write(path.join(directory, "web", "take-1.m4a"), "m4a");
        write(path.join(directory, "web", "sounds.json"), '{"take-1":{"seconds":2.5}}');
      }
      finish(child);
    }) });
    assert.equal(run.status, "done"); assert.equal(run.model, engine); assert.equal(run.files.length, 6);
    assert.deepEqual(calls.map(c => path.basename(c.args[0])), engine === "sao" ? ["gen.py", "finish.py"] : ["moss_gen.py", "peak_norm.py", "finish.py"]);
    const python = venv => path.join(venv, ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    assert.deepEqual(calls.map(c => c.exe), engine === "sao" ? [python(config.soundVenv), python(config.soundVenv)] : [python(config.mossVenv), python(config.mossVenv), python(config.soundVenv)]);
    assert.equal(calls[0].args[1], path.join(directory, "cues.json"));
    assert.equal(calls.at(-1).args[1], path.join(directory, engine === "moss" ? "norm" : "raw"));
    if (engine === "sao") assert.deepEqual(calls.at(-1).args.slice(-2), ["--music", "take-1,take-2,take-3"]);
    const cues = JSON.parse(fs.readFileSync(path.join(directory, "cues.json"), "utf8"));
    assert.deepEqual(cues.map(c => c.seed), engine === "sao" ? [20, 21, 22] : [1, 2, 3]);
    assert.ok(cues.every((c, i) => c.key === `take-${i + 1}` && c.seconds === 2.5 && c.steps === 100 && c.prompt === "implement the thing" && c.music === (engine === "sao")));
    assert.equal((await callTool("fleet_run", { runId: result.runId }, { env: f.env })).value.files.length, 6);
    assert.match((await callTool("fleet_transcript", { runId: result.runId }, { env: f.env })).value, /sounds.json/);
  });
}
test("sound validates options, caps engines together, stops after failed/interrupted stage and requires audio", async t => {
  const f = fixture(t); installSound(f);
  const opts = { backend: "sound", prompt: "sound", seconds: 1 };
  for (const change of [{ engine: "moss", music: true }, { seconds: 0.4 }, { seconds: 48 }, { seconds: "1" }, { takes: 0 }, { takes: 6 }, { seed: 1.5 }, { music: "true" }]) assert.throws(() => validateAsk({ ...opts, ...change }, { env: f.env }));
  const first = await reserve(f, { backend: "sound", seconds: 1 });
  await assert.rejects(reserve(f, { backend: "sound", engine: "moss", seconds: 1 }), /runs 1 jobs at once/);
  let calls = 0;
  const failed = await runAskJob(first.directory, { env: f.env, spawnBackend: backendFake(({ child }) => { calls++; finish(child, "", "generation failed", 1); }) });
  assert.equal(calls, 1); assert.equal(failed.status, "failed");
  const empty = await reserve(f, { backend: "sound", seconds: 1 });
  const noAudio = await runAskJob(empty.directory, { env: f.env, spawnBackend: backendFake(({ child }) => { write(path.join(empty.directory, "web", "sounds.json"), "{}"); finish(child); }) });
  assert.equal(noAudio.status, "failed"); assert.match(noAudio.error, /no output files/);
  const interrupted = await reserve(f, { backend: "sound", seconds: 1 }); calls = 0;
  const stopped = await runAskJob(interrupted.directory, { env: f.env, spawnBackend: backendFake(({ child }) => {
    calls++; write(path.join(interrupted.directory, "interrupt.flag"), ""); finish(child);
  }) });
  assert.equal(calls, 1); assert.equal(stopped.status, "interrupted");
});
test("model menu discovers ids, caches no account data, refreshes sign-in and sound, and filters backends", async t => {
  const f = fixture(t), config = installSound(f), discoveries = [], requests = [];
  f.env.FAKE_PROVIDER_KEY = randomUUID();
  const options = { env: f.env, dataDir: f.dataDir, now: () => 1000, discover: async name => {
    discoveries.push(name);
    return { code: name === "grok" ? 1 : 0, stdout: name === "grok" ? grokModelsOutput : "gemini-3.8-flash-low\nclaude-sonnet-4-6", stderr: "" };
  }, apiOptions: { keyReader: async () => f.env.FAKE_PROVIDER_KEY, fetch: async url => {
    requests.push(url);
    const data = url.endsWith("/models") ? [
      ...["vendor/a:free", "vendor/b:free", "other/c:free"].map(id => ({ id, pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } })),
      { id: "vendor/paid", pricing: { prompt: "0.01", completion: "0.01" }, architecture: { output_modalities: ["text"] } },
    ] : { limit: 10, limit_remaining: 9, free_model_daily_requests: { used: 2, limit: 1000, remaining: 998 } };
    return { status: 200, text: async () => JSON.stringify({ data }) };
  } } };
  const rows = await accounts(options);
  assert.deepEqual(new Set(rows.map(r => r.backend)), new Set(Object.keys(ADAPTERS)));
  for (const row of rows) {
    for (const key of ["backend", "found", "signedIn", "detail", "models", "notes"]) assert.ok(Object.hasOwn(row, key), `${row.backend}.${key}`);
    assert.ok(Array.isArray(row.models)); assert.ok(Array.isArray(row.notes));
    const note = effortNote(row.backend);
    if (note && !(row.backend === 'image' && row.provider === 'openrouter')) assert.ok(row.notes.includes(note), `${row.backend} effort note`);
    for (const model of row.models) {
      assert.ok(["subscription", "free", "paid", "local"].includes(model.cost));
      assert.ok(["edits", "read-only", "text", "image", "sound"].includes(model.access));
    }
  }
  const by = name => rows.find(r => r.backend === name);
  assert.deepEqual(by("codex").models.map(m => [m.id, m.modelId]), [["astra", "gpt-6-astra"], ["sol", "gpt-6.1-sol"], ["luna", "gpt-6-luna"]]);
  assert.deepEqual(by("agy").models.map(m => m.id), ["gemini-3.8-flash-low", "claude-sonnet-4-6"]);
  assert.deepEqual(by("grok").models.map(m => m.id), grokModelIds);
  assert.deepEqual(by("sound").models.map(m => m.id), ["sao", "moss"]);
  assert.equal(by("api").models.length, 3); assert.match(by("api").notes.join(" "), /catalogue size: 4/); assert.ok(!by("api").models.some(m => m.id.includes("paid")));
  assert.equal(by("advisor").signedIn, null); assert.match(by("advisor").notes[0], /only when Lok asks/);
  const saved = fs.readFileSync(path.join(f.dataDir, "model-menu.json"), "utf8");
  for (const forbidden of ["signedIn", '"found"', '"detail"', "fixture current account", "freeDaily", "keyFile", "keyEnv", f.env.FAKE_PROVIDER_KEY]) assert.ok(!saved.includes(forbidden), forbidden);
  const oldMenu = JSON.parse(saved);
  oldMenu.rows.find(row => row.backend === "codex").notes.push("effort: stale rule");
  write(path.join(f.dataDir, "model-menu.json"), JSON.stringify(oldMenu));
  f.env.FAKE_SIGNED_OUT = "1";
  const filtered = await accounts({ ...options, backend: "codex", now: () => 2000 });
  assert.equal(filtered.length, 1); assert.equal(filtered[0].signedIn, false); assert.equal(discoveries.length, 2);
  assert.ok(filtered[0].notes.includes(effortNote("codex"))); assert.ok(!filtered[0].notes.includes("effort: stale rule"));
  fs.unlinkSync(path.join(f.root, "sao", "finish.py"));
  assert.equal((await accounts({ ...options, backend: "sound" }))[0].models.length, 0);
  await accounts({ ...options, now: () => 601_001 }); assert.equal(discoveries.length, 4);
  assert.ok(requests.some(url => url.endsWith("/key")));
  assert.ok(!JSON.stringify(rows).includes(f.env.FAKE_PROVIDER_KEY));
  assert.deepEqual(parseModelIds('Not authenticated\n{"models":[{"id":"grok-4.7"}]}\ngrok-4.7'), ["grok-4.7"]);
  assert.deepEqual(parseModelIds('Not authenticated\n{"models":[{"id":"vendor/other-v1"},{"id":"o3"}]}'), ["vendor/other-v1", "o3"]);
  assert.deepEqual(parseModelIds("Models: o1 o3 o4-mini"), ["o1", "o3", "o4-mini"]);
  await assert.rejects(accounts({ ...options, backend: "unknown" }), /invalid backend/);
  const mcp = await callTool("fleet_accounts", { backend: "image" }, { env: f.env, menuOptions: options, apiOptions: options.apiOptions });
  assert.deepEqual(mcp.value.map(r => [r.backend, r.provider]), [["image", undefined], ["image", "openrouter"]]);
  const printed = [];
  assert.equal(await cli(["accounts", "--backend", "advisor"], { env: f.env, menuOptions: options, apiOptions: options.apiOptions, print: text => printed.push(JSON.parse(text)) }), 0);
  assert.deepEqual(printed[0].map(r => r.backend), ["advisor"]);
});
test("Grok discovery only reads model bullets in Available models and ignores login links", () => {
  assert.deepEqual(parseGrokModelIds(grokModelsOutput), grokModelIds);
  assert.deepEqual(parseGrokModelIds("Sign in at https://grok.com\nDefault model: grok-4.7\n- grok-9"), []);
  assert.deepEqual(parseGrokModelIds(`${grokModelsOutput}\n  - https://grok.com\n  - grok.com\n\nHelp: https://grok.com\n- grok-9`), grokModelIds);
  assert.deepEqual(parseGrokModelIds("Available models:\n- grok-4.7\n- grok-4.7"), ["grok-4.7"]);
});
test("ChatGPT menu reads fresh local state even on cache hits and never launches Chrome", async t => {
  const f = fixture(t);
  const options = { backend: "chatgpt", env: f.env, dataDir: f.dataDir, now: () => 1000, discover: async () => ({ code: 1, stdout: "", stderr: "" }), apiOptions: { keyReader: async () => null, fetch: async () => { throw new Error("fake offline"); } } };
  let [row] = await accounts(options);
  assert.equal(row.signedIn, null); assert.deepEqual(row.models.map(m => m.id), ["strongest"]);
  assert.equal(row.detail, "run: bin/chatgpt-web login, then check");
  write(path.join(f.env.CHATGPT_WEB_HOME, "state.json"), JSON.stringify({ signedIn: true, checkedAt: "2026-10-20T10:00:00Z", models: ["GPT-6", "GPT-5.6 Sol"], plan: "private fixture plan", prompts: ["2026-10-20T09:00:00Z"] }));
  [row] = await accounts({ ...options, now: () => 2000, discover: () => assert.fail("menu cache should avoid rediscovery") });
  assert.equal(row.signedIn, true); assert.deepEqual(row.models.map(m => m.id), ["GPT-6", "GPT-5.6 Sol"]); assert.match(row.detail, /2026-10-20/);
  assert.ok(row.models.every(m => m.cost === "subscription" && m.access === "text"));
  const cached = fs.readFileSync(path.join(f.dataDir, "model-menu.json"), "utf8");
  for (const value of ["signedIn", "private fixture plan", "2026-10-20T09:00:00Z", "checkedAt"]) assert.ok(!cached.includes(value));
});
test("menu fallback excludes failed agy output and CLI forwards media options", async t => {
  const f = fixture(t);
  const rows = await accounts({ env: f.env, dataDir: f.dataDir, discover: async () => ({ code: 1, stdout: "gemini-should-not-use", stderr: "" }), apiOptions: { keyReader: async () => null, fetch: async () => { throw new Error("fake offline"); } } });
  assert.deepEqual(rows.find(row => row.backend === "agy").models.map(m => m.id), ["gemini-3.8-flash-low"]);
  const received = [];
  const options = { env: f.env, print() {}, start: async opts => { received.push(opts); return {}; } };
  await cli(["ask", "--backend", "image", "--prompt", "draw", "--image", "/ref-a.png", "--image", "/ref-b.png", "--out-dir", "/output"], options);
  await cli(["ask", "--backend", "advisor", "--prompt", "ask", "--lok-asked", "--file", "/context.txt"], options);
  await cli(["ask", "--backend", "sound", "--prompt", "bell", "--engine", "sao", "--seconds", "2.5", "--takes", "3", "--seed", "20", "--music"], options);
  assert.deepEqual(received[0].images, ["/ref-a.png", "/ref-b.png"]); assert.equal(received[0].outDir, "/output");
  assert.equal(received[1].lokAsked, true); assert.deepEqual(received[1].files, ["/context.txt"]);
  assert.deepEqual(received[2], { backend: "sound", prompt: "bell", engine: "sao", seconds: 2.5, takes: 3, seed: 20, music: true });
});
test("API menu retains separate provider rows and spend when a generic catalog is unavailable", async t => {
  const f = fixture(t), configFile = path.join(f.env.AGENT_TOOLKIT_HOME, "config.json"), config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.providers.push({ name: "generic", kind: "openai", baseUrl: "https://generic.invalid/v1", keyEnv: "FAKE_PROVIDER_KEY" });
  write(configFile, JSON.stringify(config));
  f.env.FAKE_PROVIDER_KEY = randomUUID();
  for (const [name, cost] of [["openrouter", 0.1], ["generic", 0.2]]) {
    write(path.join(f.dataDir, "runs", name, "run.json"), JSON.stringify({ kind: "ask", runId: name, backend: "api", provider: name, costUsd: cost, status: "done", startedAt: "2026-10-20T00:00:00Z" }));
  }
  const rows = await accounts({ backend: "api", env: f.env, dataDir: f.dataDir, apiOptions: { keyReader: async () => f.env.FAKE_PROVIDER_KEY, fetch: async url => {
    if (url.startsWith("https://generic.invalid")) throw new Error("generic has no catalog");
    return { status: 200, text: async () => JSON.stringify({ data: url.endsWith("/models") ? [] : { limit: 10 } }) };
  } } });
  assert.deepEqual(rows.map(row => row.provider), ["openrouter", "generic"]);
  assert.deepEqual(rows.map(row => row.spendUsd), [0.1, 0.2]);
  assert.equal(rows[1].found, true); assert.equal(rows[1].signedIn, null);
  assert.match(rows[1].notes.join(" "), /catalogue size: unavailable/);
});
const subprocess = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
test("detached worker survives launcher and writes results using only fake toolkit runners", { skip: subprocess.error ? `child processes unavailable: ${subprocess.error.code}` : false, timeout: 15_000 }, async t => {
  const f = fixture(t);
  const launcher = path.join(f.root, "launcher.mjs");
  const jobsURL = new URL("../runner/lib/jobs.mjs", import.meta.url).href;
  const runtimeURL = new URL("../runner/lib/runtime.mjs", import.meta.url).href;
  const worker = write(path.join(f.root, "fake-worker.mjs"), `import { injectRuntime } from ${JSON.stringify(runtimeURL)}; import {runAskJob} from ${JSON.stringify(new URL("../runner/ask-job.mjs", import.meta.url).href)}; injectRuntime(process.env, {repo:${JSON.stringify(f.repo)}}); await runAskJob(process.argv[2], {handoff:true});`);
  write(launcher, `import {spawn} from "node:child_process"; import {injectRuntime} from ${JSON.stringify(runtimeURL)}; injectRuntime(process.env,{repo:${JSON.stringify(f.repo)}}); import {startAsk} from ${JSON.stringify(jobsURL)}; console.log(JSON.stringify(await startAsk({backend:"codex",prompt:"fake only",cwd:${JSON.stringify(f.root)}},{spawnJob:(exe,args,opts)=>spawn(exe,[${JSON.stringify(worker)},...args.slice(1)],opts)})));`);
  const result = spawnSync(process.execPath, [launcher], { env: f.env, encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const { runId } = JSON.parse(result.stdout);
  const [row] = await waitRuns([runId], { env: f.env, timeout: 10, pollMs: 20 });
  assert.equal(row.status, "done"); assert.equal(row.answer, "complete fake Codex answer");
});
