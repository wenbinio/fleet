import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const FLEET_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CORE_ROOT = path.join(FLEET_ROOT, "core");
// Explicit fake-runtime injection; never serialized to config or environment.
const injected = new WeakMap();
export function injectRuntime(env, runtime) { injected.set(env, runtime); }
export function toolkitRepo({ env = process.env } = {}) { return injected.get(env)?.repo ?? CORE_ROOT; }
export async function loadToolkit({ env = process.env } = {}) {
  const runtime = injected.get(env), repo = toolkitRepo({ env });
  return { repo, toolkit: runtime?.toolkit ?? await import(pathToFileURL(path.join(repo, "lib", "toolkit.mjs")).href) };
}
