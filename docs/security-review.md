# Security review — fleet 0.15.1

Review of command spawning, path reads, secrets, the merge guard, the installer, local listeners, prompt injection, vendored code, and `.github/workflows/ci.yml`. Clear, low-risk issues below are fixed in this branch and covered by tests. Design choices and higher-risk changes are documented and left as they are.

Severity is the impact if a hostile model, a hostile page, or a planted file in a worker directory is already in play. Fleet's MCP server is a local process the user launched. It is not a network service.

## Fixed

### 1. Windows current-directory executable planting — medium

**Where:** `core/lib/worker.mjs` (`resolveBareCommand`, `spawnWorker`); `vendor/dynamic-workflows-codex/src/worktree.js` (git). Also every driver path that spawns through `spawnWorker` (`runner/task-runner.mjs`, `runner/delegate.mjs`, `runner/fleet-runner.mjs`, `scripts/stage-ladder.mjs`, `runner/transports/exec.mjs`, `core/lib/toolkit.mjs` `launch`).

**Impact:** On Windows, `CreateProcess` / `SearchPathW` looks in the current directory before `PATH`. Fleet runs `git`, `powershell`, and `codex` with `cwd` set to a worktree the model can write. A planted `git.exe` or `powershell.exe` runs as the user when the driver verifies, merges, or starts DeepSeek. That is a sandbox escape: the worker is told not to run git, then the driver runs the planted binary.

**Fix:** Bare command names are resolved only from absolute `PATH` entries. `.` and other relative entries are skipped. An absolute path is passed to `spawn` / `execFile`. The vendored worktree helper uses the same resolver; the edit is recorded in `vendor/dynamic-workflows-codex/NOTICE.md`.

### 2. Transcript and answer reads followed symlinks and trusted `eventsPath` — medium

**Where:** `runner/lib/jobs.mjs` (`containedPath`, `transcriptRoots`, `answerOf`); `mcp/fleet-mcp.mjs` (status, transcript, delegate state); `runner/lib/operations.mjs` (`operationTranscript`).

**Impact:** `fleet_transcript`, `fleet_run`, and `fleet_status` are read-only MCP tools. Codex stores `eventsPath` on the run record and the transcript reader opened it with no root check. A run directory the worker can rewrite (or a symlink planted at `answer.txt`, `prompt.txt`, `reasoning.txt`, `events.jsonl`, or `state.json`) could return any file the fleet process can read, including keys and SSH material, back to the orchestrating model.

**Fix:** Those reads `lstat` the path, refuse symlinks, and require the real path to sit inside the run directory. Codex event logs may also sit in that run's own `runsDir/codex/<codexId>` folder when `codexId` is a single safe path segment. Anything else is rejected.

### 3. `codex/*` names outside the verdict charset skipped the merge guard — medium

**Where:** `scripts/merge-guard.sh` (the `codex/*` and `refs/heads/codex/*` arms); `scripts/merge-guard.ps1` (`Get-NormalizedCodexBranch`).

**Impact:** The guard only inspected names matching `codex/[A-Za-z0-9._/-]+`. Git allows other characters, including `+`. `git merge codex/foo+bar` in a repository fleet is already guarding was ignored, so an unreviewed branch merged through Claude's shell tool. Fleet itself cannot record a verdict for that name (`scripts/verdict-store.mjs` uses the same charset), so the branch could never become an approved exception.

**Fix:** Every `codex/*` merge operand is checked. In a known repository a name with no matching approval is blocked. Unknown repositories still fail open, as before.

### 4. Cmd shim arguments could contain a newline — low

**Where:** `core/lib/toolkit.mjs` `assertCmdShimArgs`, called from `launch`.

**Impact:** `.cmd` / `.bat` launches go through `cmd.exe`. The existing caret escaping covers `&`, `|`, quotes, and similar metacharacters. A raw CR, LF, or NUL in an argument starts a new command line. Prompts normally travel in files, but a model name, path, or other argv value with a newline would be enough.

**Fix:** `launch` refuses newline or NUL arguments to a cmd or bat shim before spawning.

### 5. Chrome and the Qwen starter inherited provider keys — low

**Where:** `core/lib/worker.mjs` `redactSecrets`; `core/lib/webchat/engine.mjs` (DevTools-pipe Chrome and the login window); `core/lib/local.mjs` `ensureLocalReady`.

