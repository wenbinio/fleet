import fs from "node:fs";
import path from "node:path";
import { toolkitHome, userHome } from "../../core/lib/toolkit.mjs";
const previousLocations = new Map();
export function dataPaths({ env = process.env, home } = {}) {
  const user = home ?? userHome(env);
  return { shared: path.join(toolkitHome({ ...env, ...(home ? { HOME: home, USERPROFILE: home } : {}) }), "fleet"), legacy: path.join(user, ".claude", "plugins", "data", "fleet-agent-toolkit") };
}
export function migrateData(options = {}) {
  const { shared, legacy } = dataPaths(options);
  previousLocations.set(path.resolve(shared), legacy);
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  const empty = () => !fs.existsSync(shared) || fs.readdirSync(shared).length === 0;
  if (empty() && fs.existsSync(legacy)) {
    const staging = shared + ".migration-" + process.pid + "-" + Math.random().toString(16).slice(2);
    try {
      fs.cpSync(legacy, staging, { recursive: true, dereference: false });
      if (empty()) {
        if (fs.existsSync(shared)) { try { fs.rmdirSync(shared); } catch (error) { if (!['ENOENT','ENOTEMPTY'].includes(error.code)) throw error; } }
        try { fs.renameSync(staging, shared); } catch (error) { if (!fs.existsSync(shared)) throw error; }
      }
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  fs.mkdirSync(shared, { recursive: true });
  copyMissingLegacyRuns({ shared, legacy });
  return shared;
}
function copyMissingLegacyRuns({ shared, legacy }) {
  const source = path.join(legacy, "runs"), destination = path.join(shared, "runs");
  let entries;
  try { entries = fs.readdirSync(source, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const lock = path.join(shared, ".legacy-runs.lock");
  let fd;
  try { fd = fs.openSync(lock, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Another startup can finish the copy; history readers still have their
    // legacy fallback until publication. Recover an interrupted owner's lock.
    let stale = false;
    try {
      const pid = Number(fs.readFileSync(lock, "utf8"));
      if (pid > 0) { try { process.kill(pid, 0); } catch (error) { stale = error.code === "ESRCH"; } }
      else stale = Date.now() - fs.statSync(lock).mtimeMs > 30_000;
    } catch (error) { if (error.code === "ENOENT") return copyMissingLegacyRuns({ shared, legacy }); throw error; }
    if (!stale) return;
    fs.unlinkSync(lock);
    return copyMissingLegacyRuns({ shared, legacy });
  }
  fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  try {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      fs.mkdirSync(destination, { recursive: true });
      const target = path.join(destination, entry.name);
      const present = () => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
      if (present()) continue;
      const staging = path.join(shared, `.legacy-run-${process.pid}-${Math.random().toString(16).slice(2)}`);
      try {
        fs.cpSync(path.join(source, entry.name), staging, { recursive: true, dereference: false });
        // Lock serializes startup publishers; a complete snapshot appears at
        // once. Existing shared folders, including empty ones, always win.
        if (!present()) {
          try { fs.renameSync(staging, target); }
          catch (error) { if (!present()) throw error; } // A shared writer won; leave it intact.
        }
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
  } finally { fs.unlinkSync(lock); }
}
export async function resolveDataDir(options = {}) { return migrateData(options); }
export function legacyDataDir(dataDir) {
  return previousLocations.get(path.resolve(dataDir)) ?? (path.resolve(dataDir) === path.resolve(dataPaths().shared) ? dataPaths().legacy : null);
}
export function approvalPath(options = {}) {
  const { shared, legacy } = dataPaths(options);
  const current = path.join(shared, "approved.json"), old = path.join(legacy, "approved.json");
  return !fs.existsSync(current) && fs.existsSync(old) ? old : current;
}
