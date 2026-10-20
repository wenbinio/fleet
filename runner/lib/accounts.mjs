import { enabledBackends, assertEnabled } from "./profile.mjs";
import { resolveDataDir } from "./data-dir.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { loadToolkit } from "./runtime.mjs";
import { atomicJson, listRuns } from "./jobs.mjs";
import { BACKENDS } from "./adapters.mjs";
import { effortNote } from "../../core/lib/effort.mjs";

const TTL = 10 * 60 * 1000;
const models = (ids, cost, access) => ids.map(id => ({ id, cost, access }));
export function parseGrokModelIds(text) {
  const ids = new Set();
  let available = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*Available models:\s*$/i.test(line)) { available = true; continue; }
    if (!available || !line.trim()) continue;
    if (!/^\s*[*-]\s+/.test(line)) { available = false; continue; }
    const match = line.match(/^\s*[*-]\s+(grok-[a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s+\(default\))?\s*$/);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}
export function parseModelIds(text) {
  const ids = new Set();
  const add = id => { if (typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9/_.:-]*$/.test(id)) ids.add(id); };
  const structured = value => {
    if (Array.isArray(value)) { for (const row of value) typeof row === "string" ? add(row) : structured(row); }
    else if (value && typeof value === "object") {
      add(value.id ?? value.modelId ?? value.model_id);
      for (const key of ["models", "data"]) if (value[key]) structured(value[key]);
    }
  };
  try { structured(JSON.parse(String(text))); } catch {
    for (const line of String(text).split(/\r?\n/)) {
      const start = line.search(/[\[{]/);
      if (start >= 0) try { structured(JSON.parse(line.slice(start))); } catch {}
    }
  }
  if (ids.size) return [...ids];
  // Both CLIs also print account messages. Only model-shaped tokens are retained.
  for (const match of String(text).matchAll(/\b(?:(?:gemini|claude|grok|gpt|deepseek|qwen)[-.][a-zA-Z0-9][a-zA-Z0-9._-]*|o[134](?:[-.][a-zA-Z0-9][a-zA-Z0-9._-]*)?)\b/g)) ids.add(match[0].replace(/[.]+$/, ""));
  return [...ids];
}
export async function accounts({ backend, env = process.env, dataDir, apiOptions = {}, now = Date.now, discover, platform = process.platform } = {}) {
  if (backend !== undefined && !BACKENDS.includes(backend)) throw new Error("invalid backend");
  const enabled = enabledBackends({ env });
  if (backend) assertEnabled(backend, { env });
  dataDir ??= await resolveDataDir({ env });
  const { repo, toolkit } = await loadToolkit({ env });
  const [api, media, runners, webchat] = await Promise.all(["api", "media", "runners", "webchat/state"].map(name => import(pathToFileURL(path.join(repo, "lib", `${name}.mjs`)).href)));
  const config = toolkit.loadConfig(env), services = enabled.includes("api") ? api.providers({ env }) : [];
  const sound = media.soundTools(config, { platform });
  const soundModels = () => models(["sao", "moss"].filter(engine => sound[engine]), "local", "sound");
  const chatState = webchat.readState(webchat.chatgptHome(env));
  const chatModels = () => models(chatState.models.length ? chatState.models : ["strongest"], "subscription", "text");
  const aliases = Object.entries(runners.aliases).filter(([id]) => ["astra", "sol", "luna"].includes(id));
  // Fingerprints invalidate stale installation/provider menus without storing config or credentials.
  const fingerprint = createHash("sha256").update(JSON.stringify([4, enabled, repo, aliases, services.map(s => [s.name, s.baseUrl]), config.soundVenv, config.mossVenv, config.soundDir, config.mossTools])).digest("hex");
  const cacheFile = path.join(dataDir, "model-menu.json");
  let cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
  const valid = cache?.fingerprint === fingerprint && Number.isFinite(cache.savedAt) && now() - cache.savedAt >= 0 && now() - cache.savedAt < TTL && Array.isArray(cache.rows);
  let menu = valid ? cache.rows : null;
  if (!menu) {
    const discoverModels = discover ?? (async name => {
      const exe = toolkit.resolveTool(name, { env });
      return exe ? toolkit.capture(exe, ["models"], { env, timeout: 30_000 }) : { code: 1, stdout: "", stderr: "" };
    });
    const cliModels = async (name, fallback) => {
      if (!enabled.includes(name)) return [fallback];
      try {
        const result = await discoverModels(name);
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        const ids = name === "grok" ? parseGrokModelIds(output) : result.code !== 0 ? [] : parseModelIds(output);
        return ids.length ? ids : [fallback];
      } catch { return [fallback]; }
    };
    const [agy, grok] = await Promise.all([cliModels("agy", "gemini-3.8-flash-low"), cliModels("grok", "grok-4.7")]);
    menu = [
      { backend: "codex", models: aliases.map(([id, modelId]) => ({ id, modelId, cost: "subscription", access: "edits" })), notes: [] },
      { backend: "agy", models: models(agy, "subscription", "read-only"), notes: [] },
      { backend: "grok", models: models(grok, "subscription", "read-only"), notes: [] },
      { backend: "deepseek", models: models(["deepseek-flash", "deepseek-v4-pro"], "subscription", "edits"), notes: [] },
      ...await Promise.all(services.map(async service => {
        let free = [], size = null;
        try { free = await api.freeModels(service, { ...apiOptions, env }); size = await api.catalogSize(service, { ...apiOptions, env }); } catch {}
        return { backend: "api", provider: service.name, models: models(free.map(m => m.id), "free", "text"), notes: ["paid: any other model id by name, with maxCostUsd", `catalogue size: ${size ?? "unavailable"}`] };
      })),
      { backend: "image", models: [{ id: "sol", modelId: runners.aliases.sol, cost: "subscription", access: "image" }], notes: [] },
      { backend: "advisor", models: models(["argon"], "subscription", "text"), notes: ["only when Lok asks"] },
      { backend: "chatgpt", models: chatModels(), notes: ["ChatGPT chat allowance; one prompt at a time, paced"] },
      { backend: "sound", models: soundModels(), notes: [] },
    ];
    fs.mkdirSync(dataDir, { recursive: true });
    // Only the menu is cached: never accountStatus, sign-in detail, keys or raw CLI output.
    atomicJson(cacheFile, { savedAt: now(), fingerprint, rows: menu });
  }
  const selected = menu.filter(row => enabled.includes(row.backend) && (backend === undefined || row.backend === backend));
  const statuses = new Map();
  const signIn = name => {
    if (!statuses.has(name)) statuses.set(name, toolkit.signInStatus(name, { env }));
    return statuses.get(name);
  };
  const history = selected.some(row => row.backend === "api") ? await listRuns(dataDir, { backend: "api", limit: Number.MAX_SAFE_INTEGER }) : null;
  return Promise.all(selected.map(async row => {
    let status;
    if (["codex", "agy", "grok", "deepseek", "image"].includes(row.backend)) {
      status = await signIn(row.backend === "deepseek" ? "dsh" : row.backend === "image" ? "codex" : row.backend);
    } else if (row.backend === "api") {
      const service = services.find(service => service.name === row.provider);
      status = { ...await api.accountStatus(service, { ...apiOptions, env }), spendUsd: history.runs.filter(run => run.provider === row.provider).reduce((sum, run) => sum + (run.costUsd ?? 0), 0) };
    } else if (row.backend === "advisor") {
      const found = fs.existsSync(path.join(repo, "..", "backends", "advisor", "advisor.mjs")) && Boolean(toolkit.resolveTool("chrome", { env }));
      status = { found, signedIn: null, detail: found ? "Gemini web; sign-in checked only when Lok asks" : "advisor script or Chrome missing" };
    } else if (row.backend === "chatgpt") {
      status = { found: Boolean(toolkit.resolveTool("chrome", { env })), signedIn: chatState.signedIn ?? null, detail: chatState.signedIn === true ? `signed in; checked ${chatState.checkedAt ?? "date unavailable"}` : "run: bin/chatgpt-web login, then check" };
    } else {
      status = { found: soundModels().length > 0, signedIn: null, detail: "local sound tools; no login" };
    }
    // Derive effort notes after cache lookup so a cached catalog never freezes
    // backend option rules from an earlier release.
    const note = effortNote(row.backend), notes = [...row.notes.filter(note => !note.startsWith("effort:")), ...(note ? [note] : [])];
    return { ...status, backend: row.backend, ...(row.provider ? { provider: row.provider } : {}), models: row.backend === "sound" ? soundModels() : row.backend === "chatgpt" ? chatModels() : row.models, notes };
  }));
}
