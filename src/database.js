const Database = require('better-sqlite3');
const { metrics, normalizeDurations, parseList } = require('./insights');

function openDatabase(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, status TEXT NOT NULL, folder TEXT NOT NULL,
      summary TEXT, action_items TEXT, key_points TEXT, notes TEXT DEFAULT '', favorite INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('me', 'them')),
      start_time REAL NOT NULL, end_time REAL NOT NULL, text TEXT NOT NULL, speaker TEXT,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL,
      at_time REAL NOT NULL, note TEXT DEFAULT '',
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS writings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source_language TEXT NOT NULL DEFAULT 'auto', target_language TEXT NOT NULL DEFAULT 'auto',
      format TEXT NOT NULL DEFAULT 'clean', tone TEXT NOT NULL DEFAULT 'natural', intensity TEXT NOT NULL DEFAULT 'balanced',
      verbatim TEXT NOT NULL DEFAULT '', polished TEXT NOT NULL DEFAULT '', audio_path TEXT, status TEXT NOT NULL DEFAULT 'draft'
    );
    CREATE INDEX IF NOT EXISTS transcript_meeting_time ON transcript_segments(meeting_id, start_time);
    CREATE INDEX IF NOT EXISTS writings_updated ON writings(updated_at DESC);
  `);
  migrate(db, 'meetings', 'key_points', 'TEXT');
  migrate(db, 'meetings', 'notes', "TEXT DEFAULT ''");
  migrate(db, 'meetings', 'favorite', 'INTEGER DEFAULT 0');
  migrate(db, 'meetings', 'archived', 'INTEGER DEFAULT 0');
  migrate(db, 'transcript_segments', 'speaker', 'TEXT');

  return {
    startMeeting(meeting) {
      db.prepare(`INSERT INTO meetings (id,title,started_at,status,folder)
        VALUES (@id,@title,@startedAt,'recording',@folder)`).run(meeting);
    },
    finishMeeting(id, endedAt) {
      db.prepare("UPDATE meetings SET ended_at=?, status='available' WHERE id=?").run(endedAt, id);
    },
    saveSummary(id, summary) {
      db.prepare('UPDATE meetings SET summary=?, key_points=?, action_items=? WHERE id=?')
        .run(summary?.summary || null, JSON.stringify(summary?.key_points || []), JSON.stringify(summary?.action_items || []), id);
    },
    addSegments(meetingId, channel, offset, segments) {
      const insert = db.prepare(`INSERT INTO transcript_segments
        (meeting_id,channel,start_time,end_time,text,speaker) VALUES (?,?,?,?,?,?)`);
      db.transaction(() => segments.forEach(segment => insert.run(
        meetingId, channel, offset + Number(segment.start || 0),
        offset + Number(segment.end || segment.start || 0), segment.text || '', segment.speaker || null,
      )))();
    },
    listMeetings(query = '', archived = false) {
      const search = `%${query}%`;
      return db.prepare(`SELECT m.*, COUNT(t.id) AS segment_count
        FROM meetings m LEFT JOIN transcript_segments t ON t.meeting_id=m.id
        WHERE m.archived=? AND (?='' OR m.title LIKE ? OR m.summary LIKE ? OR m.notes LIKE ? OR t.text LIKE ?)
        GROUP BY m.id ORDER BY m.favorite DESC, m.started_at DESC`).all(archived ? 1 : 0, query, search, search, search, search);
    },
    getMeeting(id) {
      const meeting = db.prepare('SELECT * FROM meetings WHERE id=?').get(id);
      if (!meeting) return null;
      const transcript = this.getTranscript(id);
      return {
        ...meeting,
        favorite: Boolean(meeting.favorite),
        archived: Boolean(meeting.archived),
        key_points: parseList(meeting.key_points),
        action_items: parseList(meeting.action_items),
        transcript,
        bookmarks: db.prepare('SELECT * FROM bookmarks WHERE meeting_id=? ORDER BY at_time').all(id),
        metrics: metrics(transcript),
      };
    },
    getTranscript(meetingId) {
      return normalizeDurations(db.prepare(`SELECT channel,start_time,end_time,text,speaker
        FROM transcript_segments WHERE meeting_id=? ORDER BY start_time`).all(meetingId));
    },
    replaceTranscript(meetingId, segments) {
      db.transaction(() => {
        db.prepare('DELETE FROM transcript_segments WHERE meeting_id=?').run(meetingId);
        const insert = db.prepare(`INSERT INTO transcript_segments
          (meeting_id,channel,start_time,end_time,text,speaker) VALUES (?,?,?,?,?,?)`);
        segments.forEach(segment => insert.run(meetingId, segment.channel, segment.start_time, segment.end_time, segment.text, segment.speaker || null));
      })();
    },
    updateMeeting(id, changes) {
      db.prepare('UPDATE meetings SET title=?, notes=?, favorite=? WHERE id=?')
        .run(changes.title, changes.notes || '', changes.favorite ? 1 : 0, id);
      return this.getMeeting(id);
    },
    saveNotes(id, notes) {
      db.prepare('UPDATE meetings SET notes=? WHERE id=?').run(notes, id);
      return this.getMeeting(id);
    },
    archiveMeeting(id, archived) {
      db.prepare('UPDATE meetings SET archived=? WHERE id=?').run(archived ? 1 : 0, id);
      return this.getMeeting(id);
    },
    addBookmark(meetingId, atTime, note) {
      db.prepare('INSERT INTO bookmarks (meeting_id,at_time,note) VALUES (?,?,?)').run(meetingId, atTime, note || '');
      return this.getMeeting(meetingId).bookmarks;
    },
    deleteBookmark(id) {
      const bookmark = db.prepare('SELECT meeting_id FROM bookmarks WHERE id=?').get(id);
      db.prepare('DELETE FROM bookmarks WHERE id=?').run(id);
      return bookmark?.meeting_id;
    },
    renameSpeaker(meetingId, speaker, name) {
      db.prepare('UPDATE transcript_segments SET speaker=? WHERE meeting_id=? AND speaker=?').run(name, meetingId, speaker);
      return this.getMeeting(meetingId);
    },
    deleteMeeting(id) {
      const meeting = db.prepare('SELECT folder FROM meetings WHERE id=?').get(id);
      db.prepare('DELETE FROM meetings WHERE id=?').run(id);
      return meeting?.folder;
    },
    createWriting(writing) {
      db.prepare(`INSERT INTO writings (id,title,created_at,updated_at,source_language,target_language,format,tone,intensity,audio_path,status)
        VALUES (@id,@title,@createdAt,@createdAt,@sourceLanguage,@targetLanguage,@format,@tone,@intensity,@audioPath,'recording')`).run(writing);
      return db.prepare('SELECT * FROM writings WHERE id=?').get(writing.id);
    },
    updateWriting(id, changes) {
      const writing = db.prepare('SELECT * FROM writings WHERE id=?').get(id);
      if (!writing) return null;
      const next = {
        title: String(changes.title ?? writing.title).trim().slice(0, 120) || writing.title,
        sourceLanguage: changes.sourceLanguage ?? writing.source_language,
        targetLanguage: changes.targetLanguage ?? writing.target_language,
        format: changes.format ?? writing.format, tone: changes.tone ?? writing.tone,
        intensity: changes.intensity ?? writing.intensity, verbatim: changes.verbatim ?? writing.verbatim,
        polished: changes.polished ?? writing.polished, status: changes.status ?? writing.status,
      };
      db.prepare(`UPDATE writings SET title=@title,source_language=@sourceLanguage,target_language=@targetLanguage,format=@format,
        tone=@tone,intensity=@intensity,verbatim=@verbatim,polished=@polished,status=@status,updated_at=@updatedAt WHERE id=@id`)
        .run({ ...next, id, updatedAt: Date.now() });
      return db.prepare('SELECT * FROM writings WHERE id=?').get(id);
    },
    getWriting(id) { return db.prepare('SELECT * FROM writings WHERE id=?').get(id); },
    listWritings() { return db.prepare('SELECT * FROM writings ORDER BY updated_at DESC LIMIT 100').all(); },
    deleteWriting(id) {
      const writing = db.prepare('SELECT audio_path FROM writings WHERE id=?').get(id);
      db.prepare('DELETE FROM writings WHERE id=?').run(id);
      return writing?.audio_path;
    },
    close() { db.close(); },
  };
}

function migrate(db, table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

module.exports = { openDatabase };
