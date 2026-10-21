#!/usr/bin/env node
import { enabledBackends, assertEnabled } from "../runner/lib/profile.mjs";
import { ADAPTERS } from "../runner/lib/adapters.mjs";
import { assertOrchestrator } from "../core/lib/worker.mjs";
import { EFFORT_DESCRIPTION, validateEffort } from "../core/lib/effort.mjs";

import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fsp } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { startAsk, listRuns, runDirectory, kindOf, storedKind, readAsk, answerOf, capText, transcriptSource, BACKENDS } from "../runner/lib/jobs.mjs";
import { startOperation, operationTranscript } from "../runner/lib/operations.mjs";
import { accounts } from "../runner/lib/accounts.mjs";
import { finalText } from "../runner/ask-job.mjs";

import { resolveDataDir } from "../runner/lib/data-dir.mjs";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const TERMINAL_STATUSES = new Set(["done", "interrupted", "failed"]);
const TRANSCRIPT_LIMIT = 40_000;
const WORKER_HIDDEN = new Set(["fleet_ask", "fleet_steer", "fleet_interrupt", "fleet_review", "fleet_shot", "fleet_deploy_wait"]);
const TRUNCATION_NOTE = "\n\n[Transcript truncated to 40000 characters.]";

const str = { type: "string" };
const runSchema = objectSchema({ runId: str }, ["runId"]);
export const TOOLS = [
  { name: "fleet_ask", description: "Start a backend job and return its wait command.", inputSchema: objectSchema({ backend: { enum: BACKENDS }, prompt: str, promptFile: str, cwd: { type: "string", description: "Absolute folder the worker runs in." }, model: str, timeout: { type: "number", exclusiveMinimum: 0, description: "Seconds; local default 1200, chatgpt 1800." }, keepChat: { type: "boolean" }, effort: { type: "string", description: EFFORT_DESCRIPTION }, readOnly: { type: "boolean" }, addDirs: { type: "array", items: str }, jsonSchema: str, noPreamble: { type: "boolean" }, resume: { type: "string", description: "Earlier runId to continue." }, provider: str, n: { type: "integer", minimum: 1, maximum: 10 }, resolution: str, aspect_ratio: str, size: str, quality: str, output_format: { enum: ["png", "jpeg", "webp", "svg"] }, background: { enum: ["auto", "transparent", "opaque"] }, maxTokens: { type: "integer", minimum: 1 }, maxCostUsd: { type: "number", minimum: 0 }, system: { type: "string", description: "System-prompt file path." }, images: { type: "array", items: str, description: "Absolute reference images." }, outDir: str, files: { type: "array", items: str, description: "Absolute paths sent to the advisor." }, lokAsked: { type: "boolean", description: "True only when Lok asked for Argon." }, engine: { enum: ["sao", "moss"] }, seconds: { type: "number", minimum: 0.5, maximum: 47 }, takes: { type: "integer", minimum: 1, maximum: 5 }, seed: { type: "integer" }, music: { type: "boolean" } }, ["backend"]) },
  { name: "fleet_runs", description: "List recent jobs, batches and delegates.", inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, default: 20 }, backend: { enum: BACKENDS } }) },
  { name: "fleet_run", description: "Read one run's results and answer.", inputSchema: runSchema },
  { name: "fleet_transcript", description: "Read a run or batch task transcript.", inputSchema: objectSchema({ runId: str, taskId: str }, ["runId"]) },
  { name: "fleet_status", description: "Show a live run's status and recent event beats.", inputSchema: runSchema },
  { name: "fleet_steer", description: "Queue a steering message for a delegate.", inputSchema: objectSchema({ runId: str, text: str }, ["runId", "text"]) },
  { name: "fleet_interrupt", description: "Request interruption of a job or delegate.", inputSchema: runSchema },
  { name: "fleet_accounts", description: "Show models and current sign-in status.", inputSchema: objectSchema({ backend: { enum: BACKENDS } }) },
  { name: "fleet_review", description: "Review a diff across models and report agreed findings.", inputSchema: objectSchema({ repo: str, diffFile: str, range: str, branch: str, base: str, spec: str, reviewers: { type: "array", items: str }, minAgree: { type: "integer", minimum: 1, default: 2 }, private: { type: "boolean" }, maxCostUsd: { type: "number", minimum: 0, description: "Cap for each explicitly named paid API reviewer." } }, ["repo"]) },
  { name: "fleet_shot", description: "Capture responsive screenshots in an isolated headless browser.", inputSchema: objectSchema({ url: str, dir: str, widths: { type: "array", items: { type: "integer" } }, waitFor: str, waitMs: { type: "number", minimum: 0 }, fullPage: { type: "boolean", default: true } }) },
  { name: "fleet_deploy_wait", description: "Wait for a deployed marker and report matching build checks.", inputSchema: objectSchema({ url: str, path: str, marker: str, timeoutMin: { type: "number", default: 75 }, intervalSec: { type: "number", default: 60 }, repo: { type: "string", description: "GitHub owner/repo for optional checks." }, sha: str }, ["url", "path", "marker"]) },
].map(tool => ["fleet_runs", "fleet_run", "fleet_transcript", "fleet_status", "fleet_accounts"].includes(tool.name) ? { ...tool, annotations: { readOnlyHint: true } } : tool);

