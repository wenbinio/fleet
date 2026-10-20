import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { install, inspectBackend, parseArgs, managedBlock, setKey, hiddenKeyPrompt, soundRecipe, ROOT } from "../install.mjs";
import { loadConfig, saveConfig } from "../core/lib/toolkit.mjs";
import { dataPaths } from "../runner/lib/data-dir.mjs";
import { readProfile, agentsBlock } from "../runner/lib/profile.mjs";
import { toolsFor, callTool, TOOLS } from "../mcp/fleet-mcp.mjs";
import { startAsk } from "../runner/lib/jobs.mjs";
import { accounts } from "../runner/lib/accounts.mjs";
import { cli as fleetCli } from "../runner/fleet.mjs";
import { injectRuntime } from "../runner/lib/runtime.mjs";
import * as toolkit from "../core/lib/toolkit.mjs";
import { parseMcpInventory, registrationMatches, parseNamedInventory, inspectRegistration } from "../core/install-inventory.mjs";
import { approvalPlan, editCodexApprovals } from "../core/install-approvals.mjs";

function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; }
const realOutput = name => fs.readFileSync(new URL(`./fixtures/cli-real/${name}`, import.meta.url), "utf8");
function capturedResult(name, replacements = []) {
  let text = realOutput(name);
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  const footer = /\r?\nexit (\d+)\s*$/.exec(text);
  const code = footer ? Number(footer[1]) : 0, body = footer ? text.slice(0, footer.index) : text;
  return { code, stdout: code ? "" : body, stderr: code ? body : "" };
}
function snapshot(root) {
  const output = {};
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file), key = path.relative(root, file);
      if (stat.isSymbolicLink()) output[key] = ["link", fs.readlinkSync(file), stat.mtimeMs];
      else if (stat.isDirectory()) walk(file);
      else output[key] = [fs.readFileSync(file, "utf8"), stat.mtimeMs];
    }
  };
  walk(root); return output;
}
function fixture(t) {
  const scratch = fileURLToPath(new URL("../.test-tmp/", import.meta.url)); fs.mkdirSync(scratch, { recursive: true });
  const home = fs.mkdtempSync(path.join(scratch, "install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { HOME: home, USERPROFILE: home, FLEET_HOME: path.join(home, "fleet-home"), AGENT_TOOLKIT_HOME: "", PATH: "", Path: "", CHATGPT_WEB_HOME: "", ADVISOR_HOME: "" };
  const calls = [], servers = {}, plugins = new Map(), markets = new Set(), codexPlugins = new Map(), codexMarkets = new Set(), inspections = [];
  saveConfig({ tools: Object.fromEntries(["node", "codex", "claude", "grok", "agy"].map(name => [name, `fake-${name}`])) }, env);
  write(path.join(home, ".grok/docs/user-guide/12-project-rules.md"), "Home rules: $GROK_HOME. AGENTS.md is loaded.");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version;
  const run = async (exe, args) => {
    const host = exe.replace("fake-", ""); calls.push([host, ...args]);
    if (args[0] === "--version") return { code: 0, stdout: "v25.0.0", stderr: "" };
    if (args[0] === "mcp") {
      if (args[1] === "get") return servers[host]
        ? { code: 0, stdout: JSON.stringify({ name: "fleet", enabled: true, transport: { type: "stdio", ...servers[host] } }), stderr: "" }
        : { code: 1, stdout: "", stderr: "Error: No MCP server named 'fleet' found." };
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify(servers[host] ? [{ name: "fleet", ...servers[host] }] : []), stderr: "" };
      if (args[1] === "add") { servers[host] = { command: "node", args: [args.at(-1)] }; return { code: 0, stdout: "", stderr: "" }; }
      if (args[1] === "remove") { delete servers[host]; return { code: 0, stdout: "", stderr: "" }; }
    }
    const hostMarkets = host === "codex" ? codexMarkets : markets, hostPlugins = host === "codex" ? codexPlugins : plugins;
    if (args.join(" ") === "plugin marketplace list") return { code: 0, stdout: JSON.stringify([...hostMarkets].map(name => ({ name }))), stderr: "" };
    if (["plugin list --json", "plugin list"].includes(args.join(" "))) return { code: 0, stdout: JSON.stringify([...hostPlugins].map(([id, value]) => ({ id, ...value }))), stderr: "" };
    if (args[0] === "plugin") {
      if (args[1] === "marketplace" && args[2] === "add") markets.add("agent-toolkit");
      else if (args[1] === "marketplace" && args[2] === "remove") hostMarkets.delete(args[3]);
      else if (["install", "update", "enable"].includes(args[1])) plugins.set(args[2], { enabled: true, version });
      else if (args[1] === "uninstall") plugins.delete(args[2]);
      else if (host === "codex" && args[1] === "remove") codexPlugins.delete(args[2]);
      else if (!(args[1] === "marketplace" && args[2] === "update")) assert.fail(`unexpected fake plugin command ${args}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    assert.fail(`unexpected invocation ${exe}: ${args}`);
  };
  const options = { env, root: ROOT, run, inspect: async backend => { inspections.push(backend); return { found: true, signedIn: true, detail: "fixture account" }; } };
  return { home, env, calls, servers, plugins, markets, codexPlugins, codexMarkets, inspections, options, ...dataPaths({ env }) };
}
const readOnlyCall = call => call[1] === "--version" || ["mcp list", "mcp list --json", "mcp get fleet --json", "plugin list", "plugin marketplace list", "plugin list --json"].includes(call.slice(1).join(" "));
const readOnlyTools = TOOLS.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name);
test("profile approval policy uses MCP annotations and never includes mutating tools", t => {
  const f = fixture(t);
  assert.deepEqual(new Set(readOnlyTools), new Set(["fleet_runs", "fleet_run", "fleet_status", "fleet_transcript", "fleet_accounts"]));
  const lok = readProfile({ env: f.env, name: "lok" }), minimal = readProfile({ env: f.env, name: "minimal" });
  assert.equal(lok.autoApprove, "read-only"); assert.ok(lok.hosts.includes("agy")); assert.equal(minimal.autoApprove, "none");
  assert.throws(() => approvalPlan({ host: "codex", user: f.home, policy: "all", tools: TOOLS }), /none or read-only/);
  for (const host of ["grok", "claude"]) {
    const plan = approvalPlan({ host, user: f.home, policy: "read-only", tools: TOOLS });
    assert.equal(plan.status, "done"); assert.equal(plan.apply, undefined);
    assert.match(plan.detail, host === "grok" ? /no documented per-tool/ : /interactive approvals/);
  }
  // The editor consumes annotation metadata, not a second hardcoded name list.
  const synthetic = approvalPlan({ host: "agy", user: f.home, policy: "read-only", tools: [{ name: "fixture_read", annotations: { readOnlyHint: true } }, { name: "fixture_write" }] });
  synthetic.apply();
  const settings = JSON.parse(fs.readFileSync(path.join(f.home, ".gemini/antigravity-cli/settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["mcp(fleet/fixture_read)"]);
});
test("captured agy table parses and repeated apply never re-adds its registered fleet", async t => {
  const f = fixture(t);
  const original = realOutput("agy-mcp-list-fleet.txt");
  assert.equal(registrationMatches(parseMcpInventory(original).entry, {
    command: "node", args: ["d:/claude-work/agent-toolkit/plugins/fleet/mcp/fleet-mcp.mjs"],
  }, "win32"), true);
  const table = original.replace("D:\\claude-work\\agent-toolkit\\plugins\\fleet\\mcp\\fleet-mcp.mjs", path.join(ROOT, "mcp/fleet-mcp.mjs"));
  const options = { ...f.options, run: async (exe, args) => {
    if (exe === "fake-agy" && args[0] === "mcp") {
      f.calls.push(["agy", ...args]); assert.deepEqual(args, ["mcp", "list"]);
      return { code: 0, stdout: table, stderr: "" };
    }
    return f.options.run(exe, args);
  } };
  const plan = await install(parseArgs(["--plan", "--host", "agy"]), options);
  assert.equal(plan.steps.find(step => step.id === "host:agy").status, "done");
  assert.equal(plan.steps.find(step => step.id === "approvals:agy").status, "auto");
  assert.ok(!fs.existsSync(path.join(f.home, ".gemini/antigravity-cli/settings.json")));
  const opts = parseArgs(["--apply", "--host", "agy"]);
  await install(opts, options);
  const before = snapshot(f.home);
  const second = await install(opts, options);
  assert.deepEqual(snapshot(f.home), before); assert.ok(second.steps.every(step => !step.changed));
  assert.ok(f.calls.every(readOnlyCall));
});
test("agy approvals preserve BOM and other permissions, back up once, and reconcile none/remove", async t => {
  const f = fixture(t), file = path.join(f.home, ".gemini/antigravity-cli/settings.json");
  const unrelated = ["shell(read)", "mcp(other/read)", "mcp(fleet/fleet_ask)"];
  const original = "\uFEFF" + JSON.stringify({ theme: "dark", permissions: { allow: unrelated, deny: ["shell(delete)"], ask: ["mcp(fleet/fleet_steer)"] }, nested: { keep: true } }, null, 2).replaceAll("\n", "\r\n") + "\r\n";
  write(file, original);
  const options = parseArgs(["--plan", "--host", "agy"]);
  const before = snapshot(f.home), plan = await install(options, f.options);
  assert.equal(plan.steps.find(step => step.id === "approvals:agy").status, "auto");
  assert.deepEqual(snapshot(f.home), before);
  await install(parseArgs(["--apply", "--host", "agy"]), f.options);
  const text = fs.readFileSync(file, "utf8"), config = JSON.parse(text.slice(1));
  assert.ok(text.startsWith("\uFEFF")); assert.ok(!/(?<!\r)\n/.test(text));
  assert.deepEqual(config.permissions.allow, [...unrelated, ...readOnlyTools.map(name => `mcp(fleet/${name})`)]);
  assert.deepEqual(config.permissions.deny, ["shell(delete)"]); assert.deepEqual(config.permissions.ask, ["mcp(fleet/fleet_steer)"]);
  assert.deepEqual(config.nested, { keep: true }); assert.equal(config.theme, "dark");
  assert.equal(fs.readFileSync(`${file}.fleet-backup`, "utf8"), original);
  const applied = snapshot(f.home);
  await install(parseArgs(["--apply", "--host", "agy"]), f.options);
  assert.deepEqual(snapshot(f.home), applied);
  await install(parseArgs(["--apply", "--profile", "minimal", "--host", "agy"]), f.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8").slice(1)).permissions.allow, unrelated);
  await install(parseArgs(["--apply", "--profile", "lok", "--host", "agy"]), f.options);
  await install(parseArgs(["--remove", "--host", "agy"]), f.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8").slice(1)).permissions.allow, unrelated);
  assert.equal(fs.readFileSync(`${file}.fleet-backup`, "utf8"), original);
  assert.ok(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith(".tmp")));
});
test("Codex approval tables preserve quoted names, multiline text and unrelated bytes", async t => {
  const f = fixture(t), file = path.join(f.home, ".codex/config.toml");
  const prefix = '\uFEFF# keep leading comment\r\nmodel = "example"\r\nnotes = """\r\n[mcp_servers.fleet.tools.fleet_status]\r\nnot a real header\r\n"""\r\n';
  const existing = '[ mcp_servers . \'fleet\' . tools . "fleet_run" ]\r\napproval_mode = "prompt"\r\n';
  const suffix = '[apps.google_drive.tools."google_drive.search"]\r\napproval_mode = "prompt"\r\n# keep comment\r\n[mcp_servers.fleet.tools.fleet_ask]\r\napproval_mode = "prompt"\r\n';
  const original = prefix + existing + suffix; write(file, original);
  const before = snapshot(f.home);
  const plan = await install(parseArgs(["--plan", "--host", "codex"]), f.options);
  assert.equal(plan.steps.find(step => step.id === "approvals:codex").status, "auto");
  assert.deepEqual(snapshot(f.home), before);
  await install(parseArgs(["--apply", "--host", "codex"]), f.options);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith(original)); assert.ok(!/(?<!\r)\n/.test(text));
  assert.equal((text.match(/\[mcp_servers\.fleet\.tools\.fleet_status\]/g) ?? []).length, 2);
  assert.ok(!text.includes("[mcp_servers.fleet.tools.fleet_run]\r\n"), "quoted existing prompt table must not get a duplicate");
  for (const name of readOnlyTools.filter(name => name !== "fleet_run")) assert.ok(text.includes(`[mcp_servers.fleet.tools.${name}]\r\napproval_mode = "approve"`));
  for (const name of ["fleet_ask", "fleet_steer", "fleet_interrupt"]) assert.ok(!text.includes(`[mcp_servers.fleet.tools.${name}]\r\napproval_mode = "approve"`));
  const applied = snapshot(f.home);
  await install(parseArgs(["--apply", "--host", "codex"]), f.options);
  assert.deepEqual(snapshot(f.home), applied);
  await install(parseArgs(["--remove", "--host", "codex"]), f.options);
  const removed = fs.readFileSync(file, "utf8");
  assert.ok(removed.startsWith(prefix)); assert.ok(removed.includes(suffix));
  assert.ok(!removed.includes(existing)); assert.ok(!removed.includes('approval_mode = "approve"'));
  assert.equal(fs.readFileSync(`${file}.fleet-backup`, "utf8"), original);
  assert.ok(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith(".tmp")));
});
test("approval application re-reads intervening edits; malformed files are preserved", t => {
  const f = fixture(t), file = path.join(f.home, ".gemini/antigravity-cli/settings.json");
  write(file, '{"permissions":{"allow":[]},"before":true}\n');
  const plan = approvalPlan({ host: "agy", user: f.home, policy: "read-only", tools: TOOLS });
  const latest = '{"permissions":{"allow":["mcp(other/new)"]},"after":true}\n'; write(file, latest);
  plan.apply();
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.after, true); assert.equal(config.permissions.allow[0], "mcp(other/new)");
  assert.equal(fs.readFileSync(`${file}.fleet-backup`, "utf8"), latest);
  write(file, "{invalid");
  assert.throws(() => approvalPlan({ host: "agy", user: f.home, policy: "read-only", tools: TOOLS }));
  assert.equal(fs.readFileSync(file, "utf8"), "{invalid");
  assert.throws(() => editCodexApprovals('text = """unfinished', readOnlyTools, true), /Unterminated/);
});
test("captured Codex and Grok registrations use their authoritative structured commands", async () => {
  for (const [host, filename, command] of [
    ["codex", "codex-mcp-get-fleet.json", ["mcp", "get", "fleet", "--json"]],
    ["grok", "grok-mcp-list.json", ["mcp", "list", "--json"]],
  ]) {
    const captured = capturedResult(filename), calls = [];
    const found = await inspectRegistration(host, `fake-${host}`, async (exe, args) => {
      calls.push(args); assert.deepEqual(args, command); return captured;
    });
    assert.deepEqual(calls, [command]);
    assert.equal(registrationMatches(found.entry, {
      command: "node", args: ["d:/claude-work/agent-toolkit/plugins/fleet/mcp/fleet-mcp.mjs"],
    }, "win32"), true);
    assert.equal(registrationMatches(found.entry, { command: "different", args: found.entry.args }, "win32"), false);
    assert.equal(registrationMatches(found.entry, { command: "node", args: [...found.entry.args, "--different"] }, "win32"), false);
  }
  const calls = [];
  const missing = await inspectRegistration("codex", "fake-codex", async (exe, args) => {
    calls.push(args);
    assert.deepEqual(args, ["mcp", "get", "fleet", "--json"]);
    return capturedResult("codex-mcp-get-missing.txt", [["'nosuch'", "'fleet'"]]);
  });
  assert.deepEqual(missing, { known: true }); assert.equal(calls.length, 1);
  const malformed = await inspectRegistration("codex", "fake-codex", async (exe, args) => {
    assert.deepEqual(args, ["mcp", "get", "fleet", "--json"]);
    return { code: 0, stdout: "unexpected diagnostic", stderr: "" };
  });
  assert.equal(malformed.known, false);
});
test("captured Codex catalog includes only installed plugins and exact marketplace names", () => {
  const plugins = parseNamedInventory(realOutput("codex-plugin-list.txt"), "plugins");
  const markets = parseNamedInventory(realOutput("codex-plugin-marketplace-list.txt"), "marketplaces");
  assert.ok(plugins.includes("documents@openai-primary-runtime"));
  assert.ok(plugins.includes("work-pets@openai-curated-remote"));
  assert.ok(!plugins.includes("latex@openai-bundled"));
  assert.ok(!plugins.includes("codex-fleet@wenbinio"));
  assert.deepEqual(markets, ["openai-primary-runtime", "openai-bundled", "claude-plugins-official", "openai-curated", "claude-cowork"]);
  const absent = capturedResult("agy-mcp-list.txt");
  assert.equal(absent.code, 0);
  assert.deepEqual(parseMcpInventory(absent.stdout), { known: true });
});
for (const host of ["codex", "grok"]) test(`captured ${host} CLI registration stays unchanged on plan and repeated apply`, async t => {
  const f = fixture(t), script = path.join(ROOT, "mcp/fleet-mcp.mjs");
  const source = JSON.parse(realOutput(host === "codex" ? "codex-mcp-get-fleet.json" : "grok-mcp-list.json"));
  // Only relocate the captured repository path to this checkout.
  if (host === "codex") source.transport.args = [script]; else source[0].args = [script];
  const options = { ...f.options, run: async (exe, args) => {
    if (exe === `fake-${host}` && args[0] === "mcp") {
      f.calls.push([host, ...args]);
      assert.deepEqual(args, host === "codex" ? ["mcp", "get", "fleet", "--json"] : ["mcp", "list", "--json"]);
      return { code: 0, stdout: JSON.stringify(source), stderr: "" };
    }
    if (exe === "fake-codex" && args[0] === "plugin") {
      f.calls.push([host, ...args]);
      assert.ok(["plugin list", "plugin marketplace list"].includes(args.join(" ")));
      return capturedResult(args[1] === "marketplace" ? "codex-plugin-marketplace-list.txt" : "codex-plugin-list.txt");
    }
    return f.options.run(exe, args);
  } };
  const before = snapshot(f.home);
  const plan = await install(parseArgs(["--plan", "--profile", "minimal", "--host", host]), options);
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(plan.steps.find(step => step.id === `host:${host}`).status, "done");
  if (host === "codex") {
    assert.equal(plan.steps.find(step => step.id === "codex:legacy-plugin").status, "done");
    assert.equal(plan.steps.find(step => step.id === "codex:legacy-marketplace").status, "done");
    assert.ok(!plan.steps.some(step => step.id === "codex:legacy"));
  }
  const args = parseArgs(["--apply", "--profile", "minimal", "--host", host]);
  await install(args, options);
  const installed = snapshot(f.home), callCount = f.calls.length;
  const repeated = await install(args, options);
  assert.deepEqual(snapshot(f.home), installed);
  assert.ok(repeated.steps.every(step => !step.changed));
  assert.ok(f.calls.slice(callCount).every(readOnlyCall));
});
test("captured Codex missing get adds once without querying list", async t => {
  const f = fixture(t);
  const options = { ...f.options, run: async (exe, args) => {
    if (exe === "fake-codex" && args[0] === "mcp") {
      assert.notEqual(args[1], "list");
      if (args[1] === "get" && !f.servers.codex) {
        f.calls.push(["codex", ...args]);
        return capturedResult("codex-mcp-get-missing.txt", [["'nosuch'", "'fleet'"]]);
      }
    }
    return f.options.run(exe, args);
  } };
  const args = parseArgs(["--apply", "--profile", "minimal", "--host", "codex"]);
  await install(args, options); await install(args, options);
  assert.equal(f.calls.filter(call => call.slice(0, 3).join(" ") === "codex mcp add").length, 1);
});
for (const dependentInstalled of [false, true]) test(`Codex captured table cleanup ${dependentInstalled ? "preserves" : "removes"} marketplace according to installed dependencies`, async t => {
  const f = fixture(t);
  f.servers.codex = { command: "node", args: [path.join(ROOT, "mcp/fleet-mcp.mjs")] };
  f.codexPlugins.set("codex-fleet@wenbinio", {}); f.codexMarkets.add("wenbinio");
  const catalog = realOutput("codex-plugin-list.txt");
  const installedRow = catalog.split(/\r?\n/).find(line => line.startsWith("documents@"));
  const availableRow = catalog.split(/\r?\n/).find(line => line.startsWith("latex@"));
  const section = [
    "Marketplace `wenbinio`",
    "D:\\fixture\\wenbinio\\.claude-plugin\\marketplace.json",
    "",
    catalog.split(/\r?\n/).find(line => line.startsWith("PLUGIN ")),
    installedRow.replace("documents@openai-primary-runtime", "codex-fleet@wenbinio"),
    (dependentInstalled ? installedRow : availableRow).replace(/^\S+/, "keep@wenbinio"),
    "",
  ].join("\n");
  const options = { ...f.options, run: async (exe, args) => {
    if (exe === "fake-codex" && args.join(" ") === "plugin list") {
      f.calls.push(["codex", ...args]); return { code: 0, stdout: catalog + "\n" + section, stderr: "" };
    }
    if (exe === "fake-codex" && args.join(" ") === "plugin marketplace list") {
      f.calls.push(["codex", ...args]); return { code: 0, stdout: realOutput("codex-plugin-marketplace-list.txt") + "\nwenbinio  D:\\fixture\\wenbinio\n", stderr: "" };
    }
    return f.options.run(exe, args);
  } };
  await install(parseArgs(["--apply", "--profile", "minimal", "--host", "codex"]), options);
  assert.equal(f.codexPlugins.has("codex-fleet@wenbinio"), false);
  assert.equal(f.codexMarkets.has("wenbinio"), dependentInstalled);
  const removals = f.calls.filter(call => call.includes("remove"));
  assert.deepEqual(removals, [
    ["codex", "plugin", "remove", "codex-fleet@wenbinio"],
    ...(!dependentInstalled ? [["codex", "plugin", "marketplace", "remove", "wenbinio"]] : []),
  ]);
  const availableLegacy = section.replace(/^(codex-fleet@wenbinio\s+)installed, enabled/m, "$1not installed");
  assert.ok(!parseNamedInventory(availableLegacy, "plugins").includes("codex-fleet@wenbinio"));
});
for (const unknown of [false, "unrecognized future inventory", "fleet: [unrecognized status]"]) test(`agy ${unknown || "captured empty"} inventory plans registration instead of done`, async t => {
  const f = fixture(t);
  const options = { ...f.options, run: async (exe, args) => {
    if (exe === "fake-agy" && args[0] === "mcp" && args[1] === "list" && (unknown || !f.servers.agy)) {
      f.calls.push(["agy", ...args]); assert.deepEqual(args, ["mcp", "list"]);
      return unknown ? { code: 0, stdout: unknown, stderr: "" } : capturedResult("agy-mcp-list.txt");
    }
    return f.options.run(exe, args);
  } };
  const plan = await install(parseArgs(["--plan", "--profile", "minimal", "--host", "agy"]), options);
  assert.equal(plan.steps.find(step => step.id === "host:agy").status, "auto");
  assert.ok(f.calls.every(readOnlyCall));
  const applied = await install(parseArgs(["--apply", "--profile", "minimal", "--host", "agy"]), options);
  assert.equal(applied.steps.find(step => step.id === "host:agy").changed, true);
  assert.equal(applied.steps.find(step => step.id === "host:agy").status, unknown ? "auto" : "done");
  if (unknown) assert.match(applied.steps.find(step => step.id === "host:agy").detail, /add succeeded but inventory remains unconfirmed/);
  assert.equal(f.calls.filter(call => call.slice(0, 3).join(" ") === "agy mcp add").length, 1);
  if (unknown) {
    const again = await install(parseArgs(["--plan", "--profile", "minimal", "--host", "agy"]), options);
    assert.equal(again.steps.find(step => step.id === "host:agy").status, "auto");
  }
});
test("MCP inventory isolates fleet entries and compares Windows paths across JSON, tables and blocks", () => {
  const expected = { command: "node", args: ["D:\\Fleet Folder\\mcp\\fleet-mcp.mjs"] };
  const script = "d:/fleet folder/mcp/fleet-mcp.mjs";
  const fixtures = [
    JSON.stringify({ name: "fleet", enabled: true, transport: { type: "stdio", command: "node.exe", args: [script] } }),
    JSON.stringify({ servers: [{ name: "other", command: "unrelated", args: expected.args }, { name: "fleet", command: "node", args: [script] }] }),
    `Name   Command   Args   Env   Cwd   Status   Auth\nother  wrong     elsewhere  -  -  enabled  Unsupported\nfleet  node      ${script}  -  -  enabled  Unsupported`,
    `Configured MCP servers:\n\nfleet:\n  Command: node\n  Args: ${script}\n  Enabled: true\nother:\n  Command: wrong\n  Args: elsewhere`,
    `Configured MCP servers:\n\n  fleet:\n    Command: node\n    Args: ${script}\n  other:\n    Command: wrong\n    Args: elsewhere`,
    `Configured MCP servers:\n\n\u001b[32m✓ fleet: node "${script}" - ✓ Connected\u001b[0m`,
    `Configured MCP servers:\n\nfleet: node "${script}" (stdio) - Connected`,
  ];
  for (const text of fixtures) assert.equal(registrationMatches(parseMcpInventory(text, { single: true }).entry, expected, "win32"), true, text);
  const otherRow = parseMcpInventory(`Name  Command  Args\nother  node  ${script}\nfleet  node  D:/unrelated/server.mjs`);
  assert.equal(registrationMatches(otherRow.entry, expected, "win32"), false);
  assert.equal(registrationMatches(parseMcpInventory(JSON.stringify([{ name: "other", ...expected }])).entry, expected, "win32"), false);
  assert.equal(registrationMatches({ ...expected, enabled: false }, expected, "win32"), false);
  assert.equal(registrationMatches({ ...expected, args: [...expected.args, "--different"] }, expected, "win32"), false);
  assert.equal(parseMcpInventory("unexpected diagnostic").known, false);
  assert.equal(parseMcpInventory('{"error":{"message":"inventory failed"}}').known, false);
  assert.deepEqual(parseNamedInventory("Installed plugins:\n❯ codex-fleet@wenbinio\n  Version: 1.0\n❯ unrelated@other\n  Status: enabled", "plugins"), ["codex-fleet@wenbinio", "unrelated@other"]);
  assert.deepEqual(parseNamedInventory("Marketplaces:\n❯ wenbinio\n  Source: https://example.invalid/repo\n❯ other", "marketplaces"), ["wenbinio", "other"]);
  assert.deepEqual(parseNamedInventory("Name  Version  Marketplace  Status\ncodex-fleet  1.0  wenbinio  enabled\nkeep  2.0  other  enabled", "plugins"), ["codex-fleet@wenbinio", "keep@other"]);
  assert.equal(parseNamedInventory("could not read inventory", "marketplaces"), null);
  assert.equal(parseNamedInventory('{"error":"inventory failed"}', "plugins"), null);
});
for (const [host, format] of [["codex", "get"], ["codex", "table"], ["grok", "table"], ["agy", "inline"], ["agy", "block"]]) test(`${host} ${format} inventory is idempotent with matching registered paths`, async t => {
  const f = fixture(t), script = path.join(ROOT, "mcp/fleet-mcp.mjs");
  const shown = process.platform === "win32" ? script.replaceAll("\\", "/").toUpperCase() : script;
  f.servers[host] = { command: "node", args: [shown] };
  const options = { ...f.options, run: async (exe, args) => {
    if (exe === `fake-${host}` && args[0] === "mcp") {
      if (args[1] === "get" && format !== "get") { f.calls.push([host, ...args]); return { code: 1, stdout: "", stderr: "get is unavailable" }; }
      if (args[1] === "list" && format !== "get") {
        f.calls.push([host, ...args]);
        const stdout = format === "table" ? `Name  Command  Args  Status\nfleet  node  ${shown}  enabled`
          : format === "inline" ? `Configured MCP servers:\n✓ fleet: node "${shown}" - ✓ Connected`
          : `Configured MCP servers:\nfleet:\n  Command: node\n  Args: ${shown}\n  Enabled: true`;
        return { code: 0, stdout, stderr: "" };
      }
    }
    return f.options.run(exe, args);
  } };
  const opts = parseArgs(["--apply", "--profile", "minimal", "--host", host]);
  const first = await install(opts, options);
  assert.equal(first.steps.find(step => step.id === `host:${host}`).status, "done");
  const before = snapshot(f.home), count = f.calls.length;
  const second = await install(opts, options);
  assert.ok(second.steps.every(step => !step.changed));
  assert.deepEqual(snapshot(f.home), before);
  assert.ok(f.calls.every(call => !(call[1] === "mcp" && ["add", "remove"].includes(call[2]))));
  assert.ok(f.calls.slice(count).every(readOnlyCall));
  if (host === "codex") assert.ok(f.calls.some(call => call.slice(1).join(" ") === "mcp get fleet --json"));
});
test("different owned registration is repaired but an unrelated fleet entry is preserved", async t => {
  const f = fixture(t), previousRoot = path.join(f.home, "old-fleet");
  write(path.join(f.shared, "hosts.json"), JSON.stringify({ codex: { root: previousRoot } }));
  f.servers.codex = { command: "node", args: [path.join(previousRoot, "mcp/fleet-mcp.mjs")] };
  const opts = parseArgs(["--apply", "--profile", "minimal", "--host", "codex"]);
  const repaired = await install(opts, f.options);
  assert.equal(repaired.steps.find(step => step.id === "host:codex").changed, true);
  assert.deepEqual(f.servers.codex.args, [path.join(ROOT, "mcp/fleet-mcp.mjs")]);
  f.servers.codex = { command: "node", args: [path.join(f.home, "unrelated/server.mjs")] };
  const count = f.calls.length, rejected = await install(opts, f.options);
  assert.equal(rejected.steps.find(step => step.id === "host:codex").status, "needs-you");
  assert.ok(f.calls.slice(count).every(readOnlyCall));
});
for (const failure of [null, "add", "confirm", "remove", "inventory", "malformed", "dependent"]) test(`Codex legacy cleanup is limited and gated: ${failure ?? "success"}`, async t => {
  const f = fixture(t), old = "codex-fleet@wenbinio";
  f.codexPlugins.set(old, { enabled: true });
  f.codexPlugins.set("keep@other", { enabled: true });
  f.codexMarkets.add("wenbinio"); f.codexMarkets.add("other");
  if (failure === "dependent") f.codexPlugins.set("keep@wenbinio", { enabled: true });
  const options = { ...f.options, run: async (exe, args) => {
    if (exe === "fake-codex") {
      const deny = failure === "add" && args.slice(0, 2).join(" ") === "mcp add" ||
        failure === "remove" && args.slice(0, 2).join(" ") === "plugin remove" ||
        failure === "inventory" && args[0] === "plugin";
      if (deny) { f.calls.push(["codex", ...args]); return { code: 1, stdout: "", stderr: "fixture command unavailable" }; }
      if (failure === "malformed" && args[0] === "plugin") {
        f.calls.push(["codex", ...args]); return { code: 0, stdout: "could not read inventory", stderr: "" };
      }
      if (failure === "confirm" && args[0] === "mcp" && ["get", "list"].includes(args[1])) {
        f.calls.push(["codex", ...args]); return { code: 0, stdout: "[]", stderr: "" };
      }
    }
    return f.options.run(exe, args);
  } };
  const before = snapshot(f.home);
  const plan = await install(parseArgs(["--plan", "--profile", "minimal", "--host", "codex"]), options);
  assert.deepEqual(snapshot(f.home), before); assert.ok(f.calls.every(readOnlyCall));
  assert.ok(f.codexPlugins.has(old)); assert.ok(f.codexMarkets.has("wenbinio"));
  if (!failure) assert.equal(plan.steps.find(step => step.id === "codex:legacy-plugin").status, "auto");
  const applied = await install(parseArgs(["--apply", "--profile", "minimal", "--host", "codex"]), options);
  const commands = f.calls.map(call => call.slice(1).join(" "));
  if (!failure || failure === "dependent") {
    assert.ok(!f.codexPlugins.has(old));
    assert.ok(commands.indexOf("mcp add fleet -- node " + path.join(ROOT, "mcp/fleet-mcp.mjs")) < commands.indexOf(`plugin remove ${old}`));
    const removal = f.calls.findIndex(call => call.slice(1).join(" ") === `plugin remove ${old}`);
    const added = f.calls.findIndex(call => call.slice(1, 3).join(" ") === "mcp add");
    assert.ok(f.calls.slice(added + 1, removal).some(call => call.slice(1).join(" ") === "mcp get fleet --json"), "confirmation must follow add and precede cleanup");
  } else assert.ok(f.codexPlugins.has(old));
  assert.equal(f.codexMarkets.has("wenbinio"), Boolean(failure));
  assert.ok(f.codexPlugins.has("keep@other")); assert.ok(f.codexMarkets.has("other"));
  assert.ok(!commands.some(command => /plugin (?:remove|uninstall) keep|marketplace remove other/.test(command)));
  assert.ok(!commands.some(command => command.startsWith("plugin uninstall")));
  if (["add", "confirm"].includes(failure)) assert.ok(!commands.some(command => command.startsWith("plugin remove") || command.startsWith("plugin marketplace remove")));
  if (["inventory", "malformed"].includes(failure)) assert.equal(applied.steps.find(step => step.id === "host:codex").status, "done");
});
test("Codex cleanup also works for an already registered fleet without re-adding it", async t => {
  const f = fixture(t);
  f.servers.codex = { command: "node", args: [path.join(ROOT, "mcp/fleet-mcp.mjs")] };
  f.codexPlugins.set("codex-fleet@wenbinio", { enabled: true }); f.codexMarkets.add("wenbinio");
  await install(parseArgs(["--apply", "--profile", "minimal", "--host", "codex"]), f.options);
  assert.ok(!f.codexPlugins.size && !f.codexMarkets.size);
  assert.ok(!f.calls.some(call => call[1] === "mcp" && ["add", "remove"].includes(call[2])));
  assert.ok(f.calls.some(call => call.slice(1).join(" ") === "plugin remove codex-fleet@wenbinio"));
});
test("approval guidance keeps mutating tools subject to Lok and preserves their settings", async t => {
  const f = fixture(t), configFile = path.join(f.home, ".codex/config.toml"), original = '[mcp_servers.fleet.tools.fleet_ask]\napproval_mode = "prompt"\n';
  write(configFile, original);
  await install(parseArgs(["--apply", "--profile", "minimal", "--host", "codex"]), f.options);
  assert.equal(fs.readFileSync(configFile, "utf8"), original);
  const block = fs.readFileSync(path.join(f.home, ".codex/AGENTS.md"), "utf8");
  for (const tool of ["fleet_ask", "fleet_steer", "fleet_interrupt"]) {
    assert.ok(block.includes(tool));
    assert.ok(!block.includes(`mcp_servers.fleet.tools.${tool}.approval_mode = "approve"`));
  }
  assert.match(block, /Lok decides.*installer never grants them/);
  assert.ok(!f.calls.flat().some(arg => String(arg).includes("approval_mode")));
});
test("plan is read-only and missing accounts require Lok or an explicit off choice", async t => {
  const f = fixture(t), before = snapshot(f.home);
  const result = await install(parseArgs(["--plan", "--profile", "minimal", "--host", "codex"]), { ...f.options, inspect: async () => ({ found: false, signedIn: false, detail: "not found" }) });
  assert.deepEqual(snapshot(f.home), before);
  assert.ok(result.needsYou.some(step => step.backend === "codex" && step.detail.includes("--off codex")));
  assert.ok(f.calls.every(readOnlyCall));
  assert.ok(result.steps.some(step => step.id === "host:codex" && step.status === "auto"));
});
test("web backend plan and apply inspect files only and never launch Chrome", async t => {
  const f = fixture(t), config = loadConfig(f.env);
  config.tools.chrome = "fake-gui-chrome";
  config.advisorHome = path.join(f.home, "advisor");
  saveConfig(config, f.env);
  write(path.join(config.advisorHome, "config.json"), JSON.stringify({ accounts: [{ email: "fixture@example.invalid" }] }));
  write(path.join(f.env.FLEET_HOME, "chatgpt-web/state.json"), JSON.stringify({ signedIn: true }));
  const calls = [];
  const run = async (exe, args, opts) => {
    calls.push(exe);
    assert.notEqual(exe, "fake-gui-chrome", "GUI programs must never be invoked during install");
    return f.options.run(exe, args, opts);
  };
  const options = { ...f.options, run, inspect: (backend, context) =>
    ["advisor", "chatgpt"].includes(backend) ? inspectBackend(backend, context) : f.options.inspect(backend, context) };
  for (const mode of ["--plan", "--apply"]) {
    const result = await install(parseArgs([mode, "--profile", "lok", "--host", "generic"]), options);
    assert.equal(result.steps.find(step => step.backend === "chatgpt").status, "done");
    assert.equal(result.steps.find(step => step.backend === "advisor").status, "done");
  }
  assert.ok(!calls.includes("fake-gui-chrome"));
});
test("worker mode hides mutating tools and rejects direct MCP, CLI and start calls before side effects", async t => {
  const f = fixture(t), env = { ...f.env, FLEET_WORKER: "1" }, before = snapshot(f.home);
  const denied = ["fleet_ask", "fleet_steer", "fleet_interrupt"];
  const names = toolsFor({ env }).map(tool => tool.name);
  assert.deepEqual(names, ["fleet_runs", "fleet_run", "fleet_transcript", "fleet_status", "fleet_accounts"]);
  const start = () => assert.fail("a worker must not reach a launcher");
  for (const name of denied) await assert.rejects(callTool(name, {}, { env, start }), /FLEET_WORKER=1/);
  await assert.rejects(fleetCli(["ask", "--prompt-file", "missing"], { env, start }), /FLEET_WORKER=1/);
  await assert.rejects(startAsk({}, { env, spawnJob: start }), /FLEET_WORKER=1/);
  assert.deepEqual(snapshot(f.home), before);
  assert.ok(denied.every(name => toolsFor({ env: f.env }).some(tool => tool.name === name)));
  assert.deepEqual((await callTool("fleet_runs", {}, { env })).value.runs, []);
  assert.ok(agentsBlock(readProfile({ env: f.env }), ROOT).startsWith("<!-- fleet:start -->\nIf FLEET_WORKER=1 is set, you are a fleet worker: ignore this block.\n"));
});
for (const host of ["codex", "grok", "agy", "claude"]) test(`${host} apply is idempotent, repairs externally removed registration and remove keeps data`, async t => {
  const f = fixture(t), opts = parseArgs(["--apply", "--profile", "minimal", "--host", host]);
  const first = await install(opts, f.options);
  assert.ok(first.steps.some(step => step.changed));
  assert.ok(fs.existsSync(path.join(f.shared, "config.json")));
  const before = snapshot(f.home), callCount = f.calls.length;
  const second = await install(opts, f.options);
  assert.ok(second.steps.every(step => !step.changed));
  assert.deepEqual(snapshot(f.home), before);
  assert.ok(f.calls.slice(callCount).every(readOnlyCall));
  if (host === "claude") f.plugins.delete("fleet@agent-toolkit"); else delete f.servers[host];
  await install(opts, f.options);
  assert.ok(host === "claude" ? f.plugins.has("fleet@agent-toolkit") : f.servers[host]);
  write(path.join(f.shared, "runs/retained/answer.txt"), "history");
  const removed = await install(parseArgs(["--remove", "--host", host]), f.options);
  assert.ok(removed.steps.some(step => step.changed));
  assert.equal(fs.readFileSync(path.join(f.shared, "runs/retained/answer.txt"), "utf8"), "history");
  if (["codex", "grok"].includes(host)) {
    assert.ok(!fs.existsSync(path.join(f.home, `.${host}/skills/fleet-ask`)));
    assert.ok(!fs.readFileSync(path.join(f.home, `.${host}/AGENTS.md`), "utf8").includes("<!-- fleet:start -->"));
  }
});
test("Claude legacy removal waits for fleet success and old installs can be removed without receipts", async t => {
  const f = fixture(t);
  f.plugins.set("gemini-fleet@agent-toolkit", { enabled: true });
  const options = { ...f.options, run: async (exe, args) => args[1] === "install" ? { code: 1, stdout: "", stderr: "fixture failure" } : f.options.run(exe, args) };
  await install(parseArgs(["--apply", "--profile", "minimal", "--host", "claude"]), options);
  assert.ok(f.plugins.has("gemini-fleet@agent-toolkit"));
  await install(parseArgs(["--apply", "--profile", "minimal", "--host", "claude"]), f.options);
  assert.ok(!f.plugins.has("gemini-fleet@agent-toolkit"));
  fs.unlinkSync(path.join(f.shared, "hosts.json"));
  await install(parseArgs(["--remove", "--host", "claude"]), f.options);
  assert.ok(!f.plugins.has("fleet@agent-toolkit"));
});
test("skills preserve local edits and managed blocks insert, replace and remove only their section", async t => {
  const f = fixture(t);
  const agents = path.join(f.home, ".codex/AGENTS.md");
  write(agents, "My instructions.\n");
  write(path.join(f.home, ".codex/skills/fleet-ask/SKILL.md"), "local skill");
  let result = await install(parseArgs(["--apply", "--profile", "minimal", "--host", "codex"]), f.options);
  assert.ok(result.needsYou.some(step => step.id === "skill:codex:ask"));
  assert.equal(fs.readFileSync(path.join(f.home, ".codex/skills/fleet-ask/SKILL.md"), "utf8"), "local skill");
  const text = fs.readFileSync(agents, "utf8");
  assert.ok(text.startsWith("My instructions.\n")); assert.ok(text.includes("codex:")); assert.ok(!text.includes("- grok:"));
  result = await install(parseArgs(["--apply", "--profile", "minimal", "--host", "codex", "--on", "grok"]), f.options);
  assert.equal((fs.readFileSync(agents, "utf8").match(/<!-- fleet:start -->/g) ?? []).length, 1);
  assert.ok(fs.readFileSync(agents, "utf8").includes("- grok:"));
  assert.throws(() => managedBlock("<!-- fleet:start -->", "new"), /malformed/);
  assert.equal(managedBlock("before\n<!-- fleet:start -->\nold\n<!-- fleet:end -->\nafter\n", ""), "before\nafter\n");
});
test("profiles slim schemas, menus, help and refuse disabled starts before launching", async t => {
  const f = fixture(t), full = toolsFor({ env: f.env });
  await install(parseArgs(["--apply", "--profile", "minimal", "--host", "generic", "--off", "api"]), f.options);
  const slim = toolsFor({ env: f.env });
  assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length);
  assert.deepEqual(slim[0].inputSchema.properties.backend.enum, ["codex"]);
  for (const key of ["files", "images", "lokAsked", "keepChat", "provider", "maxCostUsd", "seconds"]) assert.equal(slim[0].inputSchema.properties[key], undefined);
  await assert.rejects(startAsk({ backend: "agy", prompt: "hi" }, { env: f.env, spawnJob: () => assert.fail("disabled backend launched") }), /agy is off in profile minimal/);
  await assert.rejects(callTool("fleet_ask", { backend: "sound", prompt: "hi", seconds: 2 }, { env: f.env }), /sound is off in profile minimal/);
  const help = [];
  await fleetCli(["--help"], { env: f.env, print: line => help.push(line) });
  assert.ok(help[0].includes("--backend codex")); assert.ok(!help[0].includes("grok"));
  await assert.rejects(accounts({ backend: "grok", env: f.env }), /grok is off/);
  injectRuntime(f.env, { toolkit: { ...toolkit, signInStatus: async () => ({ found: true, signedIn: true }), capture: () => assert.fail("disabled model discovery ran") } });
  const menu = await accounts({ env: f.env, dataDir: f.shared, discover: () => assert.fail("disabled model discovery ran"), apiOptions: { keyReader: () => assert.fail("disabled key read"), fetch: () => assert.fail("disabled network") } });
  assert.deepEqual(menu.map(row => row.backend), ["codex"]);
  assert.deepEqual(readProfile({ env: f.env }).backends.api, false);
});
test("cursor merges existing MCP JSON, generic prints instructions, and remove reports manual work", async t => {
  const f = fixture(t), file = path.join(f.home, ".cursor/mcp.json");
  write(file, JSON.stringify({ other: true, mcpServers: { existing: { command: "keep" } } }));
  const opts = parseArgs(["--apply", "--profile", "minimal", "--host", "cursor"]);
  let result = await install(opts, f.options);
  assert.ok(result.needsYou.some(step => step.command?.includes("<!-- fleet:start -->")));
  assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers.existing.command, "keep");
  const before = snapshot(f.home); await install(opts, f.options); assert.deepEqual(snapshot(f.home), before);
  await install(parseArgs(["--remove", "--host", "cursor"]), f.options);
  assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers.fleet, undefined);
  result = await install(parseArgs(["--plan", "--profile", "minimal", "--host", "generic"]), f.options);
  assert.ok(result.needsYou.some(step => step.command?.includes('"mcpServers"') && step.command.includes("fleet:start")));
  result = await install(parseArgs(["--remove", "--host", "generic"]), f.options);
  assert.ok(result.needsYou.some(step => /mcpServers.fleet/.test(step.command)));
});
test("sound recipes remain manual and use bundled script weight locations and pinned environments", async t => {
  const f = fixture(t), result = await install(parseArgs(["--apply", "--profile", "minimal", "--host", "generic", "--with", "sound"]), f.options);
  const sound = result.steps.find(step => step.id === "sound:download");
  assert.equal(sound.status, "needs-you");
  for (const value of ["3.13", "3.12", "cu124", "cu128", "2.9.0", "4.57.1", "0.37.1", "stable-audio-open-1.0", "MOSS-SoundEffect-v2.0"]) assert.ok(sound.command.includes(value));
  assert.ok(sound.command.includes(JSON.stringify(path.join(ROOT, "backends", "sound", "weights", "MOSS-SoundEffect-v2.0")).slice(1, -1)));
  assert.ok(!f.calls.some(call => call.some(value => /pip|download|venv|clone/.test(value))));
  assert.ok(soundRecipe(ROOT, f.env.FLEET_HOME, { platform: "linux" }).includes("python3.13"));
});
test("key setter never exposes key input and errors are generic; non-Windows never prompts", async t => {
  const f = fixture(t);
  let prompted = false;
  const result = await setKey({ env: f.env, platform: "win32", prompt: async file => { prompted = true; write(file, "encrypted fixture"); } });
  assert.equal(prompted, true); assert.equal(result.status, "done");
  assert.ok(!JSON.stringify(result).includes("encrypted fixture"));
  assert.equal(fs.readFileSync(path.join(f.env.FLEET_HOME, "secrets/openrouter.dpapi"), "utf8"), "encrypted fixture");
  await assert.rejects(setKey({ env: f.env, platform: "win32", prompt: async () => { throw new Error("private diagnostic"); } }), error => error.message === "Key could not be stored");
  assert.equal((await setKey({ env: f.env, platform: "linux", prompt: () => assert.fail("must not prompt") })).status, "needs-you");
  let call;
  await hiddenKeyPrompt(path.join(f.home, "encrypted.tmp"), { env: f.env, spawnProcess: (exe, args, options) => {
    call = { exe, args, options }; const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0)); return child;
  } });
  assert.ok(call.args.at(-1).includes("Read-Host")); assert.ok(call.args.at(-1).includes("-AsSecureString"));
  assert.equal(call.options.stdio, "inherit"); assert.equal(call.options.env.FLEET_KEY_TARGET, path.join(f.home, "encrypted.tmp"));
  assert.equal(call.options.env.FLEET_WORKER, "1");
});
test("migration preserves configured paths and profile overrides before first apply; purge is explicit", async t => {
  const f = fixture(t);
  write(path.join(f.legacy, "profile.json"), JSON.stringify({ name: "minimal", backends: { grok: true } }));
  write(path.join(f.legacy, "config.json"), JSON.stringify({ backend: "app-server", verifiedAt: "fixture", nodeVersion: "old", custom: true }));
  saveConfig({ ...loadConfig(f.env), soundDir: "keep sound", mossTools: "keep moss", advisorHome: "keep advisor" }, f.env);
  await install(parseArgs(["--apply", "--host", "codex"]), f.options);
  assert.equal(readProfile({ env: f.env }).backends.grok, true);
  assert.equal(loadConfig(f.env).soundDir, "keep sound"); assert.equal(loadConfig(f.env).mossTools, "keep moss"); assert.equal(loadConfig(f.env).advisorHome, "keep advisor");
  const config = JSON.parse(fs.readFileSync(path.join(f.shared, "config.json")));
  assert.equal(config.backend, "app-server"); assert.equal(config.verifiedAt, "fixture"); assert.equal(config.custom, true);
  await install(parseArgs(["--remove", "--host", "codex", "--purge"]), f.options);
  assert.ok(!fs.existsSync(f.shared)); assert.ok(fs.existsSync(f.legacy)); assert.ok(fs.existsSync(path.join(f.env.FLEET_HOME, "config.json")));
});
test("installer rejects ambiguous actions and invalid overrides before doing work", () => {
  for (const args of [["--apply", "--plan"], ["--purge"], ["--host", "unknown"], ["--on", "unknown"], ["--on", "api", "--off", "api"], ["--set-key", "unknown"], ["--with", "other"]]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(["--with", "sound"]).mode, "plan");
});
