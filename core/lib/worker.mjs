import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Apply at the process boundary, after caller overrides, so every descendant
// sees the restriction without marking the orchestrating process as a worker.
export const workerEnv = (env = process.env) => ({ ...env, FLEET_WORKER: "1" });

// Names, not values. Chrome, llama.cpp starters and similar helpers do not need
// provider credentials. Callers that must keep a key (the API runner, gh) should
// not pass their environment through this.
const SECRET_ENV_KEY = /(?:^|_)(?:API_KEY|APIKEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)(?:_|$)/i;
export function redactSecrets(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (SECRET_ENV_KEY.test(key) || key === "TOOLKIT_DPAPI_FILE" || key === "FLEET_KEY_TARGET") delete next[key];
  }
  return next;
}

function pathExts(env, platform) {
  if (platform !== "win32") return [""];
  const listed = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return [...new Set(listed)];
}
function isExecutable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}
// Windows CreateProcess / SearchPathW checks the current directory before PATH.
// A worker worktree can plant git.exe or powershell.exe and have the driver run it.
// Resolve bare names from absolute PATH entries only. Relative entries and "." are skipped.
export function resolveBareCommand(command, env = process.env, platform = process.platform) {
  if (typeof command !== "string" || !command || path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  const exts = pathExts(env, platform);
  const names = path.extname(command) ? [command, ...exts.map(ext => command + ext)] : exts.map(ext => command + ext);
  const pathKey = platform === "win32" ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? env.Path ?? "");
  for (const dir of pathKey.split(platform === "win32" ? ";" : ":")) {
    const base = dir.replace(/^"|"$/g, "");
    if (!base || !path.isAbsolute(base)) continue;
    for (const name of names) {
      const candidate = path.join(base, name);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return command;
}
export function spawnWorker(command, args, options = {}) {
  const resolved = resolveBareCommand(command, options.env ?? process.env);
  return spawn(resolved, args, { ...options, env: workerEnv(options.env) });
}
export function assertOrchestrator(env = process.env) {
  if (env.FLEET_WORKER === "1") throw new Error("FLEET_WORKER=1: fleet workers cannot start, steer or interrupt fleet jobs");
}
