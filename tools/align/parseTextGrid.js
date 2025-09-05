#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i+1] : d; };

const inDir  = get("in", "data/align/textgrids");
const outDir = get("out", "data/align/json");
const jsonl  = get("jsonl", "data/align/alignments.jsonl");
const sr     = Number(get("sr", "16000"));

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function extractTierBlock(text, name) {
  // Try to isolate the tier named "words"/"phones"
  const re = new RegExp(`item \\[\\d+\\][\\s\\S]*?name *= *"${name}"[\\s\\S]*?(?:item \\[\\d+\\]|\\Z)`, "g");
  const match = re.exec(text);
  return match ? match[0] : "";
}

function extractIntervals(block) {
  const out = [];
  const rx = /intervals \[\d+\]:[\s\S]*?xmin = ([0-9.]+)[\s\S]*?xmax = ([0-9.]+)[\s\\S]*?text = "(.*?)"/g;
  let m;
  while ((m = rx.exec(block)) !== null) {
    const s = parseFloat(m[1]), e = parseFloat(m[2]);
    const t = (m[3] || "").trim();
    out.push({ s, e, t });
  }
  return out;
}

function parseTextGrid(txt) {
  const wordsBlock  = extractTierBlock(txt, "words");
  const phonesBlock = extractTierBlock(txt, "phones");
  const words  = extractIntervals(wordsBlock).filter(x => x.t.length);
  const phones = extractIntervals(phonesBlock).filter(x => x.t.length);

  // Nest phones inside their owning word (by midpoint)
  const nested = words.map(w => ({ w: w.t, s: w.s, e: w.e, ll: null, phones: [] }));
  for (const p of phones) {
    const mid = (p.s + p.e) / 2;
    const host = nested.find(w => mid >= w.s && mid <= w.e);
    if (host) host.phones.push({ ph: p.t, s: p.s, e: p.e, ll: null });
  }
  return nested;
}

const files = fs.readdirSync(inDir).filter(f => f.toLowerCase().endsWith(".textgrid"));
const outStream = fs.createWriteStream(jsonl, { flags: "w" });

for (const f of files) {
  const chunkId = path.basename(f, path.extname(f));
  const tgPath = path.join(inDir, f);
  const txt = fs.readFileSync(tgPath, "utf8");
  const words = parseTextGrid(txt);

  const obj = {
    chunkId,
    sampleRate: sr,
    words,
    stats: { wordsAligned: words.length, phonesAligned: words.reduce((a,w)=>a+(w.phones?.length||0),0) }
  };

  const outPath = path.join(outDir, `${chunkId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2), "utf8");
  outStream.write(JSON.stringify(obj) + "\n");
  console.log(`[align:parse] ${chunkId} -> ${outPath}`);
}
outStream.end();
