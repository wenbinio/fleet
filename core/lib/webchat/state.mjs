import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toolkitHome } from '../toolkit.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export const CHATGPT_DEFAULTS = { minGapSeconds: 20, maxPerHour: 30, strongest: ['GPT-6', 'GPT-5.6', 'Pro', 'Thinking'] };
export const chatgptHome = (env = process.env) => env.CHATGPT_WEB_HOME || path.join(toolkitHome(env), 'chatgpt-web');
export function settings(config = {}) {
  const value = { ...CHATGPT_DEFAULTS, ...config.chatgptWeb };
  if (!Number.isFinite(value.minGapSeconds) || value.minGapSeconds < 0) throw new Error('chatgptWeb.minGapSeconds must be non-negative');
  if (!Number.isSafeInteger(value.maxPerHour) || value.maxPerHour < 1) throw new Error('chatgptWeb.maxPerHour must be a positive integer');
  if (!Array.isArray(value.strongest) || value.strongest.some(label => typeof label !== 'string' || !label.trim())) throw new Error('chatgptWeb.strongest must be an array of labels');
  return value;
}
export function readState(home) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { models: [], prompts: [], limits: {} };
    const limits = Object.fromEntries(Object.entries(value.limits ?? {}).filter(([, row]) => row && typeof row.notice === 'string').map(([model, row]) => [model, { notice: row.notice, ...(typeof row.nextAt === 'string' ? { nextAt: row.nextAt } : {}) }]));
    return {
      ...(typeof value.signedIn === 'boolean' ? { signedIn: value.signedIn } : {}),
      ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt } : {}),
      ...(typeof value.plan === 'string' ? { plan: value.plan } : {}),
      ...(typeof value.current === 'string' ? { current: value.current } : {}),
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
      ...(value.power && Number.isSafeInteger(value.power.now) && Number.isSafeInteger(value.power.max) && value.power.now >= 0 && value.power.max >= value.power.now && value.power.max <= 100 ? { power: { now: value.power.now, max: value.power.max } } : {}),
      models: Array.isArray(value.models) ? value.models.filter(label => typeof label === 'string') : [],
      prompts: Array.isArray(value.prompts) ? value.prompts.filter(at => typeof at === 'string' && Number.isFinite(Date.parse(at))) : [],
      limits,
    };
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return { models: [], prompts: [], limits: {} }; throw error; }
}
export function writeState(home, state) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'state.json'), temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export class PacedError extends Error {
  constructor(notice, nextAt) { super(notice); this.outcome = 'paced'; this.nextAt = nextAt; }
}
export function acquireLock(home, { kill = process.kill, pid = process.pid } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'session.lock'), owner = { pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' });
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = fs.readFileSync(file, 'utf8'); const lock = JSON.parse(previous); if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('unknown lock owner'); kill(lock.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH' && fs.readFileSync(file, 'utf8') === previous) { fs.unlinkSync(file); continue; }
      }
      throw new PacedError('Another ChatGPT web session is running; wait for it to finish');
    }
  }
  throw new PacedError('Another ChatGPT web session is starting; wait for it to finish');
}
export async function pace(state, config, { now = Date.now, sleep = delay } = {}) {
  let time = now();
  const recent = state.prompts.map(Date.parse).filter(at => at > time - 3_600_000).sort((a, b) => a - b);
  if (recent.length >= config.maxPerHour) throw new PacedError('ChatGPT web hourly prompt allowance reached', new Date(recent[recent.length - config.maxPerHour] + 3_600_000).toISOString());
  const last = Math.max(-Infinity, ...state.prompts.map(Date.parse));
  const remaining = last + config.minGapSeconds * 1000 - time;
  if (remaining > 0) await sleep(remaining);
}
export function recordSent(home, state, now = Date.now) {
  const time = now();
  state.prompts = [...state.prompts.filter(at => Date.parse(at) > time - 3_600_000), new Date(time).toISOString()];
  writeState(home, state);
}
export function activeLimit(state, label, now = Date.now()) {
  const entry = Object.entries(state.limits ?? {}).find(([model]) => model.toLowerCase() === label.toLowerCase())?.[1];
  if (!entry) return null;
  return !entry.nextAt || !Number.isFinite(Date.parse(entry.nextAt)) || Date.parse(entry.nextAt) > now ? entry : null;
}
