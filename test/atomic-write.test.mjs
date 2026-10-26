import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { atomicWrite, atomicWriteJson } from "../runner/lib/atomic-write.mjs";

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

function busy(code) {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

// fsp is the shared node:fs promises object, so the helper sees these patches.
function patch(t, name, replacement) {
  const original = fsp[name];
  fsp[name] = replacement(original);
  t.after(() => { fsp[name] = original; });
}

test("atomicWrite retries a rename refused while the target is busy", async (t) => {
  const directory = await tempDir(t);
  const target = path.join(directory, "state.json");
  let failures = 0;
  patch(t, "rename", (original) => async (...args) => {
    if (failures < 3) {
      failures += 1;
      throw busy(["EPERM", "EACCES", "EBUSY"][failures - 1]);
    }
    return original(...args);
  });
  await atomicWriteJson(target, { status: "working" });
  assert.equal(failures, 3);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { status: "working" });
  assert.deepEqual(await readdir(directory), ["state.json"], "temporary file is consumed by the rename");
});

test("atomicWrite falls back to a direct write when the rename never succeeds", async (t) => {
  const directory = await tempDir(t);
  const target = path.join(directory, "state.json");
  await writeFile(target, "old\n");
  let attempts = 0;
  patch(t, "rename", () => async () => {
    attempts += 1;
    throw busy("EPERM");
  });
  await atomicWrite(target, "new\n");
  assert.equal(attempts, 10);
  assert.equal(await readFile(target, "utf8"), "new\n");
  assert.deepEqual(await readdir(directory), ["state.json"], "temporary file is removed after the fallback");
});

test("atomicWrite does not retry or fall back on unrelated rename errors", async (t) => {
  const directory = await tempDir(t);
  const target = path.join(directory, "state.json");
  await writeFile(target, "old\n");
  let attempts = 0;
  patch(t, "rename", () => async () => {
    attempts += 1;
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  });
  await assert.rejects(atomicWrite(target, "new\n"), { code: "ENOSPC" });
  assert.equal(attempts, 1);
  assert.equal(await readFile(target, "utf8"), "old\n");
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("atomicWrite reports both errors when the direct write is refused too", async (t) => {
  const directory = await tempDir(t);
  const target = path.join(directory, "state.json");
  await writeFile(target, "old\n");
  patch(t, "rename", () => async () => { throw busy("EPERM"); });
  patch(t, "writeFile", (original) => async (file, ...rest) => {
    if (file === target) throw busy("EBUSY");
    return original(file, ...rest);
  });
  await assert.rejects(atomicWrite(target, "new\n"), (error) => {
    assert.equal(error.code, "EBUSY");
    assert.match(error.message, /EPERM.*direct write failed: EBUSY/);
    return true;
  });
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("atomicWrite replaces a file that a reader holds open for a while", async (t) => {
  // On Windows the open handle refuses the rename (EPERM) until it is released;
  // elsewhere the rename succeeds at once. Either way the write must land.
  const directory = await tempDir(t);
  const target = path.join(directory, "state.json");
  await writeFile(target, "old\n");
  const reader = await open(target, "r");
  const released = delay(150).then(() => reader.close());
  t.after(() => released);
  await atomicWrite(target, "held-then-released\n");
  assert.equal(await readFile(target, "utf8"), "held-then-released\n");

  const stubborn = await open(target, "r");
  try {
    await atomicWrite(target, "held-throughout\n");
  } finally {
    await stubborn.close();
  }
  assert.equal(await readFile(target, "utf8"), "held-throughout\n");
  assert.deepEqual(await readdir(directory), ["state.json"]);
});
