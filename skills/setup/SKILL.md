---
name: setup
description: Install, repair or re-check the fleet plugin and its backends (args: optional backend to focus on); never logs in.
---

Fleet root: use `${CLAUDE_PLUGIN_ROOT}` in Claude Code; elsewhere use the fleet root in your AGENTS.md fleet block. Set `FLEET_ROOT` to that path for the commands below.

# Set up the fleet

## 1. Run the toolkit setup

Run `node "${FLEET_ROOT}/install.mjs" --plan --json`, then `--apply` for automatic steps. Choose `--profile`, `--host`, `--on` and `--off` as needed. Pass `needs-you` commands to Lok; do not perform logins, keys, remote installers, sound downloads or PATH changes. Existing agent-toolkit users can keep running `node <repo>/setup.mjs --quiet`.

The `lok` profile auto-approves fleet's read-only tools in Codex and agy. The `minimal` profile grants none;
applying it to a host removes those read-only grants. Each changed settings file gets a once-only
`.fleet-backup`. Claude keeps interactive approvals; Grok has no documented per-tool approval rule.

`fleet_ask`, `fleet_steer` and `fleet_interrupt` still ask for approval. The installer never grants these
mutating permissions; Lok decides whether to approve them.

## 2. Check the backends

Call `fleet_accounts`. It reports every backend without credentials:

- **codex**: `codex login status`. **agy**: `agy models`. **deepseek**: found or not; its account isn't
  inspectable headless.
- **grok**: the cached login in `~/.grok/auth.json` (by shape only; `grok models` falsely says "not
  authenticated").
- **api**: each provider's key status (type, credit left, free requests today) and total spend.

**Never log in for Lok.** Print the command and let him run it: `codex login`, `agy`, `grok login` (browser), or the
DeepSeek Harness app. Never read, print or copy a credential file's contents or a key.

## 3. Codex worker settings (dispatch and delegate)

Only when dispatch or delegate fails with a sandbox or backend error, or Lok asks. Use fleet's config for
`codexExe`, `nodeExe`, `model` and `effort`:

```text
"<nodeExe>" "${FLEET_ROOT}/runner/fleet-runner.mjs" --smoke --codex-exe "<codexExe>" --model "<model>" --effort "<effort>"
"<nodeExe>" "${FLEET_ROOT}/runner/fleet-runner.mjs" --probe --codex-exe "<codexExe>" --model "<model>" --effort "<effort>" --isolation "<passing isolation>"
```

The smoke must make a worker **run a shell command** and echo a fresh token; a text-only reply isn't enough. It
reports the isolation that passed. The probe checks `codex app-server`; record `backend: "app-server"` in fleet's
config only when it passes, else `exec` (delegate needs app-server). An unelevated Windows sandbox is weaker: record
`windowsSandbox: "unelevated"` only when Lok explicitly asks (`--allow-unelevated`). On `setup refresh had errors`,
report `sandbox_setup_failed`: close the Codex desktop app (it runs `node_repl.exe`), or opt in to unelevated.

Finish with what's ready, what Lok must run himself, and which skill fits his task (`fleet:ask`, `fleet:fan`,
`fleet:dispatch`, `fleet:delegate`).
