import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const bundled = fileURLToPath(new URL('../../backends/sound/', import.meta.url));

const file = value => { try { return typeof value === 'string' && fs.statSync(value).isFile(); } catch { return false; } };
const folder = value => { try { return typeof value === 'string' && fs.statSync(value).isDirectory(); } catch { return false; } };
export function soundDefaults(config) {
  const defaults = {};
  const soundDir = config.soundVenv ? path.dirname(config.soundVenv) : null;
  const mossTools = config.mossVenv ? path.join(path.dirname(config.mossVenv), 'tools') : null;
  if (!config.soundDir && soundDir && ['gen.py', 'finish.py'].every(name => file(path.join(soundDir, name)))) defaults.soundDir = soundDir;
  if (!config.mossTools && mossTools && ['moss_gen.py', 'peak_norm.py'].every(name => file(path.join(mossTools, name)))) defaults.mossTools = mossTools;
  if (!config.soundDir && !defaults.soundDir) defaults.soundDir = path.join(bundled, 'sao');
  if (!config.mossTools && !defaults.mossTools) defaults.mossTools = path.join(bundled, 'moss');
  return defaults;
}
export function venvPython(venv, { platform = process.platform } = {}) {
  if (!venv || !path.isAbsolute(venv)) return null;
  const candidates = platform === 'win32' ? [path.join(venv, 'Scripts', 'python.exe'), path.join(venv, 'Scripts', 'python')] : [path.join(venv, 'bin', 'python')];
  return candidates.find(file) ?? null;
}
export function soundTools(config, options = {}) {
  const filled = { ...config, ...soundDefaults(config) };
  const saoPython = venvPython(filled.soundVenv, options), mossPython = venvPython(filled.mossVenv, options);
  const script = (dir, name) => dir && path.isAbsolute(dir) && file(path.join(dir, name)) ? path.join(dir, name) : null;
  const result = {
    saoPython, mossPython,
    gen: script(filled.soundDir, 'gen.py'), finish: script(filled.soundDir, 'finish.py'),
    mossGen: script(filled.mossTools, 'moss_gen.py'), peakNorm: script(filled.mossTools, 'peak_norm.py'),
  };
  result.sao = Boolean(folder(filled.soundVenv) && saoPython && result.gen && result.finish);
  result.moss = Boolean(folder(filled.mossVenv) && mossPython && result.mossGen && result.peakNorm && saoPython && result.finish);
  return result;
}
