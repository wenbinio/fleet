import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { freeModels, pickFree } from '../core/lib/api.mjs';
import { estimateImages, generateImages, imageDimensions, imageModels, validateImageOptions } from '../core/lib/image-api.mjs';
import { imageApiRun } from '../core/lib/runners.mjs';
import * as toolkit from '../core/lib/toolkit.mjs';
import { ADAPTERS } from '../runner/lib/adapters.mjs';
import { accounts } from '../runner/lib/accounts.mjs';
import { atomicJson, startAsk, runDirectory, readJson, listRuns, validateAsk } from '../runner/lib/jobs.mjs';
import { runAskJob } from '../runner/ask-job.mjs';
import { CORE_ROOT, injectRuntime } from '../runner/lib/runtime.mjs';
import { BACKEND_NAMES } from '../runner/lib/profile.mjs';
import { callTool, TOOLS } from '../mcp/fleet-mcp.mjs';
import { cli } from '../runner/fleet.mjs';

const real = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/openrouter-real/${name}.json`, import.meta.url), 'utf8'));
const ids = ['recraft/recraft-v4.1-flash', 'black-forest-labs/flux-3-image-klein', 'qwen/qwen-image-3', 'tencent/hy-image-v3.5-preview'];
const endpoints = id => real(`image-endpoints-${id.replace('/', '_')}`);
const response = (data, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(data) });
function png(width = 32, height = 16) {
  const bytes = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}
function fixture(t) {
  const scratch = fileURLToPath(new URL('../.test-tmp/', import.meta.url)); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'image-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const env = { HOME: root, USERPROFILE: root, FLEET_HOME: path.join(root, 'home'), AGENT_TOOLKIT_HOME: '', FLEET_LOCAL_ROOT: path.join(root, 'missing-model'), CHATGPT_WEB_HOME: path.join(root, 'web'), FLEET_WORKER: '', PATH: '', Path: '', FIXTURE_KEY: randomUUID() };
  const service = { name: 'openrouter', kind: 'openai', baseUrl: 'https://fixture.invalid/api/v1', keyEnv: 'FIXTURE_KEY' };
  toolkit.saveConfig({ providers: [service] }, env);
  const dataDir = path.join(env.FLEET_HOME, 'fleet');
  injectRuntime(env, { repo: CORE_ROOT, toolkit: { ...toolkit, capture: async () => ({ code: 1 }), signInStatus: async () => ({ found: true, signedIn: true, detail: 'fixture account' }) } });
  const reference = path.join(root, 'reference.png'); fs.writeFileSync(reference, png(1000, 500));
  const calls = [], payload = { data: [{ b64_json: png().toString('base64'), media_type: 'image/png' }], usage: { cost: 0.008 } };
  const options = { env, keyReader: (_, { env }) => env.FIXTURE_KEY, fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/endpoints')) return response(endpoints(decodeURIComponent(url.split('/images/models/')[1].replace('/endpoints', ''))));
    if (url.endsWith('/images/models')) return response({ data: ids.map(id => ({ id })) });
    if (url.endsWith('/models')) return response(real('image-models'));
    if (url.endsWith('/key')) return response({ data: { limit_remaining: 1 } });
    assert.ok(url.endsWith('/images')); return response(payload);
  } };
  return { root, env, service, dataDir, reference, calls, payload, options };
}
const opts = (model = ids[0], extra = {}) => ({ model, maxCostUsd: 1, prompt: 'Draw a quiet garden', ...extra });
const spawnJob = () => { const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };

test('free picker rejects the real image catalogue and every nonzero pricing field, including old cached projections', async t => {
  const f = fixture(t);
  assert.deepEqual(await freeModels(f.service, f.options), []); assert.deepEqual(await pickFree(4, f.service, f.options), []);
  const cached = path.join(f.env.FLEET_HOME, 'cache/openrouter-models.json');
  atomicJson(cached, { baseUrl: f.service.baseUrl, savedAt: Date.now(), models: [{ id: 'legacy/paid:free', pricing: { prompt: 0, completion: 0 }, architecture: { output_modalities: ['text'] } }] });
  const model = (id, pricing) => ({ id, pricing, architecture: { output_modalities: ['text'] } });
  const rows = ['image', 'image_output', 'image_token', 'web_search', 'internal_reasoning', 'audio'].map(field => model(`paid/${field}:free`, { prompt: '0', completion: '0', [field]: '0.01' }));
  rows.push(model('unknown/empty:free', {}), model('unknown/null:free', { prompt: null }), model('paid/no-suffix', { prompt: '0' }), model('good/model:free', { prompt: '0', image: '0' }), model('openrouter/free', { prompt: '0' }));
  let requests = 0;
  const values = await freeModels(f.service, { ...f.options, fetch: async () => { requests++; return response({ data: rows }); } });
  assert.equal(requests, 1); assert.deepEqual(values.map(row => row.id).sort(), ['good/model:free', 'openrouter/free']);
  const saved = JSON.parse(fs.readFileSync(cached, 'utf8')); assert.equal(saved.version, 2); assert.equal(saved.models[0].pricing.image, 0.01);
});
test('endpoint fixture estimates use real output prices, variants and reference charges', t => {
  const f = fixture(t);
  assert.equal(estimateImages(endpoints(ids[0]), opts(ids[0], { n: 3 })).estimateUsd, 0.021);
  for (const [resolution, price] of [['768', 0.008], ['1k', 0.009], ['1.5K', 0.011], ['2K', 0.014], ['4K', 0.036]]) assert.equal(estimateImages(endpoints(ids[1]), opts(ids[1], { resolution })).estimateUsd, price);
  assert.equal(estimateImages(endpoints(ids[1]), opts(ids[1])).estimateUsd, 0.009);
  assert.ok(Math.abs(estimateImages(endpoints(ids[2]), opts(ids[2], { n: 2, images: [f.reference] })).estimateUsd - 0.063) < 1e-10);
  const token = estimateImages(endpoints(ids[3]), opts(ids[3], { resolution: '2K', seed: 42 }));
  assert.equal(token.estimate, 'rough'); assert.ok(Math.abs(token.estimateUsd - 0.0000016 * 4096 * 4 * 1.5) < 1e-10);
  const explicit = estimateImages(endpoints(ids[3]), opts(ids[3], { size: '2000x1000', aspect_ratio: '2:1' }));
  assert.equal(explicit.estimateUsd, 0.0000016 * 4096 * 2 * 1.5);
  assert.throws(() => estimateImages(endpoints(ids[1]), opts(ids[1], { n: 2 })), /unsupported n/);
  assert.throws(() => estimateImages(endpoints(ids[0]), opts(ids[0], { resolution: '1K' })), /unsupported option: resolution/);
  assert.throws(() => estimateImages(endpoints(ids[2]), opts(ids[2], { images: Array(4).fill(f.reference) })), /input_references/);
  assert.throws(() => estimateImages(endpoints(ids[0]), opts(ids[0], { maxCostUsd: 0.006 })), /estimated \$0.007 > maxCostUsd \$0.006/);
  assert.throws(() => validateImageOptions(opts(ids[3], { size: '2000x1000', aspect_ratio: '1:1' })), /conflicts/);
  assert.throws(() => validateImageOptions(opts(ids[3], { size: '4K', resolution: '1K' })), /conflicts/);
});
test('estimator handles megapixels, request prices, covering variants and unknown billables conservatively', t => {
  const f = fixture(t), document = endpoints(ids[2]), endpoint = document.endpoints[0];
  endpoint.supported_parameters.size = { type: 'boolean' };
  endpoint.pricing = [{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.02 }, { billable: 'input_reference', unit: 'request', cost_usd: 0.005 }];
  assert.equal(estimateImages(document, opts(ids[2], { size: '2000x1000', n: 2, images: [f.reference] })).estimateUsd, 0.085);
  endpoint.pricing = [{ billable: 'output_image', unit: 'image', cost_usd: 0.02, variant: '2k' }, { billable: 'output_image', unit: 'image', cost_usd: 0.05, variant: '4k' }];
  assert.equal(estimateImages(document, opts(ids[2])).estimateUsd, 0.02);
  assert.equal(estimateImages(document, opts(ids[2], { size: '9000x9000' })).estimateUsd, 0.05);
  endpoint.pricing = []; assert.throws(() => estimateImages(document, opts(ids[2])), /pricing/);
  endpoint.pricing = [{ billable: 'output_image', unit: 'request', cost_usd: 0.01 }, { billable: 'input_text', unit: 'token', cost_usd: 0.001 }];
  assert.equal(estimateImages(document, opts(ids[2], { prompt: 'sixsix', n: 2 })).estimateUsd, 0.022);
  endpoint.pricing.push({ billable: 'input_font', unit: 'request', cost_usd: 1 });
  assert.throws(() => estimateImages(document, opts(ids[2])), /unsupported image pricing billable/);
});
test('required authorization, unsupported options and caps never reach key reader or inference', async t => {
  const f = fixture(t), noKey = () => assert.fail('key must not be read');
  for (const changes of [{ model: undefined }, { maxCostUsd: undefined }, { model: 'openrouter/auto-beta' }, { effort: 'high' }]) {
    await assert.rejects(generateImages(f.service, opts(ids[0], changes), f.root, { ...f.options, keyReader: noKey, fetch: () => assert.fail('invalid authorization made a request') }));
  }
  for (const changes of [{ quality: 'high' }, { maxCostUsd: 0.001 }]) {
    const result = await generateImages(f.service, opts(ids[0], changes), f.root, { ...f.options, keyReader: noKey });
    assert.equal(result.outcome, 'failed');
  }
  assert.ok(f.calls.every(call => call.init.method === 'GET' && !call.init.headers.Authorization));
  const missing = await generateImages(f.service, opts(ids[1]), f.root, { ...f.options, keyReader: noKey, fetch: async (url, init) => {
    assert.equal(init.method, 'GET'); const doc = endpoints(ids[1]); doc.endpoints[0].pricing = []; return response(doc);
  } });
  assert.equal(missing.outcome, 'failed'); assert.match(missing.error, /pricing/);
});

test('output_format fallback decodes an SVG artifact without dimensions or base64 metadata', async t => {
  const f = fixture(t), svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
  const result = await generateImages(f.service, opts(ids[0], { output_format: 'svg' }), f.root, { ...f.options, fetch: async (url, init) => {
    if (init.method === 'POST') return response({ data: [{ b64_json: svg.toString('base64') }], usage: { cost: 0.007 } });
    const doc = endpoints(ids[0]); doc.endpoints[0].supported_parameters.output_format = { type: 'enum', values: ['svg'] }; return response(doc);
  } });
  assert.equal(result.outcome, 'done'); assert.equal(result.files.length, 1);
  assert.equal(path.extname(result.files[0].path), '.svg'); assert.equal(result.files[0].bytes, svg.length);
  assert.equal(result.files[0].width, undefined); assert.equal(result.files[0].height, undefined);
  assert.deepEqual(fs.readFileSync(result.files[0].path), svg);
  assert.ok(!JSON.stringify(result).includes(svg.toString('base64')));
});
test('Images POST embeds references, canonicalizes resolution and returns only decoded artifact metadata and cost', async t => {
  const f = fixture(t), directory = path.join(f.root, 'run'), outDir = path.join(f.root, 'out');
  f.payload.usage.cost = 0.5;
  const result = await generateImages(f.service, opts(ids[2], { n: 1, resolution: '2k', aspect_ratio: '1:1', seed: 42, images: [f.reference], outDir, maxCostUsd: 0.1 }), directory, f.options);
  assert.equal(result.outcome, 'done'); assert.equal(result.overCap, true); assert.equal(result.costUsd, 0.5); assert.equal(result.providerSlug, 'alibaba'); assert.equal(result.n, 1);
  assert.equal(result.files.length, 2); assert.ok(result.files.every(file => file.width === 32 && file.height === 16 && file.bytes === 24));
  const post = f.calls.find(call => call.init.method === 'POST'), body = JSON.parse(post.init.body);
  assert.ok(post.url.endsWith('/images')); assert.equal(post.init.headers.Authorization, `Bearer ${f.env.FIXTURE_KEY}`);
  assert.equal(post.init.redirect, 'error'); assert.equal(body.resolution, '2K'); assert.equal(body.seed, 42); assert.equal(body.model, ids[2]);
  assert.deepEqual(Object.keys(body.input_references[0]), ['type', 'image_url']); assert.match(body.input_references[0].image_url.url, /^data:image\/png;base64,/);
  assert.ok(!JSON.stringify(result).includes(f.env.FIXTURE_KEY)); assert.ok(!JSON.stringify(result).includes(f.payload.data[0].b64_json));
  assert.deepEqual(fs.readFileSync(result.files[0].path), png());
});
test('image errors never echo credentials or base64, map status, and never retry', async t => {
  const f = fixture(t), encoded = f.payload.data[0].b64_json;
  for (const [status, outcome] of [[401, 'denied'], [403, 'denied'], [402, 'limit'], [429, 'rate_limited'], [502, 'failed'], [400, 'failed']]) {
    let posts = 0;
    const result = await generateImages(f.service, opts(), f.root, { ...f.options, fetch: async (url, init) => {
      if (init.method !== 'POST') return f.options.fetch(url, init);
      posts++; return response({ error: { message: `${f.env.FIXTURE_KEY} ${encoded}` } }, status);
    } });
    assert.equal(result.outcome, outcome); assert.equal(posts, 1); assert.ok(!JSON.stringify(result).includes(encoded)); assert.ok(!JSON.stringify(result).includes(f.env.FIXTURE_KEY));
    if (status === 502) { assert.equal(result.error, 'generation failed (not billed)'); assert.equal(result.costUsd, 0); }
  }
});
test('non-JSON HTTP failures retain status without reading or exposing response bodies', async t => {
  const f = fixture(t);
  for (const [status, outcome] of [[502, 'failed'], [402, 'limit'], [401, 'denied']]) {
    const result = await generateImages(f.service, opts(), f.root, { ...f.options, fetch: async (url, init) => {
      if (init.method !== 'POST') return f.options.fetch(url, init);
      return { status, ok: false, text: () => assert.fail('error body must not be read') };
    } });
    assert.equal(result.outcome, outcome);
    if (status === 502) assert.equal(result.error, 'generation failed (not billed)');
  }
});

test('PNG, JPEG and WebP dimensions are read from headers; SVG has no dimensions', () => {
  assert.deepEqual(imageDimensions(png(3, 7), 'png'), { width: 3, height: 7 });
  const jpg = Buffer.from([255,216,255,192,0,7,8,0,7,0,3]); assert.deepEqual(imageDimensions(jpg, 'jpeg'), { width: 3, height: 7 });
  const webp = Buffer.alloc(25); webp.write('RIFF'); webp.write('WEBP', 8); webp.write('VP8L', 12); webp[20] = 47; webp[21] = 2; webp[23] = 1;
  assert.deepEqual(imageDimensions(webp, 'webp'), { width: 3, height: 5 });
  assert.deepEqual(imageDimensions(Buffer.from('<svg/>'), 'svg'), {});
});
test('menu uses real endpoint prices, caches 24 hours and works when API backend is off', async t => {
  const f = fixture(t); let clock = 1000;
  const options = { ...f.options, now: () => clock };
  const menu = await imageModels(f.service, options);
  assert.equal(menu[0].id, ids[0]); assert.equal(menu[0].price, '$0.007/image'); assert.equal(menu.find(row => row.id === ids[2]).price, '$0.03/image');
  assert.equal(menu.find(row => row.id === ids[3]).price, '$0.0000016/token');
  const count = f.calls.length; clock += 86_399_999; await imageModels(f.service, options); assert.equal(f.calls.length, count);
  clock++; await imageModels(f.service, options); assert.ok(f.calls.length > count);
  atomicJson(path.join(f.dataDir, 'profile.json'), { name: 'lok', backends: Object.fromEntries(BACKEND_NAMES.map(name => [name, name === 'image'])) });
  const rows = await accounts({ backend: 'image', env: f.env, dataDir: f.dataDir, apiOptions: f.options, now: () => clock, discover: () => assert.fail('no CLI discovery') });
  assert.equal(rows.length, 2); assert.equal(rows[0].models[0].id, 'sol'); assert.equal(rows[1].provider, 'openrouter'); assert.equal(rows[1].models[0].price, '$0.007/image');
  assert.ok(!rows[1].notes.some(note => note.startsWith('effort:')));
  assert.ok(!fs.readFileSync(path.join(f.dataDir, 'model-menu.json'), 'utf8').includes(f.env.FIXTURE_KEY));
});
test('image menu returns only the fifteen cheapest priced models', async t => {
  const f = fixture(t);
  const rows = await imageModels(f.service, { ...f.options, fetch: async url => {
    if (url.endsWith('/images/models')) return response({ data: Array.from({ length: 20 }, (_, n) => ({ id: `fixture/model-${n}` })) });
    const n = Number(/model-(\d+)/.exec(url)[1]);
    return response({ endpoints: [{ provider_slug: 'fixture', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: (20 - n) / 100 }] }] });
  } });
  assert.equal(rows.length, 15); assert.equal(rows[0].id, 'fixture/model-19'); assert.equal(rows.at(-1).id, 'fixture/model-5');
  assert.ok(rows.every(row => row.cost === 'paid'));
});

test('OpenRouter image jobs persist costs and files without base64 while Codex remains unchanged', async t => {
  const f = fixture(t), original = ADAPTERS.image.command({ model: 'sol', effort: 'high' }, { directory: f.root, repo: CORE_ROOT });
  assert.deepEqual(original.args, [path.join(CORE_ROOT, 'lib/runners.mjs'), 'codex-image', f.root, '--model', 'sol', '--effort', 'high']);
  const job = await startAsk({ backend: 'image', provider: 'openrouter', prompt: 'draw', model: ids[0], maxCostUsd: 0.01 }, { env: f.env, spawnJob });
  const directory = runDirectory(f.dataDir, job.runId); assert.equal(readJson(path.join(directory, 'run.json')).effort, undefined);
  const completed = await runAskJob(directory, { env: f.env, spawnBackend: (exe, args) => {
    const child = new EventEmitter(); child.pid = process.pid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(async () => { try { const code = await imageApiRun(args.slice(2), { ...f.options, stdout: text => child.stdout.write(text) }); child.stdout.end(); child.stderr.end(); child.emit('close', code); } catch (error) { child.emit('error', error); } });
    return child;
  } });
  assert.equal(completed.status, 'done'); assert.equal(completed.costUsd, 0.008); assert.equal(completed.estimateUsd, 0.007); assert.equal(completed.files[0].width, 32);
  for (const name of ['run.json', 'completion.json', 'answer.txt', 'stdout.txt', 'stderr.txt']) {
    const text = fs.readFileSync(path.join(directory, name), 'utf8'); assert.ok(!text.includes(f.payload.data[0].b64_json)); assert.ok(!text.includes(f.env.FIXTURE_KEY));
  }
  const transcript = (await callTool('fleet_transcript', { runId: job.runId }, { env: f.env })).value;
  assert.ok(!transcript.includes(f.payload.data[0].b64_json)); assert.equal((await listRuns(f.dataDir, { backend: 'codex', limit: 1 })).spendUsd, 0.008);
  let parsed;
  await cli(['ask', '--backend', 'image', '--provider', 'openrouter', '--prompt', 'x', '--model', ids[2], '--max-cost', '0.1', '--n', '2', '--aspect-ratio', '1:1', '--output-format', 'png'], { env: f.env, print() {}, start: async value => { parsed = value; return {}; } });
  assert.equal(parsed.n, 2); assert.equal(parsed.aspect_ratio, '1:1'); assert.equal(parsed.output_format, 'png');
  for (const key of ['n', 'resolution', 'aspect_ratio', 'size', 'quality', 'output_format', 'background']) assert.ok(TOOLS[0].inputSchema.properties[key]);
  assert.throws(() => validateAsk({ backend: 'image', prompt: 'x', n: 2 }, { env: f.env }), /requires image provider/);
  assert.equal(ADAPTERS.image.maxLive, 2);
});
