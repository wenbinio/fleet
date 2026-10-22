import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawnWorker, assertOrchestrator, workerEnv } from "../../core/lib/worker.mjs";
import { loadConfig } from "../../core/lib/toolkit.mjs";
import { localStatus, localProvider } from "../../core/lib/local.mjs";
import { reviewDiff, privateReview, routeReviewers, reviewPrompt, parseFindings, parseChangedLines, anchorFindings, mergeFindings, FINDINGS_SCHEMA } from "../../core/lib/review.mjs";
import { shot, deployWait, validateShot, validateDeploy } from "../../core/lib/browser-tasks.mjs";
import { readProfile } from "./profile.mjs";
import { resolveDataDir } from "./data-dir.mjs";
import { atomicJson, containedPath, readAsk, readJson, startReviewChild, runDirectory, waitRuns, FLEET_CLI } from "./jobs.mjs";
import { waitReviewChild } from "./job-recovery.mjs";

const worker = fileURLToPath(new URL("../operation-job.mjs", import.meta.url));
export async function startOperation(kind, opts, { env = process.env, dataDir, spawnJob = spawnWorker, reviewOptions = {}, browserOptions = {} } = {}) {
  assertOrchestrator(env);
  let prepared = opts;
  if (kind === "review") {
    if (opts.private !== undefined && typeof opts.private !== "boolean") throw new Error("private must be boolean");
    if (opts.spec !== undefined && typeof opts.spec !== "string") throw new Error("spec must be text");
    if (opts.reviewers !== undefined && (!Array.isArray(opts.reviewers) || opts.reviewers.length > 12)) throw new Error("reviewers must be an array of at most 12 targets");
    if (!Number.isInteger(opts.minAgree ?? 2) || (opts.minAgree ?? 2) < 1) throw new Error("minAgree must be a positive integer");
    if (opts.maxCostUsd !== undefined && (!Number.isFinite(opts.maxCostUsd) || opts.maxCostUsd <= 0)) throw new Error("maxCostUsd must be positive");
    const profile = readProfile({ env }), diff = await reviewDiff(opts, { env, ...reviewOptions });
    const isPrivate = privateReview(opts, diff, profile.privatePaths);
    const routed = await routeReviewers({ ...opts, private: isPrivate }, profile, { localReady: reviewOptions.localReady ?? (async () => {
      const config = loadConfig(env), status = await localStatus({ env, ...reviewOptions });
      const model = config.local?.default ?? localProvider(config, undefined, { env, platform: reviewOptions.platform }).model;
      return Boolean(status.ready && model && status.models.some(item => item.id === model));
    }) });
    prepared = { ...opts, ...routed, private: isPrivate, minAgree: opts.minAgree ?? 2, prompt: reviewPrompt(diff, opts.spec), diff };
  } else if (kind === "shot") validateShot(opts);
  else if (kind === "deploy_wait") validateDeploy(opts);
  else throw new Error("unknown operation");
  dataDir ??= await resolveDataDir({ env });
  const runId = `${kind}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(dataDir, "runs", runId); fs.mkdirSync(directory, { recursive: true });
  const run = { kind, runId, status: "running", startedAt: new Date().toISOString(), pid: process.pid, ...(prepared.notices?.length ? { notice: prepared.notices.join("; ") } : {}) };
  atomicJson(path.join(directory, "run.json"), run);
  atomicJson(path.join(directory, `${kind}.json`), prepared);
  fs.writeFileSync(path.join(directory, "prompt.txt"), prepared.prompt ?? JSON.stringify(opts));
  if (kind === "review") fs.writeFileSync(path.join(directory, "diff.patch"), prepared.diff);
  if (kind === "shot") {
    const completed = await runOperation(directory, { env, browserOptions });
    return { runId, status: completed.status, ...(completed.result ?? {}), ...(completed.error ? { error: completed.error } : {}) };
  }
  try {
    const child = spawnJob(process.execPath, [worker, directory], { env: workerEnv(env), detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    atomicJson(path.join(directory, "run.json"), { ...run, pid: child.pid });
    fs.writeFileSync(path.join(directory, "launch.ready"), ""); child.unref();
  } catch (error) {
    atomicJson(path.join(directory, "run.json"), { ...run, status: "failed", endedAt: new Date().toISOString(), error: error.message }); throw error;
  }
  return { runId, wait: `node "${FLEET_CLI}" wait ${runId}`, ...(run.notice ? { notice: run.notice } : {}) };
}
async function reviewChildren(opts, directory, { env, executeReviewer, startChild = startReviewChild, waitChild = waitReviewChild, pollMs = 1000 } = {}) {
  const rows = [], dataDir = path.dirname(path.dirname(directory)), changed = parseChangedLines(opts.diff);
  const recordProgress = () => { try { atomicJson(path.join(directory, "reviewers.json"), rows); } catch { /* Keep ownership of a started child while storage is temporarily unavailable. */ } };
  const schema = path.join(directory, "findings.schema.json"); atomicJson(schema, FINDINGS_SCHEMA);
  for (let index = 0; index < opts.reviewers.length; index++) {
    if (fs.existsSync(path.join(directory, "interrupt.flag"))) throw new Error("interrupted");
    const reviewer = opts.reviewers[index], row = { id: reviewer.id, status: "running" }; rows.push(row);
    try {
      let answer;
      if (executeReviewer) answer = await executeReviewer(reviewer, opts.prompt);
      else {
        const cwd = path.join(directory, `reviewer-${index}`); fs.mkdirSync(cwd, { recursive: true });
        const { id, ...target } = reviewer;
        const child = await startChild({ ...target, prompt: opts.prompt,
          ...(["codex", "deepseek"].includes(target.backend) ? { cwd } : {}),
          ...(target.backend === "codex" ? { readOnly: true } : {}),
          ...(target.backend === "agy" ? { jsonSchema: JSON.stringify(FINDINGS_SCHEMA), noPreamble: true } : {}),
          ...(["api", "local"].includes(target.backend) ? { responseFormat: "json" } : {}),
        }, { env, dataDir, reviewDirectory: directory });
        row.runId = child.runId; recordProgress();
        const childDirectory = path.join(dataDir, "runs", child.runId);
        let finished;
        for (;;) {
          if (fs.existsSync(path.join(directory, "interrupt.flag"))) {
            try { fs.writeFileSync(path.join(childDirectory, "interrupt.flag"), ""); } catch { await delay(pollMs); continue; }
          }
          try { [finished] = await waitChild([child.runId], { dataDir, env, timeout: 0, warn() {} }); }
          catch (error) {
            // A transient read/rename failure must not abandon a running child.
            row.waitError = error.message; recordProgress();
            await delay(pollMs); continue;
          }
          if (!["running", "waiting_for_lok"].includes(finished.status)) break;
          await delay(pollMs);
        }
        if (fs.existsSync(path.join(directory, "interrupt.flag"))) throw new Error("interrupted");
        if (finished.status !== "done") throw Object.assign(new Error(finished.error ?? finished.status), { status: finished.status });
        answer = fs.readFileSync(path.join(childDirectory, "answer.txt"), "utf8");
      }
      row.answer = answer; row.findings = anchorFindings(parseFindings(answer), changed); row.status = "done";
    } catch (error) {
      row.status = ["limit", "daily_limit", "rate_limited", "denied", "interrupted", "lost"].includes(error.status) ? error.status : "failed"; row.error = error.message;
      if (error.message === "interrupted") throw error;
    } finally { atomicJson(path.join(directory, "reviewers.json"), rows); }
  }
  const answered = rows.filter(row => row.status === "done").length, notices = [...opts.notices];
  const insufficient = answered < opts.minAgree;
  return { reviewers: rows.map(({ id, status }) => ({ id, status })), agreed: mergeFindings(rows, opts.minAgree),
    ...(insufficient ? { note: `only ${answered} reviewers answered; agreement impossible`, unconfirmed: mergeFindings(rows, 1).slice(0, 10).map(item => ({ ...item, failure: item.failure.slice(0, 1000) })) } : {}), ...(notices.length ? { notices } : {}) };
}
export async function runOperation(directory, { env = process.env, handoff = false, browserOptions = {}, ...options } = {}) {
  if (handoff) {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(directory, "launch.ready"))) { if (Date.now() > deadline) throw new Error("worker launch handoff timed out"); await delay(20); }
  }
  let run = readAsk(directory);
  try {
    const opts = readJson(path.join(directory, `${run.kind}.json`));
    const interrupted = () => fs.existsSync(path.join(directory, "interrupt.flag"));
    if (interrupted()) throw new Error("interrupted");
    const result = run.kind === "review" ? await reviewChildren(opts, directory, { env, ...options }) :
      run.kind === "shot" ? await shot(opts, directory, { env, ...browserOptions }) :
      await deployWait(opts, directory, { env, ...browserOptions, interrupted });
    fs.writeFileSync(path.join(directory, "answer.txt"), JSON.stringify(result));
    run = { ...run, status: interrupted() ? "interrupted" : "done", result };
  } catch (error) { run = { ...run, status: error.message === "interrupted" ? "interrupted" : "failed", error: error.message, ...(error.notices?.length ? { notices: error.notices } : {}) }; }
  run.endedAt = new Date().toISOString(); run.durationMs = Date.now() - Date.parse(run.startedAt);
  atomicJson(path.join(directory, "run.json"), run);
  return run;
}
export function operationTranscript(directory, run) {
  const file = path.join(directory, run.kind === "review" ? "reviewers.json" : `${run.kind}.json`);
  const read = target => {
    try { return fs.readFileSync(containedPath(target, [directory]), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  };
  return `${fs.existsSync(file) ? read(file) : ""}\n\n${JSON.stringify(run.result ?? {})}\n\n${fs.readFileSync(containedPath(path.join(directory, "prompt.txt"), [directory]), "utf8")}`;
}
