# Antigravity CLI (`agy`)

Google's Antigravity CLI, one binary. Installed under `%LOCALAPPDATA%\agy\bin\agy.exe` and usually on PATH.
Tested here on 1.4.2 (2026-10-18).

## Use it for

Read-only work Gemini is good at: watching or auditing material, bulk image audits with Flash, lore and
consistency checks, second opinions. Not for writing code (that goes to Codex), and not for image or audio
generation.

## Headless recipe

```bash
agy -p "<prompt>" --mode plan --model gemini-4-hydrogen --add-dir <dir> \
    --output-format json --print-timeout 600s
```

Or use `bin/agy-run`, which does the checks below for you, and `bin/agy-fan` to run several at once.

- `--mode plan` is read-only. Asked to write a file, it only drafts a plan.
- `agy models` lists the model ids your plan can use. From Google's docs on 2026-11-13 (not yet run on this
  machine): `gemini-4-hydrogen` (every plan; fleet's default), `gemini-4-argon` (paid Pro and Ultra),
  `gemini-4-carbon` (Ultra), `gemini-3.8-flash`, `claude-sonnet-5-5`, `claude-opus-5-5`. `claude-sonnet-4-6`,
  `claude-opus-4-6-thinking` and `gpt-oss-120b-medium` go away on 2026-11-18.
- Thinking level: append it to the id (`gemini-4-hydrogen-xhigh`) or pass `--effort low|medium|high|xhigh`
  (agy 1.2.11 or later). Hydrogen defaults to high. fleet passes the model id through as written, so use the
  suffix form: `fleet:ask agy` with model `gemini-4-argon` or `gemini-4-hydrogen-xhigh`.
- `--output-format json` returns `{conversation_id, status, response, usage, …}`; add `--json-schema '<schema>'`
  and the answer also comes back as `structured_output`.
- It reads images (`.webp`, `.png`) from an added folder, and it loads a repo's `AGENTS.md` as rules.
- `agy update` downloads about 190 MB and swaps it in; give it a few minutes. A second call while one runs says
  "update already in progress".

## Traps (all found the hard way)

1. **Exit code 0 doesn't mean success.** Headless mode can't ask for permission, so it quietly denies the tool,
   prints `jetski: no output produced … auto-denied` on stderr and returns an empty `response` with
   `denied_actions` filled in — with exit 0. Treat empty output, that stderr line or any `denied_actions` as a
   failure. `agy-run` exits 3 for this.
2. **Gemini Flash reaches for the shell to read files**, even though `read_file(**)` is allowed in
   `~/.gemini/antigravity-cli/settings.json`. Start every prompt with
   `Use only your file-reading tool to open files. Never run shell or terminal commands.` (`agy-run` does).
   Claude models in agy don't need it. Don't use `--dangerously-skip-permissions`.
3. **One login for the whole machine.** Parallel jobs work fine (six at once tested), but they share one quota,
   and you can't pool accounts.

## Plugin

The `fleet` plugin (`plugins/fleet`) runs agy through `agy-run`: `fleet:ask agy …`, `fleet:fan` (up to 4 agy jobs at
once, mixed models and backends), and the `fleet_*` run history. agy is plan-mode only there; a denial is reported
as `denied`, never as an answer. The raw output shapes are in [docs/agy-output.md](../agy-output.md).
