# Fleet

Version **0.15.1**. Public repository, [MIT](LICENSE).

Fleet is one MCP server, plus skills and a small rules block, that runs many model backends from one menu and one run history. Claude Code also gets a plugin: skills, two subagents, and a merge-guard hook. Codex, Grok, agy, Cursor, and any other MCP client use the same server.

Backends: **codex**, **agy**, **grok**, **deepseek**, **chatgpt** (the web app), **api** (OpenRouter), **local** (Qwen via llama.cpp), **image**, **advisor** (Gemini web / Argon), and **sound** (local Stable Audio Open or MOSS). A profile can turn any of them off. Disabled backends leave the tool schema and cannot start jobs.

The old Claude→Codex-only plugin lived in `wenbinio/claudeorchestratortocodex` and stopped at 0.6.2. That repository was imported here and retired. This tree is the product: several backends, any harness, and the original verified-Codex dispatch path still available as one workflow.

## Install

Requirements: Node 24 LTS or newer (even-numbered LTS; odd majors warn but still run), and git. `package.json` sets `"node": ">=24"`.

```bash
git clone https://github.com/wenbinio/fleet.git
cd fleet
node install.mjs --plan --json
node install.mjs --apply
```

`--plan` only reports. Each step is `done`, `auto`, `warn`, or `needs-you`. `--apply` performs the `auto` steps. It does not log in, install remote CLIs, change `PATH`, download models, or type an API key.

```bash
node install.mjs --apply --profile lok          # all backends; hosts claude, codex, grok, agy
node install.mjs --apply --profile minimal      # codex + api; host claude; no auto-approve
node install.mjs --apply --host codex           # add one harness
node install.mjs --apply --off grok             # a subscription lapsed
node install.mjs --remove --host codex          # unregister that host
node install.mjs --remove --purge               # also delete shared fleet data
node install.mjs --set-key openrouter           # Windows: hidden prompt, DPAPI file
node install.mjs --with sound                   # print the manual sound recipe; does not download
```

Hosts are `claude`, `codex`, `grok`, `agy`, `cursor`, and `generic`. `generic` prints MCP JSON to paste. agy gets the MCP server only, until it has a documented place for rules and skills.

What you still do yourself (`needs-you`):

| Backend | Command |
| --- | --- |
| codex, image | `codex login` |
| agy | install the Antigravity CLI, then `agy` |
| grok | install from the xAI docs, then `grok login` |
| deepseek | install DeepSeek Harness and sign in |
| chatgpt | `node core/lib/webchat/chatgpt.mjs login` |
| advisor | `node backends/advisor/advisor.mjs login` |
| api | `node install.mjs --set-key openrouter` on Windows, or set `OPENROUTER_API_KEY` anywhere else |
| local | point `FLEET_LOCAL_ROOT` or `local.root` at an existing Qwen install. Do not copy the GGUF |
| sound | the printed recipe (several GB, pinned revisions) |

`--set-key` stores the OpenRouter key with Windows DPAPI. The key is not an argument, not printed, and not written into the installer receipt. Elsewhere, set `OPENROUTER_API_KEY` in a private shell or secret store. Do not paste it into chat.

### Claude Code plugin

From an interactive Claude Code session, the marketplace in this repo is `agent-toolkit` and the plugin is `fleet`:

```text
/plugin marketplace add wenbinio/fleet
/plugin install fleet@agent-toolkit
/fleet:setup
```

`wenbinio/claudeorchestratortocodex` is the retired pre-split repo. Do not add it.

Cloud sessions cannot run `/plugin`. Check this into `.claude/settings.json` in a repo that should load Fleet:

```json
{
  "enabledPlugins": { "fleet@agent-toolkit": true },
  "extraKnownMarketplaces": {
    "agent-toolkit": {
      "source": { "source": "github", "repo": "wenbinio/fleet" }
    }
  }
}
```

Add `OPENAI_API_KEY` as an environment secret when Codex should run in that sandbox. Without it, dispatch falls back to Claude subagents under the same verify and review rules. Cloud data may not persist; rerun setup if the data directory is empty. Cloud hook behavior has not been confirmed on a real claude.ai session. See [docs/cloud-validation.md](docs/cloud-validation.md).

