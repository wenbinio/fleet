#!/usr/bin/env node
import path from "node:path";
import { isMain } from "../core/lib/toolkit.mjs";
import { runOperation } from "./lib/operations.mjs";
if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: operation-job.mjs <runDir>");
    process.exitCode = (await runOperation(path.resolve(process.argv[2]), { handoff: true })).status === "done" ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
