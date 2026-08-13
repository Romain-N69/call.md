const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const ffmpeg = '/opt/homebrew/bin/ffmpeg';

function textTokens(value) {
  return String(value || '').toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').match(/[\p{L}\p{N}]+/gu) || [];
}
function similarText(first, second) {
  const a = textTokens(first), b = textTokens(second);
  if (!a.length || !b.length) return false;
  const left = new Set(a), right = new Set(b);
  let common = 0;
  left.forEach(token => { if (right.has(token)) common += 1; });
  return common / Math.max(left.size, right.size) >= 0.6 || (Math.min(left.size, right.size) <= 2 && common === Math.min(left.size, right.size));
}
function mergeOverlappingSegments(segments) {
  return [...segments].sort((a, b) => a.start_time - b.start_time).filter((segment, index, all) => !all.slice(0, index).some(previous => previous.channel === segment.channel && Math.abs(previous.start_time - segment.start_time) < 1.5 && similarText(previous.text, segment.text)));
}
function suppressCrosstalk(segments, windowSeconds = 2.5) {
  return segments.filter(segment => segment.channel !== 'me' || !segments.some(other => other.channel === 'them' && Math.abs(other.start_time - segment.start_time) <= windowSeconds && similarText(segment.text, other.text)));
}
function meanVolume(stderr) { return Number((stderr.match(/mean_volume: ([-\d.]+) dB/) || [])[1] ?? -160); }
async function isSystemAudioLeak(micFile, systemFile) {
  if (!systemFile || !fs.existsSync(systemFile)) return false;
  const [mic, system] = await Promise.all([
    exec(ffmpeg, ['-hide_banner', '-i', micFile, '-af', 'volumedetect', '-f', 'null', '-']).catch(error => error),
    exec(ffmpeg, ['-hide_banner', '-i', systemFile, '-af', 'volumedetect', '-f', 'null', '-']).catch(error => error),
  ]);
  const micDb = meanVolume(mic.stderr || ''), systemDb = meanVolume(system.stderr || '');
  return systemDb > -42 && micDb < -36 && micDb < systemDb - 6;
}
function nearestSystemChunk(folder, startedAt) {
  return fs.readdirSync(folder).map(file => ({ file, match: file.match(/^system-(\d+)\.wav$/) })).filter(item => item.match).map(item => ({ path: path.join(folder, item.file), distance: Math.abs(Number(item.match[1]) - startedAt) })).sort((a, b) => a.distance - b.distance)[0]?.path;
}
async function finalizeMicrophone(folder) {
  const files = fs.readdirSync(folder).map(file => ({ file, match: file.match(/^mic-(\d+)\.webm$/) })).filter(item => item.match).sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (!files.length) return null;
  const list = path.join(folder, '.mic-concat.txt'), output = path.join(folder, 'mic-full.wav');
  fs.writeFileSync(list, files.map(item => `file '${path.join(folder, item.file).replaceAll("'", "'\\''")}'`).join('\n'));
  try {
    await exec(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-af', 'highpass=f=90,lowpass=f=7600,alimiter=limit=0.95', output]);
    return { path: output, startedAt: Number(files[0].match[1]) };
  } finally { fs.rmSync(list, { force: true }); }
}
async function finalizeVideo(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).size) return false;
  const fixed = `${file}.fixed.webm`;
  try {
    const { stdout } = await exec('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]);
    const [numerator, denominator] = stdout.trim().split('/').map(Number);
    const frameDurationMs = Math.max(1, Math.round(1000 * denominator / numerator)) || 34;
    await exec(ffmpeg, ['-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', `setts=pts=N*${frameDurationMs}:dts=N*${frameDurationMs}`, fixed]);
    fs.renameSync(fixed, file);
    return true;
  } catch (error) { fs.rmSync(fixed, { force: true }); throw error; }
}

module.exports = { finalizeMicrophone, finalizeVideo, isSystemAudioLeak, mergeOverlappingSegments, nearestSystemChunk, similarText, suppressCrosstalk };
