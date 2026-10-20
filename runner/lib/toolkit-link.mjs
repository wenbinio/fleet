import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NOT_FOUND = "agent-toolkit not found: run node setup.mjs in the agent-toolkit checkout";

export function toolkitRepo({ env = process.env } = {}) {
  const home = env.AGENT_TOOLKIT_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".agent-toolkit");
  try {
    const { repo } = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8").replace(/^\uFEFF/, ""));
    if (typeof repo !== "string" || !path.isAbsolute(repo) || !fs.statSync(path.join(repo, "lib", "runners.mjs")).isFile()) throw new Error();
    return repo;
  } catch { throw new Error(NOT_FOUND); }
}

export async function loadToolkit(options) {
  const repo = toolkitRepo(options);
  return { repo, toolkit: await import(pathToFileURL(path.join(repo, "lib", "toolkit.mjs")).href) };
}
