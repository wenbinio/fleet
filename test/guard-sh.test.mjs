import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeVerdict } from "../scripts/verdict-store.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "scripts", "merge-guard.sh");

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

function runGuard(command, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [GUARD], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("merge-guard.sh timed out")); }, 20_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ tool_input: { command } }));
  });
}

test("POSIX merge guard checks codex branches outside the old charset", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "fleet-guard-sh-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const fleetHome = path.join(temp, "toolkit");
  const dataDir = path.join(fleetHome, "fleet");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Fleet Guard Test"]);
  await git(repo, ["config", "user.email", "fleet-guard@example.invalid"]);
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await git(repo, ["add", "--", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const sha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repo, ["branch", "codex/approved", sha]);
  await git(repo, ["branch", "codex/plus+feature", sha]);
  const common = (await git(repo, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const repoKey = await realpath(path.isAbsolute(common) ? common : path.join(repo, common));
  await writeVerdict(path.join(dataDir, "approved.json"), {
    repoKey, branch: "codex/approved", sha, reviewVerdict: "approve",
    driverVerifyPassed: true, reviewVerifyPassed: true, allowUnverified: false,
  });
  const env = { ...process.env, HOME: temp, USERPROFILE: temp, FLEET_HOME: fleetHome, AGENT_TOOLKIT_HOME: "" };
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const merge = branch => `git -C ${quote(repo)} merge ${branch}`;
  const plus = await runGuard(merge("codex/plus+feature"), repo, env);
  assert.equal(plus.code, 2, plus.stderr);
  assert.match(plus.stderr, /Merge blocked/);
  const approved = await runGuard(merge("codex/approved"), repo, env);
  assert.equal(approved.code, 0, approved.stderr);
  const other = await runGuard("git status", repo, env);
  assert.equal(other.code, 0, other.stderr);
});
