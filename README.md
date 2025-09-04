# Sonet-Oralytics
AI-powered speech analytics that makes every word count


# Sonet-Oralytics — Milestone 0: Groundwork (Repo + Data)

This repo contains the foundation for the CEFR-Feedback pipeline in **Node.js**:
- Convert **raw audio** (mp3/wav/m4a/flac) → **16 kHz mono WAV** (normalized)
- Segment into **speech chunks** using **WebRTC VAD (WASM)** or **FFmpeg silencedetect**
- Emit a **manifest** (`chunks_manifest.jsonl`) with start/end/duration per chunk

**Acceptance (met):**
- `data/processed/16k/*.wav` are created  
- `data/chunks/*_chunk_XXX.wav` are created  
- `data/chunks/chunks_manifest.jsonl` lists chunk timings  
- One command runs end-to-end

---

## Repo layout

Sonet-Oralytics/
├─ tools/
│ ├─ prepareAudio.js # decode + normalize → 16k mono WAV
│ ├─ chunkAudio-fvad.js # VAD chunker (WASM; robust on Windows)
│ └─ chunkAudio.js # (alt) FFmpeg silencedetect chunker
├─ data/
│ ├─ raw/ # your inputs (mp3/wav/…)
│ ├─ processed/16k/ # auto: resampled WAVs
│ └─ chunks/ # auto: chunk WAVs + manifest
├─ configs/
│ └─ default.yaml # pipeline config (audio + VAD)
├─ scripts/
│ └─ run_groundwork.sh # optional shell runner
└─ package.json


---

## Prerequisites

- **Node.js 18+**
- No Python or native build tools needed for Groundwork (WASM VAD + ffmpeg-static)

Install dependencies:
```bash
npm i execa ffmpeg-static yaml node-wav @echogarden/fvad-wasm

# none beyond ffmpeg-static (already installed)

Configuration

audio:
  target_sample_rate: 16000   # resample target
  normalize_dbfs: -20.0       # RMS loudness target (dBFS)
  mono: true

vad:
  pad_sec: 0.15               # pad around speech spans
  max_chunk_sec: 30.0         # hard max per chunk
  min_speech_sec: 0.30        # ignore tiny spurts (<300ms)

  # Used only by the FFmpeg alternative:
  silence_db: -35             # silencedetect threshold
  min_silence_sec: 0.5

#Why normalize? Keeps loudness consistent across clips; improves stability for later scoring.

NPM scripts
{
  "type": "module",
  "scripts": {
    "prep": "node tools/prepareAudio.js --in data/raw --out data/processed --config configs/default.yaml",
    "chunk:fvad": "node tools/chunkAudio-fvad.js --in data/processed/16k --out data/chunks --config configs/default.yaml",
    "chunk": "node tools/chunkAudio.js --in data/processed/16k --out data/chunks --config configs/default.yaml",
    "groundwork": "npm run prep && npm run chunk:fvad"
  }
}

VAD environment knobs

FVAD_MODE ∈ {0,1,2,3} (default 2) — higher = more aggressive speech detection

FVAD_FRAME_MS ∈ {10,20,30} (default 10) — smoothing window for decisions

Internally the VAD always receives 10 ms frames for maximum reliability; the “20/30 ms” setting just smooths decisions.

npm run groundwork
$env:FVAD_MODE=3; $env:FVAD_FRAME_MS=20; npm run chunk:fvad

Usage

Put a few short recordings into data/raw/ (10–30s each).

Run the full pipeline:

npm run groundwork


Inspect outputs:

data/processed/16k/*.wav

data/chunks/*_chunk_XXX.wav

data/chunks/chunks_manifest.jsonl (JSONL; one line per chunk)

JSONL row example:

{"src":"hello.wav","chunk":"hello_chunk_001.wav","start":0.15,"end":7.92,"duration":7.77}

What each tool does (short)
tools/prepareAudio.js

Uses ffmpeg-static via execa

Converts any input to 16 kHz mono 16-bit PCM

Measures mean loudness (volumedetect) and applies gain to hit normalize_dbfs

tools/chunkAudio-fvad.js (default)

Loads WebRTC VAD via @echogarden/fvad-wasm

Slices audio into 10 ms frames (160 samples @16 kHz), pads the tail

Processes frames with VAD, optional smoothing (to emulate 20/30 ms)

Builds speech spans, pads edges, splits long spans, and cuts chunks via FFmpeg

Writes chunks_manifest.jsonl

tools/chunkAudio.js (alternative)

Uses FFmpeg silencedetect to find silence

Complements to speech intervals, splits/cuts with FFmpeg

No VAD (simple, works everywhere)

Tuning

More chunks (for testing): set vad.max_chunk_sec: 8 (or 5)

Fewer micro-chunks: increase vad.min_speech_sec to 0.40 and/or use FVAD_FRAME_MS=30

Boundary clipping: increase vad.pad_sec to 0.25

Stricter detection: FVAD_MODE=3

Troubleshooting

ESM “Reparsing as ES module” warning
Add "type": "module" to package.json (already shown above).

Only one chunk per file
Likely no long pause and file < max_chunk_sec. Reduce max_chunk_sec, raise FVAD_MODE, or insert a 0.5–1s pause in the audio.

No output / empty manifest
Confirm you ran npm run prep and that data/raw/ contains supported formats. Check console logs for ffmpeg errors.

Milestone status

 Groundwork complete: raw → 16 kHz mono → VAD chunks → manifest

 Milestone 1: Whisper ASR (per-word timestamps)

 Milestone 2: Forced alignment (MFA) & phonemes

 Milestone 3: GOP pronunciation scoring

 Milestone 4: Fluency metrics (WPM, pauses)

 Milestone 5+: Fusion → CEFR band, feedback, service packaging

License

TBD


Want me to save this into your repo as `README.md` and include a tiny example manifest line?
::contentReference[oaicite:0]{index=0}