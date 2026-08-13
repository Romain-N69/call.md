const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWritingOptions, polishInstructions, splitText, writingStats } = require('../src/writing');

test('normalizes untrusted writing options', () => {
  const options = normalizeWritingOptions({ title: ' x '.repeat(100), sourceLanguage: 'xx', targetLanguage: 'fr', format: 'unknown', tone: 'professional', intensity: 'strong', styleExample: 'a'.repeat(5000) });
  assert.equal(options.title.length, 120);
  assert.equal(options.sourceLanguage, 'auto');
  assert.equal(options.targetLanguage, 'fr');
  assert.equal(options.format, 'clean');
  assert.equal(options.styleExample.length, 4000);
});

test('polish prompt preserves facts and isolates style examples', () => {
  const prompt = polishInstructions({ sourceLanguage: 'en', targetLanguage: 'fr', format: 'email', tone: 'professional', intensity: 'balanced', styleExample: 'Short sentences.' });
  assert.match(prompt, /N’invente rien/);
  assert.match(prompt, /Traduis le résultat en français/);
  assert.match(prompt, /<exemple_de_style>/);
  assert.match(prompt, /uniquement le texte final/);
});

test('splits long dictation without losing text', () => {
  const input = `${'a'.repeat(20)}\n\n${'b'.repeat(20)}\n\n${'c'.repeat(20)}`;
  const chunks = splitText(input, 45);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join('\n\n'), input);
});

test('calculates conservative time savings', () => {
  const text = Array(120).fill('word').join(' '), stats = writingStats(text, 0, 60_000);
  assert.equal(stats.words, 120);
  assert.equal(stats.typingMinutes, 3);
  assert.equal(stats.savedMinutes, 2);
});
