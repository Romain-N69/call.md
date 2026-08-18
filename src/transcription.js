const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const MODELS = {
  large: { label: 'Turbo V3 large', file: 'ggml-large-v3-turbo.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin', detail: 'High accuracy, best quality' },
  medium: { label: 'Turbo V3 medium', file: 'ggml-medium.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin', detail: 'Balanced speed and accuracy' },
  small: { label: 'Turbo V3 small', file: 'ggml-small.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', detail: 'Fastest processing' },
};

function cleanSegments(segments) {
  const noise = /^(\s*\[?(music|musique|applause|silence|blank_audio|inaudible)\]?\s*[.!…]?\s*)$/i;
  const unsupportedScript = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/u;
  const promotional = /^(thank(s| you) for watching|please subscribe|like and subscribe|sous-titres réalisés par)|amara\.org/i;
  return segments.filter(segment => {
    const text = String(segment.text || '').trim();
    return text.length > 2 && !noise.test(text) && !promotional.test(text) && !(segment.expectedLatin && unsupportedScript.test(text)) && Number(segment.no_speech_prob || 0) < 0.55 && Number(segment.avg_logprob ?? 0) > -1.2;
  }).map(segment => ({ start: Number(segment.start ?? segment.start_time ?? segment.offsets?.from ?? 0) / (segment.offsets ? 1000 : 1), end: Number(segment.end ?? segment.end_time ?? segment.offsets?.to ?? 0) / (segment.offsets ? 1000 : 1), text: String(segment.text).trim() }));
}

async function whisperTranscribe(input, { modelPath, language = 'auto', whisperBinary = '/opt/homebrew/bin/whisper-cli', ffmpegBinary = '/opt/homebrew/bin/ffmpeg' }) {
  const wav = `${input}.wav`, output = `${input}.whisper`;
  try {
    await exec(ffmpegBinary, ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-af', 'highpass=f=100,lowpass=f=7500', wav]);
    await exec(whisperBinary, ['-m', modelPath, '-f', wav, '-l', language, '-oj', '-of', output, '-sns', '-nth', '0.45', '-et', '2.2', '-np'], { maxBuffer: 20 * 1024 * 1024 });
    const result = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'));
    return cleanSegments(result.transcription || []);
  } finally {
    for (const file of [wav, `${output}.json`]) fs.rmSync(file, { force: true });
  }
}

async function parakeetTranscribe(input, { modelsDir, ffmpegBinary = '/opt/homebrew/bin/ffmpeg' }) {
  const { OfflineRecognizer, readWave } = require('sherpa-onnx-node');
  const model = findFile(modelsDir, file => /parakeet.*\.onnx$/i.test(file) || /model.*\.onnx$/i.test(file));
  const tokens = findFile(modelsDir, file => /tokens\.txt$/i.test(file));
  if (!model || !tokens) throw new Error('Parakeet requires an ONNX model and tokens.txt in the selected folder');
  const wav = `${input}.parakeet.wav`;
  try {
    await exec(ffmpegBinary, ['-y', '-i', input, '-ar', '16000', '-ac', '1', wav]);
    const recognizer = await OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { nemoCtc: { model }, tokens, numThreads: 4, provider: 'cpu' } });
    const stream = recognizer.createStream(), wave = readWave(wav); stream.acceptWaveform(wave); await recognizer.decodeAsync(stream); const result = recognizer.getResult(stream);
    return result.text ? [{ start: 0, end: wave.samples.length / wave.sampleRate, text: result.text }] : [];
  } finally { fs.rmSync(wav, { force: true }); }
}

function findFile(root, predicate) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const found = entry.isDirectory() ? findFile(path.join(root, entry.name), predicate) : predicate(entry.name) ? path.join(root, entry.name) : null;
    if (found) return found;
  }
  return null;
}

function parakeetState(modelsDir) {
  const model = findFile(modelsDir, file => /parakeet.*\.onnx$/i.test(file) || /model.*\.onnx$/i.test(file));
  const tokens = findFile(modelsDir, file => /tokens\.txt$/i.test(file));
  return { installed: Boolean(model && tokens), model, tokens };
}

function modelState(modelsDir) {
  const known = Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [id, { ...model, path: path.join(modelsDir, model.file), installed: fs.existsSync(path.join(modelsDir, model.file)) }]));
  if (!fs.existsSync(modelsDir)) return known;
  for (const file of fs.readdirSync(modelsDir).filter(file => file.endsWith('.bin'))) {
    if (Object.values(known).some(model => model.file === file)) continue;
    const id = `custom:${file}`;
    known[id] = { label: file.replace(/^ggml-/, '').replace(/\.bin$/, ''), file, path: path.join(modelsDir, file), detail: 'Existing whisper.cpp model', installed: true, custom: true };
  }
  return known;
}

function selectedModel(modelsDir, id) {
  const model = modelState(modelsDir)[id];
  if (!model?.installed) throw new Error('Selected local model was not found');
  return model.path;
}

module.exports = { MODELS, cleanSegments, parakeetState, parakeetTranscribe, whisperTranscribe, modelState, selectedModel };
