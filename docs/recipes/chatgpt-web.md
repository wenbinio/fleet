# ChatGPT web

Uses the chatgpt.com chat allowance, separate from Codex and API usage. Agents may use it without asking, with one
prompt at a time. Default pacing is 20 seconds between sent prompts and 30 prompts per rolling hour.

```bash
node core/lib/webchat/chatgpt.mjs login
node core/lib/webchat/chatgpt.mjs check
node core/lib/webchat/chatgpt.mjs probe
node core/lib/webchat/chatgpt.mjs ask prompt.md --files context.txt --model strongest --out answer.md --timeout 1200
```

Lok signs in manually in the visible login window, then closes it. The private Chrome profile and `state.json`
live in `~/.agent-toolkit/chatgpt-web/`; `CHATGPT_WEB_HOME` overrides that folder. The runner never reads credentials.
Setup and the fleet model menu read saved state; they never open Chrome.

`chatgptWeb` in toolkit config accepts `minGapSeconds`, `maxPerHour`, and the ordered `strongest` list. Defaults:
`["GPT-6", "GPT-5.6", "Pro", "Thinking"]`, matched as words without case sensitivity. Explicit `--model` takes an
exact model radio label, such as `GPT-5.6 Sol`. Every ask selects the model and sets its power slider to maximum
before typing. Results record the radio, power and picker mode, for example `GPT-6 · power 4/4 (Pro)`.
`check` reads the radios, selected model, current power and picker label without adjusting power.
A known limited model is skipped by `strongest`; no matching label keeps the current model
and records a note. A limit encountered during a job stops that job without retry or fallback. Unknown reset
times remain blocked in state until that entry is explicitly cleared after checking the allowance.

Every ask starts a temporary chat at `https://chatgpt.com/?temporary-chat=true`. Pass `--keep-chat` to use a normal
chat instead, or `keepChat: true` through fleet. The standalone runner defaults to 20 minutes; fleet defaults to
30 minutes.

Fleet uses `backend: "chatgpt"` with `prompt` or `promptFile`, `files`, `model`, and `keepChat`. The direct fleet CLI
also accepts `--timeout SECONDS` and `--keep-chat`. Terminal outcomes are `done`, `failed`, `signed_out`, `limit`, and `paced` (runner exits
0, 1, 3, 4, and 5). `waiting_for_lok` remains live and prints a wait notice when a human verification check needs Lok.

The selectors in `core/lib/webchat/chatgpt.mjs`'s `C` object use the probed composer, model radios, power slider and
assistant Markdown root, with compatibility fallbacks. A reply finishes only after a newer assistant turn is
marked complete and the Stop button is absent. Probe dumps composer candidates, buttons, picker items, file inputs, assistant attributes and notices;
failures name the relevant `C` key. A CAPTCHA is brought on screen for Lok, never clicked or worked around.
