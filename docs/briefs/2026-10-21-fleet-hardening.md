# Brief: CI, Node 24 baseline, MCP lifecycle fixes, reproducible audio (2026-10-21)

From an outside review Lok forwarded. Its verdict, which Claude agrees with: keep the zero-dependency Node ESM core,
native `node --test` tests and the simple viewer — no framework, containers, SDK or Playwright rewrite. Work in
`plugins/fleet` (plus the matching agent-toolkit root files where named). Usual rules: no commits, no network, no
installs; Claude runs tests. Do the four parts in this order.

## 1. CI (Windows + Linux)

`README.md` says "CI runs the suite on Ubuntu and Windows (`.github/workflows/ci.yml`)" but the folder was dropped
when codex-fleet was imported. Add `plugins/fleet/.github/workflows/ci.yml` (it becomes the fleet repo's root on
subtree push): on push and pull_request, matrix `ubuntu-latest` + `windows-latest`, Node **24** via
`actions/setup-node` (pin the action to a major tag), `node --test` in the repo root, no install step (no
dependencies). Also add agent-toolkit's own `.github/workflows/ci.yml` running `node --test test/` and
`node --test` in `plugins/fleet` on the same matrix. Tests that need real CLIs, Chrome, a GPU or network must
already be skipped or faked; if any isn't, make it skip when the tool is absent (and say which).

## 2. Node 24 LTS baseline

Node 18 and 20 are end-of-life; 24 is LTS; 26 is Current. This machine runs 25.6.1 (odd-numbered Current, now
also past end of life). Change: `package.json` `engines.node` to `>=24`; docs ("Node 18+" in both READMEs,
`docs/cloud-validation.md`); `setup.mjs` and `install.mjs` version checks: < 24 → `warn`/`needs-you` "install Node 24
LTS"; an odd major (25, 27…) → `warn` "odd-numbered Node releases are short-lived; use 24 LTS" (not a failure).
Keep everything working on 25/26 (no 24-only APIs needed; don't add any).

## 3. MCP lifecycle (mcp/fleet-mcp.mjs)

- `initialize`: supported versions `["2025-11-25", "2025-06-18", "2025-03-26"]` (newest first). If the client's
  `protocolVersion` is in the list, answer with it; otherwise answer with the newest supported one (the spec's
  negotiation: the server proposes its own; the client decides whether to continue). Never echo an unknown version.
  Update the test that expects "fixture-version" to be echoed: it must now get "2025-11-25".
- `ping` (request with an id) → `{"jsonrpc":"2.0","id":…,"result":{}}`.
- Notifications (no id) stay ignored, including `notifications/initialized`. Keep stdio and the hand-written server.
- Tests for both.

## 4. Reproducible optional audio installs (`install.mjs --with sound`)

Lock files are already in the repo, captured from Lok's two working environments (2026-10-21):
- `backends/sound/sao/requirements.lock.txt`: SAO venv, Python **3.13.12**, 67 packages (`torch==2.6.0+cu124`,
  `torchaudio==2.6.0+cu124`, `diffusers==0.41.0`, `transformers==5.19.0`, …). Install with
  `--index-url https://download.pytorch.org/whl/cu124` for the torch lines and PyPI for the rest (e.g. pip
  `-r lock --extra-index-url …cu124`).
- `backends/sound/moss/requirements.lock.txt`: MOSS venv, Python **3.12.15**, 131 packages (`torch==2.9.0+cu128`,
  `transformers==4.57.1`, `diffusers==0.37.1`, `numpy==1.26.4`, …), built by `uv` with
  `--extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match`. Its MOSS package
  itself (`moss-soundeffect-v2`) is NOT in the lock: install it editable from the source checkout **at commit
  `934d6826b084c46a0d033402174d5f8ac4ed2519`** (git clone, then `git checkout <sha>`; `pip install --no-deps -e
  MOSS-TTS/moss_soundeffect_v2`). Upstream deliberately pins Python 3.12 / Torch 2.9 / Transformers 4.57 / NumPy
  1.26: never upgrade these.
- Model weights pinned too: SAO `stabilityai/stable-audio-open-1.0` revision
  `f21265c1e2710b3bd2386596943f0007f55f802e`; MOSS `OpenMOSS-Team/MOSS-SoundEffect-v2.0` revision
  `e35df4d82fbe87fcd5d14e5d100e349c0c3c076d` (`hf download … --revision <sha>`).
- Require the exact Python minor (3.13 for SAO, 3.12 for MOSS) and say so in the plan. Everything stays a
  `needs-you` step (multi-GB), printed as exact commands. Keep honouring existing configured venvs.
- Tests: the printed recipe contains the lock paths, index URLs, the source sha checkout, `--no-deps`, both weight
  revisions, and no unpinned package names.

Report briefly, including any test you made skip-when-absent for CI.
