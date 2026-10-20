# Antigravity 1.4.2 output and classification

The captures supplied in `test/fixtures/agy-real/` are the source of truth for this change (2026-10-18). Stdout and stderr are separate. These captures were supplied by the reviewer; no real agy executable was run while implementing these fixes.

## JSON shapes

`plain-success.stdout.json`, exit 0 with empty stderr:

```json
{
  "conversation_id": "600c9c33-5803-427b-b497-f9daf56d8b2a",
  "status": "SUCCESS",
  "response": "42\n",
  "duration_seconds": 5.5977609,
  "num_turns": 1,
  "usage": {
    "input_tokens": 12585,
    "output_tokens": 2,
    "thinking_tokens": 0,
    "cache_read_tokens": 0,
    "total_tokens": 12587
  }
}
```

`structured-success.stdout.json`, exit 0, also contains `json_schema` and `structured_output`. Its `response` is prose; `structured_output` is a separate object with `guides` and `one_line_purpose`. Fleet keeps both, exposes the latter as `structured`, and maps `conversation_id` to `sessionId`. Both fields survive ask/fan and results.json. `--json-schema <string-or-path>` passes unchanged through ask/fan to agy (use an absolute path when changing --cwd).

`denied.stdout.json` is **exit 0 and status SUCCESS**, but its response is empty and it contains:

```json
{"denied_actions":[{"action":"command","display_name":"RunCommand"}]}
```

Its stderr begins `jetski: no output produced` and explains the missing command permission. Fleet reports `denied: RunCommand`, never the raw JSON as an answer. A denied target is a task failure, counts against failure usage, and stops without retry/failover. A ready account stays ready; an existing shared cooldown/login requirement is preserved.

`bad-model.stdout.json`, exit 1, has status ERROR, empty response, and a string error beginning `invalid model selection`. Stderr carries the model diagnostic. Fleet reports an ordinary error, not success or an account quota failure.

## Classification

Cancellation and timeout take precedence. Remaining outcomes use this order:

| Signal | Outcome / behavior |
|---|---|
| Non-empty denied_actions or stderr containing `no output produced` | `denied`; names display_name/action when available |
| Invalid JSON in json/stream-json mode | `error`: `invalid agy JSON output`; empty response, no raw fallback |
| Nonzero exit, execution error, status ERROR, or structured error | Classify error text plus stderr as `quota`, `auth`, or `error` |
| Exit 0, status SUCCESS, and non-empty trimmed response or present structured_output | `ok`; structured_output presence includes null/false |
| Empty response with no other signal | `error`: `empty agy response` |
| Non-empty response without status SUCCESS | `error`: `agy status is not SUCCESS` |

JSON mode requires one complete JSON object. Stream-json requires every nonblank line to be a JSON object and the final event to carry SUCCESS for a successful result. Real streaming captures have not been supplied; that path is tested synthetically. Raw-stdout fallback is available only with explicit outputFormat text. Denials, execution errors, quota and auth still apply to text mode.

`usage` is retained as `stats`. `tokensFrom` exposes inputTokens, outputTokens and (when present) thinkingTokens. Thinking is reported separately, not added to outputTokens: in the captures, total_tokens equals input_tokens plus output_tokens even when thinking_tokens is nonzero. Cache reads and original totals remain available in stats. Account and report totals use input/output without double counting thinking.

## Plan mode and shared login

agy supports **plan mode only** in Fleet. Code/default requests are rejected; no edit approval or permission-bypass flags are emitted. Batch/dispatch refuses agy up front, and auto code tasks consider Gemini only.

The default `agyPlanPreamble` is exactly:

```text
Use only your file-reading tool to open files. Never run shell or terminal commands.
```

It is prepended with a blank line. Set it to an empty string in config.json to disable it. The READY check defaults to gemini-3.8-flash-low (override with --model) and ignores case and trailing punctuation. Gemini's READY comparison stays exact after trimming.

agy remains one machine-wide login and health record; Fleet never rewrites HOME/USERPROFILE or switches credentials. `agyConcurrency` is a positive integer, default 4, preserved by setup. Within one fan, up to that many distinct targets can share agy and use different models, subject to --concurrency. Claims survive completion for the entire fan; excess targets explicitly fail with no_healthy_account. This does not impose a global semaphore across independent fan invocations. Gemini keeps one target per account. Quota cools the shared agy record; already-running targets finish and cannot clear that cooldown with a late success. Each target excludes every account it has already tried from later failover.
