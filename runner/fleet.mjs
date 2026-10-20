#!/usr/bin/env node
import { enabledBackends, assertEnabled } from "./lib/profile.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDataDir } from "./lib/data-dir.mjs";
import { startAsk, waitRuns, listRuns } from "./lib/jobs.mjs";
import { loadToolkit } from "./lib/runtime.mjs";
import { assertOrchestrator } from "../core/lib/worker.mjs";
import { startOperation } from "./lib/operations.mjs";

export async function cli(argv, { env = process.env, print = console.log, warn = console.error, apiOptions = {}, menuOptions = {}, start = startAsk, operationOptions = {} } = {}) {
  const [command, ...args] = argv;
  if (["ask", "review", "shot", "deploy-wait", "deploy_wait"].includes(command)) assertOrchestrator(env);
  const dataDir = await resolveDataDir({ env });
  if (!command || ["--help", "-h", "help"].includes(command)) { print(`fleet ask --backend ${enabledBackends({ env }).join("|")} (--prompt TEXT | --prompt-file FILE) [options]
fleet ask --backend local --prompt TEXT [--timeout 1200]
fleet review --repo DIR (--diff-file FILE | --range A..B | --branch BRANCH) [--reviewer BACKEND:MODEL] [--private]
fleet shot (--url URL | --dir DIR) [--widths 390,1440]
fleet deploy-wait --url URL --path /FILE --marker TEXT [--timeout-min 75]
fleet wait RUNID...; runs; run RUNID; accounts`); return 0; }
  let result;
  if (["review", "shot", "deploy-wait", "deploy_wait"].includes(command)) {
    const opts = {}, keys = { repo: "repo", "diff-file": "diffFile", range: "range", branch: "branch", base: "base", spec: "spec", reviewer: "reviewers", reviewers: "reviewers", "min-agree": "minAgree", "max-cost": "maxCostUsd", url: "url", dir: "dir", width: "widths", widths: "widths", "wait-for": "waitFor", "wait-ms": "waitMs", path: "path", marker: "marker", "timeout-min": "timeoutMin", "interval-sec": "intervalSec", sha: "sha" };
    const allowed = new Set(command === "review" ? ["repo", "diffFile", "range", "branch", "base", "spec", "reviewers", "minAgree", "maxCostUsd", "private"] :
      command === "shot" ? ["url", "dir", "widths", "waitFor", "waitMs", "fullPage"] : ["url", "path", "marker", "timeoutMin", "intervalSec", "repo", "sha"]);
    for (let i = 0; i < args.length; i++) {
      if (["--private", "--no-private", "--full-page", "--no-full-page"].includes(args[i])) {
        const key = args[i].includes("private") ? "private" : "fullPage";
        if (!allowed.has(key)) throw new Error(`invalid option: ${args[i]}`);
        if (opts[key] !== undefined) throw new Error(`duplicate option: ${args[i]}`);
        opts[key] = !args[i].startsWith("--no-"); continue;
      }
      const key = keys[args[i].slice(2)];
      if (!args[i].startsWith("--") || !allowed.has(key) || i + 1 >= args.length) throw new Error(`invalid option: ${args[i]}`);
      if (!["reviewers", "widths"].includes(key) && opts[key] !== undefined) throw new Error(`duplicate option: ${args[i]}`);
      const value = args[++i];
      if (["reviewers", "widths"].includes(key)) (opts[key] ??= []).push(...value.split(",").map(item => key === "widths" ? Number(item) : item));
      else opts[key] = ["minAgree", "maxCostUsd", "waitMs", "timeoutMin", "intervalSec"].includes(key) ? Number(value) : value;
    }
    result = await startOperation(command.replace("-", "_"), opts, { ...operationOptions, env, dataDir });
  } else if (command === "ask") {
    const opts = {};
    const names = { backend: "backend", prompt: "prompt", "prompt-file": "promptFile", cwd: "cwd", model: "model", timeout: "timeout", effort: "effort", "add-dir": "addDirs", "json-schema": "jsonSchema", resume: "resume", provider: "provider", "max-tokens": "maxTokens", "max-cost": "maxCostUsd", system: "system", image: "images", file: "files", "out-dir": "outDir", engine: "engine", seconds: "seconds", takes: "takes", seed: "seed" };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--read-only") { opts.readOnly = true; continue; }
      if (args[i] === "--no-preamble") { opts.noPreamble = true; continue; }
      if (args[i] === "--keep-chat") { opts.keepChat = true; continue; }
      if (args[i] === "--lok-asked") { opts.lokAsked = true; continue; }
      if (args[i] === "--music") { opts.music = true; continue; }
      const name = args[i].startsWith("--") && names[args[i].slice(2)];
      if (!name || i + 1 >= args.length) throw new Error(`invalid option: ${args[i]}`);
      const value = args[++i];
      if (["addDirs", "images", "files"].includes(name)) (opts[name] ??= []).push(value);
      else if (opts[name] !== undefined) throw new Error(`duplicate option: ${args[i - 1]}`);
      else opts[name] = ["maxTokens", "maxCostUsd", "seconds", "takes", "seed", "timeout"].includes(name) ? Number(value) : value;
    }
    assertEnabled(opts.backend, { env });
    result = await start(opts, { env, dataDir });
  } else if (command === "wait") {
    const ids = []; let timeout;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--timeout") { if (timeout !== undefined || i + 1 >= args.length) throw new Error("--timeout requires seconds"); timeout = Number(args[++i]); }
      else if (args[i].startsWith("--")) throw new Error(`invalid option: ${args[i]}`);
      else ids.push(args[i]);
    }
    result = await waitRuns(ids, { dataDir, env, timeout, warn });
    for (const row of result) print(JSON.stringify(row));
    return result.every(r => r.status === "done") ? 0 : 1;
  } else if (command === "accounts") {
    if (args.length && (args.length !== 2 || args[0] !== "--backend")) throw new Error("usage: accounts [--backend BACKEND]");
    const { accounts } = await import("./lib/accounts.mjs");
    result = await accounts({ ...menuOptions, backend: args[1], env, dataDir, apiOptions });
  } else if (command === "models") {
    assertEnabled("api", { env });
    let serviceName, n = 4;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--free") continue;
      if (!["--provider", "--n"].includes(args[i]) || i + 1 >= args.length) throw new Error(`invalid option: ${args[i]}`);
      if (args[i] === "--provider") serviceName = args[++i]; else n = Number(args[++i]);
    }
    const { repo } = await loadToolkit({ env });
    const api = await import(pathToFileURL(path.join(repo, "lib", "api.mjs")).href);
    for (const id of await api.pickFree(n, api.provider(serviceName, { env }), { ...apiOptions, env })) print(id);
    return 0;
  } else if (command === "runs" && !args.length) result = await listRuns(dataDir);
  else if (command === "run" && args.length === 1) {
    const { callTool } = await import("../mcp/fleet-mcp.mjs");
    result = (await callTool("fleet_run", { runId: args[0] }, { dataDir, env })).value;
  } else throw new Error("usage: fleet.mjs ask --backend BACKEND (--prompt TEXT | --prompt-file FILE) [options] | wait RUNID... [--timeout SECONDS] | runs | run RUNID | accounts [--backend BACKEND] | models [--provider P] [--free] [--n N]");
  print(JSON.stringify(result));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await cli(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
