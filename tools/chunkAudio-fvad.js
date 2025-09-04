#!/usr/bin/env node
/**
 * VAD chunker (WASM, robust)
 * - Feeds 10 ms frames to WebRTC VAD (stable across builds)
 * - Optional smoothing to emulate 20/30 ms behavior
 * - Outputs chunk WAVs + JSONL manifest
 *
 * Env:
 *   FVAD_MODE=0|1|2|3         (default 2; 3 = most aggressive)
 *   FVAD_FRAME_MS=10|20|30    (default 10; smoothing window size)
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { readFileSync } from "node:fs";
import * as wav from "node-wav";
import { execa } from "execa";
import ffmpegPath from "ffmpeg-static";

/* ---------- CLI args & config ---------- */

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const inDir = getArg("in", "data/processed/16k");
const outDir = getArg("out", "data/chunks");
const cfgPath = getArg("config", "configs/default.yaml");

fs.mkdirSync(outDir, { recursive: true });

const cfg = yaml.parse(readFileSync(cfgPath, "utf8")) ?? {};

/* ---------- Tunables ---------- */

const SR = 16000;
const MODE = Number(process.env.FVAD_MODE ?? 2);      // 0..3 (3 = most aggressive)
const PAD  = Number(cfg.vad?.pad_sec ?? 0.15);
const MAX  = Number(cfg.vad?.max_chunk_sec ?? 30.0);
const MIN_SPEECH = Number(cfg.vad?.min_speech_sec ?? 0.30);

/** Always feed 10ms frames to VAD (16 kHz → 160 samples) */
const VAD_FRAME_MS = 10;
const SAMPLES_PER_FRAME = 160;

/** External “feel”: 10|20|30 ms via smoothing  */
const OUT_FRAME_MS = Number(process.env.FVAD_FRAME_MS ?? 10);
const SMOOTH_N = OUT_FRAME_MS === 30 ? 3 : OUT_FRAME_MS === 20 ? 2 : 1;

/* ---------- Load WASM VAD & wrap low-level API ---------- */

async function loadFvad() {
  // Load module (works whether it exports default() or is pre-initialized)
  let mod;
  try {
    const m = await import("@echogarden/fvad-wasm");
    mod = typeof m.default === "function" ? await m.default() : m;
  } catch {
    const m = await import("@echogarden/fvad-wasm/fvad.js");
    mod = typeof m.default === "function" ? await m.default() : m;
  }

  // Emscripten wrappers
  const fvad_new             = mod.cwrap("fvad_new", "number", []);
  const fvad_free            = mod.cwrap("fvad_free", "void",   ["number"]);
  const fvad_reset           = mod.cwrap("fvad_reset", "number", ["number"]);
  const fvad_set_mode        = mod.cwrap("fvad_set_mode", "number", ["number","number"]);
  const fvad_set_sample_rate = mod.cwrap("fvad_set_sample_rate", "number", ["number","number"]);
  const fvad_process         = mod.cwrap("fvad_process", "number", ["number","number","number"]);

  const ptr = fvad_new();
  if (!ptr) throw new Error("fvad_new failed");
  if (fvad_set_sample_rate(ptr, SR) !== 0) throw new Error("fvad_set_sample_rate failed");
  if (fvad_set_mode(ptr, MODE) !== 0)       throw new Error("fvad_set_mode failed");
  fvad_reset(ptr);

  function processFrame(int16Frame) {
    // Ensure exact size (pad if needed)
    if (int16Frame.length !== SAMPLES_PER_FRAME) {
      const pad = new Int16Array(SAMPLES_PER_FRAME);
      pad.set(int16Frame.subarray(0, Math.min(int16Frame.length, SAMPLES_PER_FRAME)));
      int16Frame = pad;
    }
    const bytes = SAMPLES_PER_FRAME * 2;         // int16 → 2 bytes/sample
    const buf = mod._malloc(bytes);
    mod.HEAP16.set(int16Frame, buf >> 1);
    const res = fvad_process(ptr, buf, SAMPLES_PER_FRAME); // 1=speech, 0=non-speech, -1=error
    mod._free(buf);
    if (res === -1) throw new Error("fvad_process returned error");
    return res === 1;
  }

  function close() {
    try { fvad_free(ptr); } catch {}
  }

  return { processFrame, close };
}

