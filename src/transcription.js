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
  const promotional = /^(thank(s| you) for watching|please subscribe|like and subscribe|sous-titres réalisés par)|amara\.org/i;
  return segments.filter(segment => {
    const text = String(segment.text || '').trim();
    return text.length > 1 && !noise.test(text) && !promotional.test(text) && Number(segment.no_speech_prob || 0) < 0.75;
  }).map(segment => ({ start: Number(segment.start || segment.offsets?.from || 0) / (segment.offsets ? 1000 : 1), end: Number(segment.end || segment.offsets?.to || 0) / (segment.offsets ? 1000 : 1), text: String(segment.text).trim() }));
}

async function localTranscribe(input, { modelPath, language = 'auto', whisperBinary = '/opt/homebrew/bin/whisper-cli', ffmpegBinary = '/opt/homebrew/bin/ffmpeg' }) {
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

module.exports = { MODELS, cleanSegments, localTranscribe, modelState, selectedModel };
