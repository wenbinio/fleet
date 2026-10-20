# Local model (`local` backend): Lok's Qwen on D:

Lok's own setup, not Ollama: `D:\AI\Qwen3.8-Abliterated` (Huihui-Qwen3.8-27B-abliterated, UD-IQ3_S, 11.95 GB),
served by its bundled llama.cpp `llama-server` on `http://127.0.0.1:8088` (OpenAI-compatible `/v1`, model id
`Huihui-Qwen3.8-27B-Abliterated`). His rule for it: **everything stays on D:**, so never import the GGUF into
Ollama (that copies it to `~/.ollama` on C:). Nothing ever leaves the machine, so private reviews and asks go here.

```
fleet_ask {backend: "local", prompt: "…", effort: "low|medium|high"}
```

- Fleet starts the server when it's down (`Start-Qwen.ps1` without `-OpenChat`, which would open Chrome) and never
  stops it: Lok also uses its chat page. The server frees the GPU itself after 5 idle minutes
  (`/props` → `is_sleeping`); `Stop Model.cmd` stops it and refuses mid-reply.
- Speed (2026-10-21): about 28 s cold start to a one-word answer; about 50 s for a sentence after waking.
- `--fit on` picks GPU layers to fit the free VRAM, offloading the rest to CPU: slower, still works. Fleet notes
  "partial CPU offload likely" when free VRAM is under the model's 12 GB.

## The GPU guard (SAO, MOSS and Qwen share one 16 GB card)

- A `local` job is refused (`gpu_busy`) while a fleet `sound` job runs.
- A `sound` job is refused while a `local` job runs **or the Qwen server is loaded** (not sleeping): "local Qwen is
  loaded; it frees the GPU after 5 idle minutes (or run Stop Model.cmd)". Both directions tested live.

## Traps found

1. **The start script never returns its pipes.** `Start-Qwen.ps1` launches `llama-server` with `Start-Process`, which
   inherits the script's output handles, so anything waiting for the script's output to close waits forever. Fleet
   gives it file output (`local-start.log` in the run folder) and watches `/health` instead.
2. **Spawn errors were invisible.** Starting `powershell` by bare name failed silently once; fleet now uses the full
   path and fails fast with the start log's tail.
3. **Waking the server is not free.** A chat request reloads the 12 GB model; a status probe with `/slots` and
   `/props` together did too (2026-10-21). `Stop-Qwen.ps1` reads `/props` (`is_sleeping`) before touching `/slots`,
   so `/props` is believed not to wake it, but that is unverified. Probe with `/health` and `/props` only.
