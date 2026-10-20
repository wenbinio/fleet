# Brief: cross-model review, local models, screenshots and deploy checks (2026-10-21)

Repo `D:/claude-work/agent-toolkit`, work in `plugins/fleet` (the source of truth; it is pushed to its own repo as
a subtree). Usual rules: no commits, no live CLI/network/browser/GPU/model runs, Node built-ins only; Claude runs
the tests and the live checks. Every new tool description is one short sentence; always-on tokens matter.

## A. `fleet_review`: cross-model code review that saves Claude's context

- MCP tool + `fleet.mjs review`. Input: exactly one of `diffFile` (absolute path), `range` (`A..B`) or
  `branch` (+ optional `base`, default the repo's default branch) with `repo` (absolute git folder); optional
  `spec` (text), `reviewers` (list of `backend[:model]`), `minAgree` (default 2), `private` (boolean).
- Async like `fleet_ask`: returns `{runId, wait}` at once; a new run kind `review` in the shared history.
- The diff (from `git diff`, run by fleet, not the reviewers) is capped at 60 000 chars; above that refuse with
  "diff too large: narrow the range or review per file". Reviewers get the diff **inline** in the prompt (no repo
  access), read-only, with the spec, and must answer with JSON
  `{"findings":[{"file","line","claim","severity":"blocker|major|minor","failure"}]}` (`failure` = concrete
  scenario). Use the backend's structured output where it exists (agy `jsonSchema`; local/api `response_format`
  json); otherwise parse the first JSON object in the answer; unparseable → that reviewer `failed`.
- Default reviewers (from the profile, `review.reviewers`): `agy:gemini-3.8-flash-high`, `grok`, `api:free`.
  **Private** (caller `private: true`, or `repo`/diff paths matching any glob in the profile's
  `privatePaths`): never send to `api` free models; replace them with `local` when the local backend is on and
  ready, else drop them and say so. Paid api reviewers only when named with `maxCostUsd` (existing rule).
- Merge: two findings match when the file is the same, lines are within 5, and the claims share enough words
  (normalised word-set Jaccard ≥ 0.3, stopwords removed). Group transitively; a group's `by` is the distinct
  reviewers in it; keep the most severe severity and the longest failure scenario.
- Output (wait/`fleet_run`, compact by default): `{reviewers: [{id, status}], agreed: [{file, line, severity,
  claim, failure, by}]}` with only groups where `by.length ≥ minAgree`, most severe first, each claim ≤ 300 chars.
  Everything else (all raw findings, singles) stays in the run folder; `fleet_transcript` shows it.
- Tests: merge rules, private routing, size cap, structured/unstructured parsing, failure of one reviewer.

## B. Backend `local`: Ollama on this machine

- Facts (2026-10-21): Ollama 0.40.6 at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`, server on
  `http://localhost:11434` (OpenAI-compatible `/v1`, native `/api/ps`, `/api/tags`), no models yet. GPU: RTX 4070
  Ti SUPER, 16 GB; Windows uses ~3 GB. `nvidia-smi --query-gpu=memory.total,memory.used,memory.free
  --format=csv,noheader,nounits` works; per-process memory is not available on Windows.
- Reuse the `api` machinery: a provider entry `{name: "local", kind: "openai", baseUrl:
  "http://localhost:11434/v1", local: true}` needs no key; cost always 0; never "free model" privacy warnings
  (nothing leaves the machine). Model default from config `local.default` (Claude fills it after Lok picks);
  menu lists `/api/tags` models.
- Send `keep_alive: 0` (Ollama accepts it on its OpenAI endpoint as an extra field; if not, call the native
  `/api/chat` instead) so the model unloads after each job. `effort` → nothing (reject).
- **VRAM guard** before each local job: refuse with `gpu busy` when a fleet `sound` job is live; else read free
  VRAM; refuse with `not enough VRAM: need ~X GB, free Y GB` when free < model size (from `/api/tags` `size`) ×
  1.2 + 1 GB. And the reverse: a `sound` job refuses while a `local` job is live or `/api/ps` shows a loaded
  model. maxLive 1. Statuses as for api plus `gpu_busy`.
- Found/ready: server answers `/api/version`; models present. `install.mjs`: Ollama missing → needs-you
  (installer); no models → needs-you with the exact `ollama pull <model>` lines from the profile's `local.models`
  (multi-GB, Lok's yes); `OLLAMA_MODELS` is never changed by fleet (needs-you suggestion only).
- Tests: provider wiring, keep_alive, guard math and both directions, menu from tags, installer rows.

## C. `fleet_shot` and `fleet_deploy_wait`

Both reuse `core/lib/webchat/engine.mjs` (Chrome over `--remote-debugging-pipe`, no TCP port at all, so nothing
can collide with another session's Chrome on 9333 or any port), with a **fresh temp profile** per call (deleted
after), **headless** (`--headless=new`), and never attach to or kill another Chrome. Check the first tab is
`about:blank` before navigating.

- `fleet_shot`: `url` or `dir` (a local folder; serve it with a tiny built-in static server on 127.0.0.1 and a
  random free port, closed afterwards), `widths` (default `[390, 1440]`), `waitFor` (CSS selector, optional),
  `waitMs` (optional), `fullPage` (default true). For each width: set the device metrics (mobile emulation for
  < 768), load, wait, capture PNG to the run folder. Collect console errors and failed requests. Returns
  **paths only** plus `{width, height, consoleErrors: n}` and the first 5 error lines; never image data. Sync
  (seconds); still recorded as a run (kind `shot`).
- `fleet_deploy_wait`: `url` (site), `path` (file path on the site, e.g. `/index.html` or `/assets/app.js`),
  `marker` (text that must appear), optional `timeoutMin` (default 75), `intervalSec` (default 60),
  `repo` + `sha` (optional: also report GitHub check runs named like "Workers Builds" for that commit via
  `gh api repos/{owner}/{repo}/commits/{sha}/check-runs`). Fetch the file with the headless browser (bylok.ink
  refuses curl) with a cache-busting query; async (`{runId, wait}`); result `{found, minutes, checks?}`.
  Report only: never deploy, push or trigger anything.
- Tests: arguments, static server serves only the folder (no path traversal), width loop and mobile flag, paths-only
  result, marker polling with a fake fetcher and clock, gh check parsing, profile cleanup.

## D. Profile, docs, menu

`lok.json`: `review` defaults, `privatePaths: []`, `local: {models: [], default: null}`. Menu rows for `local`.
MCP: three new tools (`fleet_review`, `fleet_shot`, `fleet_deploy_wait`) with one-sentence descriptions and no
parameter descriptions unless unclear. Report briefly.
