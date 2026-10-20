#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnWorker as spawn, workerEnv } from "./core/lib/worker.mjs";
import { fileURLToPath } from "node:url";
import { capture, isMain, loadConfig, readConfig, resolveTool, saveConfig, signInStatus, toolkitHome, userHome } from "./core/lib/toolkit.mjs";
import { defaultProvider, accountStatus } from "./core/lib/api.mjs";
import { soundDefaults, soundTools } from "./core/lib/media.mjs";
import { CHATGPT_DEFAULTS, chatgptHome, readState } from "./core/lib/webchat/state.mjs";
import { setupClaude, refreshFleetConfig } from "./core/install-claude.mjs";
import { dataPaths, migrateData } from "./runner/lib/data-dir.mjs";
import { readProfile, BACKEND_NAMES, agentsBlock } from "./runner/lib/profile.mjs";
import { inspectRegistration, registrationMatches, registrationUses, parseNamedInventory } from "./core/install-inventory.mjs";
export { setupClaude } from "./core/install-claude.mjs";
// Root setup keeps its rows/flags and marketplace source, while using the same
// installer implementation and default profile as standalone Claude installs.
export async function setupToolkitFleet(options) {
  await setupClaude(options);
  if (!options.dryRun) {
    const data = migrateData({ env: options.env }), file = path.join(data, "profile.json");
    if (!fs.existsSync(file)) writeJson(file, { name: "lok", backends: {} });
  }
}

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const HOSTS = ["claude", "codex", "grok", "agy", "cursor", "generic"];
const startMarker = "<!-- fleet:start -->", endMarker = "<!-- fleet:end -->";
const readJson = (file, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
};
function writeJson(file, value) {
  if (fs.existsSync(file) && JSON.stringify(readJson(file)) === JSON.stringify(value)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
  return true;
}
export function managedBlock(text, block) {
  const first = text.indexOf(startMarker), last = text.indexOf(endMarker);
  if ((first < 0) !== (last < 0) || last < first || (first >= 0 && (text.indexOf(startMarker, first + 1) >= 0 || text.indexOf(endMarker, last + 1) >= 0))) throw new Error("malformed fleet managed block; repair its markers first");
  if (first < 0) return block ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n` : text;
  return text.slice(0, first) + (block ? block : "") + text.slice(last + endMarker.length).replace(block ? /^$/ : /^\r?\n/, "");
}
const readText = file => { try { return fs.readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; } };
function linkMatches(destination, source) {
  try { return fs.lstatSync(destination).isSymbolicLink() && fs.realpathSync(destination) === fs.realpathSync(source); } catch { return false; }
}
function present(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
const quote = value => JSON.stringify(value);
export function soundRecipe(root, home, { platform = process.platform } = {}) {
  const windows = platform === "win32", sound = path.join(root, "backends", "sound");
  const sao = path.join(home, "sound", "sao-venv"), moss = path.join(home, "sound", "moss-venv");
  const py = venv => path.join(venv, windows ? "Scripts" : "bin", windows ? "python.exe" : "python");
  const source = path.join(home, "sound", "MOSS-TTS"), weights = path.join(sound, "weights", "MOSS-SoundEffect-v2.0");
  const cmd = (exe, args) => `${windows ? "& " : ""}${quote(exe)} ${args.map(quote).join(" ")}`;
  return [
    cmd(windows ? "py" : "python3.13", [...(windows ? ["-3.13"] : []), "-m", "venv", sao]),
    cmd(py(sao), ["-m", "pip", "install", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu124"]),
    cmd(py(sao), ["-m", "pip", "install", "diffusers", "transformers", "accelerate", "soundfile", "scipy", "huggingface_hub", "sentencepiece", "protobuf", "torchsde"]),
    cmd(path.join(sao, windows ? "Scripts" : "bin", windows ? "hf.exe" : "hf"), ["download", "stabilityai/stable-audio-open-1.0"]),
    cmd(windows ? "py" : "python3.12", [...(windows ? ["-3.12"] : []), "-m", "venv", moss]),
    cmd(py(moss), ["-m", "pip", "install", "torch==2.9.0", "torchaudio==2.9.0", "--index-url", "https://download.pytorch.org/whl/cu128"]),
    cmd(py(moss), ["-m", "pip", "install", "transformers==4.57.1", "diffusers==0.37.1", "numpy==1.26.4", "accelerate", "soundfile", "scipy", "huggingface_hub"]),
    cmd("git", ["clone", "https://github.com/OpenMOSS/MOSS-TTS.git", source]),
    cmd(py(moss), ["-m", "pip", "install", "-e", path.join(source, "moss_soundeffect_v2")]),
    cmd(path.join(moss, windows ? "Scripts" : "bin", windows ? "hf.exe" : "hf"), ["download", "OpenMOSS-Team/MOSS-SoundEffect-v2.0", "--local-dir", weights]),
    `Set soundVenv=${quote(sao)} and mossVenv=${quote(moss)} in ${quote(path.join(home, "config.json"))}.`,
    "Before the SAO download, accept its model license and run hf auth login yourself if required. Complete all downloads before asking an agent to generate sound.",
  ].join("\n");
}
export function parseArgs(argv) {
  const opts = { mode: "plan", hosts: [], on: [], off: [] }, actions = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--plan", "--apply", "--remove"].includes(arg)) { actions.push(arg); opts.mode = arg.slice(2); }
    else if (["--json", "--purge"].includes(arg)) opts[arg.slice(2)] = true;
    else if (["--profile", "--host", "--on", "--off", "--set-key", "--with"].includes(arg)) {
      const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--host") opts.hosts.push(value);
      else if (arg === "--on" || arg === "--off") opts[arg.slice(2)].push(value);
      else opts[arg.slice(2)] = value;
    } else throw new Error(`unknown installer option: ${arg}`);
  }
  if (actions.length > 1 || opts["set-key"] && actions.length) throw new Error("choose one installer action");
  if (opts.purge && opts.mode !== "remove") throw new Error("--purge requires --remove");
  if (opts.hosts.some(host => !HOSTS.includes(host))) throw new Error("unknown host");
  if ([...opts.on, ...opts.off].some(name => !BACKEND_NAMES.includes(name))) throw new Error("unknown backend");
  if (opts.on.some(name => opts.off.includes(name))) throw new Error("a backend cannot be both on and off");
  if (opts.with && opts.with !== "sound") throw new Error("--with supports sound only");
  if (opts["set-key"] && opts["set-key"] !== "openrouter") throw new Error("--set-key supports openrouter only");
  return opts;
}
export async function inspectBackend(backend, { env, config, run, root, platform, apiOptions = {}, readAuth } = {}) {
  const name = ({ deepseek: "dsh", image: "codex", advisor: "chrome", chatgpt: "chrome", sound: "python" })[backend] ?? backend;
  if (backend === "api") return accountStatus((config.providers ?? [defaultProvider(env)])[0], { env, run, platform, ...apiOptions });
  const exe = resolveTool(name, { env, config, platform });
  if (!exe) return { found: false, signedIn: null, detail: `${name} not found` };
  // A GUI executable's --version may open a window. Inspect web backends only
  // through resolved paths and saved state, in both plan and apply.
  if (backend === "chatgpt") return { found: true, signedIn: readState(chatgptHome(env)).signedIn ?? false, detail: exe };
  if (backend === "advisor") {
    const cfg = readJson(path.join(config.advisorHome, "config.json"));
    return { found: true, signedIn: Array.isArray(cfg.accounts) && cfg.accounts.length > 0 ? null : false, detail: `${exe}; configured accounts only; browser sign-in is not opened or verified` };
  }
  let version = "";
  try { const result = await run(exe, ["--version"], { env, timeout: 30_000 }); if (!result.code) version = `${result.stdout || result.stderr}`.trim().split(/\r?\n/)[0].slice(0, 120); } catch {}
  if (backend === "sound") return { found: soundTools(config, { platform }).sao, signedIn: null, detail: version || "local tools" };
  return { ...await signInStatus(name, { env, run, readAuth }), version };
}
const fixes = {
  codex: "Install Codex from https://developers.openai.com/codex/cli/ ; then codex login",
  image: "Install Codex from https://developers.openai.com/codex/cli/ ; then codex login",
  agy: "Install the Antigravity CLI yourself; then run agy",
  grok: "Install Grok Build from https://docs.x.ai/build/overview ; then grok login",
  deepseek: "Install DeepSeek Harness yourself; open DeepSeek Harness and sign in",
};
export async function install(opts, {
  env = process.env, root = ROOT, platform = process.platform, run = capture,
  inspect = inspectBackend, apiOptions = {}, readAuth,
  readDocument = readText,
} = {}) {
  const home = toolkitHome(env), user = userHome(env);
  const apply = opts.mode === "apply", remove = opts.mode === "remove";
  const initialPaths = dataPaths({ env });
  const migrationNeeded = fs.existsSync(initialPaths.legacy) && (!fs.existsSync(initialPaths.shared) || fs.readdirSync(initialPaths.shared).length === 0);
  if (apply || remove) migrateData({ env });
  const overrides = Object.fromEntries([...opts.on.map(name => [name, true]), ...opts.off.map(name => [name, false])]);
  const profile = readProfile({ env, name: opts.profile, overrides });
  const paths = dataPaths({ env });
  const savedHosts = readJson(path.join(paths.shared, "hosts.json"), readJson(path.join(paths.legacy, "hosts.json")));
  const hosts = [...new Set(opts.hosts.length ? opts.hosts : remove ? [...profile.hosts, ...Object.keys(savedHosts)] : profile.hosts)];
  const data = dataPaths({ env }).shared, steps = [], actions = [];
  const add = (step, action) => { steps.push(step); if (action && step.status === "auto") actions.push({ step, action }); };
  if (migrationNeeded) add({ id: "data:migration", status: apply || remove ? "done" : "auto", detail: `Copy ${initialPaths.legacy} to ${initialPaths.shared}; keep the original`, ...(apply || remove ? { changed: true } : {}) });
  const receiptFile = path.join(data, "hosts.json"), receipts = { ...savedHosts };
  const mcp = { command: "node", args: [path.join(root, "mcp", "fleet-mcp.mjs")] };
  const snippet = JSON.stringify({ mcpServers: { fleet: mcp } }, null, 2), block = agentsBlock(profile, root);
  const invoke = async (exe, args) => {
    try { return await run(exe, args, { env, timeout: 30_000 }); } catch { return { code: 1, stdout: "", stderr: "command failed" }; }
  };
  if (!remove) {
    const config = loadConfig(env), nextConfig = { ...config, ...soundDefaults(config) };
    if (!nextConfig.providers?.length) nextConfig.providers = [defaultProvider(env)];
    if (!nextConfig.chatgptWeb) nextConfig.chatgptWeb = { ...CHATGPT_DEFAULTS };
    const original = readConfig(env);
    add({ id: "config", status: JSON.stringify(original) === JSON.stringify(nextConfig) ? "done" : "auto", detail: "Fill missing runtime defaults; preserve configured paths and providers" }, () => saveConfig(nextConfig, env));
    const active = { name: profile.name };
    // Retain existing machine overrides as well as this invocation's changes.
    const oldProfile = readJson(path.join(data, "profile.json"), readJson(path.join(paths.legacy, "profile.json")));
    active.backends = { ...(oldProfile.name === profile.name ? oldProfile.backends : {}), ...overrides };
    add({ id: "profile", status: JSON.stringify(oldProfile) === JSON.stringify(active) ? "done" : "auto", detail: `Use profile ${profile.name}` }, () => writeJson(path.join(data, "profile.json"), active));
    for (const backend of BACKEND_NAMES.filter(name => profile.backends[name])) {
      let status;
      try { status = await inspect(backend, { env, config: nextConfig, run, root, platform, apiOptions, readAuth }); }
      catch { status = { found: false, signedIn: null, detail: "Status unavailable; inspect the backend configuration" }; }
      const missing = !status.found || status.signedIn === false;
      const command = fixes[backend] ?? (backend === "chatgpt" ? `node ${quote(path.join(root, "core/lib/webchat/chatgpt.mjs"))} login` : backend === "advisor" ? `node ${quote(path.join(root, "backends/advisor/advisor.mjs"))} login` : backend === "api" ? `node ${quote(path.join(root, "install.mjs"))} --set-key openrouter` : `node ${quote(path.join(root, "install.mjs"))} --with sound`);
      const login = { codex: "codex login", image: "codex login", agy: "agy", grok: "grok login" }[backend];
      const actionable = status.found && login ? login : backend === "grok" ? `${platform === "win32" ? "irm https://x.ai/cli/install.ps1 | iex" : "curl -fsSL https://x.ai/cli/install.sh | bash"}\ngrok login` : command;
      add({ id: `backend:${backend}`, backend, status: missing ? "needs-you" : "done", detail: `${status.detail || "available"}${status.version ? `; ${status.version}` : ""}${missing ? `; or use --off ${backend}` : ""}`, ...(missing ? { command: actionable } : {}) });
    }
    if (opts.with === "sound") add({ id: "sound:download", backend: "sound", status: "needs-you", detail: "Multi-GB venv/model installation; run manually after reviewing GPU, disk and licenses", command: soundRecipe(root, home, { platform }) });
    if (!hosts.includes("claude")) {
      const tools = Object.fromEntries(["node", "codex"].map(name => [name, resolveTool(name, { env, config: nextConfig, platform }) ?? (name === "node" ? process.execPath : null)]));
      const versions = {};
      for (const name of ["node", "codex"]) if (tools[name]) {
        const result = await invoke(tools[name], ["--version"]);
        if (!result.code) versions[name] = (result.stdout || result.stderr).trim().split(/\r?\n/)[0].slice(0, 120);
      }
      const rows = [];
      await refreshFleetConfig({ env, user, tools, versions, planOnly: true, report: (...row) => rows.push(row) });
      add({ id: "fleet-config", status: rows[0]?.[1] === "ok" ? "done" : "auto", detail: rows[0]?.[2] ?? "Refresh fleet runtime configuration" }, () => refreshFleetConfig({ env, user, tools, versions, report: (_tool, status) => {
        if (status === "ok") steps.find(step => step.id === "fleet-config").changed = false;
      } }));
    }
  }
  for (const host of hosts) {
    if (host === "claude") {
      if (remove) {
        const exe = resolveTool("claude", { env, platform });
        const inventory = exe ? await invoke(exe, ["plugin", "list", "--json"]) : null;
        const installed = inventory?.code === 0 && /fleet@agent-toolkit/.test(inventory.stdout);
        add({ id: "host:claude", host, status: inventory?.code === 0 ? installed ? "auto" : "done" : "needs-you", detail: "Remove fleet@agent-toolkit; keep marketplace and data", command: "claude plugin uninstall fleet@agent-toolkit" }, async () => {
          const result = await invoke(exe, ["plugin", "uninstall", "fleet@agent-toolkit"]); if (result.code) throw new Error("Claude plugin removal failed");
          delete receipts.claude;
        });
      } else {
        // Existing setup implementation is the authority for install/update/enable
        // and successful-fleet-before-legacy-removal ordering.
        const rows = [], tools = { node: resolveTool("node", { env, platform }) ?? process.execPath, codex: resolveTool("codex", { env, platform }), claude: resolveTool("claude", { env, platform }) };
        await setupClaude({ env, repo: root, pluginRoot: root, user, tools, planOnly: !apply, invoke, report: (tool, status, detail) => rows.push({ tool, status, detail }) });
        for (const [index, row] of rows.entries()) add({ id: `claude:${index}`, host, status: row.status === "ok" ? "done" : row.status === "installed" ? "done" : row.status === "skipped" && tools.claude ? "auto" : "needs-you", detail: row.detail, ...(row.status === "installed" && apply ? { changed: true } : {}) });
        if (apply && rows.some(row => row.tool === "fleet plugin" && row.status === "ok")) receipts.claude = { root };
      }
      continue;
    }
    if (["cursor", "generic"].includes(host)) {
      const file = path.join(user, ".cursor", "mcp.json");
      if (host === "cursor" && fs.existsSync(file)) {
        const config = readJson(file), servers = { ...config.mcpServers };
        const owned = JSON.stringify(servers.fleet) === JSON.stringify(mcp);
        if (remove) {
          if (servers.fleet && !owned) { add({ id: "host:cursor", host, status: "needs-you", detail: "Existing fleet MCP entry differs; remove it manually after checking ownership", command: `Edit ${file}: remove mcpServers.fleet` }); continue; }
          if (owned) delete servers.fleet;
        }
        else if (servers.fleet && !owned) { add({ id: "host:cursor", host, status: "needs-you", detail: "Existing fleet MCP entry differs; preserve it and merge manually", command: snippet }); continue; }
        else servers.fleet = mcp;
        add({ id: "host:cursor", host, status: JSON.stringify(servers) === JSON.stringify(config.mcpServers ?? {}) ? "done" : "auto", detail: file }, () => writeJson(file, { ...config, mcpServers: servers }));
        if (apply) receipts.cursor = { root };
        if (remove && owned) delete receipts.cursor;
        if (!remove) add({ id: "rules:cursor", host, status: "needs-you", detail: "Paste the managed fleet instructions into your Cursor rules", command: block });
      } else if (!remove) add({ id: `host:${host}`, host, status: "needs-you", detail: "Paste this MCP configuration and managed instructions into your harness", command: snippet + "\n\n" + block });
      if (remove && (host === "generic" || !fs.existsSync(file))) add({ id: `host:${host}`, host, status: "needs-you", detail: "Remove the manually pasted fleet MCP registration and managed instructions", command: "Delete mcpServers.fleet from your harness MCP settings; delete the block from <!-- fleet:start --> through <!-- fleet:end --> in its rules." });
      continue;
    }
    const exe = resolveTool(host, { env, platform });
    const args = remove ? ["mcp", "remove", "fleet", ...(host === "grok" ? ["--scope", "user"] : [])]
      : ["mcp", "add", "fleet", ...(host === "grok" ? ["--scope", "user"] : []), ...(host === "agy" ? [] : ["--"]), "node", ...mcp.args];
    const inventory = await inspectRegistration(host, exe, invoke);
    const entryPresent = Boolean(inventory.entry);
    const registered = registrationMatches(inventory.entry, mcp, platform);
    let registrationReady = registered;
    if (apply && registered) receipts[host] = { root };
    const previousScript = receipts[host]?.root && path.join(receipts[host].root, "mcp", "fleet-mcp.mjs");
    const owned = registered || registrationUses(inventory.entry, mcp.args[0], platform) || registrationUses(inventory.entry, previousScript, platform);
    const known = inventory.known;
    const bestEffort = host === "agy" && Boolean(exe) && !remove && !known;
    const status = !known ? bestEffort ? "auto" : "needs-you" : remove ? entryPresent ? owned ? "auto" : "needs-you" : "done" : registered ? "done" : entryPresent && !owned ? "needs-you" : "auto";
    add({ id: `host:${host}`, host, status, detail: `${remove ? "Remove" : registered ? "Already registered:" : "Register"} fleet MCP${bestEffort ? "; unrecognized agy inventory; re-add best-effort" : !known ? "; inventory unavailable; inspect manually" : entryPresent && !owned ? "; existing fleet entry not owned by this installation" : ""}`, command: `${host} ${args.map(quote).join(" ")}` }, async () => {
      if (!remove && entryPresent) {
        const prior = await invoke(exe, ["mcp", "remove", "fleet", ...(host === "grok" ? ["--scope", "user"] : [])]);
        if (prior.code) throw new Error(`${host} old MCP registration could not be removed`);
      }
      const result = await invoke(exe, args); if (result.code) throw new Error(`${host} MCP registration failed`);
      if (remove) delete receipts[host];
      else {
        const confirmation = await inspectRegistration(host, exe, invoke);
        registrationReady = registrationMatches(confirmation.entry, mcp, platform);
        if (!registrationReady && !(host === "agy" && !confirmation.known)) throw new Error(`${host} fleet MCP could not be confirmed after registration`);
        if (!registrationReady) return { unconfirmed: true };
        receipts[host] = { root };
      }
    });
    if (host === "codex" && !remove) {
      const pluginResult = exe ? await invoke(exe, ["plugin", "list"]) : null;
      const marketResult = exe ? await invoke(exe, ["plugin", "marketplace", "list"]) : null;
      const plugins = pluginResult?.code === 0 ? parseNamedInventory(pluginResult.stdout, "plugins") : null;
      const markets = marketResult?.code === 0 ? parseNamedInventory(marketResult.stdout, "marketplaces") : null;
      if (!plugins || !markets) {
        add({ id: "codex:legacy", host, status: "needs-you", detail: "Legacy plugin inventory unavailable; MCP registration is independent. Inspect codex plugin list and codex plugin marketplace list manually." });
      } else {
        const old = "codex-fleet@wenbinio";
        let pluginRemoved = !plugins.includes(old);
        const canRegister = registrationReady || status === "auto";
        const cleanupStatus = present => !present ? "done" : canRegister ? "auto" : "needs-you";
        add({ id: "codex:legacy-plugin", host, status: cleanupStatus(!pluginRemoved), detail: "Remove only codex-fleet@wenbinio after fleet MCP is confirmed", command: `codex plugin remove ${old}` }, async () => {
          if (!registrationReady) throw new Error("fleet MCP is not confirmed; legacy plugin preserved");
          const result = await invoke(exe, ["plugin", "remove", old]);
          if (result.code) throw new Error("legacy plugin removal failed; marketplace preserved");
          pluginRemoved = true;
        });
        const dependents = plugins.filter(name => name !== old && name.endsWith("@wenbinio"));
        add({ id: "codex:legacy-marketplace", host, status: markets.includes("wenbinio") && dependents.length ? "needs-you" : cleanupStatus(markets.includes("wenbinio")),
          detail: dependents.length ? "Preserve wenbinio: other installed plugins still use it" : "Remove only wenbinio after fleet MCP is confirmed and its legacy plugin is removed",
          command: "codex plugin marketplace remove wenbinio" }, async () => {
          if (!registrationReady || !pluginRemoved) throw new Error("fleet MCP or legacy plugin removal is not confirmed; marketplace preserved");
          const result = await invoke(exe, ["plugin", "marketplace", "remove", "wenbinio"]);
          if (result.code) throw new Error("legacy marketplace removal failed");
        });
      }
    }
    const skillRoot = host === "codex" || host === "grok" ? path.join(user, `.${host}`, "skills") : null;
    const rulesSupported = host === "codex" || host === "grok" && /\bAGENTS\.md\b/.test(readDocument(path.join(user, ".grok", "docs", "user-guide", "12-project-rules.md")));
    if (skillRoot) {
      for (const name of fs.readdirSync(path.join(root, "skills")).filter(name => fs.statSync(path.join(root, "skills", name)).isDirectory())) {
        const source = path.join(root, "skills", name), destination = path.join(skillRoot, `fleet-${name}`), owned = linkMatches(destination, source);
        add({ id: `skill:${host}:${name}`, host, status: remove ? owned ? "auto" : "done" : owned ? "done" : present(destination) ? "needs-you" : "auto", detail: present(destination) && !owned ? `Local skill preserved: ${destination}` : destination }, () => {
          if (remove) { if (linkMatches(destination, source)) fs.unlinkSync(destination); }
          else { fs.mkdirSync(skillRoot, { recursive: true }); fs.symlinkSync(source, destination, platform === "win32" ? "junction" : "dir"); }
        });
      }
    }
    if (rulesSupported) {
      const file = path.join(user, `.${host}`, "AGENTS.md"), old = readText(file), next = managedBlock(old, remove ? "" : block);
      add({ id: `rules:${host}`, host, status: old === next ? "done" : "auto", detail: file }, () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, next); });
    } else if (!remove) add({ id: `rules:${host}`, host, status: "done", detail: "No documented rules location found; MCP only for rules" });
  }
  if (apply || remove) {
    // Migration must precede profile/config/receipt writes into the new data root.
    migrateData({ env });
    for (const { step, action } of actions) {
      try {
        const changed = await action();
        step.status = changed?.unconfirmed ? "auto" : "done";
        if (changed?.unconfirmed) step.detail += "; add succeeded but inventory remains unconfirmed";
        if (step.changed !== false) step.changed = changed !== false;
      }
      catch (error) { step.status = "needs-you"; step.detail += `; ${error.message}`; }
    }
    writeJson(receiptFile, receipts);
    if (remove && opts.purge) {
      const target = fs.realpathSync(data), expected = path.resolve(home, "fleet");
      if (target !== expected || target === path.parse(target).root) throw new Error("Refusing purge outside the fleet data directory");
      fs.rmSync(target, { recursive: true, force: true });
      add({ id: "purge", status: "done", detail: "Removed shared fleet data; legacy copies and credentials retained", changed: true });
    }
  }
  return { profile: profile.name, hosts, steps, needsYou: steps.filter(step => step.status === "needs-you") };
}

// Windows owns the secure prompt and DPAPI conversion; the key never enters
// argv, environment, Node buffers, stdout or an installer receipt.
export async function hiddenKeyPrompt(file, { env = process.env, spawnProcess = spawn } = {}) {
  const script = "$ErrorActionPreference='Stop'; try { $s=Read-Host 'OpenRouter inference key' -AsSecureString; if ($s.Length -eq 0) { exit 1 }; $encrypted=ConvertFrom-SecureString $s; [IO.File]::WriteAllText($env:FLEET_KEY_TARGET,$encrypted) } catch { [Console]::Error.WriteLine('Key could not be stored'); exit 1 }";
  const child = spawnProcess("powershell.exe", ["-NoProfile", "-Command", script], { env: workerEnv({ ...env, FLEET_KEY_TARGET: file }), windowsHide: false, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw new Error("Key could not be stored");
}
export async function setKey({ env = process.env, platform = process.platform, prompt = hiddenKeyPrompt } = {}) {
  if (platform !== "win32") return { status: "needs-you", detail: "Set OPENROUTER_API_KEY privately in your shell or secret manager; do not paste it into chat", command: "Set environment variable OPENROUTER_API_KEY" };
  const service = loadConfig(env).providers?.find(provider => provider.name === "openrouter") ?? defaultProvider(env);
  const file = service.keyFile ?? defaultProvider(env).keyFile;
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("OpenRouter keyFile must be an absolute path");
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { await prompt(temp, { env }); if (!fs.existsSync(temp)) throw new Error(); fs.renameSync(temp, file); }
  catch { throw new Error("Key could not be stored"); }
  finally { fs.rmSync(temp, { force: true }); }
  return { status: "done", detail: "OpenRouter key stored with Windows DPAPI" };
}
export async function cli(argv = process.argv.slice(2), options = {}) {
  const opts = parseArgs(argv), print = options.print ?? console.log;
  let result;
  if (opts["set-key"]) {
    const step = { id: "key:openrouter", backend: "api", ...await setKey(options) };
    result = { profile: readProfile({ env: options.env }).name, hosts: [], steps: [step], needsYou: step.status === "needs-you" ? [step] : [] };
  } else result = await install(opts, options);
  if (opts.json) print(JSON.stringify(result));
  else if (result.steps) for (const step of result.steps) print(`${step.status} ${step.id}: ${step.detail}${step.command ? `\n${step.command}` : ""}`);
  else print(`${result.status}: ${result.detail}`);
  return 0;
}
if (isMain(import.meta.url)) {
  try { process.exitCode = await cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
