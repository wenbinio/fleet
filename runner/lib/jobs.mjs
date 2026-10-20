import { assertEnabled } from "./profile.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnWorker as spawn } from "../../core/lib/worker.mjs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDataDir, legacyDataDir } from "./data-dir.mjs";
import { ADAPTERS, BACKENDS, ASK_KEYS, TERMINAL_STATUSES, LIVE_STATUSES } from "./adapters.mjs";
export { BACKENDS, ASK_KEYS, TERMINAL_STATUSES } from "./adapters.mjs";
import { toolkitRepo } from "./runtime.mjs";
import { assertOrchestrator, workerEnv } from "../../core/lib/worker.mjs";

export const FLEET_CLI = fileURLToPath(new URL("../fleet.mjs", import.meta.url));
export const ASK_JOB = fileURLToPath(new URL("../ask-job.mjs", import.meta.url));
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function runDirectory(dataDir, runId) {
  if (typeof runId !== "string" || !runId.trim()) throw new Error("runId is required");
  let root = path.resolve(dataDir, "runs");
  const legacy = legacyDataDir(dataDir), oldRoot = legacy && path.resolve(legacy, "runs");
  if (path.isAbsolute(runId) && oldRoot && path.dirname(path.resolve(runId)) === oldRoot) runId = path.basename(runId);
  if (!path.isAbsolute(runId) && (runId !== path.basename(runId) || runId.includes("/") || runId.includes("\\"))) throw new Error("runId must be a run directory name or an absolute path inside runs");
  let candidate = path.resolve(root, runId);
  if (!isInside(root, candidate)) throw new Error("runId must be inside the plugin runs directory");
  if (!fs.existsSync(candidate) && oldRoot && !path.isAbsolute(runId) && fs.existsSync(path.join(oldRoot, runId))) { root = oldRoot; candidate = path.join(oldRoot, runId); }
  const resolvedRoot = fs.realpathSync(root), resolved = fs.realpathSync(candidate);
  if (!isInside(resolvedRoot, resolved)) throw new Error("runId must be inside the plugin runs directory");
  if (!fs.statSync(resolved).isDirectory()) throw new Error("runId must be a directory");
  return resolved;
}
export function liveStatus(run, kill = process.kill) {
  if (LIVE_STATUSES.has(run.status) && Number.isInteger(run.pid) && run.pid > 0) {
    try { kill(run.pid, 0); } catch (error) { if (error.code === "ESRCH") return { ...run, status: "lost" }; }
  }
  return run;
}
export function readAsk(directory) { return liveStatus(readJson(path.join(directory, "run.json"))); }
export function kindOf(directory) {
  return fs.existsSync(path.join(directory, "run.json")) ? "ask" : fs.existsSync(path.join(directory, "state.json")) ? "delegate" : "batch";
}
function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}
function absoluteDirectory(value, name) {
  nonempty(value, name);
  if (!path.isAbsolute(value) || !fs.statSync(value).isDirectory()) throw new Error(`${name} must be an absolute existing folder`);
}
export function validateAsk(opts, { env = process.env } = {}) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) throw new Error("options must be an object");
  for (const key of Object.keys(opts)) if (!ASK_KEYS.includes(key)) throw new Error(`unexpected argument: ${key}`);
  if (!BACKENDS.includes(opts.backend)) throw new Error(`backend must be one of ${BACKENDS.join(", ")}`);
  assertEnabled(opts.backend, { env });
  const adapter = ADAPTERS[opts.backend];
  for (const key of Object.keys(opts)) {
    if (opts[key] !== undefined && !["backend", "prompt", "promptFile", ...adapter.allowed].includes(key)) {
      const supported = BACKENDS.filter(name => ADAPTERS[name].allowed.includes(key)).join(" or ");
      throw new Error(`${key} is ${supported} only`);
    }
  }
  if ((opts.prompt !== undefined) === (opts.promptFile !== undefined)) throw new Error("provide exactly one of prompt or promptFile");
  if (opts.prompt !== undefined) nonempty(opts.prompt, "prompt");
  if (opts.promptFile !== undefined) {
    nonempty(opts.promptFile, "promptFile");
    if (!path.isAbsolute(opts.promptFile) || !fs.statSync(opts.promptFile).isFile()) throw new Error("promptFile must be an absolute file path");
  }
  if (adapter.required?.includes("cwd") || opts.cwd !== undefined) absoluteDirectory(opts.cwd, "cwd");
  if (opts.addDirs !== undefined) {
    if (!Array.isArray(opts.addDirs)) throw new Error("addDirs must be an array");
    for (const dir of opts.addDirs) absoluteDirectory(dir, "addDirs");
  }
  if (opts.outDir !== undefined) absoluteDirectory(opts.outDir, "outDir");
  for (const key of ["images", "files"]) {
    if (opts[key] === undefined) continue;
    if (!Array.isArray(opts[key])) throw new Error(`${key} must be an array`);
    for (const file of opts[key]) {
      nonempty(file, key);
      if (!path.isAbsolute(file) || !fs.existsSync(file) || (key === "images" && !fs.statSync(file).isFile())) throw new Error(`${key} must contain absolute existing paths`);
    }
  }
  if (opts.readOnly !== undefined && typeof opts.readOnly !== "boolean") throw new Error("readOnly must be a boolean");
  for (const key of ["resume", "jsonSchema", "model", "effort", "provider", "system"]) if (opts[key] !== undefined) nonempty(opts[key], key);
  if (opts.system !== undefined && (!path.isAbsolute(opts.system) || !fs.statSync(opts.system).isFile())) throw new Error("system must be an absolute file path");
  if (opts.maxTokens !== undefined && (!Number.isSafeInteger(opts.maxTokens) || opts.maxTokens < 1)) throw new Error("maxTokens must be a positive integer");
  if (opts.maxCostUsd !== undefined && (!Number.isFinite(opts.maxCostUsd) || opts.maxCostUsd < 0)) throw new Error("maxCostUsd must be non-negative");
  adapter.validate?.(opts);
}
async function withStartLock(root, action) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, ".ask-start.lock"), deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        if (pid > 0) {
          try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") fs.unlinkSync(lock); }
        } else if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock);
      } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (Date.now() > deadline) throw new Error("another fleet job is starting; try again");
      await delay(25);
    }
  }
  try { return await action(); } finally { fs.rmSync(lock, { force: true }); }
}
export async function startAsk(opts, { env = process.env, dataDir, spawnJob = spawn } = {}) {
  assertOrchestrator(env);
  validateAsk(opts, { env });
  const repo = toolkitRepo({ env }), adapter = ADAPTERS[opts.backend];
  dataDir ??= await resolveDataDir({ env });
  const root = path.join(dataDir, "runs");
  return withStartLock(root, async () => {
    const existing = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
      try { return [readAsk(runDirectory(dataDir, e.name))]; } catch { return []; }
    });
    if (adapter.maxLive && existing.filter(r => r.backend === opts.backend && LIVE_STATUSES.has(r.status)).length >= adapter.maxLive) throw new Error(`${opts.backend} runs ${adapter.maxLive} jobs at once; wait for one`);
    let resumed;
    if (opts.resume) {
      resumed = readAsk(runDirectory(dataDir, opts.resume));
      adapter.resume(opts, resumed, existing);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const runId = `ask-${opts.backend}-${stamp}-${randomBytes(2).toString("hex")}`;
    const prepared = await adapter.prepare?.(opts, { repo, env, runId, resumed });
    const directory = path.join(root, runId);
    fs.mkdirSync(directory);
    const prompt = opts.prompt ?? fs.readFileSync(opts.promptFile, "utf8");
    fs.writeFileSync(path.join(directory, "prompt.txt"), prompt);
    const run = {
      kind: "ask", runId, backend: opts.backend,
      ...adapter.defaults,
      ...Object.fromEntries(adapter.allowed.filter(key => opts[key] !== undefined).map(key => [key, opts[key]])),
      ...prepared,
      status: "running", startedAt: new Date().toISOString(), pid: process.pid,
    };
    const file = path.join(directory, "run.json");
    atomicJson(file, run);
    try {
      const child = spawnJob(process.execPath, [ASK_JOB, path.resolve(directory)], { detached: true, windowsHide: true, stdio: "ignore", env: workerEnv(env) });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      run.pid = child.pid;
      atomicJson(file, run);
      // The worker waits for this handoff so its terminal snapshot cannot be overwritten.
      fs.writeFileSync(path.join(directory, "launch.ready"), "");
      child.unref();
    } catch (error) {
      atomicJson(file, { ...run, status: "failed", endedAt: new Date().toISOString(), exitCode: 1, durationMs: Date.now() - Date.parse(run.startedAt), error: error.message });
      throw error;
    }
    return { runId, backend: run.backend, model: run.model, status: "running", wait: `node "${FLEET_CLI}" wait ${runId}` };
  });
}
export function capText(text, limit = 40_000, tail = false) {
  if (text.length <= limit) return text;
  const note = `\n[${tail ? "Answer" : "Transcript"} truncated to ${limit} characters${tail ? "; showing the end" : ""}.]\n`;
  return tail ? note + text.slice(-(limit - note.length)) : text.slice(0, limit - note.length) + note;
}
export function answerOf(directory, limit = 40_000, tail = false) {
  try { return capText(fs.readFileSync(path.join(directory, "answer.txt"), "utf8"), limit, tail); }
  catch (e) { if (e.code === "ENOENT") return ""; throw e; }
}
export async function listRuns(dataDir, { limit = 20, backend } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (backend !== undefined && !BACKENDS.includes(backend)) throw new Error("invalid backend");
  const entriesByName = new Map();
  for (const location of [legacyDataDir(dataDir), dataDir].filter(Boolean)) {
    try { for (const entry of fs.readdirSync(path.join(location, "runs"), { withFileTypes: true })) entriesByName.set(entry.name, entry); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const entries = [...entriesByName.values()];
  const runs = []; let spendUsd = 0;
  for (const entry of entries.filter(e => e.isDirectory())) {
    try {
      const directory = runDirectory(dataDir, entry.name), kind = kindOf(directory);
      const payload = kind === "ask" ? readAsk(directory) : readJson(path.join(directory, kind === "delegate" ? "state.json" : "results.json"));
      const startedAt = payload.startedAt ?? fs.statSync(directory).mtime.toISOString();
      const run = { runId: entry.name, kind, backend: kind === "ask" ? payload.backend : "codex", model: payload.model ?? null, status: payload.status ?? (payload.complete ? "done" : "running"), startedAt };
      if (kind === "batch") Object.assign(run, { complete: payload.complete === true, taskCount: (payload.results ?? []).length, statuses: (payload.results ?? []).map(r => (r.driver ?? r).status ?? "unknown") });
      const adapter = kind === "ask" ? ADAPTERS[payload.backend] : null;
      Object.assign(run, adapter?.row?.(payload));
      spendUsd += adapter?.spend?.(payload) ?? 0;
      if (!backend || run.backend === backend) runs.push(run);
    } catch { /* Ignore incomplete reservations and invalid run directories. */ }
  }
  return { runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId)).slice(0, limit), spendUsd };
}
export async function transcriptSource(directory, run, { env = process.env } = {}) {
  return ADAPTERS[run.backend].transcript(run, { directory, env });
}
export async function eventsFile(directory, run, options) { return (await transcriptSource(directory, run, options)).file ?? null; }
export async function waitRuns(ids, { dataDir, env = process.env, timeout, pollMs = 2000, warn = line => console.error(line) } = {}) {
  if (!ids.length) throw new Error("wait needs at least one runId");
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) throw new Error("timeout must be non-negative seconds");
  dataDir ??= await resolveDataDir({ env });
  const directories = ids.map(id => runDirectory(dataDir, id)), start = Date.now(), notified = new Set();
  for (;;) {
    const rows = directories.map(directory => {
      const kind = kindOf(directory);
      const run = kind === "ask" ? readAsk(directory) : readJson(path.join(directory, kind === "delegate" ? "state.json" : "results.json"));
      const status = run.status ?? (run.complete ? "done" : "running");
      return { runId: run.runId ?? path.basename(directory), backend: run.backend ?? "codex", model: run.model ?? null, status, ...(status !== "done" && typeof run.error === "string" ? { error: run.error.slice(0, 500) } : {}), ...(run.notice ? { notice: run.notice } : {}), ...(run.files ? { files: run.files } : {}), durationMs: run.durationMs ?? (run.startedAt ? Date.now() - Date.parse(run.startedAt) : null), answer: answerOf(directory, 6000, true) };
    });
    for (const row of rows) if (row.status === "waiting_for_lok" && !notified.has(row.runId)) { notified.add(row.runId); warn(`${row.runId}: ${row.notice}`); }
    if (rows.every(r => TERMINAL_STATUSES.has(r.status))) return rows;
    if (timeout !== undefined && Date.now() - start >= timeout * 1000) return rows.map(r => LIVE_STATUSES.has(r.status) || r.status === "awaiting-steer" ? { ...r, error: r.error ?? "wait timeout" } : r);
    await delay(Math.min(pollMs, timeout === undefined ? pollMs : Math.max(1, timeout * 1000 - (Date.now() - start))));
  }
}
