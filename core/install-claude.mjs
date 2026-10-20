import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, resolveDataDir } from '../runner/lib/data-dir.mjs';
const exists = file => fs.existsSync(file);
function parseList(text) { try { const data = JSON.parse(text); return Array.isArray(data) ? data : data.plugins ?? data.marketplaces ?? data; } catch { return text; } }
function hasEntry(list, name) {
  if (typeof list === 'string') return new RegExp(`(^|[^\\w@.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w@.-])`).test(list);
  if (Array.isArray(list)) return list.some(item => item === name || item.name === name || item.id === name || item.fullName === name);
  return Object.hasOwn(list, name);
}
function enabledEntry(list, name) {
  if (typeof list === 'string') return hasEntry(list, name) && !new RegExp(`${name}[^\n]*(disabled|false)`, 'i').test(list);
  const entry = Array.isArray(list) ? list.find(item => item.id === name || item.name === name || item.fullName === name) : list[name];
  return Boolean(entry) && entry.enabled !== false;
}
export async function setupClaude({ env, repo, pluginRoot = repo, user, tools, versions = {}, dryRun = false, planOnly = false, invoke, report }) {
  const claudeCommand = async args => {
    if (planOnly) { report('claude plugin', 'skipped', 'would run: claude ' + args.map(a => JSON.stringify(a)).join(' ')); return true; }
    const result = await invoke(tools.claude, args);
    const success = result.code === 0 || (args[0] === 'plugin' && args[1] === 'enable' && /already enabled/i.test(`${result.stdout}\n${result.stderr}`));
    report('claude plugin', success ? 'installed' : 'warn', `claude ${args.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}${result.code ? `: ${result.stderr || result.stdout}` : ''}`);
    return success;
  };
  const marketplace = path.join(repo, '.claude-plugin', 'marketplace.json');
  if (!tools.claude || dryRun) {
    report('marketplace', 'skipped', `run: claude plugin marketplace add ${JSON.stringify(repo)}; claude plugin install fleet@agent-toolkit --scope user`, true);
  } else {
    const [markets, plugins] = await Promise.all([
      invoke(tools.claude, ['plugin', 'marketplace', 'list']),
      invoke(tools.claude, ['plugin', 'list', '--json']),
    ]);
    if (markets.code || plugins.code) report('marketplace', 'warn', `could not inspect installed plugins; no migration attempted: ${markets.stderr} ${plugins.stderr}`);
    else {
      const marketList = parseList(markets.stdout), pluginList = parseList(plugins.stdout);
      let ready = hasEntry(marketList, 'agent-toolkit');
      if (!ready && exists(marketplace)) ready = await claudeCommand(['plugin', 'marketplace', 'add', repo]);
      else if (!ready) report('marketplace', 'missing', `waiting for ${marketplace}`);
      if (ready) {
        const name = 'fleet@agent-toolkit';
        const existed = hasEntry(pluginList, name);
        let installed = existed, updated = false;
        if (!installed) installed = await claudeCommand(['plugin', 'install', name, '--scope', 'user']);
        else {
          const entry = Array.isArray(pluginList) ? pluginList.find(p => p.id === name || p.name === name || p.fullName === name) : pluginList[name];
          const desired = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).version;
          if (entry?.version !== desired) {
            installed = await claudeCommand(['plugin', 'marketplace', 'update', 'agent-toolkit']) && await claudeCommand(['plugin', 'update', name, '--scope', 'user']);
            updated = installed;
            if (installed) report('fleet plugin', 'installed', 'updated; restart Claude Code to load the new version');
          }
        }
        // Install/update already handled activation; only use the original disabled
        // state when this run left the existing installation in place.
        if (installed && existed && !updated && !enabledEntry(pluginList, name)) installed = await claudeCommand(['plugin', 'enable', name, '--scope', 'user']);
        if (installed) {
          report('fleet plugin', 'ok', 'installed and enabled');
          const removed = new Set();
          for (const old of ['codex-fleet@wenbinio', 'gemini-fleet@agent-toolkit', 'gemini-fleet@wenbinio-gemini']) {
            if (hasEntry(pluginList, old) && await claudeCommand(['plugin', 'uninstall', old])) removed.add(old);
          }
          // Unknown/text-only inventories cannot prove a marketplace is empty.
          const remaining = Array.isArray(pluginList) ? pluginList.map(p => typeof p === 'string' ? p : p.id ?? p.fullName ?? p.name).filter(n => !removed.has(n)) : typeof pluginList === 'object' ? Object.keys(pluginList).filter(n => !removed.has(n)) : null;
          for (const oldMarket of ['wenbinio', 'wenbinio-gemini']) {
            if (hasEntry(marketList, oldMarket) && remaining && remaining.every(n => typeof n === 'string' && !n.endsWith('@' + oldMarket))) await claudeCommand(['plugin', 'marketplace', 'remove', oldMarket]);
          }
        }
      }
    }
  }
  await refreshFleetConfig({ env, user, tools, versions, dryRun, planOnly, report });
}
export async function refreshFleetConfig({ env, user, tools, versions = {}, dryRun = false, planOnly = false, report }) {
  const data = (dryRun || planOnly) ? dataPaths({ env }).shared : await resolveDataDir({ env });
  const fleetConfigFile = path.join(data, 'config.json');
  if (dryRun) report('fleet data', 'skipped', `would create or refresh ${fleetConfigFile}; legacy data retained`);
  else {
    const legacyFile = path.join(dataPaths({ env }).legacy, 'config.json');
    const sourceFile = exists(fleetConfigFile) ? fleetConfigFile : exists(legacyFile) ? legacyFile : null;
    const current = sourceFile ? JSON.parse(fs.readFileSync(sourceFile, 'utf8').replace(/^\uFEFF/, '')) : null;
    let fleetConfig = current;
    if (!fleetConfig) {
      const parent = path.join(user, '.claude', 'plugins', 'data');
      const legacy = exists(parent) ? fs.readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.includes('codex-fleet')).flatMap(entry => {
        const file = path.join(parent, entry.name, 'config.json');
        try { const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); return [{ value, at: Date.parse(value.verifiedAt) || fs.statSync(file).mtimeMs, name: entry.name }]; } catch { return []; }
      }).sort((a, b) => b.at - a.at || a.name.localeCompare(b.name)) : [];
      const old = legacy[0]?.value ?? {};
      fleetConfig = { backend: 'exec', ...Object.fromEntries(['backend', 'isolation', 'windowsSandbox', 'authMode', 'platform'].filter(key => old[key] !== undefined).map(key => [key, old[key]])), model: 'gpt-6-astra', effort: 'high' };
    }
    const refreshed = { ...fleetConfig, nodeExe: tools.node, nodeVersion: versions.node ?? current?.nodeVersion ?? null, codexExe: tools.codex, codexVersion: versions.codex ?? current?.codexVersion ?? null };
    if (current && sourceFile === fleetConfigFile && JSON.stringify(current) === JSON.stringify(refreshed)) report('fleet data', 'ok', 'unchanged');
    else if (planOnly) report('fleet data', 'skipped', `would create or refresh ${fleetConfigFile}; legacy data retained`);
    else {
      fs.mkdirSync(data, { recursive: true });
      const temporary = `${fleetConfigFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(refreshed, null, 2) + '\n'); fs.renameSync(temporary, fleetConfigFile);
      report('fleet data', 'installed', current ? 'refreshed executable paths and versions' : 'created fleet config; legacy data retained');
    }
  }
}
