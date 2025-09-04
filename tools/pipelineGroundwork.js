#!/usr/bin/env node
import { execa } from "execa";

const args = process.argv.slice(2);
const get = (k, def) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : def;
};
const raw = get("raw", "data/raw");
const processed = get("processed", "data/processed");
const chunks = get("chunks", "data/chunks");
const config = get("config", "configs/default.yaml");

function run(cmd, argv) {
  console.log("+", cmd, argv.join(" "));
  return execa(cmd, argv, { stdio: "inherit" });
}

(async () => {
  await run("node", ["tools/prepareAudio.js","--in", raw, "--out", processed, "--config", config]);
  await run("node", ["tools/chunkAudio.js","--in", `${processed}/16k`, "--out", chunks, "--config", config]);
  console.log("[pipeline] ✅ audio in → chunks out");
})();
