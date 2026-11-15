# Mistral Vibe

Fleet runs Mistral Vibe 3.1.2 on Lok's Mistral account. The default is `zai-glm-5-3-flash` (GLM 5.3 Flash hosted by Mistral); `mistral-medium-3.5` is also served. No effort or reasoning flag exists.

Use `fleet_ask` with `backend: "vibe"`, `cwd`, and a prompt. Optional keys: `model`, `readOnly`, `maxTurns` (integer 1–200, default 40), `timeout` (positive seconds, default 1200), and `resume` (earlier fleet runId). Up to four jobs run at once.

The standalone runner is `bin/vibe-run prompt.txt --cwd D [--model ALIAS] [--read-only] [--max-turns 40] [--timeout 1200] [--resume SESSION] [--events FILE] [--json]`. With no model, it uses Vibe's configuration; fleet explicitly supplies its default on new sessions. Resume omits `--model`.

Fleet closes stdin and invokes `vibe --prompt-file P --output streaming --workdir W --trust --output-dir D --max-turns N --time-limit S`. Without a prompt flag, Vibe errors that interactive mode needs a terminal. The runner allows another 60 seconds before its hard timeout and removes the temporary export directory after reading `export.json`.

Edit jobs use `--agent accept-edits`: file edits are auto-approved, shell requires approval and is denied headless. Read-only jobs instead use `--enabled-tools read_file --enabled-tools grep`, disabling other tools. A model may try workarounds such as its scratchpad after a denial. Report export warning messages beginning `Tool call denied`; a completed answer does not establish that a denied edit succeeded.

Streaming JSON records messages, reasoning and effects. Fleet retains raw events, takes the last assistant message as the answer, and records session, usage, cost, steps and denials from the export. `done` means finished with text; `empty` means finished without assistant text. Turn/time limits and other errors are `failed` with any partial answer retained. Missing keys/auth errors are `signed_out` with `run yourself: vibe --setup`; 429/rate limits are `rate_limited`. Vibe exits 0 for finished, 3 for limits, 1 for errors; the fleet runner exits 0 for done/empty and 1 otherwise. An edit may already have been written when a limit stops the run.

Model discovery and sign-in use the no-cost unknown-model probe `vibe -p x --model __fleet_list_models__ --workdir D --trust`. Its `Available:` line lists the account's served models even though it exits 1. Discovery falls back to the two models above. A set `MISTRAL_API_KEY` also establishes sign-in status; fleet never reads or prints keys. Keyring announcement lines on stderr are noise and are removed from errors.

Install yourself from your own terminal: `uv tool install mistral-vibe`, then `vibe --setup`. Fleet never logs in. Resolution uses `VIBE_EXE`, configured tools, PATH, then `~/.local/bin/vibe.exe` on Windows (`vibe` elsewhere).

An agent shell with redirected `%APPDATA%` can install the venv somewhere the real terminal cannot see. If the launcher reports `error: uv trampoline failed to canonicalize script path`, run `uv tool uninstall mistral-vibe` and reinstall from Lok's own terminal. Do not reinstall from that agent shell.
