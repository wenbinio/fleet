# Brief: OpenRouter image generation in the `image` backend (2026-10-21)

> Historical work order. `plugins/fleet` in the text below is this repository's root.

Lok: "Add image generation for OpenRouter in." Work in `plugins/fleet`. Usual rules: no commits, no live network or
paid calls (Claude does the one real generation), Node built-ins only. Codex (Sol) stays the default image path.

## Facts (checked live 2026-10-21; fixtures in `test/fixtures/openrouter-real/`)

- 63 models output images (`GET /api/v1/models?output_modalities=image`, saved subset `image-models.json`); **none is
  free**. Their `/models` `pricing` is misleading for images: many show `prompt`/`completion` 0 but charge via
  `image_output`/`image_token`; `pricing.image` means different things (Gemini: price per *input* image token;
  qwen-image-3: $0.003 = its *input* image price, while its real output price is $0.03 per image). `openrouter/auto-beta`
  has empty pricing.
- Use OpenRouter's **Images API**, not chat completions:
  - `POST /api/v1/images` body: `model`, `prompt` (required); optional `n` (1–10), `size` (`"2K"` or `"WxH"`),
    `resolution` (`512|768|1K|1.5K|2K|4K`), `aspect_ratio` (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`,
    `4:5`, `5:4`, `21:9`, `auto`, …), `quality`, `output_format` (`png|jpeg|webp|svg`), `background`
    (`auto|transparent|opaque`), `seed`, `input_references` (≤16 × `{"type":"image_url","image_url":{"url":<data URL or https>}}`).
    An explicit pixel `size` that conflicts with `resolution`/`aspect_ratio` is a 400; single-image providers reject `n>1`.
  - Response: `{created, data:[{b64_json, media_type?}], usage:{…, cost, completion_tokens_details:{image_tokens}}}`.
    A failed generation returns 502 and is not billed ("all-or-nothing").
  - **Price before running**: `GET /api/v1/images/models/{author}/{slug}/endpoints` →
    `{id, endpoints:[{provider_slug, supported_parameters:{name:{type, values?}}, pricing:[{billable, unit, cost_usd, variant?}]}]}`
    with `billable` ∈ `output_image|input_image|input_reference|input_text|input_font`, `unit` ∈ `request|image|megapixel|token`.
    Real: recraft-v4.1-flash output $0.007/image; flux-3-image-klein $0.008 (768) … $0.036 (4k), takes
    input_references; qwen-image-3 output $0.03/image (1k, 2k), input_image $0.003; tencent hy-image-v3.5 output
    $0.0000016 per **token**. Fixtures `image-endpoints-*.json`. `GET /api/v1/images/models` lists all image models.

## 1. Free-model picker fix (lib/api)

A model is free only when **every** pricing field is zero or absent (not just prompt/completion) and its id ends in
`:free` (or it's the free router). Any nonzero field (`image`, `image_output`, `image_token`, `web_search`,
`internal_reasoning`, `audio`, …) = paid. Empty pricing = unknown = paid (refuse to estimate). Test with
`image-models.json`: none may be picked as free.

## 2. `image` backend gains `provider: "openrouter"`

- Options: `provider: "openrouter"`, `model` (exact id, required), `maxCostUsd` (required — every OpenRouter image is
  paid, Lok's rule), `n` (default 1), `resolution`, `aspect_ratio`, `size`, `quality`, `output_format`, `background`,
  `seed`, `images` (absolute reference files → base64 data URLs in `input_references`), `outDir`. Without
  `provider` the backend is today's Codex path, unchanged.
- **Estimate first** from the Images-API endpoint pricing of the first endpoint (or a `provider` slug option if
  given): `output_image` line matching the requested `resolution` (by `variant`, case-insensitive; no variant →
  the line without one, else the cheapest that covers it, else the most expensive) × `n` for unit `image`/`request`;
  unit `megapixel` × megapixels from size/resolution (default 1K = 1.0 MP); unit `token` → estimate tokens as
  4 096 × megapixels × 1.5 and mark `estimate: "rough"`; plus `input_image`/`input_reference` × number of reference
  images. Refuse before any request when the estimate exceeds `maxCostUsd` (`estimated $X > maxCostUsd $Y`), when
  pricing is missing, or when a requested option isn't in `supported_parameters` (say which).
- Request through `POST /api/v1/images` with the key reader and secrets rules of lib/api (Bearer only, never logged).
  Decode each `b64_json` and write `image-<i>.<ext>` (ext from `media_type`, else `output_format`, else png) into
  the run folder and copy to `outDir`. **Never put base64 in run.json, answers, transcripts or tool output**: return
  file paths with bytes and dimensions only (PNG/JPEG/WebP header parse; SVG → no dims).
- Record `costUsd` from `usage.cost`, `estimateUsd`, `overCap` (cost > cap), model, provider slug, `n`. Statuses as
  api (`done`, `failed`, `denied`, `limit` for 402, `rate_limited`), 502 → `failed` "generation failed (not billed)".
- No escalation and no retries on another model.
- `fleet_accounts {backend:"image"}`: list OpenRouter image models with their **real** cheapest output price per
  image from the Images-API endpoints (cache 24 h like the free catalogue; up to 15 cheapest, `cost: "paid"`,
  `price: "$0.007/image"` or `"$0.0000016/token"`), after the Codex row.
- MCP: reuse `fleet_ask` (backend `image`); add only the new option names to the schema, no descriptions unless
  unclear. Keep `image` maxLive 2.

## 3. Tests

Picker against `image-models.json`; estimator against each `image-endpoints-*.json` (variants, token unit, input
references, missing pricing, unsupported option); request body; b64 decoding to files with no base64 anywhere in
run.json/output; cost/overCap recording; 402 → limit, 502 → failed; Codex path unchanged. Report briefly.
