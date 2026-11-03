# DeepSeek Harness (`dsh`) headless

DeepSeek's official desktop app ships a CLI at
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`. Run it from PowerShell; quoting
through Bash `cmd //c` breaks on the spaces in that path. `core/bin/dsh-run.ps1` wraps it. The script lives in `core/bin`, so its repo root is `core/` and the account patch it loads is `core/deepseek/account.patch.yml`.

## Account login, not an API key

The stock `headless` profile expects an API key: it uses the `deepseek-official` provider and switches off
`credentials`, `authorization` and `deepseek-account`, so a plain run on an account login fails with
`MISSING_CREDENTIAL`. `core/deepseek/account.patch.yml` turns those three back on and sets the default model to the
`deepseek-account` provider. Your own profile files under `~/.dsh` stay untouched.

```powershell
& $dsh --profile headless --patch <repo>\core\deepseek\account.patch.yml --json "task"
```

- Run it from the folder it may edit (workspace-write sandbox, no approval prompts inside it).
- `--json` gives NDJSON events (`tool_call`, `tool_result`, `final`); `--session-id <id>` resumes; `-` reads the task
  from stdin.
- Account models: `deepseek-flash` (default) and `deepseek-v4-pro`; `dsh-run.ps1 -Model` writes an overlay copy with
  the other model.
- Verified 2026-10-17: flash answered in 3 s; v4-pro wrote and ran a JS file in 8 s.
