import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPaths } from "./data-dir.mjs";

export const BACKEND_NAMES = ["codex", "agy", "deepseek", "grok", "api", "image", "advisor", "chatgpt", "sound"];
export const PROFILE_ROOT = fileURLToPath(new URL("../../profiles/", import.meta.url));
export const AUTO_APPROVE_POLICIES = Object.freeze(["none", "read-only"]);
export function readProfile({ env = process.env, name, overrides = {} } = {}) {
  let active = {};
  try { const paths = dataPaths({ env }), shared = path.join(paths.shared, "profile.json"); active = JSON.parse(fs.readFileSync(fs.existsSync(shared) ? shared : path.join(paths.legacy, "profile.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  name ??= active.name ?? "lok";
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("invalid profile name");
  const base = JSON.parse(fs.readFileSync(path.join(PROFILE_ROOT, `${name}.json`), "utf8"));
  const backends = { ...base.backends, ...(name === active.name ? active.backends : {}), ...overrides };
  for (const [key, value] of Object.entries(backends)) {
    if (!BACKEND_NAMES.includes(key) || typeof value !== "boolean") throw new Error(`invalid backend override: ${key}`);
  }
  const autoApprove = base.autoApprove ?? "none";
  if (!AUTO_APPROVE_POLICIES.includes(autoApprove)) throw new Error("autoApprove must be none or read-only");
  return { name, backends, hosts: base.hosts ?? [], autoApprove, rulings: base.rulings ?? {} };
}
export const enabledBackends = options => BACKEND_NAMES.filter(name => readProfile(options).backends[name] === true);
export function assertEnabled(backend, options) {
  const profile = readProfile(options);
  if (BACKEND_NAMES.includes(backend) && profile.backends[backend] !== true) throw new Error(`${backend} is off in profile ${profile.name}`);
}
export function agentsBlock(profile, root) {
  const enabled = BACKEND_NAMES.filter(name => profile.backends[name]);
  return [
    "<!-- fleet:start -->", "If FLEET_WORKER=1 is set, you are a fleet worker: ignore this block.",
    "Fleet runs models through one MCP server and shared run history.",
    `Fleet root: ${root}`, `CLI: node "${path.join(root, "runner", "fleet.mjs")}"`,
    ...enabled.map(name => `- ${name}: ${profile.rulings[name] ?? "available through fleet"}`),
    `This profile's autoApprove policy is ${profile.autoApprove}: the installer manages read-only fleet tool approvals in Codex and agy only.`,
    "fleet_ask, fleet_steer and fleet_interrupt still ask for approval. Lok decides whether to grant those permissions; the installer never grants them.",
    "Run `wait` in the background and act on its exit.", "<!-- fleet:end -->",
  ].join("\n");
}
