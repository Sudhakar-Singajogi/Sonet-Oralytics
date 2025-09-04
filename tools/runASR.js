// tools/runASR.js
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { transcribeChunk } from "./asrWhisper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- CLI args ----
const args = process.argv.slice(2);
function getArg(k, d) {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
}
const manifestPath = getArg("manifest", "data/chunks/chunks_manifest.jsonl");
const outDir = getArg("out", "data/chunks");
const cfgPath = getArg("config", "configs/default.yaml");

// ---- Load config ----
const cfg = yaml.parse(fs.readFileSync(cfgPath, "utf8"));
const MAX_GAP = Number(cfg?.asr?.max_chunk_merge_gap_sec ?? 0.5);
const MAX_DUR = Number(cfg?.asr?.max_chunk_merge_duration_sec ?? 30.0);

// ---- Helpers ----
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function collapseSpaces(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function mergeUnitsToChunks(units, gap = 0.5, maxDur = 30.0) {
  // units: [{ start, end, text, words }]
  const chunks = [];
  let cur = null;

  const flush = () => {
    if (cur) {
      // set end from last word end for precision
      if (cur.words?.length) cur.end = cur.words[cur.words.length - 1].e;
      cur.text = collapseSpaces(cur.text || "");
      chunks.push(cur);
      cur = null;
    }
  };

  for (const u of units) {
    if (!u || !u.words?.length) continue;

    if (!cur) {
      cur = {
        start: u.start,
        end: u.end,
        text: u.text || "",
        words: [...u.words],
      };
      continue;
    }

    const curEnd = cur.words.length
      ? cur.words[cur.words.length - 1].e
      : cur.end;
    const gapSec = u.start - curEnd;
    const prospectiveDur = u.end - cur.start;

    if (gapSec <= gap && prospectiveDur <= maxDur) {
      // merge
      if (cur.text && u.text) cur.text += " " + u.text;
      else if (u.text) cur.text = u.text;
      cur.words.push(...u.words);
      cur.end = u.end;
    } else {
      flush();
      cur = {
        start: u.start,
        end: u.end,
        text: u.text || "",
        words: [...u.words],
      };
    }
  }
  flush();
  return chunks;
}

function baseNameNoExt(p) {
  const { name } = path.parse(p);
  return name;
}

// Read JSONL manifest lazily
async function* iterManifestRows(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      yield obj; // { src, chunk, start, end, duration }
    } catch (e) {
      console.error(`[asr] Skipping bad JSONL line: ${s.slice(0, 120)}...`);
    }
  }
}

async function main() {
  if (!fs.existsSync(manifestPath)) {
    console.error(`[asr] Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  ensureDir(outDir);
  const perChunkDir = path.join(outDir, "json");
  ensureDir(perChunkDir);

  // Group manifest rows by original src base (so multiple inputs are supported)
  /** @type {Record<string, Array<any>>} */
  const groups = {};

  for await (const row of iterManifestRows(manifestPath)) {
    // Expect fields: src, chunk, start, end, duration
    const srcBase = baseNameNoExt(row.src || row.source || "");
    if (!srcBase) continue;
    (groups[srcBase] ||= []).push(row);
  }

  const summary = {
    files: 0,
    chunks: 0,
    failed: 0,
    model: cfg?.asr?.model || "Xenova/whisper-small.en",
  };

  for (const [srcBase, rows] of Object.entries(groups)) {
    // sort by start time
    rows.sort((a, b) => a.start - b.start);

    const units = [];
    let processed = 0;

    // directory for raw per-chunk JSON (for this src)
    const outGroupDir = path.join(perChunkDir, srcBase);
    ensureDir(outGroupDir);

    for (const r of rows) {
      try {
        // const u = await transcribeChunk(r.chunk, cfg, Number(r.start || 0));
        const chunkPath = path.isAbsolute(r.chunk)
          ? r.chunk
          : path.join(outDir, r.chunk);
        const u = await transcribeChunk(chunkPath, cfg, Number(r.start || 0));

        // if (u?.meta) {
        //   console.log(
        //     `[asr] ${u.meta.file} | audio=${u.meta.audio_sec.toFixed(
        //       2
        //     )}s | proc=${u.meta.proc_sec.toFixed(2)}s | rtf=${u.meta.rtf}`
        //   );
        // }

        processed++;
        if (u) {
          units.push(u);
          // Write raw per-chunk hypothesis (absolute times)
          const chunkName = baseNameNoExt(r.chunk);
          fs.writeFileSync(
            path.join(outGroupDir, `${chunkName}.json`),
            JSON.stringify(u, null, 2),
            "utf8"
          );
        }
      } catch (err) {
        summary.failed++;
        console.error(`[asr] Error on ${r.chunk}: ${err?.message || err}`);
      }
    }

    // Merge into stable chunks
    const merged = mergeUnitsToChunks(units, MAX_GAP, MAX_DUR);

    // Persist final consolidated transcript for this src
    const finalObj = { chunks: merged };
    const finalPath = path.join(outDir, `${srcBase}.transcript.json`);
    fs.writeFileSync(finalPath, JSON.stringify(finalObj, null, 2), "utf8");

    console.log(
      `[asr] ${srcBase}: ${processed} chunk(s) → ${
        merged.length
      } merged chunk(s) → ${path.relative(process.cwd(), finalPath)}`
    );

    summary.files++;
    summary.chunks += merged.length;
  }

  // Summary
  const sumPath = path.join(outDir, "asr_summary.json");
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(
    `[asr] Summary → ${path.relative(process.cwd(), sumPath)}\n`,
    summary
  );
}

main().catch((e) => {
  console.error("[asr] Fatal:", e);
  process.exit(1);
});
