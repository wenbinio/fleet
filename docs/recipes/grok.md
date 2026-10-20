# Grok Build (`grok`) headless

xAI's coding agent CLI. Installed on this machine at `~/.grok/bin/grok.exe` (1.0.52 as of 2026-10-20), signed in
with Lok's SuperGrok login. The official installer is on [docs.x.ai/build/overview](https://docs.x.ai/build/overview):
`irm https://x.ai/cli/install.ps1 | iex` (Windows) or `curl -fsSL https://x.ai/cli/install.sh | bash`. It runs a
remote script, so install only on Lok's say-so. Local docs come with it: `~/.grok/docs/user-guide/`.

Use `bin/grok-run` (or `fleet_ask` with `backend: "grok"`), not raw `grok -p`. **On this machine Grok is read-only,
like agy.** Code goes to Codex.

## The traps (all tested 2026-10-20)

1. **Exit 0 hides refusals.** In headless mode, a tool call that needs approval (a file edit, a shell command that
   isn't on Grok's read-only list) is cancelled: the process exits 0, the file is untouched, and `text` still reads
   like success ("I'll replace `existing.txt`…"). The only sign is `"stopReason": "cancelled"` in the JSON. This
   happens in the default permission mode, in `dontAsk`, **and in `acceptEdits`**. `grok-run` treats any stop
   reason other than `end_turn` as a failure, and `cancelled` as **denied** (exit 3).
2. **No sandbox on Windows.** `--sandbox workspace|read-only|strict` is enforced only on Linux (Landlock) and macOS
   (Seatbelt). On Windows it's silently ignored: no warning, no error. The only way to make headless Grok edit is
   `--always-approve`, and on Windows that means unrestricted shell and writes anywhere. That's why the fleet runs
   Grok read-only: `--permission-mode dontAsk --disallowed-tools run_terminal_command,search_replace,write`.
   Read-only shell commands (`echo`, `ls`…) still run under `dontAsk`; removing `run_terminal_command` stops them too.
3. **`grok models` lies about sign-in.** It printed `You are not authenticated.` (exit 0) while `grok -p` worked on
   the cached login. Check sign-in by the shape of `~/.grok/auth.json` (`GROK_HOME` overrides the folder): an entry
   with a non-empty `refresh_token` or `key` means a cached login; `XAI_API_KEY` in the environment also counts.
   Never print or copy the values. To sign in, Lok runs `grok login` himself (browser), or `grok login --device-auth`.
4. **`--prompt-file` is resolved against `--cwd`,** not the folder you launched from. Always pass an absolute path.
5. **`text` glues narration onto the answer with no separator**: "I'll read `existing.txt` and return only its
   contents.seed-7731". Ask for answers in a fenced block or a clear last line when you need to parse them.
6. **It's expensive per call.** A one-word answer cost ~17k tokens; a one-file read ~38k (Grok loads its own
   prompt, your Claude skills and your `~/.claude/settings.json` permission rules). Batch questions into one
   prompt rather than many small calls.
7. **Grok reads Claude's config.** `grok inspect` shows it loading `~/.claude/settings.json` permissions and the
   skills in `~/.claude/skills`. Changes there change Grok's behaviour too.

## Output

`--output-format json` prints one object at the end: `text`, `stopReason` (`end_turn` on success), `sessionId`,
`requestId`, `cwd`, `thought`, `usage`, `num_turns`, `modelUsage`, sometimes `total_cost_usd`. On an error it prints
`{"type":"error","message":…}` and exits 1 (bad model, auth, network). Exit 130/143 = interrupted. Quota errors
weren't seen yet; the docs say they exit 1. Real samples are in `test/fixtures/grok-real/`.

`streaming-json` gives ACP events (`tool_call` / `tool_call_update` / `text` / `usage` / `end`), handy for
debugging what a cancelled run tried to do.

## Flags worth knowing

- `-m grok-4.7` (default), `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. `--effort` sets reasoning effort.
- `-r <sessionId>` resumes; `-c` continues the latest session in the cwd.
- `--no-auto-update` for scripts (the runner passes it). `--max-turns N` caps a run.
