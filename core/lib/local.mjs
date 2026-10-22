import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { capture, loadConfig, toolkitHome } from "./toolkit.mjs";
import { spawnWorker, workerEnv, redactSecrets } from "./worker.mjs";

export const QWEN_FOLDER = "D:/AI/Qwen3.8-Abliterated";
export const QWEN_MODEL = "Huihui-Qwen3.8-27B-Abliterated";
export const QWEN_LOADED = "local Qwen is loaded; it frees the GPU after 5 idle minutes (or run Stop Model.cmd)";
export function localRoot(config = {}, { env = process.env, platform = process.platform } = {}) {
  return env.FLEET_LOCAL_ROOT || config.local?.root || config.local?.folder || (platform === "win32" ? QWEN_FOLDER : null);
}
export function localProvider(config = {}, name, { env = process.env, platform = process.platform } = {}) {
  const selected = name ?? config.local?.provider ?? "local";
  const configured = config.providers?.find(provider => provider.local === true && provider.name === selected) ?? (name === undefined && !config.local?.provider ? config.providers?.find(provider => provider.local === true) : undefined);
  if (name !== undefined && name !== "local" && !configured) throw new Error(`local provider ${name} is not configured`);
  // Ollama is retained only when explicitly configured; never import/copy a GGUF.
  const ollama = configured?.engine === "ollama" || configured?.baseUrl && new URL(configured.baseUrl).port === "11434";
  const folder = localRoot(config, { env, platform });
  const service = { name: "local", kind: "openai", baseUrl: ollama ? "http://localhost:11434/v1" : "http://127.0.0.1:8088/v1",
    ...(!ollama ? { model: QWEN_MODEL, ...(folder ? { start: { shell: "powershell", file: path.join(folder, "Start-Qwen.ps1") } } : {}) } : {}), ...configured, engine: ollama ? "ollama" : "llama.cpp", local: true };
  // Explicit roots override even a starter path saved by an earlier setup.
  if (!ollama && (env.FLEET_LOCAL_ROOT || config.local?.root || config.local?.folder)) service.start = { ...service.start, shell: "powershell", file: path.join(folder, "Start-Qwen.ps1") };
  const url = new URL(service.baseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("local provider must use a loopback HTTP URL");
  return service;
}
export function localDefaults(config, { exists = fs.existsSync, env = process.env, platform = process.platform } = {}) {
  const qwen = localProvider({ local: config.local, providers: [] }, undefined, { env, platform });
  if (!qwen.start?.file || !exists(path.dirname(qwen.start.file))) return config;
  const providers = [...(config.providers ?? [])], index = providers.findIndex(provider => provider.name === "local");
  const old = providers[index];
  if (old?.local && localProvider({ providers: [old] }, undefined, { env, platform }).engine === "llama.cpp") {
    providers[index] = localProvider(config, "local", { env, platform });
    return { ...config, providers };
  }
  if (old && !old.local) return config; // Never replace an unrelated provider.
  if (old) {
    let name = "ollama", suffix = 2;
    while (providers.some(provider => provider.name === name)) name = `ollama-${suffix++}`;
    providers[index] = { ...old, name, engine: "ollama" };
  }
  providers.push(qwen);
  return { ...config, local: { ...config.local, provider: "local", default: qwen.model }, providers };
}
export async function localRequest(service, endpoint, { fetch: fetcher = globalThis.fetch, timeoutMs = 5000, acceptBusy = false } = {}) {
  const url = new URL(service.baseUrl); url.pathname = endpoint;
  const response = await fetcher(url.href, { redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) });
  const data = JSON.parse(await response.text());
  if ((response.ok === false || response.status >= 400) && !(acceptBusy && data.status === "no slot available")) throw Object.assign(new Error(`Local server HTTP ${response.status}`), { status: response.status });
  return data;
}
const refused = error => error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED";
export async function localStatus({ env = process.env, platform = process.platform, config = loadConfig(env), service = localProvider(config, undefined, { env, platform }), exists = fs.existsSync, readFile = fs.readFileSync, probe = true, ...options } = {}) {
  if (service.engine !== "ollama") {
    if (!service.start?.file) return { found: false, ready: false, verified: false, running: false, loaded: null, signedIn: null, models: [], detail: "Configure local.root or FLEET_LOCAL_ROOT for the local model installation" };
    const folder = path.dirname(service.start.file), found = exists(folder) && exists(service.start.file);
    let verified = false;
    if (found) try { verified = JSON.parse(readFile(path.join(folder, "checks", "model.json"), "utf8").replace(/^\uFEFF/, "")).verified === true; } catch {}
    let running = false, loaded = null;
    if (probe) try { running = (await localRequest(service, "/health", options)).status === "ok"; if (running) loaded = (await localRequest(service, "/props", options)).is_sleeping === false; } catch {}
    return { found, ready: found && verified, verified, running, loaded, signedIn: null, models: found ? [{ id: config.local?.default ?? service.model, size: 11.95 * 1024 ** 3 }] : [], detail: found && verified ? "local Qwen / llama.cpp; existing verified model; nothing leaves this machine" : "Qwen folder, Start-Qwen.ps1 and checks/model.json verified:true are required" };
  }
  try {
    const version = await localRequest(service, "/api/version", options), data = await localRequest(service, "/api/tags", options);
    const models = (data.models ?? []).filter(model => typeof (model.name ?? model.model) === "string").map(model => ({ id: model.name ?? model.model, size: Number(model.size) }));
    return { found: true, ready: models.length > 0, signedIn: null, version: version.version, models, detail: models.length ? "explicit Ollama provider; local only" : "Ollama has no models" };
  } catch { return { found: false, ready: false, signedIn: null, models: [], detail: "Ollama server unavailable" }; }
}
export async function ensureLocalReady({ env = process.env, platform = process.platform, config = loadConfig(env), service = localProvider(config, undefined, { env, platform }), runDir = path.join(toolkitHome(env), "runs", "local-start"), spawnStarter = spawnWorker, onPhase = () => {}, onNote = () => {}, now = Date.now, sleep = delay, ...options } = {}) {
  if (service.engine === "ollama") return;
  const deadline = now() + 240_000;
  const ready = async () => {
    if (now() >= deadline) return false;
    try {
      const health = await localRequest(service, "/health", { ...options, timeoutMs: Math.min(5000, deadline - now()), acceptBusy: true });
      return now() <= deadline && ["ok", "no slot available"].includes(health.status);
    } catch { return false; }
  };
  onPhase("starting-server");
  if (await ready()) return;
  const status = await localStatus({ env, platform, config, service, probe: false, ...options });
  if (!status.ready) throw new Error(status.detail);
  const log = path.join(runDir, "local-start.log");
  let failure, readySeen = false, fd;
  const diagnostics = [];
  const note = detail => { if (!diagnostics.includes(detail)) { diagnostics.push(detail); onNote(detail); } };
  const failed = (detail, cause) => {
    note(detail);
    if (!readySeen) failure = Object.assign(new Error(detail), { cause, code: cause?.code });
  };
  const startupError = () => {
    let tail = "", readFd;
    try {
      readFd = fs.openSync(log, "r");
      const size = fs.fstatSync(readFd).size, bytes = Math.min(size, 4096), buffer = Buffer.alloc(bytes);
      fs.readSync(readFd, buffer, 0, bytes, size - bytes); tail = buffer.toString("utf8").slice(-1000);
    } catch {} finally { if (readFd !== undefined) fs.closeSync(readFd); }
    return Object.assign(new Error(`local server did not become ready (see ${path.join(path.dirname(service.start.file), "logs")})${diagnostics.length ? `\n${diagnostics.join("\n")}` : ""}${tail ? `\n${tail}` : ""}`), { cause: failure, code: failure?.code });
  };
  try {
    fs.mkdirSync(runDir, { recursive: true }); fd = fs.openSync(log, "a");
    const powershell = path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const starter = spawnStarter(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", service.start.file], { env: workerEnv(redactSecrets(env)), windowsHide: true, stdio: ["ignore", fd, fd], detached: platform !== "win32" });
    // Server descendants inherit only file handles, never pipes to this worker.
    // Readiness belongs to HTTP, not to the starter's exit/close/EOF lifecycle.
    starter.on("error", error => failed(`local starter spawn failed: ${error.code ?? error.name}: ${error.message}`, error));
    starter.on("exit", (code, signal) => {
      const detail = `local starter exited with code ${code}${signal ? ` (signal ${signal})` : ""}`;
      if (code === 0) note(detail); else failed(detail);
    });
    starter.unref?.();
  } catch (error) { failed(`local starter spawn failed: ${error.code ?? error.name}: ${error.message}`, error); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (failure) throw startupError();
  onPhase("waiting-ready");
  while (now() < deadline) {
    if (failure) throw startupError();
    const healthy = await ready();
    if (failure) throw startupError();
    if (healthy) { readySeen = true; return; }
    if (now() >= deadline) break;
    await sleep(Math.min(1000, deadline - now()));
  }
  throw startupError();
}
export async function gpuGuard(backend, { existing = [], model, provider, env = process.env, platform = process.platform, config = loadConfig(env), run = capture, ...options } = {}) {
  const live = existing.filter(row => ["running", "waiting_for_lok"].includes(row.status)), service = localProvider(config, provider, { env, platform });
  const busy = message => Object.assign(new Error(message), { status: "gpu_busy" });
  if (live.some(row => row.backend === (backend === "local" ? "sound" : "local"))) throw busy(backend === "sound" && service.engine !== "ollama" ? QWEN_LOADED : "gpu busy");
  if (service.engine !== "ollama") {
    let loaded = false;
    try {
      const health = await localRequest(service, "/health", options);
      if (health.status !== "ok") throw new Error("health unavailable");
      const props = await localRequest(service, "/props", options);
      if (typeof props.is_sleeping !== "boolean") throw new Error("sleep status unavailable");
      loaded = !props.is_sleeping;
    } catch (error) { if (backend === "sound" && !refused(error)) throw busy("gpu busy: cannot verify local Qwen sleep status"); }
    if (backend === "sound") { if (loaded) throw busy(QWEN_LOADED); return; }
    if (loaded) return;
    let result;
    try { result = await run("nvidia-smi", ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"], { env, timeout: 5000 }); } catch { return; }
    const free = Number(result.stdout?.trim().split(/\r?\n/)[0]?.split(",")[2]) / 1024;
    if (result.code === 0 && Number.isFinite(free) && free < 12) return { notice: `partial CPU offload likely: free ${free.toFixed(1)} GB < model 12 GB` };
    return;
  }
  if (backend === "sound") {
    let data;
    try { data = await localRequest(service, "/api/ps", options); }
    catch (error) { if (refused(error)) return; throw busy("gpu busy: cannot verify Ollama loaded models"); }
    if (!Array.isArray(data.models)) throw busy("gpu busy: invalid Ollama loaded-model response");
    if (data.models.length) throw busy("gpu busy");
    return;
  }
  const status = await localStatus({ env, platform, config, service, ...options }), selected = status.models.find(item => item.id === model);
  if (!selected || !Number.isFinite(selected.size) || selected.size <= 0) throw new Error("local model unavailable; choose an installed model from fleet_accounts");
  const result = await run("nvidia-smi", ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"], { env, timeout: 5000 });
  const freeMiB = Number(result.stdout?.trim().split(/\r?\n/)[0]?.split(",")[2]);
  if (result.code !== 0 || !Number.isFinite(freeMiB)) throw busy("gpu busy: cannot read free VRAM");
  const need = selected.size / 1024 ** 3 * 1.2 + 1, free = freeMiB / 1024;
  if (free < need) throw busy(`not enough VRAM: need ~${need.toFixed(1)} GB, free ${free.toFixed(1)} GB`);
}
