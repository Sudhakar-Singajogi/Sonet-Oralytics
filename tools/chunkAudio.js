#!/usr/bin/env node
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import ffmpegPath from "ffmpeg-static";

const args = process.argv.slice(2);
const get = (k, def) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : def;
};
const inDir = get("in", "data/processed/16k");
const outDir = get("out", "data/chunks");
const cfgPath = get("config", "configs/default.yaml");
const cfg = yaml.parse(fs.readFileSync(cfgPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

const noise = cfg.vad.silence_db ?? -35;
const minSil = cfg.vad.min_silence_sec ?? 0.5;
const maxChunk = cfg.vad.max_chunk_sec ?? 30.0;
const pad = cfg.vad.pad_sec ?? 0.15;

async function detectSilence(wavPath) {
  // ffmpeg -af silencedetect=noise=-30dB:d=0.5 -f null -
  const { stderr } = await execa(ffmpegPath, [
    "-hide_banner","-nostats","-i", wavPath,
    "-af", `silencedetect=noise=${noise}dB:d=${minSil}`,
    "-f","null","-"
  ], { stderr: "pipe" }); // parse stderr for silence_start/end
  const lines = stderr.split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    let m = line.match(/silence_start:\s*([0-9.]+)/);
    if (m) events.push({ t: parseFloat(m[1]), type: "start" });
    m = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (m) events.push({ t: parseFloat(m[1]), type: "end" });
  }
  return events;
}

function speechIntervals(totalDur, silenceEvents) {
  // Complement of silence spans → speech spans, with maxChunk cap
  const sil = [];
  for (let i=0; i<silenceEvents.length; i++) {
    if (silenceEvents[i].type === "start" && silenceEvents[i+1]?.type === "end") {
      sil.push([silenceEvents[i].t, silenceEvents[i+1].t]);
      i++;
    }
  }
  const boundaries = [0, ...sil.flat(), totalDur].sort((a,b)=>a-b);
  const spans = [];
  for (let i=0; i<boundaries.length-1; i+=2) {
    const s = boundaries[i], e = boundaries[i+1];
    if (e-s > 0.1) spans.push([s, e]);
  }
  // split long spans
  const final = [];
  for (const [s,e] of spans) {
    let cur = s;
    while (cur < e) {
      final.push([cur, Math.min(e, cur + maxChunk)]);
      cur += maxChunk;
    }
  }
  // pad
  return final.map(([s,e]) => [Math.max(0, s - pad), e + pad]);
}

async function durationOf(wavPath) {
  const { stderr } = await execa(ffmpegPath, ["-i", wavPath], { reject:false });
  const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!m) return 0;
  const h = +m[1], mi = +m[2], se = +m[3];
  return h*3600 + mi*60 + se;
}

async function cut(wavPath, outBase, i, s, e) {
  const out = path.join(outDir, `${outBase}_chunk_${String(i).padStart(3,"0")}.wav`);
  await execa(ffmpegPath, [
    "-hide_banner","-nostats","-y","-i", wavPath, "-ss", s.toFixed(2), "-to", e.toFixed(2), "-c","copy", out
  ]);
  return out;
}

(async () => {
  const files = fs.readdirSync(inDir).filter(f => /\.wav$/i.test(f));
  const manifestPath = path.join(outDir, "chunks_manifest.jsonl");
  const outStream = fs.createWriteStream(manifestPath, { flags: "w" });

  for (const f of files) {
    const wav = path.join(inDir, f);
    const base = path.parse(f).name;
    const dur = await durationOf(wav);
    const events = await detectSilence(wav); // emits silence_start/end lines :contentReference[oaicite:4]{index=4}
    const spans = speechIntervals(dur, events);
    let idx = 1;
    for (const [s,e] of spans) {
      const out = await cut(wav, base, idx++, s, e);
      outStream.write(JSON.stringify({
        src: path.basename(wav), chunk: path.basename(out),
        start: +s.toFixed(2), end: +e.toFixed(2), duration: +(e-s).toFixed(2)
      }) + "\n");
    }
    console.log(`[chunk] ${f}: ${spans.length} chunks`);
  }
  outStream.end();
  console.log(`[chunk] wrote manifest → ${manifestPath}`);
})();
