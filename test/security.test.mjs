import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCmdShimArgs } from "../core/lib/toolkit.mjs";
import { Browser } from "../core/lib/webchat/engine.mjs";
import { redactSecrets, resolveBareCommand } from "../core/lib/worker.mjs";

test("cmd shims reject newline and NUL arguments", () => {
  assert.throws(() => assertCmdShimArgs("dsh.cmd", ["ok\n& calc.exe"]), /newline or NUL/);
  assert.throws(() => assertCmdShimArgs("tool.bat", ["ok\r\nmore"]), /newline or NUL/);
  assert.throws(() => assertCmdShimArgs("tool.cmd", ["a\0b"]), /newline or NUL/);
  assert.doesNotThrow(() => assertCmdShimArgs("tool.cmd", ["safe-arg"]));
  assert.doesNotThrow(() => assertCmdShimArgs("git", ["ok\nnot-a-cmd-shim"]));
});

test("secret-like environment names are removed and ordinary names stay", () => {
  const cleaned = redactSecrets({
    PATH: "/usr/bin",
    FLEET_WORKER: "1",
    TOKENIZERS_PARALLELISM: "true",
    OPENROUTER_API_KEY: "sk-test",
    GH_TOKEN: "gh-test",
    TOOLKIT_DPAPI_FILE: "/tmp/key",
    FLEET_KEY_TARGET: "/tmp/out",
  });
  assert.equal(cleaned.PATH, "/usr/bin");
  assert.equal(cleaned.FLEET_WORKER, "1");
  assert.equal(cleaned.TOKENIZERS_PARALLELISM, "true");
  assert.equal(cleaned.OPENROUTER_API_KEY, undefined);
  assert.equal(cleaned.GH_TOKEN, undefined);
  assert.equal(cleaned.TOOLKIT_DPAPI_FILE, undefined);
  assert.equal(cleaned.FLEET_KEY_TARGET, undefined);
  assert.equal("OPENROUTER_API_KEY" in cleaned, false);
});

test("bare executables resolve from absolute PATH entries, not the current directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-bare-"));
  const planted = path.join(dir, "git");
  writeFileSync(planted, "#!/bin/sh\necho planted\n");
  chmodSync(planted, 0o755);
  const previous = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(resolveBareCommand("git", { PATH: "." }), "git");
    assert.equal(resolveBareCommand("git", { PATH: dir }), planted);
    assert.notEqual(path.resolve(resolveBareCommand("git", { PATH: process.env.PATH })), planted);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Chrome launch env drops provider keys", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-chrome-test";
  const profile = mkdtempSync(path.join(os.tmpdir(), "fleet-chrome-env-"));
  let seen;
  try {
    await assert.rejects(Browser.launch({ chrome: "fake-chrome", profile }, {
      spawnChrome(_command, _args, options) {
        seen = options.env;
        throw new Error("stop");
      },
    }), /stop/);
    assert.equal(seen.FLEET_WORKER, "1");
    assert.equal(seen.OPENROUTER_API_KEY, undefined);
    assert.equal(seen.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    rmSync(profile, { recursive: true, force: true });
  }
});
