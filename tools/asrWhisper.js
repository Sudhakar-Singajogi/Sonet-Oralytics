// tools/asrWhisper.js
// ESM module. Your package.json should have: { "type": "module" }

import 'onnxruntime-node';
import { pipeline } from '@xenova/transformers';
import fs from 'node:fs';
import wav from 'node-wav';   // <-- use node-wav to decode

let _transcriberPromise = null;

function sanitizeWord(text) {
  if (!text) return '';
  // Keep words and punctuation; trim control chars/spurious tokens
  return text.replace(/\s+/g, ' ').trim();
}

function collapseSpaces(s) {
  return s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}

export async function getTranscriber(modelName = 'Xenova/whisper-small.en', options = {}) {
  if (!_transcriberPromise) {
    _transcriberPromise = pipeline('automatic-speech-recognition', modelName, {
      // model is auto-downloaded & cached under ~/.cache
      quantized: options.quantized ?? false, // if you want quantized variants when available
      // device is chosen automatically; onnxruntime-node uses CPU/GPU as available
    });
  }
  return _transcriberPromise;
}

/**
 * Transcribe a single 16kHz mono WAV chunk and return word-level timings
 * with absolute offsets (baseStart is seconds into the original audio).
 */
export async function transcribeChunk(wavPath, cfg = {}, baseStart = 0) {
  // quick sanity check
  if (!fs.existsSync(wavPath)) {
    throw new Error(`[asr] Missing file: ${wavPath}`);
  }

  const model = cfg?.asr?.model || 'Xenova/whisper-small.en';
  const language = cfg?.asr?.language || 'en';

  const transcriber = await getTranscriber(model, {
    quantized: cfg?.asr?.quantized ?? false,
  });

   // Decode WAV into Float32Array (Node: pass raw audio, not a path)
 const buf = fs.readFileSync(wavPath);
 const { sampleRate, channelData } = wav.decode(buf);
 if (sampleRate !== 16000 || channelData.length !== 1) {
   throw new Error(`[asr] Expected 16k mono WAV, got ${sampleRate} Hz / ${channelData.length} ch`);
 }
 const audio = channelData[0]; // Float32Array

 const result = await transcriber(audio, {
   sampling_rate: 16000,
   task: 'transcribe',
   language,
   return_timestamps: 'word',
 });

  // For small pre-cut chunks, we don't need internal chunking. Still, set these for safety.
  /*const result = await transcriber(wavPath, {
    task: 'transcribe',
    language,
    return_timestamps: 'word', // <-- per-word timestamps
    // You can experiment with these if you pass full-length audio instead of VAD chunks
    // chunk_length_s: 30,
    // stride_length_s: 5,
    // condition_on_previous_text: false,
  });*/

  // result.text (string)
  // result.chunks (array) with { text, timestamp: [start, end] } at word granularity
  const words = [];
  if (Array.isArray(result?.chunks)) {
    for (const c of result.chunks) {
      if (!c?.timestamp || c.timestamp[0] == null || c.timestamp[1] == null) continue;
      const w = sanitizeWord(c.text);
      if (!w) continue;
      const s = Number((baseStart + Number(c.timestamp[0])).toFixed(3));
      const e = Number((baseStart + Number(c.timestamp[1])).toFixed(3));
      // Skip pathological cases
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
        words.push({ w, s, e });
      }
    }
  }

  if (!words.length) {
    return null; // likely silence; caller can skip
  }

  const start = words[0].s;
  const end = words[words.length - 1].e;

  // Prefer model text for punctuation; then normalize spacing a bit
  let text = result?.text ? collapseSpaces(String(result.text)) : collapseSpaces(words.map(x => x.w).join(' '));

  return { start, end, text, words };
  
}
