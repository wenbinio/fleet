import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPaths } from "./data-dir.mjs";

export const BACKEND_NAMES = ["codex", "agy", "deepseek", "grok", "api", "image", "advisor", "chatgpt", "sound"];
export const PROFILE_ROOT = fileURLToPath(new URL("../../profiles/", import.meta.url));
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
  return { name, backends, hosts: base.hosts ?? [], rulings: base.rulings ?? {} };
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
    "Codex asks approval for fleet_ask, fleet_steer and fleet_interrupt. Headless codex exec needs these per-tool settings:",
    'mcp_servers.fleet.tools.fleet_ask.approval_mode = "approve"',
    'mcp_servers.fleet.tools.fleet_steer.approval_mode = "approve"',
    'mcp_servers.fleet.tools.fleet_interrupt.approval_mode = "approve"',
    "Lok decides whether to approve these settings; the installer never writes approval overrides.",
    "Run `wait` in the background and act on its exit.", "<!-- fleet:end -->",
  ].join("\n");
}
