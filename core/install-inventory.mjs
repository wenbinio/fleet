import path from "node:path";

const clean = text => String(text ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
const unquote = value => String(value ?? "").trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
export function comparablePath(value, platform = process.platform) {
  const text = unquote(value);
  return platform === "win32" || /^[a-z]:[\\/]|^\\\\/i.test(text)
    ? path.win32.normalize(text.replaceAll("/", "\\")).toLowerCase()
    : path.posix.normalize(text);
}
function argumentsOf(value) {
  if (Array.isArray(value)) return value.every(item => typeof item === "string") ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "-") return [];
  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return argumentsOf(parsed); } catch {}
  // A table or Args: field can contain an unquoted absolute path with spaces.
  if (/^(?:[a-z]:[\\/]|\/)/i.test(text) && /\.mjs$/i.test(text)) return [text];
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map(unquote);
}
function commandLine(text) {
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { command: match[1] ?? match[2] ?? match[3], args: argumentsOf(match[4] ?? "") } : {};
}
function entryOf(value) {
  if (!value || typeof value !== "object") return {};
  const transport = value.transport && typeof value.transport === "object" ? value.transport : value;
  return { command: transport.command, args: argumentsOf(transport.args), enabled: value.enabled !== false && transport.enabled !== false };
}
function jsonEntries(value, kind) {
  if (Array.isArray(value)) return value.map(item => [typeof item === "string" ? item : item?.name ?? item?.id ?? item?.fullName, item]);
  if (!value || typeof value !== "object") return null;
  for (const key of kind === "mcp" ? ["servers", "mcpServers", "mcp_servers", "data"] : [kind, "data"]) {
    if (value[key] && typeof value[key] === "object") return jsonEntries(value[key], kind);
  }
  if (value.name || value.id || value.fullName) return [[value.name ?? value.id ?? value.fullName, value]];
  return Object.entries(value);
}
export function parseMcpInventory(output, { single = false } = {}) {
  const text = clean(output);
  try {
    const value = JSON.parse(text);
    if (single && value && typeof value === "object" && !Array.isArray(value) && (value.transport || value.command)) {
      if (value.name && value.name !== "fleet") return { known: false };
      return { known: true, entry: entryOf(value) };
    }
    const entries = jsonEntries(value, "mcp");
    if (!entries || entries.some(([name, item]) => !name || !item || typeof item !== "object" ||
      !["command", "transport", "url"].some(key => key in item))) return { known: false };
    const entry = entries.find(([name]) => name === "fleet");
    return { known: true, ...(entry ? { entry: entryOf(entry[1]) } : {}) };
  } catch {}
  const lines = text.split(/\r?\n/).map(line => line.replace(/^\s*[❯✓✔✗✘●•]\s*/, ""));
  const index = lines.findIndex(line => /^\s*fleet(?:\s*:|\s|$)/.test(line));
  if (index < 0) return { known: !text || /no (?:configured )?mcp servers|configured mcp servers|^\s*name\s+(?:type|command|transport)/im.test(text) };
  const line = lines[index].trim(), fields = {}, indentation = lines[index].length - lines[index].trimStart().length;
  // Named block output, e.g. fleet:\n  Command: node\n  Args: /path/server.mjs.
  for (let i = index + 1; i < lines.length; i++) {
    const match = /^\s+(command|args|enabled)\s*:\s*(.*)$/i.exec(lines[i]);
    if (match) fields[match[1].toLowerCase()] = match[2];
    else if (lines[i].trim() && lines[i].length - lines[i].trimStart().length <= indentation) break;
  }
  if (fields.command) return { known: true, entry: { command: unquote(fields.command), args: argumentsOf(fields.args), enabled: fields.enabled !== "false" } };
  const header = lines.slice(0, index).reverse().find(row => /^\s*name\s+/i.test(row));
  if (header) {
    const columns = header.trim().split(/\s{2,}|\t+/).map(value => value.toLowerCase());
    const values = line.split(/\s{2,}|\t+/), command = columns.findIndex(name => name === "command" || name === "command/url"), args = columns.indexOf("args");
    if (command >= 0 && values[command]) {
      return { known: true, entry: { ...(args >= 0 ? { command: unquote(values[command]), args: argumentsOf(values[args]) } : commandLine(values[command])), enabled: !values.some(value => value.toLowerCase() === "disabled") } };
    }
  }
  const body = line.replace(/^fleet\s*(?:\((?:enabled|disabled)\))?\s*:?\s*/i, "").replace(/\s+\((?:stdio|enabled|disabled)\)(?:\s*[-–]\s*.*)?$/i, "").replace(/\s+[-–]\s+[✓✔✗✘●•]?\s*(?:connected|disconnected|disabled|enabled|ready)\b.*$/i, "");
  const parsed = commandLine(body);
  if (!parsed.command || /[[\]{}]/.test(parsed.command) || !parsed.args?.length) return { known: false };
  return { known: true, entry: { ...parsed, enabled: !/\bdisabled\b/i.test(line) } };
}
export function registrationMatches(entry, expected, platform) {
  if (!entry || entry.enabled === false || !Array.isArray(entry.args)) return false;
  const node = command => /^(?:node|node\.exe)$/i.test(path.win32.basename(unquote(command)));
  const sameCommand = node(entry.command) && node(expected.command) || comparablePath(entry.command, platform) === comparablePath(expected.command, platform);
  return sameCommand && entry.args.length === expected.args.length && entry.args.every((arg, i) => comparablePath(arg, platform) === comparablePath(expected.args[i], platform));
}
export function registrationUses(entry, script, platform) {
  return Boolean(script && entry?.args?.some(arg => comparablePath(arg, platform) === comparablePath(script, platform)));
}
export async function inspectRegistration(host, exe, invoke) {
  if (!exe) return { known: false };
  if (host === "codex") {
    const result = await invoke(exe, ["mcp", "get", "fleet", "--json"]);
    if (!result.code) {
      // A supported get is authoritative; never replace its answer with list.
      return parseMcpInventory(result.stdout, { single: true });
    }
    const output = clean(`${result.stdout}\n${result.stderr}`);
    if (result.code === 1 && /^(?:Error:\s*)?No MCP server named 'fleet' found\.$/m.test(output)) return { known: true };
    // Codex refuses its whole config when fleet tables exist without a transport.
    if (/invalid transport/i.test(output) && /mcp_servers\.fleet(?![\w-])/.test(output)) return { known: false, invalidFleetTransport: true };
  }
  const result = await invoke(exe, ["mcp", "list", ...(host === "grok" ? ["--json"] : [])]);
  return result.code ? { known: false } : parseMcpInventory(result.stdout);
}
export function parseNamedInventory(output, kind) {
  const text = clean(output);
  try {
    const entries = jsonEntries(JSON.parse(text), kind);
    if (!entries || entries.some(([name]) => !name || ["error", "message", "status", "success"].includes(name))) return null;
    const names = entries.map(([name, item]) => kind === "plugins" && typeof item === "object" && item && !name?.includes("@") && (item.marketplace ?? item.marketplaceName)
      ? `${name}@${typeof item.marketplace === "object" ? item.marketplace.name : item.marketplace ?? item.marketplaceName}` : name);
    return names.every(name => typeof name === "string" && (kind !== "plugins" || /^[\w.-]+@[\w.-]+$/.test(name))) ? names : null;
  } catch {}
  const names = [];
  let columns = [], marketplacePathPending = false;
  for (const row of text.split(/\r?\n/)) {
    const line = row.trim().replace(/^[❯✓✔✗✘●•*-]\s*/, "");
    if (kind === "plugins" && /^Marketplace `[^`]+`$/.test(line)) {
      columns = []; marketplacePathPending = true; continue;
    }
    if (marketplacePathPending && line) {
      marketplacePathPending = false;
      if (line === "Remote catalog" || /^(?:[a-z]:[\\/]|\/|\\\\).*[\\/]marketplace\.json$/i.test(line)) continue;
      return null;
    }
    if (/^(?:name|plugin|marketplace)\s+/i.test(line)) { columns = line.split(/\s{2,}|\t+/).map(value => value.toLowerCase()); continue; }
    if (!line || /^plugins\s*:?\s*$/i.test(line) || /^[-─━\s]+$/.test(line) || /^(?:installed plugins|(?:configured )?marketplaces|no .*plugins|no .*marketplaces)\b/i.test(line) ||
      /^(?:version|source|path|location|scope|status|description|enabled)\s*:/i.test(line)) continue;
    if (kind === "plugins") {
      const exact = /^([\w.-]+@[\w.-]+)(?:\s|$)/.exec(line);
      if (exact) {
        // Codex lists the entire marketplace catalog, not only installations.
        if (columns.includes("status")) {
          const status = line.slice(exact[0].length).trimStart();
          if (/^not installed(?:\s|$)/i.test(status)) continue;
          if (!/^installed(?:,|\s|$)/i.test(status)) return null;
        }
        names.push(exact[1]);
      }
      else if (columns.includes("marketplace")) {
        const values = line.split(/\s{2,}|\t+/), name = values[Math.max(0, columns.indexOf("name"))], marketplace = values[columns.indexOf("marketplace")];
        if (!/^[\w.-]+$/.test(name ?? "") || !/^[\w.-]+$/.test(marketplace ?? "")) return null;
        names.push(`${name}@${marketplace}`);
      }
      else return null; // Cannot prove whether another plugin needs the marketplace.
    } else {
      const match = columns.length ? /^([\w.-]+)(?:\s|$)/.exec(line) : /^([\w.-]+)(?:\s+\([^)]*\))?$/.exec(line);
      if (!match) return null;
      names.push(match[1]);
    }
  }
  return names;
}
