# Cloud-surface validation checklist

One-time scripted run (~15 min) in a real claude.ai/code cloud session, on a repo that has the fleet-enable block checked in. This validates the "cloud sandbox surface" entries on the README untested-at-release list and spec claim A7.11 (hooks fire in cloud with `CLAUDE_CODE_REMOTE=true`).

**Prereqs (before opening the cloud session):**

- Target repo has this exact block committed in `.claude/settings.json` (see README "Claude Code plugin"):
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
  `wenbinio/claudeorchestratortocodex` and `fleet@wenbinio` are the retired pre-split names.
- `OPENAI_API_KEY` added as an environment secret for the repo's cloud sessions.

Run the steps in order; fill the Results table as you go. Cloud sandboxes are Linux, so the POSIX guard path (`scripts/merge-guard.sh`) is what fires.

## 1. Plugin loads from checked-in settings

1. Open a claude.ai/code cloud session on the target repo.
2. Type `/fleet:setup`. If the command is unknown / the skill does not load, the plugin did not install from `enabledPlugins` + `extraKnownMarketplaces` — record FAIL with the exact error text.
3. Record PASS if the setup skill begins executing.

## 2. Setup completes headless

While `/fleet:setup` runs (or run these directly if setup stalls), capture:

1. Node present: `node --version` — need >= 24; prefer Node 24 LTS. Odd-numbered releases warn but remain usable. Record version.
2. Codex installable: `which codex || npm i -g @openai/codex && which codex`. Record whether the global npm install succeeds in the sandbox and the resulting path.
3. Shell smoke (API-key mode; use a fresh token and the configured model/effort):
   ```sh
   codex exec --disable plugins -c mcp_servers.node_repl.enabled=false --json --sandbox read-only --ephemeral -m gpt-5.6-sol -c 'model_reasoning_effort="xhigh"' 'Run a shell command that prints FLEET_SHELL_<random-id>, then reply with that token. Do not run git.' < /dev/null
   ```
   Record PASS only on exit 0, a successful command event (exit code 0) whose output is the token, and a matching final answer. A chat-only response fails. Close stdin with `/dev/null`; preserve the passing `isolation` in config as described in setup.
4. Read back the written config. Fleet ignores `CLAUDE_PLUGIN_DATA`. Toolkit home is `$FLEET_HOME`, else `$AGENT_TOOLKIT_HOME`, else `$HOME/.agent-toolkit`. Config is `<toolkit>/config.json`. Shared plugin state (`approved.json`, runs, profile) is `<toolkit>/fleet/`. A copy of an older install may still sit at `~/.claude/plugins/data/fleet-agent-toolkit` and is read only when the shared file is missing. Record `authMode` and `backend` (expected: `api_key`, and `app-server` if the runner probe passes, else `exec`).

## 3. Data-dir persistence across session restart

1. Record the resolved dirs:
   ```sh
   TOOLKIT="${FLEET_HOME:-${AGENT_TOOLKIT_HOME:-$HOME/.agent-toolkit}}"
   echo "config=$TOOLKIT/config.json"
   echo "data=$TOOLKIT/fleet"
   ```
2. Confirm config exists: `ls -l "$TOOLKIT/config.json"`.
3. Write a sentinel: `date -u +%FT%TZ > "$TOOLKIT/fleet/persist-probe.txt"`.
4. End the session. Start a NEW cloud session on the same repo.
5. In the new session: `cat "$TOOLKIT/fleet/persist-probe.txt"` (re-resolve `TOOLKIT` as in step 1 — the path itself may change).
6. Record: exact path, and persistence yes/no. If no, confirm the README caveat ("re-run setup per session") by running `/fleet:setup` again and noting it completes.

## 4. Tiny run end-to-end

1. Pick a trivial, verifiable change in the repo (e.g. fix a typo in a comment).
2. Run `/fleet:dispatch` for a one-task batch (`runId` starting with `solo-`). There is no `/fleet:solo` skill. `/fleet:delegate` is the interactive surface; one of the two is sufficient.
3. Record: did the worker start, produce a diff, pass verification, and integrate? Paste the final run summary line. If it fell back to Claude-only mode, record why (from setup's `authMode`).

## 5. Merge guard fires in cloud (spec claim A7.11)

Seed a guaranteed-block state, then have Claude attempt the merge through its shell tool:

1. Record the platform signal: `echo "$CLAUDE_CODE_REMOTE"` (A7.11 says `true` in cloud).
2. Guard dependency check: `command -v jq` — the sh guard exits open without jq; if absent, record that (it is itself a finding: guard is inert in cloud until jq is present).
3. Create a throwaway branch: `git branch codex/guardtest`.
4. Seed a stale verdict into the store (recorded SHA is well-formed but will not match the branch tip → block-on-stale path):
   ```sh
   REPO_KEY=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
   TOOLKIT=${FLEET_HOME:-${AGENT_TOOLKIT_HOME:-$HOME/.agent-toolkit}}
   DATA_DIR=$TOOLKIT/fleet
   jq -n --arg repo "$REPO_KEY" \
     '{($repo): {"codex/guardtest": {"sha": "0000000000000000000000000000000000000000", "verdict": "approve"}}}' \
     > "$DATA_DIR/approved.json"
   ```
5. Ask Claude (in the session, as a normal prompt): "Run `git merge codex/guardtest`." The PreToolUse hook must fire and the command must be BLOCKED with the "Merge blocked for branch 'codex/guardtest' (verdict: stale...)" message.
6. Record: blocked yes/no, the exact block message, and the `CLAUDE_CODE_REMOTE` value from step 1.
7. Clean up, in the same shell that set `DATA_DIR`: `rm "$DATA_DIR/approved.json" && git branch -D codex/guardtest`.

## 6. Failure notes

For every red row above, record ALL of:

- Step + sub-step number
- Exact command run
- Exact error output (verbatim, first + last 5 lines if long)
- Environment facts: `node --version`, `codex --version` (if installed), `echo $CLAUDE_CODE_REMOTE`, `echo ${FLEET_HOME:-${AGENT_TOOLKIT_HOME:-$HOME/.agent-toolkit}}`, `command -v jq`
- Whether a retry in the same session reproduced it

## Results

| # | Check | Result (PASS/FAIL/SKIP) | Evidence / notes |
|---|-------|------------------------|------------------|
| 1 | Plugin loads from checked-in settings.json | | |
| 2a | `node --version` >= 24 | | version: |
| 2b | Codex installable via npm | | path: |
| 2c | Successful shell smoke with OPENAI_API_KEY | | |
| 2d | config.json written (authMode / backend) | | values: |
| 3 | Data dir persists across restart | | path: · persists: yes/no |
| 4 | Tiny dispatch/delegate run end-to-end | | summary line: |
| 5a | `CLAUDE_CODE_REMOTE` value | | value: |
| 5b | jq present in sandbox | | |
| 5c | Guard blocks stale `codex/guardtest` merge | | block message: |

## Recording results

Paste the filled Results table (plus any Failure notes) back into this file under a `## Run log — <date>` heading, and land it via PR on `wenbinio/fleet`.

Once all rows are green, update:

- **README.md** — "Claude Code plugin" and "Limitations": drop the hedges that cloud data may not persist and that cloud hook behavior is unconfirmed, using row 3 and row 5 as the evidence.
- **docs/specs/2026-07-18-codex-fleet-plugin-design.md** (historical spec for the retired repo; file an update, do not edit it blind): the cloud data-dir note and the untested-at-release lists in A6 and A7.11.
