import { spawn } from "node:child_process";

// Apply at the process boundary, after caller overrides, so every descendant
// sees the restriction without marking the orchestrating process as a worker.
export const workerEnv = (env = process.env) => ({ ...env, FLEET_WORKER: "1" });
export function spawnWorker(command, args, options = {}) {
  return spawn(command, args, { ...options, env: workerEnv(options.env) });
}
export function assertOrchestrator(env = process.env) {
  if (env.FLEET_WORKER === "1") throw new Error("FLEET_WORKER=1: fleet workers cannot start, steer or interrupt fleet jobs");
}
