---
name: ask
description: Run one job on codex, agy, grok, deepseek or api (OpenRouter) — args: backend, then the task — and report the answer honestly.
---

# One job on one backend

Arguments: `<backend> <task>`. If the backend is missing, pick by Lok's rules: building code goes to `codex`
(Astra); read-only audits, art checks and second opinions go to `agy` (cheap) or `grok`; `deepseek` takes cheap
extra jobs; `api` is for text-only questions to many models (free by default).

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
- **grok is read-only too.** Its sandbox doesn't work on Windows, so the runner removes its shell and write tools.
  Default model `grok-4.7`. Each call costs tens of thousands of tokens, so ask everything in one prompt. To
  continue a session, pass `resume: <earlier grok runId>`. At most 4 at once.
- **deepseek** edits `cwd`. Models `deepseek-flash` (default) and `deepseek-v4-pro`.
- **api** sends text only: no files, no `cwd`. Put what it needs into the prompt.
  - With no model it uses OpenRouter's **free** router and records which model answered.
  - A paid model runs only if you name its exact id and set `maxCostUsd`, and only for a reason you state.
  - **Never send private material to free models** (client work, school documents, unreleased work, keys): they
    may log or train on it.

## Run and wait

1. Call `fleet_ask` with the backend, the prompt, `cwd` and any options. It returns a `runId` and a `wait` command
   at once.
2. Start that `wait` command in a **background** shell. You'll be notified when it exits. Don't poll
   `fleet_status` in a loop.
3. Read the result from the wait output, or from `fleet_run` for the full answer. Use `fleet_transcript` only when
   you need to see what the worker did.

To redirect a running job, call `fleet_interrupt` and ask again (codex and grok: `resume`). `fleet_steer` works
only on delegate runs.

## Report honestly

- `denied`: the worker was refused and **did nothing**. agy and grok both exit 0 in that case (grok stops with
  `cancelled`); the runner catches it. Don't retry unchanged: keep the prompt to reading files, or move the job
  to codex. For api, `denied` means the key was rejected.
- `empty` (api): the model returned no answer; its reasoning is saved separately. `rate_limited` and `daily_limit`
  (api): say so, and never switch to a paid model to get around them.
- `failed`, `lost` or `interrupted`: say so, with the error. An empty answer is a failure, not a result.
- A codex `done` can still mean "I couldn't do it". Read the answer, and for edits check `git status` and the diff
  yourself before calling it done.
- Say which backend and model answered (for api, the model that actually answered, and the cost). Keep an answer
  apart from verification you ran yourself.
