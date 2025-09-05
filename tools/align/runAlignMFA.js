#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i+1] : d; };

const corpusDir = get("corpus", "data/align/corpus");
const dictPath  = get("dict", "data/align/dict/lexicon.txt");
const outDir    = get("out", "data/align/textgrids");
const model     = get("model", "english_mfa");             // acoustic model name
const mfaBinArg = get("mfaBin", process.env.MFA_BIN || "mfa"); // allow override

if (!fs.existsSync(corpusDir)) throw new Error(`[align:mfa] corpusDir not found: ${corpusDir}`);
if (!fs.existsSync(dictPath))  throw new Error(`[align:mfa] dictPath not found: ${dictPath}`);
if (!fs.existsSync(outDir))    fs.mkdirSync(outDir, { recursive: true });

// Try to resolve MFA binary on Windows if "mfa" doesn’t exist on PATH
async function resolveMfaBin(candidate) {
  try {
    await execa(candidate, ["version"], { stdio: "ignore" });
    return candidate;
  } catch {
    // Try typical Windows user Scripts path
    if (process.platform === "win32") {
      const guesses = [
        path.join(os.homedir(), "AppData/Roaming/Python/Python311/Scripts/mfa.exe"),
        path.join(os.homedir(), "AppData/Roaming/Python/Python310/Scripts/mfa.exe"),
        path.join(os.homedir(), "AppData/Local/Programs/Python/Python311/Scripts/mfa.exe"),
        path.join(os.homedir(), "AppData/Local/Programs/Python/Python310/Scripts/mfa.exe"),
      ];
      for (const g of guesses) {
        if (fs.existsSync(g)) {
          try {
            await execa(g, ["version"], { stdio: "ignore" });
            return g;
          } catch { /* continue */ }
        }
      }
    }
    throw new Error(
      "[align:mfa] MFA binary not found. Install MFA via `py -m pip install montreal-forced-aligner` " +
      "and ensure `mfa` is on PATH, or pass `--mfaBin <full\\path\\to\\mfa.exe>`."
    );
  }
}

const mfaBin = await resolveMfaBin(mfaBinArg);

console.log("[align:mfa] Using MFA:", mfaBin);
console.log("[align:mfa] Running MFA align...");

try {
  await execa(mfaBin, [
    "align",
    corpusDir,
    dictPath,
    model,
    outDir,
    "--clean",
    "--beam", "10",
    "--retry_beam", "40",
    "--verbose"
  ], { stdio: "inherit" });
} catch (err) {
  console.error("\n[align:mfa] MFA failed.\n", {
    command: err.command,
    exitCode: err.exitCode,
    failed: err.failed,
    timedOut: err.timedOut,
    isCanceled: err.isCanceled,
    isGracefulTimeout: err.isGracefulTimeout
  });
  throw err;
}

console.log("[align:mfa] Done. Outputs:", outDir);
