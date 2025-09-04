// tools/wer.js
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function getArg(k, d) {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
}
const hypPath = getArg('hyp', '');
const refPath = getArg('ref', '');
const allFlag = args.includes('--all');

function tokenize(s) {
  if (!s) return [];
  // Lowercase, remove most punctuation, keep apostrophes/numbers, split on whitespace
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.split(/\s+/) : [];
}

function loadHypTextFromJson(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!raw?.chunks?.length) return '';
  // Concatenate chunk texts; fallback to joining words if text missing
  const texts = raw.chunks.map((c) => (c?.text && c.text.trim()) || (c?.words || []).map(w => w.w).join(' '));
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

// Levenshtein with backtrace to get S/D/I
function werCounts(refTokens, hypTokens) {
  const R = refTokens.length;
  const H = hypTokens.length;

  const dp = Array.from({ length: R + 1 }, () => new Array(H + 1).fill(0));
  const bt = Array.from({ length: R + 1 }, () => new Array(H + 1).fill(null));

  for (let i = 0; i <= R; i++) {
    dp[i][0] = i;
    bt[i][0] = 'D'; // deletions
  }
  for (let j = 0; j <= H; j++) {
    dp[0][j] = j;
    bt[0][j] = 'I'; // insertions
  }
  bt[0][0] = '✓';

  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const subCost = refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1;
      const candSub = dp[i - 1][j - 1] + subCost;
      const candDel = dp[i - 1][j] + 1;
      const candIns = dp[i][j - 1] + 1;

      const min = Math.min(candSub, candDel, candIns);
      dp[i][j] = min;
      bt[i][j] = min === candSub ? (subCost ? 'S' : 'M') : (min === candDel ? 'D' : 'I');
    }
  }

  // Backtrace
  let i = R, j = H;
  let S = 0, D = 0, I = 0, M = 0;
  while (i > 0 || j > 0) {
    const op = bt[i][j];
    if (op === 'M' || op === 'S') {
      if (op === 'S') S++; else M++;
      i--; j--;
    } else if (op === 'D') {
      D++; i--;
    } else if (op === 'I') {
      I++; j--;
    } else {
      break;
    }
  }
  return { S, D, I, N: R };
}

function printOne(hypFile, refFile) {
  if (!fs.existsSync(hypFile)) {
    console.error(`[wer] Missing hyp: ${hypFile}`);
    return null;
  }
  if (!fs.existsSync(refFile)) {
    console.error(`[wer] Missing ref: ${refFile}`);
    return null;
  }
  const hypText = loadHypTextFromJson(hypFile);
  const refText = fs.readFileSync(refFile, 'utf8');

  const H = tokenize(hypText);
  const R = tokenize(refText);
  const { S, D, I, N } = werCounts(R, H);
  const WER = N ? (S + D + I) / N : 0;

  const base = path.parse(hypFile).name.replace(/\.transcript$/, '');
  console.log(
    `[wer] ${base}  WER=${(WER * 100).toFixed(2)}%   (S=${S}, D=${D}, I=${I}, N=${N})`
  );
  return { base, WER, S, D, I, N };
}

async function main() {
  if (allFlag) {
    const dir = 'data/chunks';
    const refDir = 'data/refs';
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.transcript.json'));
    if (!files.length) {
      console.error('[wer] No transcript files found in data/chunks');
      process.exit(1);
    }
    let sumWER = 0, sumN = 0, nFiles = 0;
    for (const f of files) {
      const base = f.replace(/\.transcript\.json$/, '');
      const hypFile = path.join(dir, f);
      const refFile = path.join(refDir, `${base}.txt`);
      const r = printOne(hypFile, refFile);
      if (r) {
        sumWER += r.WER * r.N;
        sumN += r.N;
        nFiles++;
      }
    }
    if (nFiles) {
      const macro = (sumWER / (sumN || 1)) * 100;
      console.log(`[wer] Average (weighted by N): ${macro.toFixed(2)}% over ${nFiles} file(s)`);
    }
  } else {
    if (!hypPath || !refPath) {
      console.log('Usage: node tools/wer.js --hyp data/chunks/<base>.transcript.json --ref data/refs/<base>.txt');
      console.log('       node tools/wer.js --all');
      process.exit(0);
    }
    printOne(hypPath, refPath);
  }
}

main();
