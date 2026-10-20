# OpenRouter (the `api` backend)

One OpenAI-compatible backend for text-only jobs: a prompt in, an answer out. No file access and no editing.
Providers are entries in `~/.agent-toolkit/config.json` → `providers` (`name`, `kind: "openai"`, `baseUrl`,
`keyFile`, `keyEnv`); OpenRouter (`https://openrouter.ai/api/v1`) is the first. Other services are added as
entries, never as code.

Use `fleet_ask` with `backend: "api"`, or `bin/api-run`. Exit codes for `api-run`: 0 done, 1 failed, 3 denied
(bad or management key), 4 empty, 5 rate-limited or out of free requests for the day.

## The key

- Stored DPAPI-encrypted for Lok's Windows user at `~/.agent-toolkit/secrets/openrouter.dpapi` (made with
  `ConvertFrom-SecureString`). The runner decrypts it in memory and sends it only as a Bearer header. It never goes
  on a command line, in a log, a run record, a transcript, or a prompt to another agent. Fallback:
  `OPENROUTER_API_KEY`.
- Check it with GET `/api/v1/key` (setup and `fleet_accounts` do): type, credit limit and remaining,
  `free_model_daily_requests` used/limit. A **management/provisioning key** returns 401 on chat completions, so
  the runner refuses it up front.
- As of 2026-10-20: an inference key with a $10 limit, $10 of purchased credit (not free tier), 1000 free-model
  requests a day, expiring 2027-10-20.

## Free first, paid only by name

- No model, `free`, `auto` or `openrouter/free` → the **free router**. It picks a different free model on each
  call, so the run records the model that actually answered (the response's `model`, for example
  `nvidia/nemotron-3.5-super-vl:free`).
- An id ending in `:free` → that free model. `fleet.mjs models --free --n 3` picks free models from distinct
  vendors for a fan.
- Anything else is **paid**, including `openrouter/auto` (it can route to paid models). A paid model runs only when
  the job names its exact id **and** sets `maxCostUsd`. Paid use needs a reason in the brief.
- **No escalation:** a failed, empty or rate-limited free run never retries on a paid model.
- Every run records `usage.cost`; `fleet_runs` shows total spend and `fleet_accounts` shows credit remaining.

## Traps

1. **Empty answer, no error.** With `max_tokens: 20`, a reasoning free model spent the whole budget thinking and
   returned empty `content`. With 400 it answered. The runner leaves `max_tokens` unset for free models, reports
   empty content as `empty` (never as done), and saves `reasoning` separately.
2. **Rate limits.** About 20 requests a minute on `:free` models (third-party figure, unverified), plus the daily
   free allowance. A 429 is retried on the same model with backoff; an exhausted daily allowance is its own outcome,
   `daily_limit`, with no retry.
3. **Free models may log or train on what you send.** Never send private material to a `:free` model or the free
   router: client work, school documents, unreleased work, keys, anything Lok hasn't published. Use Codex, or a
   paid model whose provider doesn't train on prompts, when the material is private.
4. **Some `:free` models refuse plain API calls**: `thinkingmachines/inkling:free` and `inkling-small:free` answer
   "only available on agentic harnesses". That run is `failed` (not `denied`, which means a rejected key), and the
   model goes into `~/.agent-toolkit/cache/openrouter-unusable.json`; the free picker skips it for 7 days.
5. **Bad model ids** come back as HTTP 400 with `{"error":{"message":"… is not a valid model ID"}}`.

Real samples: `test/fixtures/openrouter-real/`.