## Usage

Day to day, any MCP client calls the tools. Claude Code can also use the skills.

| Tool | What it does |
| --- | --- |
| `fleet_ask` | Start one backend job and return a wait command |
| `fleet_runs` / `fleet_run` | List jobs, or read one result |
| `fleet_status` / `fleet_transcript` | Live beats, or the stored transcript |
| `fleet_steer` / `fleet_interrupt` | Delegate steering, or interrupt a job |
| `fleet_accounts` | Models and sign-in, without logging in |
| `fleet_review` | Send one diff to several reviewers; return agreed findings |
| `fleet_shot` | Responsive PNGs in a fresh headless Chrome |
| `fleet_deploy_wait` | Poll a deployed URL for a marker; optionally read GitHub checks |

Read-only tools are `fleet_runs`, `fleet_run`, `fleet_transcript`, `fleet_status`, and `fleet_accounts`. The others start or change work.

The same commands exist on the CLI:

```bash
node runner/fleet.mjs ask --backend codex --prompt "…" --cwd /absolute/repo
node runner/fleet.mjs review --repo /absolute/repo --range HEAD~1..HEAD
node runner/fleet.mjs shot --url https://example.com --widths 390,1440
node runner/fleet.mjs deploy-wait --url https://example.com --path /assets/app.js --marker COMMIT
node runner/fleet.mjs wait RUNID
node runner/fleet.mjs runs
node runner/fleet.mjs accounts
```

Direct runners, when you are not going through a job:

```bash
node core/lib/runners.mjs codex-run <id> <prompt-file> --cwd DIR
node core/lib/runners.mjs agy-run <prompt-file>
node core/lib/runners.mjs grok-run <prompt-file> --json
node core/lib/runners.mjs api-run <prompt-file> --model openrouter/free
node core/lib/runners.mjs image-api-run PROMPT --model ID --max-cost USD
node core/lib/webchat/chatgpt.mjs ask <prompt-file>
node backends/advisor/advisor.mjs ask <prompt-file>
```

Recipes for each backend's traps are in [docs/recipes/](docs/recipes/).

### Claude Code skills

`ask` (one job), `fan` (one read-only prompt, several models), `dispatch` (verified Codex worktrees, review, staged integrate), `delegate` (live Codex in your tree, steerable), `setup` (the installer, once per machine). A single verified task is a dispatch batch of one (`runId` starting with `solo-`). There is no separate `solo` skill.

Dispatch still means: Claude writes a grounded spec, a Codex worker edits an isolated worktree, the driver runs verify outside Codex's sandbox, a reviewer re-runs verify, and only an `approve` for that exact tip is integrated. Default integration is `stage`: a temp-commit ladder, re-verify each rung, then `git reset --soft` so your tree gets one staged diff and no fleet commits. `commit` leaves merge commits. `manual` leaves the branches.

The standalone batch runner does the worker half only (worktrees, Codex turns, verify, one correction, commit, transcripts). Review and integrate stay with the dispatch skill:

```bash
node runner/fleet-runner.mjs --batch batch.json
node runner/fleet-runner.mjs --resume batch.json
node runner/fleet-runner.mjs --probe
node runner/fleet-runner.mjs --smoke
node runner/fleet-runner.mjs --cleanup batch.json
```

