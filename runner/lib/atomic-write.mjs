import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// On Windows, replacing a file fails while any reader holds it open (even a Node
// reader, which shares delete). Status pollers such as a narrator reading
// state.json every few seconds make that a routine race, not a fatal error.
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;
const RENAME_BACKOFF_MS = 20; // linear: 20, 40, ... 180 ms, about 0.9 s in total

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      if (!BUSY_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) throw error;
      await delay(RENAME_BACKOFF_MS * attempt);
    }
  }
}

export async function atomicWrite(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await renameWithRetry(temporary, filePath);
    } catch (error) {
      if (!BUSY_CODES.has(error?.code)) throw error;
      // The target is still held open. Readers that share write access (most do)
      // still allow an in-place write; it is not atomic, but a reader that sees a
      // torn file retries, while a lost state update would leave callers stale.
      try {
        await fsp.writeFile(filePath, contents, "utf8");
      } catch (fallbackError) {
        throw Object.assign(
          new Error(`cannot replace ${filePath}: ${error.message}; direct write failed: ${fallbackError.message}`, { cause: error }),
          { code: fallbackError.code },
        );
      }
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
