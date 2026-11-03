# Claude Code Plugin Format — Verified Facts

Researched against official docs 2026-07-18, then updated for the public repo [wenbinio/fleet](https://github.com/wenbinio/fleet) (plugin `fleet`, marketplace `agent-toolkit`). Workers: treat the format rules below as authoritative; do not invent fields. The retired repo `wenbinio/claudeorchestratortocodex` and the names `codex-fleet@wenbinio` and `fleet@wenbinio` are not this tree.

## plugin.json (`.claude-plugin/plugin.json`)

Required: `name` only (kebab-case; becomes the skill namespace prefix `/name:skill`).
Recommended: `description` (discovery), `version` (set it — we version-pin releases), `author`.
Do NOT add a `userConfig` block — this plugin keeps machine config solely in the data-dir `config.json` written by the setup skill.

## marketplace.json (`.claude-plugin/marketplace.json`)

```json
{
  "name": "agent-toolkit",
  "owner": { "name": "wenbinio" },
  "plugins": [
    {
      "name": "fleet",
      "version": "0.15.1",
      "source": "./",
      "description": "Text, image, advisor and local sound jobs with one model menu, shared history and guarded integration."
    }
  ]
}
```

`source` in the committed file is `./` (this repository). Cloud sessions name the GitHub repo separately, in the block below.

## Install commands (README material)

```
/plugin marketplace add wenbinio/fleet
/plugin install fleet@agent-toolkit
```

Updates: `/plugin marketplace update agent-toolkit`. Version bumps in plugin.json gate update visibility.

## Path variables

- `${CLAUDE_PLUGIN_ROOT}` — absolute path to the installed plugin (cache dir). Usable in skill/agent content and hook commands to reference bundled files (e.g. the workflow script).
- `${CLAUDE_PLUGIN_DATA}` — Claude's own persistent per-plugin data dir (`~/.claude/plugins/data/<id>/`). Fleet does not read it. Machine config is `<toolkit>/config.json`. Shared runs, profile, and `approved.json` are `<toolkit>/fleet/`. Toolkit home is `FLEET_HOME`, else `AGENT_TOOLKIT_HOME`, else `~/.agent-toolkit`. An older copy at `~/.claude/plugins/data/fleet-agent-toolkit` is used only when the shared file is missing.
- Plugins cannot reference files outside their own directory.

## Directory conventions

`skills/<name>/SKILL.md` (YAML frontmatter: only `name` and `description`, max 1024 chars, description starts "Use when...")
`agents/<name>.md` (subagent definitions; markdown frontmatter `name`, `description`, optional `tools`, body = system prompt)
`hooks/hooks.json` (hook registrations; `${CLAUDE_PLUGIN_ROOT}` allowed in commands)
Any other dirs (workflows/, scripts/, docs/) ride along and are reachable via `${CLAUDE_PLUGIN_ROOT}`.

CAVEAT (spec A7.1): a bundled `workflows/*.js` script is readable but there is NO documented stock tool that executes it — the `Workflow` tool is not part of the documented Claude Code tool surface. The dispatch skill must carry a full Agent-tool orchestration fallback; the engine script is an accelerator on installations where a workflow runtime exists.

## Cloud sandbox constraints (README material)

- Cloud sessions cannot run `/plugin`; they load plugins from the target repo's checked-in `.claude/settings.json`:

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

- Skills and agents load in cloud sandboxes. Hooks (repo-level AND plugin) DO run in cloud sessions with `CLAUDE_CODE_REMOTE=true` set — an earlier version of this file claimed hooks were local-only; that was stale research, corrected per spec A7.11. Monitors and LSP servers remain CLI-only.
- Codex CLI in a sandbox: `npm i -g @openai/codex`, auth via `OPENAI_API_KEY` env secret (interactive ChatGPT OAuth is impossible headless). No key → the plugin's Claude-only fallback mode.
