import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDataDir } from "./data-dir.mjs";
import { toolkitRepo, loadToolkit } from "./toolkit-link.mjs";

export const FLEET_CLI = fileURLToPath(new URL("../fleet.mjs", import.meta.url));
export const ASK_JOB = fileURLToPath(new URL("../ask-job.mjs", import.meta.url));
export const BACKENDS = ["codex", "agy", "deepseek"];
export const ASK_KEYS = ["backend", "prompt", "promptFile", "cwd", "model", "effort", "readOnly", "addDirs", "jsonSchema", "resume"];
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
  const root = path.resolve(dataDir, "runs");
  if (!path.isAbsolute(runId) && (runId !== path.basename(runId) || runId.includes("/") || runId.includes("\\"))) throw new Error("runId must be a run directory name or an absolute path inside runs");
  const candidate = path.resolve(root, runId);
  if (!isInside(root, candidate)) throw new Error("runId must be inside the plugin runs directory");
  const resolvedRoot = fs.realpathSync(root), resolved = fs.realpathSync(candidate);
  if (!isInside(resolvedRoot, resolved)) throw new Error("runId must be inside the plugin runs directory");
  if (!fs.statSync(resolved).isDirectory()) throw new Error("runId must be a directory");
  return resolved;
}
export function liveStatus(run, kill = process.kill) {
  if (run.status === "running" && Number.isInteger(run.pid) && run.pid > 0) {
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
export function validateAsk(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) throw new Error("options must be an object");
  for (const key of Object.keys(opts)) if (!ASK_KEYS.includes(key)) throw new Error(`unexpected argument: ${key}`);
  if (!BACKENDS.includes(opts.backend)) throw new Error("backend must be codex, agy or deepseek");
  if ((opts.prompt !== undefined) === (opts.promptFile !== undefined)) throw new Error("provide exactly one of prompt or promptFile");
  if (opts.prompt !== undefined) nonempty(opts.prompt, "prompt");
  if (opts.promptFile !== undefined) {
    nonempty(opts.promptFile, "promptFile");
    if (!path.isAbsolute(opts.promptFile) || !fs.statSync(opts.promptFile).isFile()) throw new Error("promptFile must be an absolute file path");
  }
  if (opts.backend !== "agy" || opts.cwd !== undefined) absoluteDirectory(opts.cwd, "cwd");
  for (const key of ["effort", "readOnly", "resume"]) if (opts[key] !== undefined && opts.backend !== "codex") throw new Error(`${key} is codex only`);
  if (opts.jsonSchema !== undefined && opts.backend !== "agy") throw new Error("jsonSchema is agy only");
  if (opts.addDirs !== undefined) {
    if (opts.backend === "deepseek") throw new Error("addDirs is codex or agy only");
    if (!Array.isArray(opts.addDirs)) throw new Error("addDirs must be an array");
    for (const dir of opts.addDirs) absoluteDirectory(dir, "addDirs");
  }
  if (opts.effort !== undefined && !["low", "medium", "high", "xhigh"].includes(opts.effort)) throw new Error("invalid effort");
  if (opts.readOnly !== undefined && typeof opts.readOnly !== "boolean") throw new Error("readOnly must be a boolean");
  for (const key of ["resume", "jsonSchema", "model"]) if (opts[key] !== undefined) nonempty(opts[key], key);
  if (opts.backend === "deepseek" && opts.model !== undefined && !["deepseek-flash", "deepseek-v4-pro"].includes(opts.model)) throw new Error("invalid deepseek model");
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
  validateAsk(opts);
  toolkitRepo({ env }); // Fail before creating a run when setup is missing.
  dataDir ??= await resolveDataDir({ env });
  const root = path.join(dataDir, "runs");
  return withStartLock(root, async () => {
    const existing = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
      try { return [readAsk(runDirectory(dataDir, e.name))]; } catch { return []; }
    });
    if (opts.backend === "agy" && existing.filter(r => r.backend === "agy" && r.status === "running").length >= 4) throw new Error("agy runs 4 jobs at once; wait for one");
    let resumed;
    if (opts.resume) {
      resumed = readAsk(runDirectory(dataDir, opts.resume));
      if (resumed.kind !== "ask" || resumed.backend !== "codex" || !resumed.codexId) throw new Error("resume must name an earlier codex ask run");
      if (existing.some(r => r.codexId === resumed.codexId && r.status === "running")) throw new Error("that Codex session is still running; wait before resuming");
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const runId = `ask-${opts.backend}-${stamp}-${randomBytes(2).toString("hex")}`;
    const directory = path.join(root, runId);
    fs.mkdirSync(directory);
    const prompt = opts.prompt ?? fs.readFileSync(opts.promptFile, "utf8");
    fs.writeFileSync(path.join(directory, "prompt.txt"), prompt);
    const run = {
      kind: "ask", runId, backend: opts.backend,
      model: opts.model ?? { codex: "astra", agy: "gemini-3.8-flash-low", deepseek: "deepseek-flash" }[opts.backend],
      ...(opts.backend === "codex" ? { effort: opts.effort ?? "high", codexId: resumed?.codexId ?? runId } : {}),
      ...Object.fromEntries(["cwd", "readOnly", "addDirs", "jsonSchema", "resume"].filter(key => opts[key] !== undefined).map(key => [key, opts[key]])),
      status: "running", startedAt: new Date().toISOString(), pid: process.pid,
    };
    const file = path.join(directory, "run.json");
    atomicJson(file, run);
    try {
      const child = spawnJob(process.execPath, [ASK_JOB, path.resolve(directory)], { detached: true, windowsHide: true, stdio: "ignore", env });
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
  let entries;
  try { entries = fs.readdirSync(path.join(dataDir, "runs"), { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const runs = [];
  for (const entry of entries.filter(e => e.isDirectory())) {
    try {
      const directory = runDirectory(dataDir, entry.name), kind = kindOf(directory);
      const payload = kind === "ask" ? readAsk(directory) : readJson(path.join(directory, kind === "delegate" ? "state.json" : "results.json"));
      const startedAt = payload.startedAt ?? fs.statSync(directory).mtime.toISOString();
      const run = { runId: entry.name, kind, backend: kind === "ask" ? payload.backend : "codex", model: payload.model ?? null, status: payload.status ?? (payload.complete ? "done" : "running"), startedAt };
      if (kind === "batch") Object.assign(run, { complete: payload.complete === true, taskCount: (payload.results ?? []).length, statuses: (payload.results ?? []).map(r => (r.driver ?? r).status ?? "unknown") });
      if (!backend || run.backend === backend) runs.push(run);
    } catch { /* Ignore incomplete reservations and invalid run directories. */ }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId)).slice(0, limit);
}
export async function eventsFile(directory, run, { env = process.env } = {}) {
  if (run.backend !== "codex") return path.join(directory, "events.jsonl");
  if (run.eventsPath) return run.eventsPath;
  const { toolkit } = await loadToolkit({ env });
  const root = path.join(toolkit.loadConfig(env).runsDir, "codex", run.codexId);
  try {
    const rounds = fs.readdirSync(root).filter(n => /^r\d+\.events\.jsonl$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    return rounds[0] ? path.join(root, rounds[0]) : null;
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export async function waitRuns(ids, { dataDir, env = process.env, timeout, pollMs = 2000 } = {}) {
  if (!ids.length) throw new Error("wait needs at least one runId");
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) throw new Error("timeout must be non-negative seconds");
  dataDir ??= await resolveDataDir({ env });
  const directories = ids.map(id => runDirectory(dataDir, id)), start = Date.now();
  for (;;) {
    const rows = directories.map(directory => {
      const kind = kindOf(directory);
      const run = kind === "ask" ? readAsk(directory) : readJson(path.join(directory, kind === "delegate" ? "state.json" : "results.json"));
      return { runId: run.runId ?? path.basename(directory), backend: run.backend ?? "codex", model: run.model ?? null, status: run.status ?? (run.complete ? "done" : "running"), durationMs: run.durationMs ?? (run.startedAt ? Date.now() - Date.parse(run.startedAt) : null), answer: answerOf(directory, 6000, true) };
    });
    if (rows.every(r => ["done", "failed", "denied", "interrupted", "lost"].includes(r.status))) return rows;
    if (timeout !== undefined && Date.now() - start >= timeout * 1000) return rows.map(r => ["running", "awaiting-steer"].includes(r.status) ? { ...r, error: "wait timeout" } : r);
    await delay(Math.min(pollMs, timeout === undefined ? pollMs : Math.max(1, timeout * 1000 - (Date.now() - start))));
  }
}
