---
name: ask
description: Run one job on Codex, agy or DeepSeek (args: backend, then the task) and report the answer honestly.
---

# One job on one backend

Arguments: `<backend> <task>`. Backend is `codex`, `agy` or `deepseek`. If it's missing, pick by Lok's rules:
building code goes to `codex` (Astra), read-only audits/art checks/second opinions go to `agy`, and `deepseek` is
for cheap extra jobs.

## Write the prompt

Ground it first: exact files, the question or change, allowed files, and what "done" means. Put long prompts in a
file outside the target repo and pass `promptFile`. Never ask a worker to run tests, git or commits; you run them.

- **codex** edits `cwd` (workspace-write) unless `readOnly`. Defaults: model `astra`, effort `high`. Use `sol` for
  research or audits, `luna` for cheap checks against given ground truth, and `xhigh` effort rarely.
  To continue the same Codex session, pass `resume: <earlier runId>`.
- **agy is read-only. Never ask it for code.** Plan mode only. Default model `gemini-3.8-flash-low`. The runner
  adds the no-shell line ("use only your file-reading tool… never run shell commands"); keep it, because Flash
  reaches for the shell and gets denied. Point it at folders with `addDirs`/`cwd`. Use `jsonSchema` for
  structured output. At most 4 agy jobs at once.
- **deepseek** edits `cwd`. Models `deepseek-flash` (default) and `deepseek-v4-pro`.

## Run and wait

1. Call `fleet_ask` with the backend, the prompt, `cwd` and any options. It returns a `runId` and a `wait` command
   at once.
2. Start that `wait` command in a **background** shell. You'll be notified when it exits. Don't poll
   `fleet_status` in a loop.
3. Read the result from the wait output, or from `fleet_run` for the full answer. Use `fleet_transcript` only when
   you need to see what the worker did.

To redirect a running job, call `fleet_interrupt` and ask again (codex: `resume`). `fleet_steer` works only on
delegate runs.

## Report honestly

- `denied` (agy): agy refused a tool and **did nothing**. agy itself exits 0 in this case; the runner catches it.
  Don't retry it unchanged: tighten the prompt (file reads only), or move the job to codex.
- `failed`, `lost` or `interrupted`: say so, with the error. An empty answer is a failure, not a result.
- A codex `done` can still mean "I couldn't do it". Read the answer, and for edits check `git status` / the diff
  yourself before calling it done.
- Say which backend and model answered. Keep an answer apart from verification you ran yourself.
