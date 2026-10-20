import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chat } from "../core/lib/api.mjs";
import { apiRun } from "../core/lib/runners.mjs";
import { saveConfig } from "../core/lib/toolkit.mjs";

function fixture(t) {
  const scratch = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const home = fs.mkdtempSync(path.join(scratch, "effort-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { HOME: home, USERPROFILE: home, FLEET_HOME: path.join(home, "home"), AGENT_TOOLKIT_HOME: "", FIXTURE_KEY: randomUUID() };
  const service = { name: "fixture", kind: "openai", baseUrl: "https://fixture.invalid/v1", keyEnv: "FIXTURE_KEY" };
  saveConfig({ providers: [service] }, env); // Credentials live only in the injected environment.
  const prompt = path.join(home, "prompt.txt"); fs.writeFileSync(prompt, "sixsix");
  const requests = [];
  const options = {
    env, keyReader: async (_, { env }) => env.FIXTURE_KEY,
    fetch: async (url, init) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      const data = url.endsWith("/models")
        ? { data: [{ id: "vendor/paid", pricing: { prompt: "0.01", completion: "0.02" }, context_length: 1000 }] }
        : { choices: [{ message: { content: "fixture answer" } }], usage: { cost: 0 } };
      return { status: 200, text: async () => JSON.stringify(data) };
    },
  };
  return { env, service, prompt, requests, options };
}
for (const effort of [undefined, "low", "medium", "high"]) test(`API reasoning is ${effort ?? "omitted"} without model capability checks`, async t => {
  const f = fixture(t);
  const result = await chat(f.service, { prompt: "hello", model: "arbitrary/new-model:free", ...(effort !== undefined ? { effort } : {}) }, f.options);
  assert.equal(result.outcome, "done");
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0].url.endsWith("/chat/completions"));
  assert.equal(f.requests[0].body.model, "arbitrary/new-model:free");
  if (effort === undefined) assert.ok(!Object.hasOwn(f.requests[0].body, "reasoning"));
  else assert.deepEqual(f.requests[0].body.reasoning, { effort });
});
test("API CLI passes --effort and rejects invalid values before fetching", async t => {
  const f = fixture(t), output = [], errors = [];
  const options = { ...f.options, stdout: text => output.push(text), stderr: text => errors.push(text) };
  assert.equal(await apiRun([f.prompt, "--model", "vendor/model:free", "--effort", "medium", "--json"], options), 0);
  assert.deepEqual(f.requests[0].body.reasoning, { effort: "medium" });
  assert.equal(JSON.parse(output[0]).answer, "fixture answer"); assert.deepEqual(errors, []);
  for (const effort of ["xhigh", "max", "", "HIGH"]) {
    await assert.rejects(apiRun([f.prompt, "--model", "vendor/model:free", "--effort", effort], options), /effort/);
    await assert.rejects(chat(f.service, { prompt: "hello", model: "vendor/model:free", effort }, f.options), /effort/);
  }
  assert.equal(f.requests.length, 1);
  assert.equal(await apiRun([f.prompt, "--model", "vendor/model:free"], options), 0);
  assert.ok(!Object.hasOwn(f.requests[1].body, "reasoning"));
});
test("API effort preserves paid authorization and completion budgeting", async t => {
  const f = fixture(t);
  await assert.rejects(chat(f.service, { prompt: "sixsix", model: "vendor/paid", effort: "high" }, {
    ...f.options, keyReader: () => assert.fail("paid authorization precedes key access"),
    fetch: () => assert.fail("paid authorization precedes HTTP"),
  }), /needs maxCostUsd/);
  const result = await chat(f.service, { prompt: "sixsix", model: "vendor/paid", maxCostUsd: 0.1, effort: "high" }, f.options);
  assert.equal(result.outcome, "done");
  assert.deepEqual(f.requests.at(-1).body.reasoning, { effort: "high" });
  assert.equal(f.requests.at(-1).body.max_tokens, 4); // Two estimated prompt tokens leave 0.08 for completion.
  const denied = await chat(f.service, { prompt: "sixsix", model: "vendor/paid", maxCostUsd: 0.01, maxTokens: 1, effort: "low" }, f.options);
  assert.equal(denied.outcome, "failed"); assert.match(denied.error, /prompt alone exceeds/);
  assert.equal(f.requests.filter(request => request.url.endsWith("/chat/completions")).length, 1);
});
