function normalizeDurations(transcript) {
  return transcript.map((segment, index) => {
    const start = Number(segment.start_time) || 0, end = Number(segment.end_time) || 0;
    if (end > start) return segment;
    const next = transcript.slice(index + 1).find(item => Number(item.start_time) > start);
    const words = (segment.text.match(/\S+/g) || []).length;
    // ponytail: infer missing ASR duration from the next timestamp; remove when every provider returns segment ends.
    const duration = next ? Math.min(15, Number(next.start_time) - start) : Math.min(10, Math.max(1, words / 2.5));
    return { ...segment, start_time: start, end_time: start + duration };
  });
}

function metrics(transcript) {
  const channels = { me: { seconds: 0, words: 0 }, them: { seconds: 0, words: 0 } };
  let questions = 0;
  let longestMonologue = 0;
  for (const segment of normalizeDurations(transcript)) {
    const channel = channels[segment.channel];
    if (!channel) continue;
    const duration = Math.max(0, Number(segment.end_time) - Number(segment.start_time));
    channel.seconds += duration;
    channel.words += (segment.text.match(/\S+/g) || []).length;
    questions += (segment.text.match(/\?/g) || []).length;
    longestMonologue = Math.max(longestMonologue, duration);
  }
  const total = channels.me.seconds + channels.them.seconds;
  return {
    talkRatio: total ? Math.round(channels.me.seconds / total * 100) : 0,
    wordsPerMinute: channels.me.seconds ? Math.round(channels.me.words / channels.me.seconds * 60) : 0,
    questions,
    longestMonologue: Math.round(longestMonologue),
  };
}

function markdown(meeting, transcript, bookmarks = []) {
  const actions = parseList(meeting.action_items);
  const points = parseList(meeting.key_points);
  const lines = [
    `# ${meeting.title}`,
    '',
    `_${new Date(meeting.started_at).toLocaleString()}_`,
    '',
    '## Personal notes', '', meeting.notes || 'No personal notes.', '',
    '## Summary', '', meeting.summary || 'No summary available.', '',
    '## Key points', '', ...points.map(item => `- ${item}`), '',
    '## Action items', '', ...actions.map(item => `- [ ] ${item}`), '',
    '## Bookmarks', '', ...bookmarks.map(item => `- ${formatTime(item.at_time)} — ${item.note || 'Important moment'}`), '',
    '## Transcript', '',
    ...transcript.map(item => `**${item.channel === 'me' ? 'You' : item.speaker || 'Them'} · ${formatTime(item.start_time)}**  \n${item.text}\n`),
  ];
  return lines.join('\n');
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

module.exports = { metrics, normalizeDurations, markdown, parseList, formatTime };
