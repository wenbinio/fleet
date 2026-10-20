import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dataPaths, resolveDataDir, approvalPath } from "../runner/lib/data-dir.mjs";
import { runDirectory, listRuns } from "../runner/lib/jobs.mjs";
import { writeVerdict } from "../scripts/verdict-store.mjs";
import { cli } from "../runner/fleet.mjs";
import { callTool } from "../mcp/fleet-mcp.mjs";
function fixture(t) {
  const scratch = fileURLToPath(new URL("../.test-tmp/", import.meta.url)); fs.mkdirSync(scratch, {recursive:true});
  const home = fs.mkdtempSync(path.join(scratch,"data-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env = { HOME:home, USERPROFILE:home, FLEET_HOME:"", AGENT_TOOLKIT_HOME:"", CLAUDE_PLUGIN_DATA:"ignored" };
  return {home,env,...dataPaths({env})};
}
function write(file,value) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,value); }
function comparableShellPath(value) {
  // Git Bash may render D:/repo as /d/repo. This comparison concerns filesystem
  // identity only; the guard itself uses the path directly, not a JS comparison.
  let normalized = value.trim().replaceAll("\\", "/");
  if (process.platform === "win32") normalized = normalized.replace(/^\/([a-z])\//i, "$1:/");
  normalized = path.normalize(normalized);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
test("one shared home ignores host data and preserves legacy home override",async t=>{
  const f=fixture(t);
  assert.equal(await resolveDataDir({env:f.env}),path.join(f.home,".agent-toolkit","fleet"));
  assert.equal(await resolveDataDir({env:{...f.env,AGENT_TOOLKIT_HOME:path.join(f.home,"old")}}),path.join(f.home,"old","fleet"));
  assert.equal(await resolveDataDir({env:{...f.env,FLEET_HOME:path.join(f.home,"new"),AGENT_TOOLKIT_HOME:path.join(f.home,"old")}}),path.join(f.home,"new","fleet"));
});
test("migration copies once without changing legacy data or replacing newer values",async t=>{
  const f=fixture(t); write(path.join(f.legacy,"config.json"),'{"model":"custom"}'); write(path.join(f.legacy,"approved.json"),'{}');
  const run=path.join(f.legacy,"runs","old-run"); write(path.join(run,"run.json"),JSON.stringify({kind:"ask",backend:"agy",status:"done",startedAt:"2026-10-20"}));
  assert.equal(await resolveDataDir({env:f.env}),f.shared);
  assert.equal(fs.readFileSync(path.join(f.shared,"config.json"),"utf8"),'{"model":"custom"}');
  assert.ok(fs.existsSync(path.join(f.legacy,"approved.json")));
  write(path.join(f.shared,"config.json"),'new'); await resolveDataDir({env:f.env});
  assert.equal(fs.readFileSync(path.join(f.shared,"config.json"),"utf8"),'new');
  assert.equal(runDirectory(f.shared,run),fs.realpathSync(path.join(f.shared,"runs","old-run")));
  assert.equal((await listRuns(f.shared)).runs.length,1);
});
test("nonempty destination copies history while approvals still use the legacy store",async t=>{
  const f=fixture(t); write(path.join(f.shared,"profile.json"),'{}'); write(path.join(f.legacy,"approved.json"),'{}');
  const run=path.join(f.legacy,"runs","late"); write(path.join(run,"run.json"),JSON.stringify({kind:"ask",backend:"agy",status:"done",startedAt:"2026-10-20"}));
  await resolveDataDir({env:f.env}); assert.equal(approvalPath({env:f.env}),path.join(f.legacy,"approved.json"));
  await writeVerdict(path.join(f.shared,"approved.json"), {repoKey:"fixture",branch:"codex/test",sha:"a".repeat(40),reviewVerdict:"approve",driverVerifyPassed:true,reviewVerifyPassed:true,allowUnverified:false});
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.legacy,"approved.json"),"utf8")).fixture);
  assert.equal(fs.existsSync(path.join(f.shared,"approved.json")),false);
  assert.equal(runDirectory(f.shared,run),fs.realpathSync(path.join(f.shared,"runs","late"))); assert.equal((await listRuns(f.shared)).runs[0].runId,"late");
  write(path.join(f.shared,"approved.json"),'{}'); assert.equal(approvalPath({env:f.env}),path.join(f.shared,"approved.json"));
  assert.throws(()=>runDirectory(f.shared,path.join(f.home,"elsewhere","late")),/inside/);
});
test("each CLI and MCP startup copies late legacy runs without overwriting collisions or deleting originals", async t => {
  const f = fixture(t);
  write(path.join(f.legacy, "config.json"), '{"kept":"legacy"}');
  await resolveDataDir({ env: f.env });
  write(path.join(f.shared, "config.json"), '{"kept":"shared"}');
  const id = "ask-api-20261020-165539-3634";
  const old = path.join(f.legacy, "runs", id), shared = path.join(f.shared, "runs", id);
  write(path.join(old, "run.json"), JSON.stringify({ kind: "ask", runId: id, backend: "api", status: "done" }));
  write(path.join(old, "nested/answer.txt"), "late answer");
  write(path.join(f.shared, "runs/collision/answer.txt"), "shared wins");
  write(path.join(f.legacy, "runs/collision/answer.txt"), "old loses");
  fs.mkdirSync(path.join(f.shared, "runs/empty"), { recursive: true });
  write(path.join(f.legacy, "runs/empty/answer.txt"), "do not merge");
  await cli(["--help"], { env: f.env, print() {} });
  assert.equal(fs.readFileSync(path.join(shared, "nested/answer.txt"), "utf8"), "late answer");
  assert.equal(fs.readFileSync(path.join(old, "nested/answer.txt"), "utf8"), "late answer");
  assert.equal(fs.readFileSync(path.join(f.shared, "runs/collision/answer.txt"), "utf8"), "shared wins");
  assert.deepEqual(fs.readdirSync(path.join(f.shared, "runs/empty")), []);
  write(path.join(f.legacy, "runs/mcp-late/run.json"), '{"kind":"ask","backend":"agy","status":"done"}');
  await callTool("fleet_runs", {}, { env: f.env });
  assert.ok(fs.existsSync(path.join(f.shared, "runs/mcp-late/run.json")));
  assert.ok(fs.existsSync(path.join(f.legacy, "runs/mcp-late/run.json")));
  assert.equal(fs.readFileSync(path.join(f.shared, "config.json"), "utf8"), '{"kept":"shared"}');
  write(path.join(old, "nested/answer.txt"), "later legacy edit");
  await resolveDataDir({ env: f.env });
  assert.equal(fs.readFileSync(path.join(shared, "nested/answer.txt"), "utf8"), "late answer");
});
test("a failed staged late-run copy leaves no partial shared run and retries on next startup", async t => {
  const f = fixture(t);
  write(path.join(f.shared, "profile.json"), "{}");
  write(path.join(f.legacy, "runs/retry/answer.txt"), "complete");
  const copy = fs.cpSync;
  fs.cpSync = (...args) => { copy(...args); throw new Error("fixture copy failure"); };
  try { await assert.rejects(resolveDataDir({ env: f.env }), /fixture copy failure/); }
  finally { fs.cpSync = copy; }
  assert.ok(!fs.existsSync(path.join(f.shared, "runs/retry")));
  assert.ok(!fs.readdirSync(f.shared).some(name => name.startsWith(".legacy-")));
  await resolveDataDir({ env: f.env });
  assert.equal(fs.readFileSync(path.join(f.shared, "runs/retry/answer.txt"), "utf8"), "complete");
});
for(const shell of ["sh","powershell"]) test(shell+" approval resolver matches shared/legacy fallback",t=>{
  if(shell==="powershell"&&process.platform!=="win32")return t.skip("Windows-only guard");
  const exe=shell==="sh"?"sh":"powershell.exe";
  const probe=spawnSync(exe,shell==="sh"?["-c","exit 0"]:["-NoProfile","-Command","exit 0"],{windowsHide:true});
  if(probe.error)return t.skip(probe.error.code);
  const f=fixture(t),source=fs.readFileSync(new URL("../scripts/merge-guard."+(shell==="sh"?"sh":"ps1"),import.meta.url),"utf8");
  const fn=shell==="sh"?source.slice(source.indexOf("resolve_data_dir()"),source.indexOf("\ncommand -v jq")):source.slice(source.indexOf("function Resolve-DataDirectory"),source.indexOf("\nfunction ConvertTo-StaticCommandToken"));
  const check=()=>{
    const script=fn+(shell==="sh"?"\nresolve_data_dir":"\nResolve-DataDirectory"),args=shell==="sh"?["-c",script]:["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")];
    const result=spawnSync(exe,args,{encoding:"utf8",windowsHide:true,env:{...process.env,...f.env,HOME:shell==="sh"?f.home.replaceAll("\\","/"):f.home}});
    assert.equal(result.status,0,result.stderr); assert.equal(comparableShellPath(result.stdout),comparableShellPath(path.dirname(approvalPath({env:f.env}))));
  };
  check(); write(path.join(f.legacy,"approved.json"),'{}'); check(); write(path.join(f.shared,"approved.json"),'{}'); check();
});
