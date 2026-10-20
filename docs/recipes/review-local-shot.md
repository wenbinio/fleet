# Reviews, local models and browser checks

Run commands from the fleet folder. MCP tools accept the corresponding camelCase options.

```bash
node runner/fleet.mjs review --repo /absolute/repo --range HEAD~1..HEAD
node runner/fleet.mjs review --repo /absolute/repo --branch feature --base origin/trunk --private
node runner/fleet.mjs review --repo /absolute/repo --diff-file /absolute/change.patch --reviewer codex:sol --reviewer agy
node runner/fleet.mjs shot --dir /absolute/site --widths 390,1440 --wait-for main
node runner/fleet.mjs shot --url https://example.com --no-full-page
node runner/fleet.mjs deploy-wait --url https://example.com --path /assets/app.js --marker COMMIT --timeout-min 75
node runner/fleet.mjs wait RUNID
```

Reviews and deploy waits return `{runId, wait}` immediately. Screenshots complete synchronously and return PNG
paths, dimensions, error counts and the first five error lines. All three appear in the same run history and
support run, status, transcript and interrupt. These tools start work and are never auto-approved by the installer.

Reviews accept exactly one of `diffFile`, `range` (`A..B`), or `branch`. Branch mode compares against `base` or the
repository's `origin/HEAD`; if that default is unavailable, supply `base`. Diffs over 60,000 characters are refused.
Optional `spec` is inline text. Reviewers receive the diff in their prompt. Codex and DeepSeek receive an empty
scratch directory rather than the repository, and Codex uses its read-only sandbox. Reviewers are instructed to
report concrete failures in JSON. A failed or malformed reviewer remains visible alongside successful reviewers.

