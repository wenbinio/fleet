#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, readJson } from "./lib/jobs.mjs";
import { loadToolkit } from "./lib/toolkit-link.mjs";

import { ADAPTERS } from "./lib/adapters.mjs";

const OUTPUT_LIMIT = 2 * 1024 * 1024;
export { finalText } from "./lib/adapters.mjs";
export function backendCommand(run, directory, repo) { return ADAPTERS[run.backend].command(run, { directory, repo }); }
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
export async function runAskJob(directory, { env = process.env, spawnBackend = spawn, stopTree = killTree, pollMs = 1000, handoff = false, platform = process.platform } = {}) {
  const file = path.join(directory, "run.json");
  let run = readJson(file), child, timer, interrupted = false;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), answer = "", outputFd, jsonOutput = "";
  const adapter = ADAPTERS[run.backend], state = {};
  const append = (current, chunk) => current.length >= OUTPUT_LIMIT ? current : Buffer.concat([current, Buffer.from(chunk).subarray(0, OUTPUT_LIMIT - current.length)]);
  try {
    if (handoff) {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(path.join(directory, "launch.ready"))) {
        if (Date.now() >= deadline) throw new Error("worker launch handoff timed out");
        await delay(20);
      }
      run = readJson(file);
    }
    const { repo, toolkit } = await loadToolkit({ env });
    const context = { run, directory, repo, toolkit, env, state, platform };
    await adapter.before?.(context);
    const command = adapter.command(run, context);
    const commands = Array.isArray(command) ? command : [command];
    if (adapter.outputFile) outputFd = fs.openSync(path.join(directory, adapter.outputFile), "w");
    const line = text => adapter.line?.(text, state, run);
    const stderrLine = text => {
      const change = adapter.stderrLine?.(text, state, run);
      if (change) { run = { ...run, ...change }; if (!run.notice) delete run.notice; atomicJson(file, run); }
    };
    let exitCode = 1;
    for (const { exe, args } of commands) {
      let pending = "", pendingError = "";
      if (fs.existsSync(path.join(directory, "interrupt.flag"))) { interrupted = true; break; }
      child = spawnBackend(exe, args, { cwd: run.cwd ?? directory, env: { ...env, AGENT_TOOLKIT_CAPTURE_ATTACHED: "1" }, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        stdout = append(stdout, chunk);
        if (outputFd !== undefined) fs.writeSync(outputFd, chunk);
        if (adapter.json) jsonOutput += chunk;
        if (adapter.line) {
          pending += chunk;
          let index;
          while ((index = pending.indexOf("\n")) !== -1) { line(pending.slice(0, index).replace(/\r$/, "")); pending = pending.slice(index + 1); }
        }
      });
      child.stderr.on("data", chunk => {
        stderr = append(stderr, chunk);
        if (adapter.stderrLine) {
          pendingError += chunk;
          let index;
          while ((index = pendingError.indexOf("\n")) !== -1) { stderrLine(pendingError.slice(0, index).replace(/\r$/, "")); pendingError = pendingError.slice(index + 1); }
        }
      });
      timer = setInterval(() => {
        if (!interrupted && fs.existsSync(path.join(directory, "interrupt.flag"))) { interrupted = true; stopTree(child); }
      }, pollMs);
      exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
      if (pending) line(pending);
      if (pendingError) stderrLine(pendingError);
      clearInterval(timer);
      if (interrupted || exitCode !== 0) break;
    }
    if (outputFd !== undefined) { fs.closeSync(outputFd); outputFd = undefined; }
    const parsed = await adapter.parse({ run, directory, toolkit, env, exitCode, interrupted, state, stdout: adapter.json ? jsonOutput : stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    answer = typeof parsed.answer === "string" ? parsed.answer : "";
    fs.writeFileSync(path.join(directory, "answer.txt"), answer);
    if (parsed.reasoning !== undefined) fs.writeFileSync(path.join(directory, "reasoning.txt"), parsed.reasoning);
    const status = interrupted ? "interrupted" : parsed.status ?? (adapter.deniedCodes?.includes(exitCode) ? "denied" : exitCode !== 0 || !answer.trim() ? "failed" : "done");
    delete run.notice;
    run = { ...run, ...parsed.metadata, status, exitCode };
    if (status !== "done") run.error = status === "interrupted" ? "interrupted" : parsed.error || stderr.toString("utf8").slice(0, 2000) || (exitCode ? `exit ${exitCode}` : "empty answer");
    if (!parsed.status && !exitCode && !answer.trim() && !interrupted) run.error = "empty answer";
  } catch (error) {
    delete run.notice;
    run = { ...run, status: interrupted ? "interrupted" : "failed", exitCode: 1, error: (stderr.toString("utf8") || error.message).slice(0, 2000) };
  } finally {
    clearInterval(timer);
    if (outputFd !== undefined) fs.closeSync(outputFd);
    fs.writeFileSync(path.join(directory, "stdout.txt"), stdout);
    fs.writeFileSync(path.join(directory, "stderr.txt"), stderr);
    if (!fs.existsSync(path.join(directory, "answer.txt"))) fs.writeFileSync(path.join(directory, "answer.txt"), answer);
    atomicJson(file, { ...run, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(run.startedAt) });
  }
  return readJson(file);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: ask-job.mjs <runDir>");
    const run = await runAskJob(path.resolve(process.argv[2]), { handoff: true });
    process.exitCode = run.status === "done" ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
