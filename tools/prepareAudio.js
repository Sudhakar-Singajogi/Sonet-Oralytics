#!/usr/bin/env node
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import ffmpegPath from "ffmpeg-static";

const args = process.argv.slice(2);
const get = (k, def) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : def;
};
const inDir = get("in", "data/raw");
const outDir = path.join(get("out", "data/processed"), "16k");
const cfgPath = get("config", "configs/default.yaml");
const cfg = yaml.parse(fs.readFileSync(cfgPath, "utf8"));

fs.mkdirSync(outDir, { recursive: true });
const SR = cfg.audio.target_sample_rate ?? 16000;
const TARGET = cfg.audio.normalize_dbfs ?? -20.0;

async function ff(args) {
  const { stderr } = await execa(ffmpegPath, args, { stderr: "pipe" });
  return stderr;
}

function listInputs(dir) {
  return fs.readdirSync(dir)
    .filter(f => /\.(mp3|wav|m4a|flac)$/i.test(f))
    .map(f => path.join(dir, f));
}

async function convertOne(inp) {
  const tmp = path.join(outDir, path.parse(inp).name + ".tmp.wav");
  const out = path.join(outDir, path.parse(inp).name + ".wav");

  // Convert → 16k mono PCM s16
  await ff(["-hide_banner","-nostats","-y","-i", inp, "-ac","1","-ar", String(SR), "-sample_fmt","s16", tmp]);

  // Measure mean_volume
  const det = await ff(["-hide_banner","-nostats","-y","-i", tmp, "-filter:a","volumedetect","-f","null","-"]);
  const match = det.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  if (match) {
    const mean = parseFloat(match[1]);
    const gain = TARGET - mean;
    await ff(["-hide_banner","-nostats","-y","-i", tmp, "-filter:a", `volume=${gain}dB`, out]);
    fs.unlinkSync(tmp);
  } else {
    fs.renameSync(tmp, out);
  }
  console.log(`[prepare] ${path.basename(inp)} → ${path.relative(process.cwd(), out)}`);
}

(async () => {
  const files = listInputs(inDir);
  if (!files.length) {
    console.error(`[prepare] No audio in ${inDir}`);
    process.exit(1);
  }
  for (const f of files) await convertOne(f);
  console.log("[prepare] done.");
})();
