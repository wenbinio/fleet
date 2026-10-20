# moss_gen.py <cues.json> <out dir> [--timings <timings.json>] : sound cues from text with MOSS-SoundEffect v2.0.
# Writes <out dir>/<key>.wav (48 kHz mono float32). Skips keys whose file exists.
from time import perf_counter

PROCESS_START = perf_counter()

import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
MODEL_DIR = Path(__file__).resolve().parents[1] / "weights/MOSS-SoundEffect-v2.0"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cues", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--timings", type=Path)
    args = parser.parse_args()
    jobs = json.loads(args.cues.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=True)
    if args.timings:
        args.timings.parent.mkdir(parents=True, exist_ok=True)

    import torch
    import soundfile as sf
    from moss_soundeffect_v2 import MossSoundEffectPipeline

    started = perf_counter()
    pipe = MossSoundEffectPipeline.from_pretrained(
        MODEL_DIR, torch_dtype=torch.bfloat16, device="cuda",
    )
    # The DiT is built in float32 (5.6 GB) and only run under bf16 autocast; with a 30 s latent and the VAE decode
    # that overran the 16 GB card into shared memory, so hold its weights in bf16 too.
    for p in pipe.engine.dit.parameters():  # parameters only: the RoPE freqs are complex and must stay complex
        if p.is_floating_point():
            p.data = p.data.to(torch.bfloat16)
    pretrained_seconds = perf_counter() - started
    torch.cuda.synchronize()
    timings = {
        "load_seconds": perf_counter() - PROCESS_START,
        "from_pretrained_seconds": pretrained_seconds,
        "cues": {},
    }
    print(f"loaded in {timings['load_seconds']:.2f}s", flush=True)

    def save_timings():
        if args.timings:
            timings["max_memory_allocated_mb"] = torch.cuda.max_memory_allocated() / 1_000_000
            timings["max_memory_reserved_mb"] = torch.cuda.max_memory_reserved() / 1_000_000
            temporary = args.timings.with_suffix(args.timings.suffix + ".tmp")
            temporary.write_text(json.dumps(timings, indent=2) + "\n", encoding="utf-8")
            temporary.replace(args.timings)

    save_timings()
    failed = False
    for cue in jobs:
        key = cue["key"]
        path = args.out / (key + ".wav")
        entry = timings["cues"][key] = {}
        if path.exists():
            entry["status"] = "skipped"
            save_timings()
            continue
        try:
            torch.cuda.synchronize()
            started = perf_counter()
            try:
                audio = pipe(
                    prompt=cue["prompt"], seconds=float(cue["seconds"]),
                    num_inference_steps=cue.get("steps", 100),
                    cfg_scale=4.0, sigma_shift=5.0, seed=cue["seed"],
                    negative_prompt=cue["negative"], append_duration_suffix=True,
                    num_channels=1,
                )
            finally:
                torch.cuda.synchronize()
                entry["generation_seconds"] = perf_counter() - started
            audio = audio[0].detach().to(device="cpu", dtype=torch.float32).T.numpy()
            if audio.shape != (int(float(cue["seconds"]) * pipe.sample_rate), 1):
                raise ValueError(f"Unexpected audio shape {audio.shape} for {cue['seconds']}s mono")
            temporary = path.with_suffix(".wav.tmp")
            sf.write(temporary, audio, pipe.sample_rate, format="WAV", subtype="FLOAT")
            temporary.replace(path)
            entry["status"] = "written"
            print("wrote", path, flush=True)
        except Exception as exc:
            failed = True
            entry.update(status="failed", error=f"{type(exc).__name__}: {exc}")
            print(f"error {key}: {entry['error']}", file=sys.stderr, flush=True)
        torch.cuda.empty_cache()
        save_timings()
    save_timings()
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
