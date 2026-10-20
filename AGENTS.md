# fleet — guide for agents

fleet is one MCP server (plus skills and an AGENTS.md rules block) that runs Lok's models: codex, agy, grok,
deepseek, chatgpt (web), api (OpenRouter), local (Qwen / llama.cpp), image, advisor (Gemini web, Argon), sound. It plugs into any harness;
Claude Code gets the most (hooks, subagents, background notices).

## Set it up, slim it down, move it

```bash
node install.mjs --plan --json            # read this first: done / auto / needs-you
node install.mjs --apply                  # do the auto part (profile lok: hosts claude, codex, grok, agy)
node install.mjs --apply --host codex     # add a harness;  --remove --host codex  takes it out again
node install.mjs --apply --off grok       # a subscription lapsed: drop the backend everywhere
node install.mjs --apply --profile minimal  # codex + api only
```

- **You may do** every `auto` step without asking. Rerun `--apply` until a plan shows only `done` and `needs-you`.
- **Hand `needs-you` items to Lok** in one short list, each with its command: logins (`codex login`, `agy`,
  `grok login`, the DeepSeek Harness app, `node core/lib/webchat/chatgpt.mjs login`, `node backends/advisor/advisor.mjs login`), keys
  (`node install.mjs --set-key openrouter`, typed by him in a hidden prompt), remote installers, sound downloads
  (`--with sound`, several GB), PATH changes. Never do these yourself, never read or print credentials.
- A backend that isn't found or isn't signed in usually means a lapsed subscription: suggest `--off <backend>`.
- `lok` auto-approves read-only fleet tools in Codex and agy; `minimal` grants none. Starting, steering and
  interrupting jobs still ask. The installer never grants those mutating permissions; they remain Lok's call.
- `fleet_review` reviews inline diffs across models; mark private material with `private: true` or profile
  `privatePaths`. `fleet_shot` captures responsive PNGs; `fleet_deploy_wait` reports a deployed marker.
  These also require approval. [Usage](docs/recipes/review-local-shot.md).
- Local uses `FLEET_LOCAL_ROOT`, then config `local.root`, then legacy `local.folder`; Windows alone defaults
  to the existing verified Qwen installation at `D:/AI/Qwen3.8-Abliterated`. Other platforms require a root. It is served by llama.cpp
  on port 8088. Do not copy/import its GGUF or download another copy. It shares the GPU with sound and sleeps
  after five idle minutes; fleet never stops it after a job. Ollama is an explicitly configured alternative only.

## Changing fleet

All implementation goes to Codex Astra (Lok's rule): brief it, review the diff, run the tests yourself
(`node --test` here; Codex's sandbox can't spawn processes). Each backend's traps are in `docs/recipes/` here
and summarised in the skills. Never commit sign-ins, keys, browser profiles or run output.