Profile `review.reviewers` defaults to `agy:gemini-3.8-flash-high`, `grok`, `api:free`; disabled backends are dropped.
`minAgree` defaults to two distinct reviewer IDs. Each group holds at most one finding per reviewer. Findings are
anchored to changed lines in their own file before grouping. Every changed line is scored by identifier, number and
operator overlap with the claim plus failure. Ties prefer the reported line, then the nearest line, then the lowest
line. A reported changed line moves when another line scores higher. With no overlap, the reported changed line
stays or the nearest changed line is used. Replacement blocks use added text; pure deletions use deleted
text at the new-file position. Moved findings record `reportedLine`; original answers remain unchanged. Findings are
processed in file/line order and assigned to the group with the nearest matching member, keeping the earlier group
on equal distances; existing groups are never joined. Members match in the same file when lines differ by at most
two, or by at most eight with word-set Jaccard similarity of at least 0.15 across claim plus failure text after
stopword removal. The representative line and claim come from the most severe member, with lowest line breaking
severity ties. The compact result contains only agreed groups, most severe
first; raw answers and single-reviewer findings remain in the transcript. When fewer than `minAgree` reviewers
answer, the result explicitly says agreement is impossible and includes up to ten `unconfirmed` findings.
Quota failures remain `limit` (or the backend's specific rate/daily-limit status), not a clean review.
agy reviews disable its normal file-reading preamble and receive a no-tools first line plus its structured-output schema.

Privacy defaults to false. Set `private: true` / `--private` for private material, or configure profile `privatePaths`
globs such as `["D:/private/**", "**/secrets/**"]`. Matching covers repository, diff-file and changed paths, including
deleted and renamed files. An explicit false does not override a matching private glob. Free API reviewers are then
replaced by the configured local default only when installed and ready; otherwise they are dropped with a notice.
There is no remote fallback. Paid API reviewers require their exact model ID and `maxCostUsd` / `--max-cost`; this is
a cap for **each** paid reviewer, not a shared total. Choose the paid reviewer deliberately and explain why.

The `lok` profile enables local inference; `minimal` disables it. Root precedence is `FLEET_LOCAL_ROOT`, config
`local.root`, legacy `local.folder`, then `D:/AI/Qwen3.8-Abliterated` on Windows only. Other platforms require an
explicit root. An override also replaces a starter path saved by setup. The existing installation uses
`Huihui-Qwen3.8-27B-abliterated-UD-IQ3_S.gguf` (11.95 GB). Setup configures its
model alias and starter when that folder exists; it never copies the GGUF, imports it into Ollama or downloads
another copy. The provider representation is:

```json
{"name":"local","kind":"openai","baseUrl":"http://127.0.0.1:8088/v1","local":true,"engine":"llama.cpp","model":"Huihui-Qwen3.8-27B-Abliterated","start":{"shell":"powershell","file":"D:/AI/Qwen3.8-Abliterated/Start-Qwen.ps1"}}
```

Only loopback URLs are accepted. Found means the folder and start script exist; ready additionally requires
`checks/model.json` with `verified: true`. Setup and menu inspect these files without starting the server. The alias
is still listed when found but unverified. Before inference, fleet checks `/health`, reuses a healthy endpoint,
otherwise starts hidden PowerShell `-File Start-Qwen.ps1` without `-OpenChat`. The executable is resolved from
`SystemRoot` (fallback `C:\Windows`); the inherited environment is preserved. Stdin is ignored and stdout/stderr
go directly to the run's `local-start.log`, never pipes. Windows startup is not detached; POSIX startup is. Fleet polls
health every second with its own 240-second deadline, independent of starter exit or inherited pipe EOF.
Both `ok` and `no slot available` mean ready (including HTTP 503 for the latter). Failure points to the configured
installation's `logs` folder and includes the last 1000 starter-log characters. Spawn errors and exit codes are
appended to `run.json` notes; a failed spawn or nonzero exit before readiness fails promptly. Exit zero alone does
not imply readiness. `fleet_status` exposes `starting-server`, `waiting-ready`, and `generating` phases.
Generation has a separate 20-minute request timeout, including response-body reading; override it with job
`timeout` or CLI `--timeout SECONDS`. Fleet leaves the model server running after a job.

Use `fleet ask --backend local --prompt TEXT [--effort low|medium|high]`. Effort maps to `reasoning_effort`; absent
effort leaves the server's medium default intact. There is no key, pricing lookup, remote fallback or `keep_alive`
on llama.cpp. Fleet never calls the stop script after a job. The supplied server uses `--fit on`, leaves 768 MiB
free, and offloads layers to CPU; under 12 GB free while unloaded produces a note rather than a refusal.

Local and sound jobs reserve the GPU mutually. Sound also checks Qwen's `/props.is_sleeping`: a loaded model
blocks sound until five idle minutes have released VRAM, or Lok uses `Stop Model.cmd`. An unavailable sleep
status fails closed; a refused connection means Qwen is not running.

Setup migrates a previous default Ollama entry to a named optional provider and makes Qwen the default when its
folder exists. Explicit Ollama configurations remain usable with `--backend local --provider ollama --model MODEL`.
That alternative keeps `/api/tags`, `/api/ps`, the VRAM size check and `keep_alive: 0`; it is never an automatic
fallback. Fleet never changes `OLLAMA_MODELS`.

Screenshots default to widths 390 and 1440, with mobile emulation below 768 and full-page capture. `dir` must be
absolute; the temporary static server permits only files within that directory, including after symlink resolution.
`waitFor` is a CSS selector; `waitMs` adds a delay. Chrome always starts headless with its own temporary profile and
DevTools pipe, verifies its first tab is blank, and closes on success or failure. A single profile under
`os.tmpdir()/fleet-chrome-*` is used for the whole run. Cleanup waits for confirmed process exit, then retries removal
ten times at 300 ms intervals. A locked profile produces a recorded cleanup note without turning a completed run
into a failure; an unconfirmed process exit leaves the profile intact.

Deploy wait checks the same-site `path` with a fresh cache-busting query every 60 seconds for up to 75 minutes.
Each browser fetch has a bounded timeout. Optional `repo: "owner/repo"` and commit `sha` add read-only GitHub
Workers Builds check results through `gh api`. A timeout returns `found: false`; it never pushes, retries a build
or deploys. No browser profile, existing Chrome process or debugging TCP port is reused.
