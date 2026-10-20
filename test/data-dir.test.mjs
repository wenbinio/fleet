import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveDataDir } from "../runner/lib/data-dir.mjs";

test("CLAUDE_PLUGIN_DATA is authoritative and returned verbatim", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fleet-data-dir-env-"));
  const dataRoot = path.join(home, ".claude", "plugins", "data");

  try {
    await Promise.all([
      mkdir(path.join(dataRoot, "fleet"), { recursive: true }),
      mkdir(path.join(dataRoot, "fleet-inline"), { recursive: true }),
    ]);
    await writeFile(path.join(dataRoot, "fleet-inline", "config.json"), "{}\n", "utf8");

    const authoritative = path.join("host-provided", "fleet-data");
    assert.equal(
      await resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: authoritative }, home }),
      authoritative,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a deterministic config-containing match wins over matches without config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fleet-data-dir-match-"));
  const dataRoot = path.join(home, ".claude", "plugins", "data");
  const bare = path.join(dataRoot, "fleet");
  const configuredFirst = path.join(dataRoot, "fleet-inline");
  const configuredSecond = path.join(dataRoot, "fleet-wenbinio");

  try {
    await Promise.all([
      mkdir(bare, { recursive: true }),
      mkdir(configuredFirst, { recursive: true }),
      mkdir(configuredSecond, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(configuredFirst, "config.json"), "{}\n", "utf8"),
      writeFile(path.join(configuredSecond, "config.json"), "{}\n", "utf8"),
    ]);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => resolveDataDir({ env: {}, home })),
    );
    assert.deepEqual(results, Array(20).fill(configuredFirst));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the lexicographically-first match wins when no match contains config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fleet-data-dir-unconfigured-"));
  const dataRoot = path.join(home, ".claude", "plugins", "data");

  try {
    await Promise.all([
      mkdir(path.join(dataRoot, "fleet-wenbinio"), { recursive: true }),
      mkdir(path.join(dataRoot, "fleet-inline"), { recursive: true }),
    ]);

    assert.equal(
      await resolveDataDir({ env: {}, home }),
      path.join(dataRoot, "fleet-inline"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the bare plugin data name is used when nothing matches", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fleet-data-dir-default-"));

  try {
    assert.equal(
      await resolveDataDir({ env: {}, home }),
      path.join(home, ".claude", "plugins", "data", "fleet-agent-toolkit"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("preferred fleet directory wins and legacy or substring names never match", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fleet-directory-priority-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".claude", "plugins", "data");
  for (const name of ["codex-fleet-wenbinio", "gemini-fleet-agent-toolkit", "my-fleet", "fleetish"]) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, "config.json"), "{}");
  }
  const preferred = path.join(root, "fleet-agent-toolkit");
  assert.equal(await resolveDataDir({ env: {}, home }), preferred);
  await mkdir(path.join(root, "fleet-a"), { recursive: true });
  await writeFile(path.join(root, "fleet-a", "config.json"), "{}");
  await mkdir(preferred);
  assert.equal(await resolveDataDir({ env: {}, home }), preferred);
  assert.equal(await resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: " " }, home }), " ");
});

for (const shell of ["sh", "powershell"]) {
  test(`${shell} guard uses the same deterministic data-directory algorithm`, async t => {
    if (shell === "powershell" && process.platform !== "win32") return t.skip("PowerShell guard is Windows-only");
    const exe = shell === "powershell" ? "powershell.exe" : "sh";
    const probe = spawnSync(exe, shell === "powershell" ? ["-NoProfile", "-Command", "exit 0"] : ["-c", "exit 0"], { windowsHide: true });
    if (probe.error) return t.skip(`shell unavailable: ${probe.error.code}`);
    const home = await mkdtemp(path.join(os.tmpdir(), "fleet-guard-directory-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = path.join(home, ".claude", "plugins", "data");
    const source = await readFile(new URL(`../scripts/merge-guard.${shell === "sh" ? "sh" : "ps1"}`, import.meta.url), "utf8");
    // Extract the unchanged resolver, substituting only the test home reference.
    const fn = shell === "sh"
      ? source.slice(source.indexOf("resolve_data_dir()"), source.indexOf("\ncommand -v jq")).replaceAll("HOME", "FLEET_TEST_HOME")
      : source.slice(source.indexOf("function Resolve-DataDirectory"), source.indexOf("\nfunction ConvertTo-StaticCommandToken")).replaceAll("$HOME", "$env:FLEET_TEST_HOME");
    const resolve = override => {
      const script = fn + (shell === "sh" ? "\nresolve_data_dir" : "\nResolve-DataDirectory");
      const args = shell === "sh" ? ["-c", script] : ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      const result = spawnSync(exe, args, { windowsHide: true, encoding: "utf8", env: { ...process.env, FLEET_TEST_HOME: shell === "sh" ? home.replaceAll("\\", "/") : home, CLAUDE_PLUGIN_DATA: override ?? "" } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.replace(/\r?\n$/, "");
    };
    const check = async () => assert.equal(path.normalize(resolve()), path.normalize(await resolveDataDir({ env: {}, home })));
    await check();
    for (const name of ["codex-fleet", "gemini-fleet", "prefix-fleet", "fleetish"]) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, "config.json"), "{}");
    }
    await check();
    for (const name of ["fleet-z", "fleet", "fleet-a"]) await mkdir(path.join(root, name), { recursive: true });
    await check();
    await writeFile(path.join(root, "fleet-z", "config.json"), "{}"); await check();
    await writeFile(path.join(root, "fleet-a", "config.json"), "{}"); await check();
    await mkdir(path.join(root, "fleet-agent-toolkit")); await check();
    assert.equal(resolve(" "), " ");
    assert.equal(resolve("host-provided"), "host-provided");
  });
}
