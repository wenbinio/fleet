# gen.py <list.json> [out dir] : sound cues from text with Stable Audio Open. list.json is [{"key","prompt","seconds","seed"?,"steps"?}].
# Writes out/<key>.wav (44.1 kHz stereo). Skips keys whose file exists.
import sys, json, os, torch, soundfile as sf
from diffusers import StableAudioPipeline
jobs = json.load(open(sys.argv[1], encoding='utf-8'))
out = sys.argv[2] if len(sys.argv) > 2 else 'out'
os.makedirs(out, exist_ok=True)
pipe = StableAudioPipeline.from_pretrained('stabilityai/stable-audio-open-1.0', torch_dtype=torch.float16).to('cuda')
NEG = 'low quality, noise, hiss, distortion, speech, voice, vocals, music'
for j in jobs:
    path = os.path.join(out, j['key'] + '.wav')
    if os.path.exists(path):
        continue
    g = torch.Generator('cuda').manual_seed(j.get('seed', 7))
    neg = j.get('negative', NEG if not j.get('music') else 'low quality, noise, hiss, distortion, vocals, speech')
    audio = pipe(j['prompt'], negative_prompt=neg, num_inference_steps=j.get('steps', 100), audio_end_in_s=float(j['seconds']),
                 num_waveforms_per_prompt=1, generator=g).audios[0]
    sf.write(path, audio.T.float().cpu().numpy(), pipe.vae.sampling_rate)
    print('wrote', path, flush=True)
