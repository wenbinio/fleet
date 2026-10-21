import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { capture, loadConfig, toolkitHome } from './toolkit.mjs';
import { validateEffort } from './effort.mjs';
import { localProvider } from './local.mjs';
import { quotaLimited } from './quota.mjs';

export function defaultProvider(env = process.env) {
  return { name: 'openrouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyFile: path.join(toolkitHome(env), 'secrets', 'openrouter.dpapi'), keyEnv: 'OPENROUTER_API_KEY' };
}
export function provider(name, { env = process.env, platform = process.platform, config = loadConfig(env) } = {}) {
  const entries = config.providers ?? [];
  const value = name === undefined ? entries[0] : entries.find(p => p.name === name);
  if (!value) throw new Error(`provider ${name ?? '(default)'} is not configured; run node setup.mjs`);
  if (typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(value.name) || value.kind !== 'openai') throw new Error('invalid provider configuration');
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new Error('invalid provider baseUrl'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('provider baseUrl must be an HTTP(S) URL without credentials, query or fragment');
  if (value.local === true) return localProvider({ ...config, providers: [value] }, value.name, { env, platform });
  return Object.fromEntries(['name', 'kind', 'baseUrl', 'keyFile', 'keyEnv'].filter(k => value[k] !== undefined).map(k => [k, value[k]]));
}
export function providers(options = {}) {
  const env = options.env ?? process.env, config = options.config ?? loadConfig(env);
  return (config.providers ?? []).map(p => provider(p.name, { env, config, platform: options.platform }));
}
export async function readKey(service, { env = process.env, platform = process.platform, run = capture } = {}) {
  if (platform === 'win32' && service.keyFile && fs.existsSync(service.keyFile)) {
    try {
      const script = "$s = Get-Content -LiteralPath $env:TOOLKIT_DPAPI_FILE | ConvertTo-SecureString; [Console]::Out.Write([Net.NetworkCredential]::new('', $s).Password)";
      const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...env, TOOLKIT_DPAPI_FILE: service.keyFile }, timeout: 30_000 });
      if (result.code === 0 && result.stdout?.trim()) return result.stdout.trim();
    } catch { /* Never expose decryptor output or errors; use the configured env fallback. */ }
  }
  const value = service.keyEnv ? env[service.keyEnv] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function scrub(value, key) {
  if (!key) return value;
  const secrets = [...new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])];
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => scrub(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k, key), scrub(v, key)]));
  return value;
}
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const finite = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
const endpoint = (service, suffix) => service.baseUrl.replace(/\/+$/, '') + suffix;
async function request(service, suffix, { key, redactKey = key, method = 'GET', body, fetch: fetcher = globalThis.fetch, timeoutMs, timeoutSignal = AbortSignal.timeout } = {}) {
  try {
    const response = await fetcher(endpoint(service, suffix), {
      method, redirect: 'error', signal: timeoutSignal(timeoutMs ?? (service.local ? 1_200_000 : 30_000)),
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: { message: 'provider returned invalid JSON' } }; }
    return { status: response.status, ok: response.ok ?? (response.status >= 200 && response.status < 300), headers: response.headers, data: scrub(data, redactKey) };
  } catch (error) { throw new ApiError(scrub(['AbortError', 'TimeoutError'].includes(error.name) ? 'provider request timed out' : error.message || 'provider request failed', redactKey), 0); }
}
const message = response => response.data?.error?.message ?? (typeof response.data?.error === 'string' ? response.data.error : null) ?? response.data?.message ?? `HTTP ${response.status}`;
const header = (response, name) => response.headers?.get?.(name) ??
  Object.entries(response.data?.error?.metadata?.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
export async function keyStatus(service, options = {}) {
  let key = options.key;
  if (!key) {
    try { key = await (options.keyReader ?? readKey)(service, options); }
    catch { throw new ApiError('key unavailable or unreadable', 401); }
  }
  if (!key) throw new ApiError(`key unavailable; set ${service.keyEnv || 'the provider keyEnv'} or create its DPAPI file`, 401);
  const unknown = { type: 'inference', limit: null, limitRemaining: null, usage: null, isFreeTier: null, expiresAt: null, freeDaily: { used: null, limit: null, remaining: null } };
  // OpenAI-compatible providers need not implement OpenRouter account endpoints.
  if (service.name !== 'openrouter') return unknown;
  const response = await request(service, '/key', { ...options, key });
  if (!response.ok || response.data?.error) throw new ApiError(scrub(message(response), key), response.status);
  const data = response.data?.data ?? {};
  const counters = data.free_model_daily_requests ?? data.free_daily ?? data.freeDaily ?? {};
  const used = finite(counters.used ?? data.free_requests_daily_used ?? header(response, 'x-ratelimit-free-daily-used'));
  const limit = finite(counters.limit ?? data.free_requests_daily_limit ?? header(response, 'x-ratelimit-free-daily-limit'));
  const explicitRemaining = finite(counters.remaining ?? data.free_requests_daily_remaining ?? header(response, 'x-ratelimit-free-daily-remaining'));
  return scrub({
    type: data.is_management_key ? 'management' : data.is_provisioning_key ? 'provisioning' : 'inference',
    limit: finite(data.limit), limitRemaining: finite(data.limit_remaining), usage: finite(data.usage),
    isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null, expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
    freeDaily: { used, limit, remaining: explicitRemaining ?? (limit !== null && used !== null ? Math.max(0, limit - used) : null) },
  }, key);
}
export function modelRules(model, maxCostUsd, service = { name: 'openrouter' }) {
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error('model must be a non-empty string');
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) throw new Error('maxCostUsd must be non-negative');
  if (service.local === true) {
    localProvider({ providers: [service] }, service.name, { env: {} });
    if (!model) throw new Error('local.default is not configured; choose an installed model');
    return { model, free: false, local: true };
  }
  const automatic = model === undefined || ['free', 'auto', 'openrouter/free'].includes(model);
  if (automatic && service.name !== 'openrouter') throw new Error(`name an explicit model for provider ${service.name}`);
  const requested = automatic ? 'openrouter/free' : model;
  if (service.name === 'openrouter' && requested === 'openrouter/auto') throw new Error("openrouter/auto can't be capped; name a model id");
  const free = requested === 'openrouter/free' || requested.endsWith(':free');
  if (!free && maxCostUsd === undefined) throw new Error(`paid model ${requested} needs maxCostUsd`);
  return { model: requested, free };
}
async function catalog(service, options = {}) {
  const env = options.env ?? process.env, now = options.now?.() ?? Date.now();
  const file = path.join(toolkitHome(env), 'cache', `${service.name}-models.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version === 2 && saved.baseUrl === service.baseUrl && Array.isArray(saved.models) && now - saved.savedAt >= 0 && now - saved.savedAt < 3_600_000) return saved.models;
  } catch { /* A missing or invalid cache is refreshed without credentials. */ }
  const response = await request(service, '/models', { ...options, key: undefined });
  if (!response.ok || response.data?.error) throw new ApiError(message(response), response.status);
  if (!Array.isArray(response.data?.data)) throw new Error('provider returned no model catalog');
  const models = response.data.data.filter(m => typeof m?.id === 'string').map(m => ({
    id: m.id, context_length: finite(m.context_length),
    pricing: Object.fromEntries(Object.entries(m.pricing ?? {}).map(([key, value]) => [key, finite(value)])),
    architecture: { output_modalities: Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities.filter(v => typeof v === 'string') : [] },
    max_completion_tokens: finite(m.top_provider?.max_completion_tokens),
  }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ version: 2, baseUrl: service.baseUrl, savedAt: now, models }) + '\n'); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return models;
}
export async function catalogSize(service, options = {}) { return (await catalog(service, options)).length; }
const UNUSABLE_TTL = 7 * 24 * 60 * 60 * 1000;
const unusableFile = (service, options) => path.join(toolkitHome(options.env ?? process.env), 'cache', `${service.name}-unusable.json`);
function unusableModels(service, options = {}) {
  const now = options.now?.() ?? Date.now();
  try {
    const rows = JSON.parse(fs.readFileSync(unusableFile(service, options), 'utf8'));
    return Array.isArray(rows) ? rows.filter(row => typeof row?.id === 'string' && typeof row.date === 'string' && now >= Date.parse(row.date) && now - Date.parse(row.date) < UNUSABLE_TTL).map(({ id, date }) => ({ id, date })) : [];
  } catch { return []; }
}
function markUnusable(service, id, options) {
  const file = unusableFile(service, options), now = options.now?.() ?? Date.now();
  const rows = [...unusableModels(service, options).filter(row => row.id !== id), { id, date: new Date(now).toISOString() }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(rows) + '\n', { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function modelUnavailable(text) {
  return /\b(?:only\s+(?:available|supported|accessible|usable)\s+(?:on|in|via|through|for)|requires?|restricted\s+to|limited\s+to)\s+(?:an?\s+)?(?:agentic|agent|coding)\s+harness(?:es)?\b/i.test(text)
    || /\b(?:not|no longer)\s+(?:available|supported|accessible)\s+(?:via|through|on|for|in)\s+(?:the\s+)?(?:public\s+)?(?:api|chat[- ]completions)\b/i.test(text);
}
export async function freeModels(service, options = {}) {
  if (service.name !== 'openrouter') return [];
  const models = await catalog(service, options), unusable = new Set(unusableModels(service, options).map(row => row.id));
  return models.filter(m => !unusable.has(m.id) && (m.id.endsWith(':free') || m.id === 'openrouter/free') && Object.keys(m.pricing).length > 0 && Object.values(m.pricing).every(value => value === 0) && m.architecture.output_modalities.includes('text') && !/guard|safety|moderation/i.test(m.id))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0) || a.id.localeCompare(b.id));
}
export async function pickFree(n = 4, service, options = {}) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('n must be a positive integer');
  service ??= provider(undefined, options);
  const seen = new Set(), selected = [];
  for (const model of await freeModels(service, options)) {
    const vendor = model.id.split('/')[0];
    if (seen.has(vendor)) continue;
    selected.push(model.id); seen.add(vendor);
    if (selected.length === n) break;
  }
  return selected;
}
function dailyLimited(response, now) {
  if (/free-models-per-day/i.test(String(message(response)))) return true;
  if (String(header(response, 'x-ratelimit-remaining')) !== '0') return false;
  const reset = header(response, 'x-ratelimit-reset'), period = header(response, 'x-ratelimit-reset-period') ?? header(response, 'x-ratelimit-window') ?? '';
  if (/daily|day|86400/i.test(`${reset ?? ''} ${period}`)) return true;
  // Daily limits reset at a date/day boundary, rather than a short minute window.
  const numeric = Number(reset), resetAt = reset && Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : Date.parse(reset);
  return Number.isFinite(resetAt) && resetAt > now && resetAt % 86_400_000 === 0;
}
export async function chat(service, opts, options = {}) {
  // Model authorization is checked before key introspection, catalog or inference.
  const rule = modelRules(opts.model, opts.maxCostUsd, service);
  validateEffort(service.local ? 'local' : 'api', opts.effort);
  if (opts.responseFormat !== undefined && opts.responseFormat !== 'json') throw new Error('responseFormat must be json');
  if (typeof opts.prompt !== 'string' || !opts.prompt.trim()) throw new Error('prompt must be non-empty');
  if (opts.system !== undefined && typeof opts.system !== 'string') throw new Error('system must be text');
  if (opts.maxTokens !== undefined && (!Number.isSafeInteger(opts.maxTokens) || opts.maxTokens < 1)) throw new Error('maxTokens must be a positive integer');
  if (opts.timeout !== undefined && (!service.local || !Number.isFinite(opts.timeout) || opts.timeout <= 0)) throw new Error('timeout must be positive seconds for local jobs');
  const requestOptions = service.local && opts.timeout !== undefined ? { ...options, timeoutMs: Math.ceil(opts.timeout * 1000) } : options;
  let key;
  const base = { answer: '', reasoning: '', model: rule.model, requestedModel: rule.model, provider: service.name, free: rule.free, usage: {}, costUsd: 0, overCap: false };
  const outcome = (status, extra = {}) => scrub({ outcome: status, ...base, ...extra }, key);
  try {
    key = service.local ? undefined : await (options.keyReader ?? readKey)(service, options);
    if (!service.local && !key) return outcome('denied', { error: `key unavailable; set ${service.keyEnv || 'the provider keyEnv'} or create its DPAPI file` });
    const status = service.local ? { type: 'inference' } : await keyStatus(service, { ...options, key });
    if (['management', 'provisioning'].includes(status.type)) return outcome('denied', { error: 'this is a management key; use an inference key' });
    let maxTokens = opts.maxTokens;
    if (!rule.free && !service.local) {
      // A cap cannot be estimated without prices, even when maxTokens is supplied.
      const model = (await catalog(service, { ...options, redactKey: key })).find(m => m.id === rule.model);
      if (!model || !Number.isFinite(model.pricing.prompt) || !Number.isFinite(model.pricing.completion) || model.pricing.prompt < 0 || model.pricing.completion < 0) return outcome('failed', { error: 'model pricing unavailable; this provider must publish prompt/completion pricing before a paid job can be capped' });
      const promptTokens = Math.ceil((opts.prompt.length + (opts.system?.length ?? 0)) / 3);
      const remaining = opts.maxCostUsd - promptTokens * model.pricing.prompt;
      if (remaining < 0) return outcome('failed', { error: 'prompt alone exceeds maxCostUsd' });
      if (maxTokens === undefined) {
        const contextRemaining = model.context_length > 0 ? Math.max(0, model.context_length - promptTokens) : Number.MAX_SAFE_INTEGER;
        const outputLimit = model.max_completion_tokens > 0 ? model.max_completion_tokens : Number.MAX_SAFE_INTEGER;
        const byCost = model.pricing.completion === 0 ? Math.min(contextRemaining, outputLimit) : Math.floor(remaining / model.pricing.completion);
        maxTokens = Math.min(byCost, contextRemaining, outputLimit);
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens === Number.MAX_SAFE_INTEGER) return outcome('failed', { error: 'maxCostUsd leaves no bounded completion budget; supply maxTokens' });
      }
    }
    const body = { model: rule.model, messages: [...(opts.system ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: opts.prompt }], ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}), ...(opts.effort !== undefined ? service.local ? { reasoning_effort: opts.effort } : { reasoning: { effort: opts.effort } } : {}) };
    if (service.local && service.engine === 'ollama') body.keep_alive = 0;
    if (opts.responseFormat) body.response_format = { type: "json_object" };
    let response;
    for (let attempt = 0; attempt <= 3; attempt++) {
      response = await request(service, '/chat/completions', { ...requestOptions, key, method: 'POST', body });
      if (service.local && service.engine === 'ollama' && response.status === 400 && /keep_alive|unknown field|unsupported field/i.test(String(message(response)))) {
        const native = { ...service, baseUrl: new URL("/", service.baseUrl).href };
        response = await request(native, '/api/chat', { ...requestOptions, method: 'POST', body: {
          model: body.model, messages: body.messages, stream: false, keep_alive: 0,
          ...(opts.responseFormat ? { format: 'json' } : {}),
          ...(maxTokens !== undefined ? { options: { num_predict: maxTokens } } : {}),
        } });
        if (response.ok && !response.data.error) response.data = { model: response.data.model, choices: [{ message: response.data.message }], usage: {} };
      }
      if ((!response.ok || response.data?.error) && modelUnavailable(String(message(response)))) {
        // Record only the requested model and date, never the provider's error or key.
        // A cache-write failure must not turn a model-availability failure into denial.
        if (!service.local) try { markUnusable(service, scrub(rule.model, key), options); } catch {}
        return outcome('failed', { error: message(response) });
      }
      if (response.status !== 429) break;
      const now = options.now?.() ?? Date.now();
      if (dailyLimited(response, now)) return outcome('daily_limit', { error: message(response) });
      if (attempt === 3) return outcome('rate_limited', { error: message(response) });
      const retry = header(response, 'retry-after');
      const seconds = retry === null ? NaN : Number(retry);
      const retryAt = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
      await (options.sleep ?? delay)(Number.isFinite(retryAt) && retryAt >= 0 ? retryAt : 2000 * 2 ** attempt);
    }
    if ((!response.ok || response.data?.error) && (response.status === 402 || quotaLimited(message(response)))) return outcome('limit', { error: message(response) });
    if ([401, 403].includes(response.status)) return outcome('denied', { error: message(response) });
    if (!response.ok || response.data?.error) return outcome('failed', { error: message(response) });
    const data = response.data, content = data.choices?.[0]?.message;
    const answer = typeof content?.content === 'string' ? content.content : '';
    const reasoning = typeof content?.reasoning === 'string' ? content.reasoning : typeof content?.reasoning_content === 'string' ? content.reasoning_content : '';
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    const costUsd = service.local ? 0 : finite(usage.cost) ?? 0;
    return outcome(answer.trim() ? 'done' : 'empty', { answer, reasoning, model: typeof data.model === 'string' ? data.model : rule.model, usage, costUsd, overCap: opts.maxCostUsd !== undefined && costUsd > opts.maxCostUsd, ...(!answer.trim() ? { error: 'empty answer' } : {}) });
  } catch (error) { return outcome((key || service.local) && (error.status === 402 || quotaLimited(error.message)) ? 'limit' : service.local ? 'failed' : !key || [401, 403].includes(error.status) ? 'denied' : 'failed', { error: service.local ? error.message : key ? scrub(error.message || 'API request failed', key) : 'key unavailable or unreadable' }); }
}
export async function accountStatus(service, options = {}) {
  if (service.local) return { backend: 'local', provider: service.name, found: true, signedIn: null, detail: 'local provider; no API key or usage cost' };
  let key;
  try {
    key = await (options.keyReader ?? readKey)(service, options);
    if (!key) return { backend: 'api', provider: service.name, found: false, signedIn: false, detail: `create ${service.keyFile || 'the DPAPI key file'} or set ${service.keyEnv || 'keyEnv'}` };
    const status = await keyStatus(service, { ...options, key });
    const generic = service.name !== 'openrouter';
    return scrub({ backend: 'api', provider: service.name, found: true, signedIn: generic ? null : status.type === 'inference', detail: generic ? 'key available; account status is not inspected' : status.type === 'inference' ? 'inference key' : 'this is a management key; use an inference key', ...status }, key);
  } catch (error) { return scrub({ backend: 'api', provider: service.name, found: Boolean(key), signedIn: false, detail: key ? error.message || 'key check failed' : 'key unavailable or unreadable' }, key); }
}