function stringSchema(description) {
  return { type: "string", description };
}

function objectSchema(properties, required = []) {
  const schema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireOnlyKeys(value, allowed) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`unexpected argument: ${unexpected}`);
}

function isInside(parent, candidate) {
  const relation = path.relative(path.resolve(parent), path.resolve(candidate));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation));
}

async function delegateDirectory(dataDir, runId) { return runDirectory(dataDir, runId); }

async function readJson(filePath, label = filePath) {
  let contents;
  try {
    contents = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error?.message ?? String(error)}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`cannot parse ${label}: ${error?.message ?? String(error)}`);
  }
}

async function atomicWrite(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function reportsFrom(payload) {
  return Array.isArray(payload?.results) ? payload.results : [];
}

function driverFrom(report) {
  return isObject(report?.driver) ? report.driver : isObject(report) ? report : {};
}

function reviewVerdict(review) {
  if (typeof review === "string" && review) return review;
  if (!isObject(review)) return undefined;
  return review.verdict ?? review.reviewVerdict;
}


async function fleetRun(dataDir, runId) {
  const directory = runDirectory(dataDir, runId);
  const payload = await readJson(path.join(directory, "results.json"), `results for ${runId}`);
  const tasks = reportsFrom(payload).map((report) => {
    const driver = driverFrom(report);
    const task = {
      taskId: report?.taskId ?? driver.taskId ?? null,
      status: driver.status ?? null,
      verifyPassed: driver.verifyPassed ?? null,
      commitSha: driver.commitSha ?? null,
      transcriptPath: driver.transcriptPath ?? null,
    };
    const verdict = reviewVerdict(report?.review);
    if (verdict !== undefined) task.reviewVerdict = verdict;
    return task;
  });
  return { runId: payload?.runId ?? runId, complete: payload?.complete === true, tasks };
}

async function fleetTranscript(dataDir, runId, taskId) {
  requireString(taskId, "taskId");
  const directory = runDirectory(dataDir, runId);
  const payload = await readJson(path.join(directory, "results.json"), `results for ${runId}`);
  const report = reportsFrom(payload).find((item) => item?.taskId === taskId || item?.driver?.taskId === taskId);
  if (!report) throw new Error(`task not found in run ${runId}: ${taskId}`);
  const recorded = driverFrom(report).transcriptPath;
  const transcriptPath = path.resolve(recorded || path.join(directory, "transcripts", `${taskId}.transcript.md`));
  if (!isInside(dataDir, transcriptPath)) throw new Error("transcriptPath is outside the plugin data directory");
  const realPath = await fsp.realpath(transcriptPath);
  if (!isInside(await fsp.realpath(dataDir), realPath)) throw new Error("transcriptPath is outside the plugin data directory");
  const text = await fsp.readFile(realPath, "utf8").catch((error) => {
    throw new Error(`cannot read transcript: ${error?.message ?? String(error)}`);
  });
  if (text.length <= TRANSCRIPT_LIMIT) return text;
  return `${text.slice(0, TRANSCRIPT_LIMIT - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}

function oneLine(value, limit = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function eventBeat(event) {
  if (event?.item) event = { ...event.item, at: event.at };
  if (event?.type === "agent_message") event = { ...event, type: "agentMessage" };
  if (event?.type === "command_execution") event = { ...event, type: "commandExecution", exitCode: event.exit_code };
  if (event?.type === "file_change") event = { ...event, type: "fileChange" };
  if (event?.type === "reasoning" || event?.type === "reasoningSummary") return `reasoning: ${oneLine(event.text ?? event.summary)}`;
  if (event?.type === "final" || event?.event === "final") return `agent: ${oneLine(finalText(event))}`;
  if (event?.type === "tool_call") return `tool: ${oneLine(event.name ?? event.tool ?? event.function?.name)} ${oneLine(event.arguments ?? event.input ?? event.function?.arguments)}`;
  if (event?.type === "tool_result") return `tool result: ${oneLine(event.output ?? event.result ?? event.content)}${event.exit_code == null ? "" : ` (exit ${event.exit_code})`}`;
  if (!isObject(event)) return oneLine(event);
  const prefix = event.at ? `${event.at} ` : "";
  if (event.type === "agentMessage") return `${prefix}agent: ${oneLine(event.text)}`.trim();
  if (event.type === "commandExecution") {
    const exit = event.exitCode == null ? "" : ` (exit ${event.exitCode})`;
    return `${prefix}command: ${oneLine(event.command)}${exit}`.trim();
  }
  if (event.type === "fileChange") {
    const changes = Array.isArray(event.changes) ? event.changes.map((item) => item?.path ?? item).join(", ") : event.changes;
    return `${prefix}files: ${oneLine(changes)}`.trim();
  }
  if (event.type === "turn") return `${prefix}turn: ${oneLine(event.status)}${event.error ? ` — ${oneLine(event.error)}` : ""}`.trim();
  if (event.type === "tokenUsage") {
    const total = event.tokenUsage?.total?.totalTokens ?? event.tokenUsage?.total ?? "updated";
    return `${prefix}tokens: ${oneLine(total)}`.trim();
  }
  if (event.type === "verify") return `${prefix}verify: ${event.passed === true || event.code === 0 ? "passed" : "failed"}${event.code == null ? "" : ` (exit ${event.code})`}`.trim();
  if (event.type === "steer") return `${prefix}steer: ${oneLine(event.text)}`.trim();
  if (event.type === "delegate-summary") {
    const count = Array.isArray(event.filesChanged) ? event.filesChanged.length : 0;
    return `${prefix}delegate summary: ${count} file${count === 1 ? "" : "s"} changed`.trim();
  }
  const detail = event.status ?? event.method ?? event.warning ?? event.text ?? event.type ?? "event";
  return `${prefix}${oneLine(event.type ?? "event")}: ${oneLine(detail)}`.trim();
}

async function delegateStatus(dataDir, runDir) {
  const directory = await delegateDirectory(dataDir, runDir);
  const state = await readJson(path.join(directory, "state.json"), "delegate state");
  const beats = await eventBeats(path.join(directory, "events.jsonl"), 10);
  return { state, beats };
}

async function delegateSteer(dataDir, runDir, text) {
  requireString(text, "text");
  const directory = await delegateDirectory(dataDir, runDir);
  const state = await readJson(path.join(directory, "state.json"), "delegate state");
  if (TERMINAL_STATUSES.has(state?.status)) throw new Error(`run is ${state.status}`);
  const at = new Date().toISOString();
  const timestamp = at.replaceAll(":", "-");
  const messagePath = path.join(directory, "steer.inbox", `${timestamp}-${randomUUID()}.json`);
  await atomicWriteJson(messagePath, { text, at });
  return { ok: true, action: "steer", runDir: directory, at };
}

async function delegateInterrupt(dataDir, runDir) {
  const directory = await delegateDirectory(dataDir, runDir);
  await fsp.access(path.join(directory, "state.json"), fsConstants.F_OK).catch(() => {
    throw new Error(`delegate run not found: ${directory}`);
  });
  const at = new Date().toISOString();
  await atomicWriteJson(path.join(directory, "interrupt.flag"), { at });
  return { ok: true, action: "interrupt", runDir: directory, at };
}

async function readTail(file, bytes = 256 * 1024, completeLines = false) {
  let handle;
  try {
    handle = await fsp.open(file, "r");
    const { size } = await handle.stat();
    const offset = Math.max(0, size - bytes), buffer = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset && completeLines) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  finally { await handle?.close(); }
}
async function eventBeats(file, last) {
  if (!file) return [];
  const text = last ? await readTail(file, 256 * 1024, true) : await fsp.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  const lines = text.split(/\r?\n/).filter(Boolean);
  return (last ? lines.slice(-last) : lines).map(line => { try { return eventBeat(JSON.parse(line)); } catch { return `invalid event: ${oneLine(line)}`; } });
}

export function toolsFor({ env = process.env } = {}) {
  const enabled = enabledBackends({ env });
  const allowed = new Set(["backend", "prompt", "promptFile", ...enabled.flatMap(name => ADAPTERS[name].allowed)]);
  return TOOLS.filter(tool => env.FLEET_WORKER !== "1" || !WORKER_HIDDEN.has(tool.name)).map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, properties: Object.fromEntries(Object.entries(tool.inputSchema.properties).filter(([key]) => tool.name !== "fleet_ask" || allowed.has(key)).map(([key, value]) => [key, key === "backend" ? { ...value, enum: enabled } : value])) } }));
}
export async function callTool(name, rawArguments, { env = process.env, dataDir, start = startAsk, apiOptions = {}, menuOptions = {}, operationOptions = {} } = {}) {
  if (WORKER_HIDDEN.has(name)) assertOrchestrator(env);
  const args = rawArguments === undefined ? {} : requireObject(rawArguments, "arguments");
  if (name === "fleet_ask") validateEffort(args.backend, args.effort);
  dataDir ??= await resolveDataDir({ env });
  if (name === "fleet_ask" || name === "fleet_accounts") assertEnabled(args.backend, { env });
  const tool = toolsFor({ env }).find(tool => tool.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  requireOnlyKeys(args, Object.keys(tool.inputSchema.properties));
  if (["fleet_review", "fleet_shot", "fleet_deploy_wait"].includes(name)) return { value: await startOperation(name.slice(6), args, { ...operationOptions, env, dataDir }), json: true };
  if (name === "fleet_ask") return { value: await start(args, { env, dataDir }), json: true };
  if (name === "fleet_accounts") {
    return { value: await accounts({ ...menuOptions, ...args, env, dataDir, apiOptions }), json: true };
  }
  if (name === "fleet_runs") return { value: await listRuns(dataDir, args), json: true };
  const directory = runDirectory(dataDir, requireString(args.runId, "runId"));
  const kind = kindOf(directory);
  if (name === "fleet_steer") {
    if (kind !== "delegate") throw new Error("steering is for delegates; use fleet_ask with resume");
    return { value: await delegateSteer(dataDir, directory, args.text), json: true };
  }
  if (name === "fleet_interrupt") {
    if (kind === "delegate") return { value: await delegateInterrupt(dataDir, directory), json: true };
    if (!storedKind(kind)) throw new Error("interrupt is for jobs and delegate runs");
    await atomicWriteJson(path.join(directory, "interrupt.flag"), { at: new Date().toISOString() });
    return { value: { ok: true, action: "interrupt", runId: path.basename(directory) }, json: true };
  }
  if (name === "fleet_run") {
    if (storedKind(kind) && kind !== "ask") { const { result, ...run } = readAsk(directory); return { value: { ...run, ...result }, json: true }; }
    const value = kind === "ask" ? { ...readAsk(directory), answer: answerOf(directory) } : kind === "delegate" ? await delegateStatus(dataDir, directory) : await fleetRun(dataDir, directory);
    return { value, json: true };
  }
  if (name === "fleet_status") {
    if (kind === "delegate") return { value: await delegateStatus(dataDir, directory), json: true };
    if (!storedKind(kind)) throw new Error("status is for jobs and delegate runs; use fleet_run for batches");
    const run = readAsk(directory);
    const source = await transcriptSource(directory, run, { env });
    const tail = source.format === "text" ? await readTail(path.join(directory, "answer.txt"), 2000) : "";
    const beats = source.format === "text" ? (tail ? [oneLine(tail)] : []) : await eventBeats(source.file, 10);
    return { value: { runId: run.runId, backend: run.backend, model: run.model, status: run.status, ...(run.phase ? { phase: run.phase } : {}), ...(run.notice ? { notice: run.notice } : {}), elapsedSeconds: Math.max(0, Math.floor((Date.parse(run.endedAt ?? new Date().toISOString()) - Date.parse(run.startedAt)) / 1000)), beats: beats.slice(-10) }, json: true };
  }
  if (name === "fleet_transcript") {
    if (storedKind(kind) && kind !== "ask") return { value: capText(operationTranscript(directory, readAsk(directory))), json: false };
    if (kind === "batch") return { value: await fleetTranscript(dataDir, directory, requireString(args.taskId, "taskId")), json: false };
    if (args.taskId !== undefined) throw new Error("taskId is for batch runs only");
    const run = kind === "ask" ? readAsk(directory) : null;
    const source = run ? await transcriptSource(directory, run, { env }) : { format: "events", file: path.join(directory, "events.jsonl") };
    const text = source.format === "text" ? `Prompt:\n${await fsp.readFile(path.join(directory, "prompt.txt"), "utf8")}\n\nAnswer:\n${answerOf(directory)}${source.reasoning ? "\n\nReasoning:\n" + await readTail(path.join(directory, "reasoning.txt"), 80_000) : ""}${source.details ? "\n\n" + JSON.stringify(source.details) : ""}` : (await eventBeats(source.file)).join("\n");
    return { value: capText(text), json: false };
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    rpcError(isObject(message) && Object.hasOwn(message, "id") ? message.id : null, -32600, "Invalid Request");
    return;
  }
  const hasId = Object.hasOwn(message, "id");
  if (!hasId) return;

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(message.params?.protocolVersion) ? message.params.protocolVersion : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "fleet", version: "0.15.1" },
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools: toolsFor() });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const params = requireObject(message.params, "params");
      const name = requireString(params.name, "name");
      const outcome = await callTool(name, params.arguments);
      const text = outcome.json ? JSON.stringify(outcome.value, null, 2) : outcome.value;
      result(message.id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      result(message.id, {
        content: [{ type: "text", text: error?.message ?? String(error) }],
        isError: true,
      });
    }
    return;
  }
  rpcError(message.id, -32601, "Method not found");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
await resolveDataDir();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    rpcError(null, -32700, "Parse error");
    continue;
  }
  try {
    await handleMessage(message);
  } catch (error) {
    rpcError(isObject(message) && Object.hasOwn(message, "id") ? message.id : null, -32603, error?.message ?? "Internal error");
  }
}

}