Worker isolation defaults to `plugins-off` (`--disable plugins` and `mcp_servers.node_repl.enabled=false`, and fleet's own MCP server disabled for that invocation). `ignore-user-config` drops user config and needs an explicit model. `none` keeps plugins. On Windows, `windowsSandbox` may be `elevated` or `unelevated`; unset leaves the user's setting. `unelevated` is a weaker sandbox and is recorded only when setup is passed `--allow-unelevated`.

## Configuration

| Location | Role |
| --- | --- |
| `FLEET_HOME` or `AGENT_TOOLKIT_HOME` | Toolkit home. Default `~/.agent-toolkit` |
| `$FLEET_HOME/config.json` | Providers, tool paths, advisor home, sound venvs |
| `$FLEET_HOME/fleet/` | Shared runs, `profile.json`, `hosts.json`, `approved.json` |
| `$FLEET_HOME/secrets/openrouter.dpapi` | Windows DPAPI blob for the OpenRouter key |
| `$FLEET_HOME/fleet/profile.json` | Per-machine backend overrides for the active profile |
| `profiles/lok.json`, `profiles/minimal.json` | Shipped profiles |

`lok` turns every backend on, targets Claude, Codex, Grok, and agy, and sets `autoApprove` to `read-only`. `minimal` is Codex and API, host Claude, `autoApprove` `none`. Overrides in the machine `profile.json` win over the shipped file for that same profile name.

Local model root, first match wins: `FLEET_LOCAL_ROOT`, then config `local.root`, then legacy `local.folder`, then `D:/AI/Qwen3.8-Abliterated` on Windows only. Other platforms have no default. The server fleet expects is `http://127.0.0.1:8088/v1`. Ollama is used only when a provider is explicitly configured with engine `ollama` or port 11434. Fleet does not import or download the GGUF.

`FLEET_WORKER=1` is set on every child. Those processes keep the read-only tools and cannot start, steer, or interrupt jobs. Ask, review, shot, and deploy-wait refuse them on the CLI as well.

Removing a host deletes Fleet's registration and the read-only approval rules it added. History stays unless `--purge` is explicit. `--purge` deletes only `$FLEET_HOME/fleet` and refuses any other path. Legacy `~/.claude/plugins/data/fleet-agent-toolkit` is copied into the shared folder on first use and left in place.

The first time the installer changes a Codex or agy settings file, it writes `<file>.fleet-backup` with the original bytes.

## Security model

Fleet treats model output as untrusted supply, and it is not itself a sandbox around the user.

**Merge guard.** `hooks/hooks.json` runs `scripts/merge-guard.sh` before Claude's Bash tool and `scripts/merge-guard.ps1` before the PowerShell tool. It blocks `git merge` and `git merge --squash` of `codex/*` when the repo has verdicts and the branch tip is missing, not `approve`, ineligible, or no longer the reviewed SHA. Fleet only records verdicts for `codex/[A-Za-z0-9._/-]+`. This is an advisory seatbelt for Claude's own tools. It does not see your terminal. Rebase, cherry-pick, pull, and merging a raw SHA are not matched. Unknown repositories, missing tools, corrupt `approved.json`, and internal guard errors fail open so a bug cannot block an unrelated merge. The verdict file written by dispatch is the real gate.

**Approvals.** The installer never grants ask, steer, interrupt, review, shot, or deploy-wait. For `autoApprove: "read-only"` it writes Codex `approval_mode = "approve"` and agy `mcp(fleet/<tool>)` only for the five read-only tools. `none`, or removing a host, deletes those rules. Other permissions in the file are left alone. Claude stays interactive. Grok has no per-tool approval setting fleet can write.

**Secrets.** The OpenRouter key is a DPAPI file or `OPENROUTER_API_KEY`. Decrypt uses a fixed PowerShell script; the path is an environment variable, not part of the script text. The key is sent as a Bearer header. Provider responses are scrubbed for the key and its JSON/URI encodings. Do not put the key in a prompt, a commit, or a log.

**Network.** The MCP server is stdio. The screenshot helper listens on `127.0.0.1` only, for the duration of a shot, and rejects path traversal. Chrome is attached with `--remote-debugging-pipe` and a throwaway profile, not a TCP debugging port. Local inference must be a loopback HTTP URL; the default is `127.0.0.1:8088`. Fleet does not bind a public port.

**Workers.** Children get `FLEET_WORKER=1` and the parent environment. Backends that need a key (API, Codex, `gh`) keep it. A worker that can read its environment can read those variables. Codex workers default to plugins off and fleet MCP disabled for that invocation.

`fleet_review` with `private: true`, or a path matching profile `privatePaths`, does not send the diff to a free API reviewer. It uses local Qwen when that backend is ready, or drops the reviewer with a notice.

## Limitations

- The merge guard is not a security boundary. See above.
- Codex's sandbox cannot reliably run the project's toolchain. Task specs must not ask the worker to run tests. The driver verifies outside the sandbox.
- Verify commands are shell strings (`sh -c` or `powershell -Command`). They are the driver's on purpose, and a hostile spec is code execution as the user.
- `fleet_shot` and `fleet_review` can read local files and reach the network from the host. They are not auto-approved. A prompt-injected orchestrator can still call them if the host allows it.
- Single-machine facts (absolute tool paths, the Qwen folder, browser profiles) stay in the data directory, never in git.
- Cloud sandbox loading, the POSIX driver path on a second machine, and cloud merge-guard behavior have not been signed off by a recorded live run. [docs/cloud-validation.md](docs/cloud-validation.md) is the checklist.
- Sound installs are manual, multi-gigabyte, and pinned. The installer only prints them.
- GitHub Actions in this repo runs `node --test` on Ubuntu and Windows. It does not deploy.

## Development

```bash
npm test
```

That is `node --test`. The suite fakes Codex, Chrome, and the network. CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (Node 24, Ubuntu and Windows). No npm dependencies are installed.

Do not commit sign-ins, API keys, browser profiles, or run output.

## Attribution

`vendor/dynamic-workflows-codex/` is vendored from [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex) (MIT, © Stephen Casella). See [`vendor/dynamic-workflows-codex/NOTICE.md`](vendor/dynamic-workflows-codex/NOTICE.md). Fleet does not claim those files.

## License

[MIT](LICENSE). Copyright 2026 wenbinio. Vendored files keep their upstream MIT license.

## Changelog

Rebuilt from git history. There are no release tags. Versions below are the ones named in commit subjects. The 0.6.2 line is the imported Claude→Codex plugin; everything after it is this multi-backend server.

- **0.15.1** — CI on Ubuntu and Windows, Node 24 baseline, MCP `initialize` negotiates a supported protocol version and answers `ping`, sound installs pinned to lockfiles and fixed upstream revisions.
- **0.15.0** — Server and README version bump, then OpenRouter image generation: price the endpoint first, require an exact model id and `maxCostUsd`, write image files, record actual cost. Codex remains the default image provider.
- **0.14.1** — `fleet_review` across models with agreement on changed lines; private reviews prefer local Qwen. Local backend drives llama.cpp on 127.0.0.1:8088 and does not stop it. `fleet_shot` and `fleet_deploy_wait` use headless Chrome over a DevTools pipe.
- **0.13.0** — agy as a host. Profile `lok` auto-approves read-only fleet tools in Codex and agy. Tools that start or change work still ask.
- **0.12.0** — `effort` for OpenRouter (`reasoning.effort`) and advisor (Argon thinking level), from one rules table. ChatGPT web refuses effort.
- **0.11.0** — Standalone tree: runners, OpenRouter client, browser engine, advisor, and sound scripts live in this repo. One data home at `~/.agent-toolkit/fleet`. `install.mjs` plans and applies per host and profile. Workers carry `FLEET_WORKER=1` and cannot start jobs.
- **0.10.1** — ChatGPT web selectors taken from a signed-in page probe. Each job uses a Temporary chat unless `keepChat` is set.
- **0.10.0** — ChatGPT web backend on the shared browser engine. Paced (one at a time, 20s apart, 30 an hour). Strongest model only; a limit is reported, not a silent downgrade.
- **0.9.1** — Smoke-test fixes: harness-only free models are failures the picker skips, wait shows the error, image runs keep Codex's final message, Grok's model menu parses model lines only.
- **0.9.0** — Image, advisor (Argon, only when `lokAsked`), and local sound. `fleet_accounts` returns the whole menu with cost and access tags. `openrouter/auto` is refused.
- **0.8.0** — One adapter table. Grok read-only. OpenRouter text jobs: free by default, paid only by exact id plus `maxCostUsd`.
- **0.7.0** (landed as `fleet@agent-toolkit`, no patch tag) — `fleet_ask` starts Codex, agy, or DeepSeek and returns immediately. Shared history across asks, batches, and delegates. Skills: ask, fan, dispatch, delegate, setup. `solo` folded into dispatch.
- **0.6.2** — Imported from codex-fleet. Codex workers isolate plugins and MCP helpers by default, optional Windows sandbox override, sandbox-setup failures classified, setup requires a real shell command.
