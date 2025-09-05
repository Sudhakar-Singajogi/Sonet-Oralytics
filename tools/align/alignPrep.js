#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i+1] : d; };

const manifestPath   = get("manifest", "data/chunks/chunks_manifest.jsonl");
const asrSummaryPath = get("asr", "data/chunks/asr-summary.json");
const corpusDir      = get("corpus", "data/align/corpus");
const dictDir        = get("dict", "data/align/dict");
const cfgPath        = get("config", "configs/default.yaml");

// base dirs
const manifestDir = path.dirname(manifestPath);
const chunksDir   = get("chunksDir", manifestDir);

if (!fs.existsSync(corpusDir)) fs.mkdirSync(corpusDir, { recursive: true });
if (!fs.existsSync(dictDir))   fs.mkdirSync(dictDir,   { recursive: true });

// optional config (not used yet but future-proof)
const cfg = fs.existsSync(cfgPath) ? yaml.parse(readFileSync(cfgPath, "utf8")) : {};

function normalizeText(t) {
  if (!t) return "";
  let s = t.normalize("NFC");
  s = s.replace(/[“”]/g, '"').replace(/[’]/g, "'");
  s = s.replace(/[^a-zA-Z0-9' \-]/g, " ");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

function resolveAudioPath(p) {
  if (!p) return undefined;
  return path.isAbsolute(p) ? p : path.join(chunksDir, p);
}

function pickAudioPath(obj) {
  const candidates = [obj.chunk, obj.wav, obj.audio, obj.path, obj.file, obj.filepath, obj.outWav, obj.out_path]
    .filter(Boolean);
  return candidates.length ? resolveAudioPath(candidates[0]) : undefined;
}

const asrSummary = fs.existsSync(asrSummaryPath)
  ? JSON.parse(readFileSync(asrSummaryPath, "utf8"))
  : {};

const raw = fs.readFileSync(manifestPath, "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);

for (const line of lines) {
  let item;
  try { item = JSON.parse(line); }
  catch { console.warn("[align:prep] Skipping non-JSON line:", line.slice(0, 120)); continue; }

  const wavSrc = pickAudioPath(item);
  if (!wavSrc) throw new Error(`[align:prep] No audio path in row: ${line}`);
  if (!fs.existsSync(wavSrc)) throw new Error(`[align:prep] Missing wav on disk: ${wavSrc}`);

  const base    = path.basename(wavSrc, path.extname(wavSrc));
  const chunkId = item.id || item.chunkId || base;
  const wavDst  = path.join(corpusDir, `${chunkId}.wav`);
  if (!fs.existsSync(wavDst)) fs.copyFileSync(wavSrc, wavDst);

  const refText =
    item.reference_text ||
    item.referenceText ||
    asrSummary[chunkId]?.text ||
    asrSummary[base]?.text ||
    item.text ||
    "";

  fs.writeFileSync(path.join(corpusDir, `${chunkId}.lab`), normalizeText(refText) + "\n", "utf8");
}

const lexiconPath = path.join(dictDir, "lexicon.txt");
if (!fs.existsSync(lexiconPath)) fs.writeFileSync(lexiconPath, "", "utf8");

console.log("[align:prep] Corpus ready:", corpusDir);
console.log("[align:prep] Using chunksDir:", chunksDir);
