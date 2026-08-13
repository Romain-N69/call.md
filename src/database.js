const Database = require('better-sqlite3');
const { metrics, parseList } = require('./insights');

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
    CREATE INDEX IF NOT EXISTS transcript_meeting_time ON transcript_segments(meeting_id, start_time);
  `);
  migrate(db, 'meetings', 'key_points', 'TEXT');
  migrate(db, 'meetings', 'notes', "TEXT DEFAULT ''");
  migrate(db, 'meetings', 'favorite', 'INTEGER DEFAULT 0');
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
    listMeetings(query = '') {
      const search = `%${query}%`;
      return db.prepare(`SELECT m.*, COUNT(t.id) AS segment_count
        FROM meetings m LEFT JOIN transcript_segments t ON t.meeting_id=m.id
        WHERE (?='' OR m.title LIKE ? OR m.summary LIKE ? OR m.notes LIKE ? OR t.text LIKE ?)
        GROUP BY m.id ORDER BY m.favorite DESC, m.started_at DESC`).all(query, search, search, search, search);
    },
    getMeeting(id) {
      const meeting = db.prepare('SELECT * FROM meetings WHERE id=?').get(id);
      if (!meeting) return null;
      const transcript = this.getTranscript(id);
      return {
        ...meeting,
        favorite: Boolean(meeting.favorite),
        key_points: parseList(meeting.key_points),
        action_items: parseList(meeting.action_items),
        transcript,
        bookmarks: db.prepare('SELECT * FROM bookmarks WHERE meeting_id=? ORDER BY at_time').all(id),
        metrics: metrics(transcript),
      };
    },
    getTranscript(meetingId) {
      return db.prepare(`SELECT channel,start_time,end_time,text,speaker
        FROM transcript_segments WHERE meeting_id=? ORDER BY start_time`).all(meetingId);
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
    addBookmark(meetingId, atTime, note) {
      db.prepare('INSERT INTO bookmarks (meeting_id,at_time,note) VALUES (?,?,?)').run(meetingId, atTime, note || '');
      return this.getMeeting(meetingId).bookmarks;
    },
    deleteBookmark(id) { db.prepare('DELETE FROM bookmarks WHERE id=?').run(id); },
    deleteMeeting(id) {
      const meeting = db.prepare('SELECT folder FROM meetings WHERE id=?').get(id);
      db.prepare('DELETE FROM meetings WHERE id=?').run(id);
      return meeting?.folder;
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
