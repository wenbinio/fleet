import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, readJson, runDirectory, TERMINAL_STATUSES } from "./jobs.mjs";
import { ADAPTERS } from "./adapters.mjs";

function alive(pid, kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
const active = (run, kill) => alive(run.pid, kill) || alive(run.backendPid, kill);
function matches(receipt, run) { return receipt.runId === run.runId && receipt.startedAt === run.startedAt; }
export async function reviewChildState(directory, { kill = process.kill, sleep = delay, now = Date.now, graceMs = 2000 } = {}) {
  const file = path.join(directory, "run.json");
  let run = readJson(file);
  if (TERMINAL_STATUSES.has(run.status) || active(run, kill)) return run;
  const deadline = now() + graceMs;
  do {
    if (now() < deadline) await sleep(Math.min(100, deadline - now()));
    run = readJson(file);
    if (TERMINAL_STATUSES.has(run.status) || active(run, kill)) return run;
  } while (now() < deadline);
  const lock = path.join(directory, ".recovery.lock");
  let fd;
  try { fd = fs.openSync(lock, "wx"); } catch (error) { if (error.code === "EEXIST") return run; throw error; }
  try {
    run = readJson(file);
    if (TERMINAL_STATUSES.has(run.status) || active(run, kill)) return run;
    let recovered;
    try {
      const receipt = readJson(path.join(directory, "completion.json"));
      if (matches(receipt, run) && receipt.backend === run.backend && TERMINAL_STATUSES.has(receipt.status)) recovered = receipt;
    } catch {}
    if (!recovered && ["api", "local"].includes(run.backend)) {
      try {
        const output = path.join(directory, "stdout.txt"), errorFile = path.join(directory, "stderr.txt");
        // Older workers write these only during finalization. Require both files
        // from this run and a complete API envelope, never a prefix or streamed chunk.
        if ([output, errorFile].some(name => fs.statSync(name).mtimeMs < Date.parse(run.startedAt))) throw new Error("stale output");
        const data = JSON.parse(fs.readFileSync(output, "utf8"));
        if (!["done", "empty", "failed", "denied", "limit", "rate_limited", "daily_limit"].includes(data.outcome) || typeof data.answer !== "string") throw new Error("incomplete API envelope");
        let receipt;
        try { receipt = readJson(path.join(directory, "backend-exit.json")); } catch {}
        if (receipt && !matches(receipt, run)) throw new Error("wrong exit receipt");
        const interrupted = receipt?.interrupted || fs.existsSync(path.join(directory, "interrupt.flag"));
        const parsed = ADAPTERS[run.backend].parse({ stdout: JSON.stringify(data), exitCode: receipt?.exitCode ?? 0 });
        fs.writeFileSync(path.join(directory, "answer.txt"), parsed.answer);
        fs.writeFileSync(path.join(directory, "reasoning.txt"), parsed.reasoning ?? "");
        recovered = { ...run, ...parsed.metadata, status: interrupted ? "interrupted" : parsed.status, exitCode: receipt?.exitCode ?? null,
          ...(parsed.error ? { error: parsed.error } : {}), recovery: receipt ? "complete output and backend exit receipt" : "complete legacy API output; process exit code unavailable" };
      } catch { /* Incomplete evidence stays lost, never a successful empty review. */ }
    }
    const latest = readJson(file);
    if (TERMINAL_STATUSES.has(latest.status) || active(latest, kill)) return latest;
    const final = { ...(recovered ?? { ...run, status: "lost", error: "worker exited without a terminal record or complete recoverable output" }),
      endedAt: recovered?.endedAt ?? new Date(now()).toISOString(), durationMs: now() - Date.parse(run.startedAt) };
    atomicJson(file, final);
    return final;
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
export async function waitReviewChild(ids, { dataDir, ...options }) {
  return Promise.all(ids.map(id => reviewChildState(runDirectory(dataDir, id), options)));
}
