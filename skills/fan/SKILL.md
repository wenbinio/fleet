---
name: fan
description: Send one read-only prompt to several backends or models at once (args: backend:model targets), then compare and synthesize their answers.
---

# One prompt, several answers

Arguments: the targets, written `backend[:model]`, for example `agy:gemini-3.8-flash-low agy:claude-sonnet-4-6
codex:sol deepseek:deepseek-v4-pro`. With no targets, use three agy jobs on `gemini-3.8-flash-low`.

1. Write one grounded, **read-only** prompt in a file outside the repo. Every target gets the same prompt.
   Codex targets get `readOnly: true`. agy is read-only by design and must never be asked for code. Its runner adds
   the no-shell line, so keep the prompt about reading files.
2. Call `fleet_ask` once per target. agy allows at most 4 jobs at once, and `fleet_ask` refuses a fifth.
3. Start one background `wait` with every runId (`node "<fleet.mjs>" wait <id1> <id2> …`). Don't poll.
4. Read each answer (the wait output, or `fleet_run`).

## Synthesize

Keep each answer as written. Then give: where they agree, where they disagree, claims none of them supports, and
the best-supported answer. Attribute every substantive difference to its target (backend and model). List failed
targets: an agy `denied` did nothing (agy exits 0 on denials; the runner catches it), and an empty answer counts as
a failure. Never fill a failed target's slot with a guess.