**Impact:** `workerEnv` copies the parent environment and sets `FLEET_WORKER=1`. Chrome and `Start-Qwen.ps1` then saw `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, GitHub tokens, and the DPAPI path. A page opened by `fleet_shot`, or a local server the starter launches, could read those from the process environment.

**Fix:** Those two spawns drop environment names that look like API keys, secrets, passwords, tokens, or credentials, plus `TOOLKIT_DPAPI_FILE` and `FLEET_KEY_TARGET`. `PATH` and `FLEET_WORKER` stay. The API runner and `gh` are unchanged, because they need their own credentials.

### 6. DeepSeek's PowerShell wrapper searched for `node` in the current directory — low

**Where:** `core/bin/dsh-run.ps1`; `runner/lib/adapters.mjs` (deepseek command passes `-Node` with `process.execPath`).

**Impact:** On Windows, PowerShell command lookup checks the current directory. The wrapper invoked bare `node` while preparing a DeepSeek job whose working directory is the repo under edit.

**Fix:** Fleet passes its own Node executable. Manual runs that omit `-Node` still call `node`.

### 7. CI workflow token permissions were the repository default — low

**Where:** `.github/workflows/ci.yml`.

**Impact:** The workflow only checks out the repo and runs `node --test`. It has no secrets. A default `GITHUB_TOKEN` can still be broader than the job needs (for example if the repository's default is read/write).

**Fix:** `permissions: contents: read`.

## Reviewed, not changed

### Merge guard is an advisory seatbelt — by design

**Where:** `scripts/merge-guard.sh` lines 1–10 and the `exit 0` paths (missing `jq` or `git`, empty input, unknown repository, `git rev-parse` failure, nesting deeper than 4); `scripts/merge-guard.ps1` lines 1–2 and the matching `exit 0` paths; `hooks/hooks.json`.

**Impact:** The hook only sees Claude's Bash and PowerShell tool calls. It does not see a terminal the user types into. These cases still fail open:

- Git Bash / MSYS / Cygwin exits immediately (`merge-guard.sh` lines 7–10), so a Windows Bash tool is not checked. The PowerShell hook is the Windows path.
- `git rebase`, `git cherry-pick`, `git pull`, and merging a raw SHA or `origin/codex/...` are not treated as `git merge` of `codex/*`.
- A command nested more than four shells deep is ignored.
- Corrupt `approved.json`, a missing data directory, or a `rev-parse` that does not return a SHA fails open so a guard bug cannot block an unrelated merge.
- The guard is not a shell. It does not expand command substitution.

Tightening those would risk blocking ordinary merges when paths or verdict files are odd. The dispatch verdict protocol remains the real gate. Do not treat the hook as a security boundary.

### Installer auto-approve is read-only tools only

**Where:** `core/install-approvals.mjs` `approvalPlan` (about line 87); `mcp/fleet-mcp.mjs` tool annotations (the `.map` that sets `readOnlyHint`); `runner/lib/profile.mjs` `AUTO_APPROVE_POLICIES`.

**Impact:** Profiles only allow `none` or `read-only`. The installer writes Codex `approval_mode = "approve"` and agy `mcp(fleet/<tool>)` allow rules solely for tools with `readOnlyHint`: `fleet_runs`, `fleet_run`, `fleet_transcript`, `fleet_status`, `fleet_accounts`. It does not grant `fleet_ask`, `fleet_steer`, `fleet_interrupt`, `fleet_review`, `fleet_shot`, or `fleet_deploy_wait`. Removal deletes those read-only rules and leaves every other permission alone. The first edit of a settings file writes a `.fleet-backup`.

No code change. This matches the installer's stated policy.

### Workers still receive the parent environment

**Where:** `core/lib/worker.mjs` `workerEnv`.

**Impact:** Codex, the API runner, and `gh` need credentials that live in the environment (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GH_TOKEN`). Stripping those globally would break those backends. A worker that can read its own environment can read those keys. `FLEET_WORKER=1` is an environment flag, not a sandbox: a worker that spawns a process without `spawnWorker` can drop it. The MCP server hides ask, steer, interrupt, review, shot, and deploy-wait when the flag is set (`mcp/fleet-mcp.mjs` `WORKER_HIDDEN`).

Chrome and the Qwen starter are the exception fixed above. Leaving the rest of the environment intact is deliberate.

### OpenRouter key handling

**Where:** `core/lib/api.mjs` `readKey` and `scrub` (about lines 28–45); `install.mjs` `hiddenKeyPrompt` / `setKey` (about lines 353–371).

**Impact:** On Windows the key is decrypted by a fixed PowerShell script. The DPAPI path is an environment variable, not interpolated into the script. The plaintext is returned on stdout into the Node process and sent only as an `Authorization` header. `scrub` redacts the key, its URI encoding, and its JSON string escaping from provider responses. The installer prompt uses `Read-Host -AsSecureString` and does not put the key on argv. Non-Windows setups are told to set `OPENROUTER_API_KEY` outside the chat.

Residual: the decrypting PowerShell process still receives the parent environment, the plaintext exists in Node memory, and a provider or model that echoes the key in a form `scrub` does not recognize could land it in a transcript. The DPAPI file's ACL is whatever `WriteAllText` creates; the blob is encrypted to the Windows user. No change.

### Local Qwen and Chrome

**Where:** `core/lib/local.mjs` `localProvider` (loopback check, about line 24) and `ensureLocalReady` (System32 `powershell.exe` and `-File`); `core/lib/webchat/engine.mjs` `--remote-debugging-pipe`; `core/lib/browser-tasks.mjs` `staticServer` (`listen(0, "127.0.0.1")`).

**Impact:** Fleet does not open a public port. The screenshot helper binds `127.0.0.1` on an ephemeral port and rejects `..` and symlink escapes (`staticHandler`). Chrome is controlled over stdio pipes, not a TCP DevTools port, with a fresh temporary profile. The llama.cpp server is an external `Start-Qwen.ps1`; fleet only talks to a loopback URL and refuses other hosts. If that script listens on a non-loopback address, that is outside this repo.

`fleet_shot` `dir` and `url`, and `fleet_deploy_wait` `url`, are host-level network and filesystem capabilities. A prompt-injected orchestrator can screenshot an internal URL or a local folder. Those tools are not auto-approved. Restricting them to public sites would break local shots. No change.

### Prompt injection

**Where:** `runner/task-runner.mjs` `runVerify` (about line 324); `runner/delegate.mjs` `startVerify`; `core/lib/review.mjs` `reviewDiff` / `reviewPrompt`; `mcp/fleet-mcp.mjs` tool handlers.

**Impact:** Verify strings from task specs are shell commands by design (`sh -c` or `powershell -Command`). They run outside Codex's sandbox so the driver can run the real toolchain. A hostile spec is arbitrary code as the user. Review diffs are inlined into reviewer prompts with an instruction to treat them as data; findings are parsed and returned, not applied. Model text that comes back through `fleet_transcript` can still instruct the orchestrating agent to call another tool. That is indirect prompt injection at the host agent. Fleet does not have a second loop that executes model-suggested shell commands on its own, apart from verify.

`fleet_review` `diffFile` reads any absolute file the caller names and may send that text to reviewers (`core/lib/review.mjs`). That is the tool's contract, and the tool is not auto-approved. It is also an exfiltration path if the orchestrator is prompt-injected. No change.

### Dependencies, vendor, and Actions pins

**Where:** `package.json` (no dependencies); `vendor/dynamic-workflows-codex/`; `.github/workflows/ci.yml` (`actions/checkout@v4`, `actions/setup-node@v4`).

**Impact:** The runtime dependency tree is empty. The vendored app-server client is MIT, attributed, and recorded in `NOTICE.md`. One security edit is noted there. CI has no `pull_request_target`, no secrets, and now read-only token permissions. Actions are pinned to major tags on purpose (see `docs/briefs/2026-10-21-fleet-hardening.md`). A compromised tag could still change the action. Pinning commit SHAs would be a supply-chain hardening step, not a bug fix in this tree. No further change.

### Hard links and check-then-read races — low, residual

**Where:** `runner/lib/jobs.mjs` `containedPath`; `runner/lib/adapters.mjs` `artifactFiles`.

**Impact:** Symlinks are refused. A hard link inside the run directory is a normal file and will be read or copied. Replacing a file with a symlink between the `lstat` check and the read is possible for a process that can write the same directory. Both are same-user races. Closing them would mean hashing file identity against a known-good create, which is a larger design change. No change.
