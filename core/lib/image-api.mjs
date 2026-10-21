import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readKey, scrub } from './api.mjs';
import { toolkitHome } from './toolkit.mjs';

export const IMAGE_OPTIONS = ['n', 'resolution', 'aspect_ratio', 'size', 'quality', 'output_format', 'background', 'seed'];
const TTL = 24 * 60 * 60 * 1000;
const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const resolutionPixels = value => {
  const match = /^(\d+(?:\.\d+)?)(k)?$/i.exec(String(value));
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : null;
};
export function validateImageOptions(opts) {
  if (typeof opts.model !== 'string' || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(opts.model) || /^openrouter\/(?:auto|free)/i.test(opts.model)) throw new Error('OpenRouter images require an exact model id');
  if (!Number.isFinite(opts.maxCostUsd) || opts.maxCostUsd < 0) throw new Error('OpenRouter images require maxCostUsd');
  if (opts.effort !== undefined) throw new Error('effort is not supported for OpenRouter images');
  if (!Number.isSafeInteger(opts.n ?? 1) || (opts.n ?? 1) < 1 || (opts.n ?? 1) > 10) throw new Error('n must be between 1 and 10');
  if (opts.images !== undefined && (!Array.isArray(opts.images) || opts.images.length > 16)) throw new Error('images accepts at most 16 reference files');
  if (opts.seed !== undefined && !Number.isSafeInteger(opts.seed)) throw new Error('seed must be an integer');
  for (const key of ['resolution', 'aspect_ratio', 'size', 'quality', 'output_format', 'background']) if (opts[key] !== undefined && (typeof opts[key] !== 'string' || !opts[key].trim())) throw new Error(`${key} must be non-empty text`);
  if (opts.resolution !== undefined && !['512', '768', '1k', '1.5k', '2k', '4k'].includes(opts.resolution.toLowerCase())) throw new Error('invalid resolution');
  if (opts.output_format !== undefined && !['png', 'jpeg', 'webp', 'svg'].includes(opts.output_format)) throw new Error('invalid output_format');
  if (opts.background !== undefined && !['auto', 'transparent', 'opaque'].includes(opts.background)) throw new Error('invalid background');
  if (opts.size !== undefined && !/^\d+x\d+$/i.test(opts.size) && !resolutionPixels(opts.size)) throw new Error('size must be a resolution or WxH');
  const pixels = /^(\d+)x(\d+)$/i.exec(opts.size ?? '');
  if (pixels && (!Number(pixels[1]) || !Number(pixels[2]))) throw new Error('size dimensions must be positive');
  if (!pixels && opts.size !== undefined && opts.resolution !== undefined && resolutionPixels(opts.size) !== resolutionPixels(opts.resolution)) throw new Error('size conflicts with resolution');
  const ratio = /^(\d+):(\d+)$/.exec(opts.aspect_ratio ?? '');
  if (opts.aspect_ratio !== undefined && opts.aspect_ratio !== 'auto' && (!ratio || !Number(ratio[1]) || !Number(ratio[2]))) throw new Error('invalid aspect_ratio');
  if (pixels && ratio && Number(pixels[1]) * Number(ratio[2]) !== Number(pixels[2]) * Number(ratio[1])) throw new Error('pixel size conflicts with aspect_ratio');
  for (const file of opts.images ?? []) if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('images must be absolute reference files');
  if (opts.outDir !== undefined && !path.isAbsolute(opts.outDir)) throw new Error('outDir must be absolute');
}
const megapixels = opts => {
  const pixels = /^(\d+)x(\d+)$/i.exec(opts.size ?? '');
  if (pixels) return Number(pixels[1]) * Number(pixels[2]) / 1_000_000;
  return ((resolutionPixels(opts.resolution ?? opts.size ?? '1K') ?? 1000) / 1000) ** 2;
};
function selectRate(lines, opts) {
  if (!lines.length || lines.some(line => number(line.cost_usd) === null)) throw new Error('image pricing unavailable');
  const requested = String(opts.resolution ?? opts.size ?? '1K').toLowerCase();
  const exact = lines.filter(line => typeof line.variant === 'string' && line.variant.toLowerCase() === requested);
  const plain = lines.filter(line => !line.variant);
  const target = resolutionPixels(requested);
  const covering = lines.filter(line => target && resolutionPixels(line.variant) >= target);
  const candidates = exact.length ? exact : plain.length ? plain : covering;
  return [...(candidates.length ? candidates : lines)].sort((a, b) => (number(a.cost_usd) - number(b.cost_usd)) * (candidates.length ? 1 : -1))[0];
}
export function estimateImages(document, opts, references = []) {
  validateImageOptions(opts);
  const endpoint = document?.endpoints?.[0];
  if (!endpoint || typeof endpoint.provider_slug !== 'string' || !Array.isArray(endpoint.pricing)) throw new Error('image endpoint pricing unavailable');
  const supported = endpoint.supported_parameters ?? {};
  for (const key of [...IMAGE_OPTIONS.filter(key => opts[key] !== undefined), ...((opts.images?.length ?? 0) ? ['input_references'] : [])]) {
    const spec = supported[key], value = key === 'input_references' ? opts.images.length : opts[key];
    if (!spec) throw new Error(`unsupported option: ${key}`);
    // boolean metadata means that the option is supported, not that its value is boolean.
    if (Array.isArray(spec.values) && !spec.values.some(item => String(item).toLowerCase() === String(value).toLowerCase())) throw new Error(`unsupported ${key} value`);
    if (spec.type === 'range' && (!Number.isFinite(value) || spec.min !== undefined && value < spec.min || spec.max !== undefined && value > spec.max)) throw new Error(`unsupported ${key} value`);
  }
  const n = opts.n ?? 1, mp = megapixels(opts);
  let rough = false;
  const cost = (rate, count, pixels) => {
    const price = number(rate.cost_usd);
    if (rate.unit === 'image' || rate.unit === 'request') return price * count;
    if (rate.unit === 'megapixel') return price * pixels * count;
    if (rate.unit === 'token') { rough = true; return price * Math.ceil(4096 * pixels * 1.5) * count; }
    throw new Error('unsupported image pricing unit');
  };
  if (endpoint.pricing.some(rate => !['output_image', 'input_image', 'input_reference', 'input_text'].includes(rate.billable) && number(rate.cost_usd) !== 0)) throw new Error('unsupported image pricing billable');
  const output = selectRate(endpoint.pricing.filter(rate => rate.billable === 'output_image'), opts);
  let estimateUsd = cost(output, n, mp);
  for (const billable of ['input_image', 'input_reference']) {
    const lines = endpoint.pricing.filter(rate => rate.billable === billable);
    if (!lines.length || !opts.images?.length) continue;
    const rate = selectRate(lines, opts);
    if (['token', 'megapixel'].includes(rate.unit)) {
      if (references.length !== opts.images.length || references.some(ref => !ref.width || !ref.height)) throw new Error('reference dimensions required for input image pricing');
      for (const ref of references) estimateUsd += cost(rate, 1, ref.width * ref.height / 1_000_000);
    } else estimateUsd += cost(rate, opts.images.length, 1);
  }
  const textRates = endpoint.pricing.filter(rate => rate.billable === 'input_text');
  if (textRates.length) {
    const rate = selectRate(textRates, opts);
    if (rate.unit === 'token') { rough = true; estimateUsd += number(rate.cost_usd) * Math.ceil((opts.prompt ?? '').length / 3); }
    else if (rate.unit === 'request') estimateUsd += number(rate.cost_usd);
    else throw new Error('unsupported input_text pricing unit');
  }
  if (!Number.isFinite(estimateUsd)) throw new Error('image pricing unavailable');
  if (estimateUsd > opts.maxCostUsd) throw new Error(`estimated $${estimateUsd} > maxCostUsd $${opts.maxCostUsd}`);
  return { estimateUsd, ...(rough ? { estimate: 'rough' } : {}), providerSlug: endpoint.provider_slug, n };
}
async function request(service, suffix, { fetch: fetcher = globalThis.fetch, key, body } = {}) {
  let response;
  try { response = await fetcher(service.baseUrl.replace(/\/+$/, '') + suffix, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(body ? 1_200_000 : 30_000), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new Error('image API request failed'); }
  if (!(response.ok ?? response.status < 400)) throw Object.assign(new Error(response.status === 502 ? 'generation failed (not billed)' : `image API HTTP ${response.status}`), { status: response.status });
  let data;
  try { data = JSON.parse(await response.text()); } catch { throw new Error('invalid image API response'); }
  if (data?.error) throw new Error('image API returned an error');
  return data;
}
async function cached(service, label, load, options) {
  const env = options.env ?? process.env, now = options.now?.() ?? Date.now();
  const name = createHash('sha256').update(service.baseUrl + '\n' + label).digest('hex');
  const file = path.join(toolkitHome(env), 'cache', `image-${name}.json`);
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.version === 1 && now >= saved.savedAt && now - saved.savedAt < TTL) return saved.value; } catch {}
  const value = await load();
  fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, savedAt: now, value }), { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return value;
}
export async function imageEndpoints(service, model, options = {}) {
  return cached(service, model, async () => {
    const data = await request(service, `/images/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`, { fetch: options.fetch });
    if (!Array.isArray(data.endpoints)) throw new Error('image endpoint pricing unavailable');
    return { id: model, endpoints: data.endpoints.map(endpoint => ({
      provider_slug: typeof endpoint.provider_slug === 'string' && /^[a-z0-9._/-]{1,128}$/i.test(endpoint.provider_slug) ? endpoint.provider_slug : null,
      supported_parameters: Object.fromEntries(Object.entries(endpoint.supported_parameters ?? {}).filter(([key]) => [...IMAGE_OPTIONS, 'input_references'].includes(key)).map(([key, spec]) => [key, {
        type: spec?.type, ...(Array.isArray(spec?.values) ? { values: spec.values.filter(value => typeof value === 'string' || typeof value === 'number') } : {}), ...(number(spec?.min) !== null ? { min: number(spec.min) } : {}), ...(number(spec?.max) !== null ? { max: number(spec.max) } : {}),
      }])),
      pricing: (endpoint.pricing ?? []).map(rate => ({ billable: rate.billable, unit: rate.unit, cost_usd: number(rate.cost_usd), ...(typeof rate.variant === 'string' ? { variant: rate.variant } : {}) })),
    })) };
  }, options);
}
export async function imageModels(service, options = {}) {
  return cached(service, 'menu', async () => {
    const data = await request(service, '/images/models', { fetch: options.fetch });
    const rows = Array.isArray(data) ? data : data.data ?? data.models;
    if (!Array.isArray(rows)) throw new Error('image model catalogue unavailable');
    const result = [];
    for (const row of rows) {
      const id = typeof row === 'string' ? row : row?.id;
      if (typeof id !== 'string' || !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(id)) continue;
      try {
        const doc = await imageEndpoints(service, id, options), rates = doc.endpoints.flatMap(endpoint => endpoint.pricing).filter(rate => rate.billable === 'output_image' && number(rate.cost_usd) !== null && ['image', 'request', 'token', 'megapixel'].includes(rate.unit));
        const rate = rates.sort((a, b) => number(a.cost_usd) * (a.unit === 'token' ? 6144 : 1) - number(b.cost_usd) * (b.unit === 'token' ? 6144 : 1))[0];
        if (!rate || !['image', 'request', 'token', 'megapixel'].includes(rate.unit)) continue;
        result.push({ id, cost: 'paid', access: 'image', price: `$${rate.cost_usd}/${rate.unit === 'request' ? 'image' : rate.unit}`, sortPrice: number(rate.cost_usd) * (rate.unit === 'token' ? 6144 : 1) });
      } catch { /* A model without authoritative endpoint prices is not advertised. */ }
    }
    return result.sort((a, b) => a.sortPrice - b.sortPrice || a.id.localeCompare(b.id)).slice(0, 15).map(({ sortPrice, ...row }) => row);
  }, options);
}
export function imageDimensions(data, ext) {
  if (ext === 'png' && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (ext === 'jpeg' && data.length > 4 && data[0] === 255 && data[1] === 216) {
    for (let i = 2; i + 3 < data.length;) {
      if (data[i++] !== 255) break; while (data[i] === 255) i++;
      const marker = data[i++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (i + 2 > data.length) break; const length = data.readUInt16BE(i);
      if (length < 2 || i + length > data.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) return { width: data.readUInt16BE(i + 5), height: data.readUInt16BE(i + 3) };
      i += length;
    }
  }
  if (ext === 'webp' && data.length >= 25 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X' && data.length >= 30) return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && data.length >= 30) return { width: data.readUInt16LE(26) & 16383, height: data.readUInt16LE(28) & 16383 };
    if (kind === 'VP8L' && data[20] === 47) return { width: 1 + ((data[21] | data[22] << 8) & 16383), height: 1 + ((data[22] >> 6 | data[23] << 2 | data[24] << 10) & 16383) };
  }
  return {};
}
function reference(file) {
  const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg'), type = Object.entries(formats).find(([, format]) => format === ext)?.[0];
  if (!type) throw new Error('unsupported reference image format');
  const data = fs.readFileSync(file);
  return { type: 'image_url', image_url: { url: `data:${type};base64,${data.toString('base64')}` }, ...imageDimensions(data, ext) };
}
export async function generateImages(service, opts, directory, options = {}) {
  validateImageOptions(opts);
  if (typeof opts.prompt !== 'string' || !opts.prompt.trim()) throw new Error('prompt must be non-empty');
  let key, estimate;
  const base = { model: opts.model, provider: 'openrouter', n: opts.n ?? 1, files: [], costUsd: 0, overCap: false };
  const result = (outcome, extra = {}) => scrub({ outcome, ...base, ...estimate, ...extra }, key);
  try {
    const refs = (opts.images ?? []).map(reference);
    const document = await imageEndpoints(service, opts.model, options);
    estimate = estimateImages(document, opts, refs);
    try { key = await (options.keyReader ?? readKey)(service, options); } catch { return result('denied', { error: 'key unavailable or unreadable' }); }
    if (!key) return result('denied', { error: 'OpenRouter key unavailable' });
    const body = { model: opts.model, prompt: opts.prompt, ...Object.fromEntries(IMAGE_OPTIONS.filter(name => opts[name] !== undefined).map(name => [name,
      document.endpoints[0].supported_parameters?.[name]?.values?.find(value => String(value).toLowerCase() === String(opts[name]).toLowerCase()) ?? opts[name]])), ...(refs.length ? { input_references: refs.map(({ type, image_url }) => ({ type, image_url })) } : {}) };
    const data = await request(service, '/images', { fetch: options.fetch, key, body });
    base.costUsd = number(data.usage?.cost) ?? 0; base.overCap = base.costUsd > opts.maxCostUsd;
    if (!Array.isArray(data.data) || !data.data.length) return result('failed', { error: 'image API returned no images' });
    const decoded = data.data.map(item => {
      const ext = formats[item.media_type] ?? opts.output_format ?? 'png', encoded = item.b64_json;
      if (typeof encoded !== 'string' || !encoded.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid image data');
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('invalid image data');
      return { ext, bytes, dimensions: imageDimensions(bytes, ext) };
    });
    fs.mkdirSync(directory, { recursive: true });
    for (const [index, item] of decoded.entries()) {
      const file = path.join(directory, `image-${index + 1}.${item.ext}`);
      fs.writeFileSync(file, item.bytes, { flag: 'wx' });
      base.files.push({ path: file, bytes: item.bytes.length, ...item.dimensions });
      if (opts.outDir && path.resolve(opts.outDir) !== path.resolve(directory)) {
        fs.mkdirSync(opts.outDir, { recursive: true }); const copy = path.join(opts.outDir, path.basename(file));
        fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL); base.files.push({ path: copy, bytes: item.bytes.length, ...item.dimensions });
      }
    }
    return result('done');
  } catch (error) {
    // Never echo remote messages or HTTP bodies: they may contain credentials or
    // input/output base64. Only locally generated validation diagnostics escape.
    const status = error.status;
    const safe = /^(?:unsupported |invalid |image (?:endpoint pricing|pricing|API)|reference dimensions|estimated \$)/.test(error.message) ? error.message : status === 502 ? 'generation failed (not billed)' : 'image generation failed';
    return result(status === 402 ? 'limit' : [401, 403].includes(status) ? 'denied' : status === 429 ? 'rate_limited' : 'failed', { error: safe });
  }
}
