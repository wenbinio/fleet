import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { atomicJson, startAsk, readAsk, runDirectory, liveStatus, waitRuns, validateAsk, listRuns, ASK_JOB } from "../runner/lib/jobs.mjs";
import { runAskJob, backendCommand } from "../runner/ask-job.mjs";
import { toolkitRepo } from "../runner/lib/toolkit-link.mjs";
import { callTool, TOOLS, eventBeat } from "../mcp/fleet-mcp.mjs";
import { cli } from "../runner/fleet.mjs";

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ask-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const repo = path.join(root, "toolkit"), dataDir = path.join(root, "data"), runsDir = path.join(root, "toolkit-runs");
  const env = { ...process.env, AGENT_TOOLKIT_HOME: path.join(root, "home"), CLAUDE_PLUGIN_DATA: dataDir, FLEET_FAKE_RUNS: runsDir };
  write(path.join(env.AGENT_TOOLKIT_HOME, "config.json"), JSON.stringify({ repo }));
  write(path.join(repo, "lib/toolkit.mjs"), `
    export const loadConfig = env => ({ runsDir: env.FLEET_FAKE_RUNS });
    export const resolveTool = name => name;
    export const signInStatus = async name => ({ backend: name === "dsh" ? "deepseek" : name, found: true, signedIn: name === "dsh" ? null : true, detail: "fixture" });
  `);
  // A complete fake runner can also be launched by the detached integration test.
  write(path.join(repo, "lib/runners.mjs"), `
    import fs from "node:fs"; import path from "node:path";
    const args = process.argv.slice(2), backend = args[0];
    if (backend === "codex-run") {
      const id=args[1], dir=path.join(process.env.FLEET_FAKE_RUNS,"codex",id);
      fs.mkdirSync(dir,{recursive:true}); let round=1; while(fs.existsSync(path.join(dir,"r"+round+".last.txt"))) round++;
      fs.writeFileSync(path.join(dir,"r"+round+".last.txt"),"complete fake Codex answer");
      fs.writeFileSync(path.join(dir,"r"+round+".events.jsonl"),JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"complete"}})+"\\n");
      console.log("["+id+"] round "+round+" exit 0, session fake-session");
    } else console.log("complete fake agy answer");
  `);
  write(path.join(repo, "bin/dsh-run.ps1"), `'{"type":"final","text":"complete fake DeepSeek answer","session_id":"fake-dsh"}'\nexit 0\n`);
  return { root, repo, dataDir, runsDir, env };
}
function detachedFake(calls = []) {
  return (exe, args, opts) => {
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
    const child = new EventEmitter();
    child.pid = 123456789; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => action({ exe, args, opts, child }));
    return child;
  };
}
async function reserve(f, opts = {}) {
  const result = await startAsk({ backend: "codex", prompt: "implement the thing", cwd: f.root, ...opts }, { env: f.env, spawnJob: detachedFake() });
  return { result, directory: runDirectory(f.dataDir, result.runId) };
}
function finish(child, stdout = "", stderr = "", code = 0) {
  child.stdout.end(stdout); child.stderr.end(stderr); child.emit("close", code);
}
test("toolkit discovery uses config and returns an actionable missing error", t => {
  const f = fixture(t);
  assert.equal(toolkitRepo({ env: f.env }), f.repo);
  fs.unlinkSync(path.join(f.repo, "lib/runners.mjs"));
  assert.throws(() => toolkitRepo({ env: f.env }), /agent-toolkit not found: run node setup.mjs/);
});
test("ask validates backend options, prompt exclusivity and absolute directories", t => {
  const f = fixture(t), valid = { backend: "codex", prompt: "hello", cwd: f.root };
  for (const changes of [{ backend: "other" }, { promptFile: path.join(f.root, "missing") }, { prompt: undefined }, { cwd: "." }, { effort: "max" }, { readOnly: "yes" }, { addDirs: "dir" }, { jsonSchema: "{}" }, { unknown: true }]) assert.throws(() => validateAsk({ ...valid, ...changes }));
  for (const key of ["effort", "readOnly", "resume"]) assert.throws(() => validateAsk({ backend: "agy", prompt: "hello", [key]: "x" }), /codex only/);
  assert.throws(() => validateAsk({ backend: "deepseek", prompt: "hello", cwd: f.root, model: "other" }), /invalid deepseek model/);
  assert.throws(() => validateAsk({ backend: "deepseek", prompt: "hello", cwd: f.root, addDirs: [] }), /codex or agy only/);
  assert.doesNotThrow(() => validateAsk({ backend: "agy", prompt: "hello", jsonSchema: "{}" }));
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
  const [run] = await listRuns(f.dataDir);
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
  assert.deepEqual(TOOLS.map(t => t.name), ["fleet_ask", "fleet_runs", "fleet_run", "fleet_transcript", "fleet_status", "fleet_steer", "fleet_interrupt", "fleet_accounts"]);
  assert.ok(TOOLS.every(t => t.description.length < 120));
  for (const name of ["fleet_runs", "fleet_run", "fleet_transcript", "fleet_status", "fleet_accounts"]) assert.equal(TOOLS.find(t => t.name === name).annotations.readOnlyHint, true);
  const asked = await callTool("fleet_ask", { backend: "agy", prompt: "hello" }, { ...options, start: (opts, options) => startAsk(opts, { ...options, spawnJob: detachedFake() }) });
  const id = asked.value.runId, directory = runDirectory(f.dataDir, id);
  assert.equal((await callTool("fleet_runs", { backend: "agy", limit: 1 }, options)).value[0].kind, "ask");
  assert.equal((await callTool("fleet_run", { runId: id }, options)).value.answer, "");
  assert.equal((await callTool("fleet_status", { runId: id }, options)).value.status, "running");
  assert.match((await callTool("fleet_transcript", { runId: id }, options)).value, /Prompt:\nhello/);
  await assert.rejects(callTool("fleet_steer", { runId: id, text: "continue" }, options), /fleet_ask with resume/);
  assert.equal((await callTool("fleet_interrupt", { runId: id }, options)).value.ok, true);
  assert.ok(fs.existsSync(path.join(directory, "interrupt.flag")));
  assert.equal((await callTool("fleet_accounts", {}, options)).value.length, 3);
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
  const runs = (await callTool("fleet_runs", {}, options)).value;
  assert.deepEqual(new Set(runs.map(r => r.kind)), new Set(["ask", "batch", "delegate"]));
  assert.equal(runs.find(r => r.kind === "batch").taskCount, 1);
  const codex = await reserve(f);
  const run = readAsk(codex.directory);
  write(path.join(f.runsDir, "codex", run.codexId, "r1.events.jsonl"), '{"type":"item.completed","item":{"type":"reasoning","text":"live thought"}}\n');
  assert.match((await callTool("fleet_status", { runId: run.runId }, options)).value.beats[0], /reasoning: live thought/);
  assert.match(eventBeat({ item: { type: "file_change", changes: [{ path: "app.js" }] } }), /files: app.js/);
  await assert.rejects(callTool("fleet_runs", { limit: -1 }, options), /positive integer/);
});
const subprocess = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
test("detached worker survives launcher and writes results using only fake toolkit runners", { skip: subprocess.error ? `child processes unavailable: ${subprocess.error.code}` : false, timeout: 15_000 }, async t => {
  const f = fixture(t);
  const launcher = path.join(f.root, "launcher.mjs");
  const jobsURL = new URL("../runner/lib/jobs.mjs", import.meta.url).href;
  write(launcher, `import {startAsk} from ${JSON.stringify(jobsURL)}; console.log(JSON.stringify(await startAsk({backend:"codex",prompt:"fake only",cwd:${JSON.stringify(f.root)}})));`);
  const result = spawnSync(process.execPath, [launcher], { env: f.env, encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const { runId } = JSON.parse(result.stdout);
  const [row] = await waitRuns([runId], { env: f.env, timeout: 10, pollMs: 20 });
  assert.equal(row.status, "done"); assert.equal(row.answer, "complete fake Codex answer");
});
