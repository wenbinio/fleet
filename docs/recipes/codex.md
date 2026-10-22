# Codex CLI

OpenAI's Codex CLI, signed in with ChatGPT. On Windows it isn't on PATH: the binary is
`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, and the hash folder changes every time Codex updates itself.
Always resolve the newest one at run time (`node core/lib/runners.mjs codex-run` does); a stored path silently breaks (exit 127).

## Models and effort

- `gpt-6-astra` ("astra") — default for building code and backend work.
- `gpt-6.1-sol` ("sol") — research, verification, audits; also image generation.
- `gpt-6-luna` ("luna") — fast and cheap, for checks against supplied ground truth.

Default effort high; medium for structured work from given inputs; keep xhigh for the rare hard call. A big fleet
of xhigh jobs eats a lot of usage — size fleets to the job and say the rough job count first.

## Running a job

```bash
node core/lib/runners.mjs codex-run my-job brief-prompt.txt --cwd D:/path/to/repo --model astra --effort high
node core/lib/runners.mjs codex-run my-job follow-up.txt --resume last      # continue the same session
```

Output lands in `~/.agent-toolkit/runs/codex/<id>/`: `rN.last.txt` is Codex's final message, `rN.events.jsonl`
the full event stream, `session.txt` the session id.

Flags it always passes, and why:

- `--ignore-user-config` — Codex's own config loads a computer-use helper at start; while it runs, the Windows
  sandbox setup can't open it, so no command or file write works.
- `-c windows.sandbox="unelevated"` and `-s workspace-write` — writes stay inside the working folder plus any
  `--add-dir`.
- Prompt on stdin (`-` then `< file`). `-i <image>` is variadic and would swallow a positional prompt.

Before dispatching to a folder, probe that the sandbox can **edit an existing file** there — see
[codex-sandbox-ownership.md](codex-sandbox-ownership.md). `node setup.mjs --smoke` was the old agent-toolkit
entry and is not in this repository.

The Codex sandbox may not be able to spawn child processes, so it often can't run `node --test`. Run the tests
yourself after it reports.

## Images

`node core/lib/runners.mjs codex-image <dir> [ref.png ...]` reads `<dir>/prompt.txt` and saves images in `<dir>`. Codex produces real-alpha
transparent PNGs. For a consistent set, make one style sheet first and pass it as a reference to every later run.
"4 frames in one row, 1536x1024, transparent" gives animation sheets that slice cleanly by alpha gaps. Previews
show a glow around figures; it's RGB under zero alpha, so cut-outs are clean. Seven runs in parallel took ~15 min.

## Related

- The fleet plugin (this repository, formerly the codex-fleet plugin) dispatches verified Codex batches in worktrees
  (`/fleet:dispatch`), runs live steerable jobs (`/fleet:delegate`), and starts one-off jobs through `codex-run`
  (`fleet_ask`).
