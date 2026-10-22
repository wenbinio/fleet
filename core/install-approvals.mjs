import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUTO_APPROVE_POLICIES } from "../runner/lib/profile.mjs";

function tomlPath(text) {
  const parts = [], token = /\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*/y;
  let offset = 0;
  while (offset < text.length) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) return null;
    const value = match[1];
    try { parts.push(value[0] === '"' ? JSON.parse(value) : value[0] === "'" ? value.slice(1, -1) : value); } catch { return null; }
    offset = token.lastIndex;
    if (offset === text.length) return parts;
    if (text[offset++] !== ".") return null;
  }
  return null;
}
// Locate headers without treating table-looking text inside TOML strings as a
// section. We splice original text rather than parsing/reformatting the config.
function tables(text) {
  const result = [];
  let mode = null, offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (!mode) {
      const header = /^\s*(\[\[?)(.*?)\]\]?\s*(?:#.*)?$/.exec(line);
      if (header) result.push({ start: offset, parts: tomlPath(header[2]), array: header[1] === "[[" });
    }
    for (let i = 0; i < line.length; i++) {
      if (mode === '"""' || mode === "'''") {
        if (mode === '"""' && line[i] === "\\") { i++; continue; }
        if (line.slice(i, i + 3) === mode) { i += 2; mode = null; }
      } else if (mode) {
        if (mode === '"' && line[i] === "\\") { i++; continue; }
        if (line[i] === mode) mode = null;
      } else {
        if (line[i] === "#") break;
        if (line[i] === '"' || line[i] === "'") {
          mode = line.slice(i, i + 3) === line[i].repeat(3) ? line[i].repeat(3) : line[i];
          if (mode.length === 3) i += 2;
        }
      }
    }
    if (mode === '"' || mode === "'") throw new Error("Unterminated TOML string; approval config preserved");
    offset += line.length;
  }
  if (mode) throw new Error("Unterminated TOML multiline string; approval config preserved");
  return result.map((table, index) => ({ ...table, end: result[index + 1]?.start ?? text.length }));
}
export function editCodexApprovals(text, names, enable) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  text = text.slice(bom.length);
  const sections = tables(text);
  const targets = sections.filter(section => !section.array && section.parts?.length === 4 &&
    section.parts.slice(0, 3).join(".") === "mcp_servers.fleet.tools" && names.includes(section.parts[3]));
  if (!enable) {
    for (const section of [...targets].reverse()) {
      // Keep separators and trailing comments adjacent to the next table.
      const body = text.slice(section.start, section.end);
      const trailing = /(?:\r?\n[ \t]*(?:#[^\r\n]*)?)*$/.exec(body)[0];
      text = text.slice(0, section.start) + trailing + text.slice(section.end);
    }
    return bom + text;
  }
  const missing = names.filter(name => !targets.some(section => section.parts[3] === name));
  if (!missing.length) return bom + text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const prefix = text && !text.endsWith("\n") ? newline : "";
  return bom + text + prefix + missing.map(name => `${newline}[mcp_servers.fleet.tools.${name}]${newline}approval_mode = "approve"${newline}`).join("");
}
export function editAgyApprovals(text, names, enable) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const config = text.trim() ? JSON.parse(text.slice(bom.length)) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("agy settings must be a JSON object");
  const permissions = config.permissions ?? {};
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("agy permissions must be an object");
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow)) throw new Error("agy permissions.allow must be an array");
  const rules = names.map(name => `mcp(fleet/${name})`);
  const next = enable ? [...allow, ...rules.filter(rule => !allow.includes(rule))] : allow.filter(rule => !rules.includes(rule));
  if (JSON.stringify(allow) === JSON.stringify(next)) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return bom + JSON.stringify({ ...config, permissions: { ...permissions, allow: next } }, null, 2).replaceAll("\n", newline) + newline;
}
export const readOnlyNames = tools => tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name);
export const codexConfigFile = user => path.join(user, ".codex", "config.toml");
// Re-read before applying so an intervening harness edit is preserved; the
// first write keeps a one-time backup and every write is temp-then-rename.
export function rewriteConfig(file, edit) {
  const exists = fs.existsSync(file), current = exists ? fs.readFileSync(file) : Buffer.alloc(0);
  const updated = Buffer.from(edit(current.toString("utf8")));
  if (current.equals(updated)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.fleet-backup`;
  try { fs.writeFileSync(backup, current, { flag: "wx", mode: exists ? fs.statSync(file).mode : 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, updated, { flag: "wx", mode: exists ? fs.statSync(file).mode : 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return true;
}
export function approvalPlan({ host, user, policy, remove, tools }) {
  if (!AUTO_APPROVE_POLICIES.includes(policy)) throw new Error("autoApprove must be none or read-only");
  if (!["codex", "agy"].includes(host)) return { status: "done", detail: host === "claude" ? "Claude keeps interactive approvals; no approval settings are written" : host === "grok" ? "Grok has no documented per-tool approval rule; no approval settings are written" : `${host}: no approval settings are written` };
  const names = readOnlyNames(tools);
  const file = host === "codex" ? codexConfigFile(user) : path.join(user, ".gemini", "antigravity-cli", "settings.json");
  const enable = !remove && policy === "read-only";
  const edit = host === "codex" ? editCodexApprovals : editAgyApprovals;
  const original = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  const next = Buffer.from(edit(original.toString("utf8"), names, enable));
  return {
    status: original.equals(next) ? "done" : "auto",
    detail: `${enable ? "Approve" : "Remove approval for"} fleet read-only tools in ${file}; other permissions remain unchanged`,
    apply: () => rewriteConfig(file, text => edit(text, names, enable)),
  };
}
