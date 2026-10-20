#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDataDir } from "./lib/data-dir.mjs";
import { startAsk, waitRuns, listRuns } from "./lib/jobs.mjs";

export async function cli(argv, { env = process.env, print = console.log } = {}) {
  const [command, ...args] = argv;
  const dataDir = await resolveDataDir({ env });
  let result;
  if (command === "ask") {
    const opts = {};
    const names = { backend: "backend", prompt: "prompt", "prompt-file": "promptFile", cwd: "cwd", model: "model", effort: "effort", "add-dir": "addDirs", "json-schema": "jsonSchema", resume: "resume" };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--read-only") { opts.readOnly = true; continue; }
      const name = args[i].startsWith("--") && names[args[i].slice(2)];
      if (!name || i + 1 >= args.length) throw new Error(`invalid option: ${args[i]}`);
      const value = args[++i];
      if (name === "addDirs") (opts.addDirs ??= []).push(value);
      else if (opts[name] !== undefined) throw new Error(`duplicate option: ${args[i - 1]}`);
      else opts[name] = value;
    }
    result = await startAsk(opts, { env, dataDir });
  } else if (command === "wait") {
    const ids = []; let timeout;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--timeout") { if (timeout !== undefined || i + 1 >= args.length) throw new Error("--timeout requires seconds"); timeout = Number(args[++i]); }
      else if (args[i].startsWith("--")) throw new Error(`invalid option: ${args[i]}`);
      else ids.push(args[i]);
    }
    result = await waitRuns(ids, { dataDir, env, timeout });
    for (const row of result) print(JSON.stringify(row));
    return result.every(r => r.status === "done") ? 0 : 1;
  } else if (command === "runs" && !args.length) result = await listRuns(dataDir);
  else if (command === "run" && args.length === 1) {
    const { callTool } = await import("../mcp/fleet-mcp.mjs");
    result = (await callTool("fleet_run", { runId: args[0] }, { dataDir, env })).value;
  } else throw new Error("usage: fleet.mjs ask --backend BACKEND (--prompt TEXT | --prompt-file FILE) [options] | wait RUNID... [--timeout SECONDS] | runs | run RUNID");
  print(JSON.stringify(result));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await cli(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