/* ---------- Helpers ---------- */

function floatToInt16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i=0;i<float32.length;i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return pcm;
}

/** Slice into strict 10ms frames; zero-pad last partial */
function framesFromPCMStrict(int16) {
  const frames = [];
  const step = SAMPLES_PER_FRAME; // 160 @16k
  let i = 0;
  for (; i + step <= int16.length; i += step) {
    frames.push(int16.subarray(i, i + step));
  }
  const rem = int16.length - i;
  if (rem > 0) {
    const pad = new Int16Array(step);
    pad.set(int16.subarray(i));
    frames.push(pad);
  }
  return frames;
}

/** Majority smoothing over N frames (N = 1/2/3) */
function smoothFlags(flags, n) {
  if (n <= 1) return flags;
  const out = new Array(flags.length);
  const half = Math.floor(n / 2);
  for (let i=0; i<flags.length; i++) {
    const start = Math.max(0, i - half);
    const end   = Math.min(flags.length - 1, i + half);
    let cnt = 0, total = 0;
    for (let j=start; j<=end; j++) { total++; if (flags[j]) cnt++; }
    out[i] = cnt >= Math.ceil(total/2);
  }
  return out;
}

/** Build spans from flags (seconds), split long spans, pad edges */
function spansFromVad(vadFlags, frameDur) {
  const spans = [];
  let s = null;
  for (let i=0; i<vadFlags.length; i++) {
    if (vadFlags[i] && s === null) s = i * frameDur;
    const isLast = i === vadFlags.length - 1;
    if ((!vadFlags[i] || isLast) && s !== null) {
      const end = (vadFlags[i] && isLast) ? (i+1)*frameDur : i*frameDur;
      if (end - s >= MIN_SPEECH) spans.push([s, end]);
      s = null;
    }
  }
  // split long spans and pad
  const out = [];
  for (const [a,b] of spans) {
    let cur = a;
    while (cur < b) {
      const e = Math.min(b, cur + MAX);
      out.push([Math.max(0, cur - PAD), e + PAD]);
      cur = e;
    }
  }
  return out;
}

/* ---------- Main ---------- */

async function main() {
  const { processFrame, close } = await loadFvad();

  const files = fs.readdirSync(inDir).filter(f => f.toLowerCase().endsWith(".wav"));
  if (!files.length) {
    console.error(`[fvad] No WAV files found in ${inDir}. Did you run "npm run prep"?`);
    process.exit(1);
  }

  const manifestPath = path.join(outDir, "chunks_manifest.jsonl");
  const outStream = fs.createWriteStream(manifestPath, { flags: "w" });

  for (const f of files) {
    const wavPath = path.join(inDir, f);
    const { sampleRate, channelData } = wav.decode(readFileSync(wavPath));
    if (sampleRate !== SR || channelData.length !== 1) {
      throw new Error(`Expected 16 kHz mono WAV. Got sr=${sampleRate}, channels=${channelData.length}. Run prep first.`);
    }

    const pcm = floatToInt16(channelData[0]);
    const frames = framesFromPCMStrict(pcm);                 // always 10ms frames
    const rawFlags = frames.map(fr => processFrame(fr));     // true = speech
    const flags = smoothFlags(rawFlags, SMOOTH_N);           // emulate 20/30ms if requested
    const frameDur = VAD_FRAME_MS / 1000;                    // 0.01s
    const spans = spansFromVad(flags, frameDur);

    let idx = 1;
    for (const [s,e] of spans) {
      const out = path.join(outDir, `${path.parse(f).name}_chunk_${String(idx++).padStart(3,"0")}.wav`);
      await execa(ffmpegPath, [
        "-hide_banner","-nostats","-y",
        "-i", wavPath,
        "-ss", s.toFixed(2), "-to", e.toFixed(2),
        "-c","copy", out
      ]);
      outStream.write(JSON.stringify({
        src: f, chunk: path.basename(out),
        start: +s.toFixed(2), end: +e.toFixed(2), duration: +(e-s).toFixed(2)
      }) + "\n");
    }
    console.log(`[fvad] ${f}: ${spans.length} chunks`);
  }

  outStream.end();
  close();
  console.log(`[fvad] wrote manifest → ${manifestPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
