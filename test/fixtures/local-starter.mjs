// Test-only stand-in for a launcher that exits while a server inherits its stdio.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [mode, root] = process.argv.slice(2);
if (mode === 'starter') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'server', root], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true, detached: true } /* like Start-Process: the real server outlives its launcher */);
  child.on('error', error => { fs.writeFileSync(path.join(root, 'spawn-error'), error.code ?? error.message); process.exitCode = 1; });
  // Exit only after the fake server confirms startup; no guessed startup sleep.
  child.once('message', message => { if (message === 'ready') { child.disconnect(); child.unref(); } });
} else if (mode === 'server') {
  fs.writeFileSync(path.join(root, 'server-pid'), String(process.pid));
  process.send?.('ready');
  const timer = setInterval(() => { if (fs.existsSync(path.join(root, 'stop-server'))) clearInterval(timer); }, 50);
} else if (mode !== undefined) throw new Error('invalid fixture mode');
