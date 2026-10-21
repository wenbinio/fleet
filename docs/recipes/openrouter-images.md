# Images through OpenRouter (`image` backend, `provider: "openrouter"`)

Codex (Sol) stays the default image path. OpenRouter adds 60+ image models when a specific one is wanted.

```
fleet_ask {backend: "image", provider: "openrouter", model: "recraft/recraft-v4.1-flash", maxCostUsd: 0.05,
           prompt: "…", aspect_ratio: "1:1"}                       # + n, resolution, size, quality, output_format,
                                                                   #   background, seed, images (references), outDir
fleet_accounts {backend: "image"}                                  # cheapest models with real prices
```

- **Every OpenRouter image model is paid** (none ends in `:free`), so the paid rule applies: name the exact model and
  set `maxCostUsd`, with a reason.
- Fleet prices the job **before** sending it, from the Images API's per-endpoint pricing, and refuses when the
  estimate exceeds the cap, the pricing is missing, or an option isn't in the model's `supported_parameters`.
  After the run it records the real `usage.cost` (`costUsd`, `overCap`).
- Images are written to the run folder (and `outDir`); results carry **file paths, bytes and dimensions only**,
  never base64.
- Uses OpenRouter's Images API (`POST /api/v1/images`), not chat completions. A failed generation (502) is not billed.

## Prices seen 2026-10-21 (per image, cheapest first)

recraft-v4.1-flash $0.007 · flux-3-image-klein $0.008 at 768 px, $0.009 at 1K (takes reference images) ·
seedream-5-0-flash $0.018 · qwen-image-2.1-turbo $0.018 · qwen-image-3 $0.03 · tencent hy-image-v3.5 bills per
token. First real run: recraft-v4.1-flash, 1024×1024 WebP, **$0.007 real = $0.007 estimated**, 4 s.

## Traps

1. **`/models` pricing lies for images.** Many image models show `prompt`/`completion` at 0 and charge through
   `image_output`/`image_token`, so a "both zero means free" check called them free. A model is free only when every
   pricing field is zero and its id ends in `:free`.
2. **`pricing.image` means different things.** For qwen-image-3 it's $0.003, its *input*-image price; its output is
   $0.03 per image, ten times more. For Gemini it's a per-token input price. Never estimate from `/models`; use
   `GET /api/v1/images/models/{author}/{slug}/endpoints` (`pricing[]` with `billable`, `unit`, `cost_usd`, `variant`).
3. **Units differ**: `image`, `request`, `megapixel` or `token`; per-token prices can only be estimated
   (marked `estimate: "rough"`).
4. `openrouter/auto-beta` has no pricing at all: refused.

Fixtures: `test/fixtures/openrouter-real/image-models.json`, `image-endpoints-*.json`.
