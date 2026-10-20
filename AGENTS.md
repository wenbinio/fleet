# fleet — guide for agents

fleet is one MCP server (plus skills and an AGENTS.md rules block) that runs Lok's models: codex, agy, grok,
deepseek, chatgpt (web), api (OpenRouter), image, advisor (Gemini web, Argon), sound. It plugs into any harness;
Claude Code gets the most (hooks, subagents, background notices).

## Set it up, slim it down, move it

```bash
node install.mjs --plan --json            # read this first: done / auto / needs-you
node install.mjs --apply                  # do the auto part (profile lok: hosts claude, codex, grok)
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
- Codex asks before fleet tools that start work; per-tool auto-approval in Codex's config is Lok's call.

## Changing fleet

All implementation goes to Codex Astra (Lok's rule): brief it, review the diff, run the tests yourself
(`node --test` here; Codex's sandbox can't spawn processes). Each backend's traps are in `docs/recipes/` here
and summarised in the skills. Never commit sign-ins, keys, browser profiles or run output.
