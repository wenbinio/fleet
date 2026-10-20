#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, readJson } from "./lib/jobs.mjs";
import { loadToolkit } from "./lib/toolkit-link.mjs";

const OUTPUT_LIMIT = 2 * 1024 * 1024;
export function backendCommand(run, directory, repo) {
  const prompt = path.join(directory, "prompt.txt");
  if (run.backend === "deepseek") return {
    exe: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "bin", "dsh-run.ps1"), "-Task", prompt, "-Cwd", run.cwd, "-Model", run.model],
  };
  const args = [path.join(repo, "lib", "runners.mjs"), `${run.backend}-run`];
  if (run.backend === "codex") args.push(run.codexId);
  args.push(prompt, "--model", run.model);
  if (run.backend === "codex") {
    args.push("--cwd", run.cwd, "--effort", run.effort);
    if (run.readOnly) args.push("--read-only");
    if (run.resume) args.push("--resume", "last");
  } else {
    if (run.cwd) args.push("--add-dir", run.cwd);
    if (run.jsonSchema) args.push("--json-schema", run.jsonSchema);
  }
  for (const dir of run.addDirs ?? []) args.push("--add-dir", dir);
  return { exe: process.execPath, args };
}
export function finalText(event) {
  const value = event.text ?? event.content ?? (typeof event.message === "string" ? event.message : event.message?.content) ?? (typeof event.data === "string" ? event.data : event.data?.text ?? event.data?.content) ?? event.output ?? event.answer ?? event.result;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => typeof part === "string" ? part : part.text ?? "").join("");
  return "";
}
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
export async function runAskJob(directory, { env = process.env, spawnBackend = spawn, stopTree = killTree, pollMs = 1000, handoff = false } = {}) {
  const file = path.join(directory, "run.json");
  let run = readJson(file), child, timer, interrupted = false;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), answer = "", eventsFd, answerFd;
  let codexSummary;
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
    const { exe, args } = backendCommand(run, directory, repo);
    if (run.backend === "deepseek") eventsFd = fs.openSync(path.join(directory, "events.jsonl"), "w");
    if (run.backend === "agy") answerFd = fs.openSync(path.join(directory, "answer.txt"), "w");
    let pending = "";
    const line = text => {
      if (run.backend === "codex") {
        const escaped = run.codexId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = text.match(new RegExp(`^\\[${escaped}\\] round (\\d+) exit (-?\\d+), session (.+)$`));
        if (match) codexSummary = { codexRound: Number(match[1]), session: match[3].trim() };
      } else if (run.backend === "deepseek") {
        try {
          const event = JSON.parse(text);
          const session = event.session_id ?? event.sessionId ?? (typeof event.session === "string" ? event.session : event.session?.id) ?? event.data?.session_id ?? event.data?.sessionId ?? event.data?.session?.id;
          if (typeof session === "string") run.session = session;
          if (event.type === "final" || event.event === "final") {
            const text = finalText(event);
            if (text) answer += (answer ? "\n" : "") + text;
          }
        } catch { /* Retain malformed or partial event lines in events.jsonl. */ }
      }
    };
    if (fs.existsSync(path.join(directory, "interrupt.flag"))) {
      interrupted = true;
      throw new Error("interrupted");
    }
    child = spawnBackend(exe, args, { cwd: run.cwd ?? directory, env: { ...env, AGENT_TOOLKIT_CAPTURE_ATTACHED: "1" }, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout = append(stdout, chunk);
      if (eventsFd !== undefined) fs.writeSync(eventsFd, chunk);
      if (answerFd !== undefined) fs.writeSync(answerFd, chunk);
      if (run.backend !== "agy") {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) !== -1) { line(pending.slice(0, index).replace(/\r$/, "")); pending = pending.slice(index + 1); }
      }
    });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    timer = setInterval(() => {
      if (!interrupted && fs.existsSync(path.join(directory, "interrupt.flag"))) { interrupted = true; stopTree(child); }
    }, pollMs);
    const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
    if (pending) line(pending);
    clearInterval(timer);
    if (answerFd !== undefined) { fs.closeSync(answerFd); answerFd = undefined; answer = fs.readFileSync(path.join(directory, "answer.txt"), "utf8"); }
    if (run.backend === "codex" && codexSummary) {
      Object.assign(run, codexSummary);
      const root = path.join(toolkit.loadConfig(env).runsDir, "codex", run.codexId);
      run.eventsPath = path.join(root, `r${run.codexRound}.events.jsonl`);
      try { answer = fs.readFileSync(path.join(root, `r${run.codexRound}.last.txt`), "utf8"); }
      catch (error) { if (!exitCode && !interrupted) throw new Error(`cannot read Codex final answer: ${error.message}`); }
    }
    fs.writeFileSync(path.join(directory, "answer.txt"), answer);
    const status = interrupted ? "interrupted" : run.backend === "agy" && exitCode === 3 ? "denied" : exitCode !== 0 || !answer.trim() ? "failed" : "done";
    run = { ...run, status, exitCode };
    if (status !== "done") run.error = status === "interrupted" ? "interrupted" : stderr.toString("utf8").slice(0, 2000) || (exitCode ? `exit ${exitCode}` : "empty answer");
    if (!exitCode && !answer.trim() && !interrupted) run.error = "empty answer";
  } catch (error) {
    run = { ...run, status: interrupted ? "interrupted" : "failed", exitCode: 1, error: (stderr.toString("utf8") || error.message).slice(0, 2000) };
  } finally {
    clearInterval(timer);
    if (eventsFd !== undefined) fs.closeSync(eventsFd);
    if (answerFd !== undefined) fs.closeSync(answerFd);
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
