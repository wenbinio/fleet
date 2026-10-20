# peak_norm.py <in dir> <out dir> [peak dBFS, default -1] : gain-only peak normalise every .wav before finish.py.
# MOSS writes its raw output at -20 to -32 dBFS and finish.py trims "silence" at a fixed -45/-50 dB, so quiet takes lose real sound.
import sys, os, glob, numpy as np, soundfile as sf
src, dst = sys.argv[1], sys.argv[2]
target = float(sys.argv[3]) if len(sys.argv) > 3 else -1.0
os.makedirs(dst, exist_ok=True)
for f in sorted(glob.glob(os.path.join(src, '*.wav'))):
    x, sr = sf.read(f, dtype='float32')
    peak = float(np.max(np.abs(x)))
    if peak == 0:
        print('silent, skipped', f)
        continue
    gain = 10 ** (target / 20) / peak
    sf.write(os.path.join(dst, os.path.basename(f)), x * gain, sr, subtype='FLOAT')
    print(os.path.basename(f), f'{20 * np.log10(gain):+.1f} dB')
