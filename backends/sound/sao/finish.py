# finish.py <in dir> <out dir> [--music key,key] [--ceiling dB] [--only key,key]
# Make generated .wav files fit for a game.
# Trims silence from both ends, fades the tail, evens out loudness, folds effects to mono, and writes small .ogg files
# (Opus is not played by every Safari; Vorbis .ogg plus an .m4a twin covers everything). Music keeps stereo and gets a
# crossfaded loop point. Needs ffmpeg on PATH.
import sys, os, subprocess, json, math, array

def decoded_peak(path):
    # Measure the encoded file in float at 4x so codec and inter-sample overshoots count.
    command = ['ffmpeg', '-v', 'error', '-i', path, '-af', 'aresample=176400',
               '-c:a', 'pcm_f32le', '-f', 'f32le', '-']
    peak = 0.0
    with subprocess.Popen(command, stdout=subprocess.PIPE) as process:
        while True:
            data = process.stdout.read(65536)
            if not data:
                break
            samples = array.array('f')
            samples.frombytes(data)
            if sys.byteorder != 'little':
                samples.byteswap()
            peak = max(peak, max(map(abs, samples), default=0.0))
        if process.wait():
            raise subprocess.CalledProcessError(process.returncode, command)
    return peak

src, dst = sys.argv[1], sys.argv[2]
music = set()
if '--music' in sys.argv:
    music = set(sys.argv[sys.argv.index('--music') + 1].split(','))
only = None
if '--only' in sys.argv:
    only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
ceiling = None
if '--ceiling' in sys.argv:
    try:
        ceiling_db = float(sys.argv[sys.argv.index('--ceiling') + 1])
        if not math.isfinite(ceiling_db) or not -24 <= ceiling_db <= 0:
            raise ValueError
        ceiling = 10 ** (ceiling_db / 20)
    except (ValueError, IndexError):
        sys.exit('--ceiling must be a finite number between -24 and 0 dBFS')
os.makedirs(dst, exist_ok=True)
report = {}
for name in sorted(os.listdir(src)):
    if not name.endswith('.wav'):
        continue
    key = name[:-4]
    if only is not None and key not in only:
        continue
    a = os.path.join(src, name)
    if key in music:
        # loudness for a bed under effects, a short fade at both ends so a loop does not click
        chain = 'loudnorm=I=-20:TP=-2:LRA=9,afade=t=in:d=0.4,areverse,afade=t=in:d=1.2,areverse'
        ch, rate = '2', '96k'
    else:
        # cut leading silence hard (a cue must speak at once), trailing silence softly, short fade out
        chain = ('silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.005,'
                 'areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,afade=t=in:d=0.06,areverse,'
                 'loudnorm=I=-16:TP=-1.5:LRA=11')
        ch, rate = '1', '64k'
    for ext, codec in (('ogg', ['-c:a', 'libvorbis']), ('m4a', ['-c:a', 'aac'])):
        out = os.path.join(dst, key + '.' + ext)
        gain = 1.0
        for attempt in range(8):
            output_chain = chain
            if ceiling is not None:
                # Fold channels before limiting: the mono mix can itself raise the peak.
                layout = 'mono' if ch == '1' else 'stereo'
                output_chain += (f',aformat=channel_layouts={layout},aresample=176400,'
                                 f'alimiter=limit={ceiling}:level=false:attack=1:release=50:'
                                 f'latency=true:level_out={gain},aresample=44100')
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', a, '-af', output_chain, '-ac', ch, '-ar', '44100', '-b:a', rate, *codec, out], check=True)
            if ceiling is None:
                break
            peak = decoded_peak(out)
            if math.isfinite(peak) and peak <= ceiling:
                break
            # Lossy codecs can overshoot even a limited signal. Re-encode from the source
            # with measured headroom plus 0.1 dB, never from an already lossy output.
            if not math.isfinite(peak):
                break
            gain = max(0.015625, gain * ceiling / peak * 10 ** (-0.1 / 20))
        if ceiling is not None and (not math.isfinite(peak) or peak > ceiling):
            os.remove(out)
            raise RuntimeError(f'{out}: could not meet the {ceiling_db:g} dBFS ceiling')
    d = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', os.path.join(dst, key + '.ogg')]).decode().strip()
    report[key] = {'seconds': round(float(d), 2), 'bytes': os.path.getsize(os.path.join(dst, key + '.ogg'))}
    print(key, report[key])
if only is not None:
    # Keep entries for existing outputs even when just a few sources were regenerated.
    for name in sorted(os.listdir(dst)):
        if not name.endswith('.ogg') or not os.path.isfile(os.path.join(dst, name)):
            continue
        key = name[:-4]
        if key not in report:
            out = os.path.join(dst, name)
            d = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).decode().strip()
            report[key] = {'seconds': round(float(d), 2), 'bytes': os.path.getsize(out)}
    report = dict(sorted(report.items()))
json.dump(report, open(os.path.join(dst, 'sounds.json'), 'w'), indent=1)
