// tools/prefetch.js (ESM)
import 'onnxruntime-node';
import { pipeline } from '@xenova/transformers';

const MODEL = process.env.WHISPER_MODEL || 'Xenova/whisper-small.en';
const LANG  = process.env.WHISPER_LANG  || 'en';
const QUANT = process.env.WHISPER_QUANT === '1'; // set to "1" to use quantized variants if available

console.log(`[prefetch] Loading model: ${MODEL} (quantized=${QUANT})`);

// 1) Load & cache the model
const asr = await pipeline('automatic-speech-recognition', MODEL, { quantized: QUANT });

// 2) Warm-up: 0.5s silence @ 16k to compile graph once
const warm = new Float32Array(8000);
await asr(warm, { sampling_rate: 16000, task: 'transcribe', language: LANG, return_timestamps: 'word' });

const cacheHint = process.env.TRANSFORMERS_CACHE || process.env.HF_HOME || '~/.cache';
console.log(`[prefetch] Done. Cached under: ${cacheHint}`);
