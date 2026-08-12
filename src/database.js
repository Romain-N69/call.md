const Database = require('better-sqlite3');

function openDatabase(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      folder TEXT NOT NULL,
      summary TEXT,
      action_items TEXT
    );
    CREATE TABLE IF NOT EXISTS transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('me', 'them')),
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS transcript_meeting_time
      ON transcript_segments(meeting_id, start_time);
  `);

  return {
    startMeeting(meeting) {
      db.prepare(`INSERT INTO meetings (id,title,started_at,status,folder)
        VALUES (@id,@title,@startedAt,'recording',@folder)`).run(meeting);
    },
    finishMeeting(id, endedAt) {
      db.prepare("UPDATE meetings SET ended_at=?, status='available' WHERE id=?")
        .run(endedAt, id);
    },
    saveSummary(id, summary) {
      db.prepare("UPDATE meetings SET summary=?, action_items=? WHERE id=?")
        .run(summary?.summary || null, JSON.stringify(summary?.action_items || []), id);
    },
    failMeeting(id) {
      db.prepare("UPDATE meetings SET status='failed' WHERE id=?").run(id);
    },
    addSegments(meetingId, channel, offset, segments) {
      const insert = db.prepare(`INSERT INTO transcript_segments
        (meeting_id,channel,start_time,end_time,text) VALUES (?,?,?,?,?)`);
      db.transaction(() => {
        for (const segment of segments) {
          insert.run(meetingId, channel, offset + Number(segment.start || 0),
            offset + Number(segment.end || segment.start || 0), segment.text || '');
        }
      })();
    },
    listMeetings() {
      return db.prepare(`SELECT m.*, COUNT(t.id) AS segment_count
        FROM meetings m LEFT JOIN transcript_segments t ON t.meeting_id=m.id
        GROUP BY m.id ORDER BY m.started_at DESC`).all();
    },
    getTranscript(meetingId) {
      return db.prepare(`SELECT channel,start_time,end_time,text
        FROM transcript_segments WHERE meeting_id=? ORDER BY start_time`).all(meetingId);
    },
    close() { db.close(); },
  };
}

module.exports = { openDatabase };
