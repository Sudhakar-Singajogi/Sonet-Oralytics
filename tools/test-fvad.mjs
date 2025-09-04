import path from "node:path";

async function load() {
  try {
    // Most packages export from the root
    const mod = await import("@echogarden/fvad-wasm");
    return { mod, from: "@echogarden/fvad-wasm" };
  } catch {
    // Fallback: direct file
    const mod = await import("@echogarden/fvad-wasm/fvad.js");
    return { mod, from: "@echogarden/fvad-wasm/fvad.js" };
  }
}

const { mod, from } = await load();
console.log("[fvad] loaded from:", from);
console.log("[fvad] export keys:", Object.keys(mod));

if (typeof mod.default === "function") {
  const api = await mod.default();        // common pattern for WASM init
  console.log("[fvad] api keys:", Object.keys(api));
} else {
  console.log("[fvad] no default() factory — chunker will try named exports");
}
