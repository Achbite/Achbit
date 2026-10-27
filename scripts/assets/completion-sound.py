#!/usr/bin/env python3
"""Generate Achbit's original soft two-note completion chime (no external audio)."""
import math
import struct
import wave
from pathlib import Path

RATE = 44100
DURATION = 1.65
samples = []
for i in range(round(RATE * DURATION)):
    t = i / RATE
    value = 0.0
    # E5 -> C5, a short rounded attack and a softer, longer second note.
    for start, frequency, gain in [(0.0, 659.255, 0.17), (0.36, 523.251, 0.145)]:
        age = t - start
        if age < 0:
            continue
        envelope = (1 - math.exp(-age / 0.012)) * math.exp(-age / 0.29)
        tone = math.sin(2 * math.pi * frequency * age)
        tone += 0.12 * math.sin(2 * math.pi * frequency * 2 * age) * math.exp(-age / 0.12)
        value += gain * envelope * tone
    value *= min(1.0, (DURATION - t) / 0.10)
    samples.append(struct.pack('<h', round(value * 32767)))
output = Path(__file__).resolve().parents[2] / 'shells/achbit-gui/src-tauri/sounds/completion.wav'
with wave.open(str(output), 'wb') as audio:
    audio.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
    audio.writeframes(b''.join(samples))
print(output)
