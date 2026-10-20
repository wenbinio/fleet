---
name: fan
description: Send one read-only prompt to several backends or models at once (args: backend:model targets), then compare and synthesize their answers.
---

Fleet root: use `${CLAUDE_PLUGIN_ROOT}` in Claude Code; elsewhere use the fleet root in your AGENTS.md fleet block. Set `FLEET_ROOT` to that path for the commands below.

# One prompt, several answers

Arguments: the targets, written `backend[:model]`, for example `agy:gemini-3.8-flash-low grok codex:sol
api:free api:free api:free`. With no targets, use three free api models from different vendors:
`node "${FLEET_ROOT}/runner/fleet.mjs" models --free --n 3`.

1. Write one grounded, **read-only** prompt. Every target gets the same prompt. Codex targets get
   `readOnly: true`. agy and grok are read-only by design and must never be asked for code. api targets see only
   the prompt text, so put the material into it.
   - Free api models may log or train on what they get. **Never fan private material** (client work, school
     documents, unreleased work) to them.
   - A paid api model needs its exact id, `maxCostUsd` and a reason.
   - `local` keeps text on the existing Qwen / llama.cpp server and shares the GPU with sound; one local job at a time.
2. Call `fleet_ask` once per target. agy and grok allow 4 live jobs each, and api allows 8; `fleet_ask` refuses
   more than that.
3. Start one background `wait` with every runId (`node "${FLEET_ROOT}/runner/fleet.mjs" wait <id1> <id2> …`).
   Don't poll. It exits 1 if any target failed; the output still has every answer and error.
4. Read the answers from the wait output; `fleet_run` only for one that was trimmed.

## Synthesize

Keep each answer as written. Then give: where they agree, where they disagree, claims none of them supports, and
the best-supported answer. Attribute every substantive difference to its target: backend and the model that
actually answered (the free router picks one per call). List failed targets: a `denied` agy or grok job did nothing
(both exit 0 on refusals; the runner catches it). An `empty`, `rate_limited` or `daily_limit` api job is a failure
too; never refill its slot with a paid model or a guess. Give the total api cost.
