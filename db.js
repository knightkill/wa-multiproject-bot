import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA journal_size_limit = 67108864;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_group_access (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      group_jid TEXT NOT NULL,
      PRIMARY KEY (project_id, group_jid)
    );

    CREATE TABLE IF NOT EXISTS allowed_groups (
      jid TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY,
      project_name TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      media_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS message_log_created_idx ON message_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS dm_allowed (
      jid TEXT PRIMARY KEY,
      label TEXT,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS readable_chats (
      jid TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('group','person')),
      label TEXT,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dm_queue (
      id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL,
      to_jid TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')) DEFAULT 'pending',
      error TEXT,
      idempotency_key TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS dm_queue_status_id_idx ON dm_queue(status, id);

    CREATE TABLE IF NOT EXISTS dm_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT,
      paused_at INTEGER
    );
    INSERT OR IGNORE INTO dm_state (id, paused) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS inbound_messages (
      id INTEGER PRIMARY KEY,
      wa_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender_jid TEXT,
      from_me INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      text TEXT,
      media_type TEXT,
      quoted_wa_id TEXT,
      UNIQUE(wa_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS inbound_messages_chat_idx
      ON inbound_messages(chat_jid, id DESC);
  `);

  // Idempotent column add for installs that predate media_count.
  const cols = db.prepare("PRAGMA table_info(message_log)").all();
  if (!cols.some((c) => c.name === 'media_count')) {
    db.exec('ALTER TABLE message_log ADD COLUMN media_count INTEGER NOT NULL DEFAULT 0');
  }

  // Idempotent column adds for media download (2026-10-04).
  const inboundCols = db.prepare('PRAGMA table_info(inbound_messages)').all();
  for (const [name, type] of [['media_mime', 'TEXT'], ['media_raw', 'TEXT'], ['media_path', 'TEXT']]) {
    if (!inboundCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE inbound_messages ADD COLUMN ${name} ${type}`);
    }
  }

  return makeQueries(db);
}

const MESSAGE_LOG_CAP = 5000;
const INBOUND_CAP = Number(process.env.INBOUND_CAP ?? 10_000);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function makeQueries(db) {
  const stmt = {
    insertProject: db.prepare(
      'INSERT INTO projects (name, token_hash, created_at) VALUES (?, ?, ?)'
    ),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    listProjects: db.prepare(
      'SELECT id, name, created_at FROM projects ORDER BY created_at ASC'
    ),
    getProjectById: db.prepare('SELECT id, name FROM projects WHERE id = ?'),
    getProjectByTokenHash: db.prepare(
      'SELECT id, name FROM projects WHERE token_hash = ?'
    ),
    rotateProjectToken: db.prepare(
      'UPDATE projects SET token_hash = ? WHERE id = ?'
    ),

    listProjectGroups: db.prepare(
      'SELECT group_jid FROM project_group_access WHERE project_id = ?'
    ),
    insertProjectGroup: db.prepare(
      'INSERT OR IGNORE INTO project_group_access (project_id, group_jid) VALUES (?, ?)'
    ),
    clearProjectGroups: db.prepare(
      'DELETE FROM project_group_access WHERE project_id = ?'
    ),
    deleteProjectGroup: db.prepare(
      'DELETE FROM project_group_access WHERE project_id = ? AND group_jid = ?'
    ),

    listAllowedGroups: db.prepare('SELECT jid FROM allowed_groups'),
    insertAllowedGroup: db.prepare(
      'INSERT OR IGNORE INTO allowed_groups (jid, added_at) VALUES (?, ?)'
    ),
    clearAllowedGroups: db.prepare('DELETE FROM allowed_groups'),

    insertMessage: db.prepare(
      'INSERT INTO message_log (project_name, group_jid, title, status, error, created_at, media_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    pruneMessages: db.prepare(
      `DELETE FROM message_log WHERE id <= (
         SELECT id FROM message_log ORDER BY id DESC LIMIT 1 OFFSET ?
       )`
    ),
    listMessages: db.prepare(
      `SELECT id, project_name, group_jid, title, status, error, created_at, media_count
       FROM message_log
       WHERE (? IS NULL OR project_name = ?)
         AND (? IS NULL OR group_jid = ?)
       ORDER BY id DESC
       LIMIT ?`
    ),

    listDmAllowed: db.prepare(
      'SELECT jid, label FROM dm_allowed ORDER BY added_at ASC'
    ),
    insertDmAllowed: db.prepare(
      'INSERT OR IGNORE INTO dm_allowed (jid, label, added_at) VALUES (?, ?, ?)'
    ),
    clearDmAllowed: db.prepare('DELETE FROM dm_allowed'),
    isDmAllowed: db.prepare('SELECT 1 FROM dm_allowed WHERE jid = ?'),

    enqueueDm: db.prepare(
      `INSERT OR IGNORE INTO dm_queue (batch_id, to_jid, body, status, idempotency_key, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    ),
    nextPendingDm: db.prepare(
      `SELECT id, batch_id, to_jid, body FROM dm_queue
       WHERE status = 'pending' ORDER BY id ASC LIMIT 1`
    ),
    markDmSent: db.prepare(
      "UPDATE dm_queue SET status = 'sent', sent_at = ? WHERE id = ?"
    ),
    markDmFailed: db.prepare(
      "UPDATE dm_queue SET status = 'failed', error = ? WHERE id = ?"
    ),
    markDmSkipped: db.prepare(
      "UPDATE dm_queue SET status = 'skipped', error = ? WHERE id = ?"
    ),
    countDmSentSince: db.prepare(
      "SELECT COUNT(*) AS n FROM dm_queue WHERE status = 'sent' AND sent_at >= ?"
    ),
    pendingDmCount: db.prepare(
      "SELECT COUNT(*) AS n FROM dm_queue WHERE status = 'pending'"
    ),
    listDmQueue: db.prepare(
      `SELECT id, batch_id, to_jid, body, status, error, created_at, sent_at
       FROM dm_queue
       WHERE (? IS NULL OR batch_id = ?)
         AND (? IS NULL OR status = ?)
       ORDER BY id ASC
       LIMIT ?`
    ),
    cancelDmBatch: db.prepare(
      "UPDATE dm_queue SET status = 'skipped', error = ? WHERE batch_id = ? AND status = 'pending'"
    ),

    getDmState: db.prepare(
      'SELECT paused, pause_reason, paused_at FROM dm_state WHERE id = 1'
    ),
    setDmPaused: db.prepare(
      'UPDATE dm_state SET paused = 1, pause_reason = ?, paused_at = ? WHERE id = 1'
    ),
    clearDmPause: db.prepare(
      'UPDATE dm_state SET paused = 0, pause_reason = NULL, paused_at = NULL WHERE id = 1'
    ),

    listReadableChats: db.prepare(
      'SELECT jid, kind, label, added_at FROM readable_chats ORDER BY kind, jid'
    ),
    getReadableChat: db.prepare('SELECT kind FROM readable_chats WHERE jid = ?'),
    insertReadableChat: db.prepare(
      'INSERT OR REPLACE INTO readable_chats (jid, kind, label, added_at) VALUES (?, ?, ?, ?)'
    ),
    clearReadableChats: db.prepare('DELETE FROM readable_chats'),

    insertInbound: db.prepare(
      `INSERT OR IGNORE INTO inbound_messages
       (wa_id, chat_jid, sender_jid, from_me, timestamp, text, media_type, quoted_wa_id, media_mime, media_raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getInboundMedia: db.prepare(
      'SELECT id, media_type, media_mime, media_raw, media_path FROM inbound_messages WHERE id = ?'
    ),
    setInboundMediaPath: db.prepare('UPDATE inbound_messages SET media_path = ? WHERE id = ?'),
    pruneInbound: db.prepare(
      `DELETE FROM inbound_messages WHERE id <= (
         SELECT id FROM inbound_messages ORDER BY id DESC LIMIT 1 OFFSET ?
       )`
    ),
    listInbound: db.prepare(
      `SELECT id, wa_id, chat_jid, sender_jid, from_me, timestamp, text, media_type, quoted_wa_id,
              media_mime, (media_path IS NOT NULL) AS media_saved
       FROM inbound_messages
       WHERE (? IS NULL OR chat_jid = ?)
         AND (? IS NULL OR id > ?)
         AND (? IS NULL OR from_me = ?)
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`
    ),
  };

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function replaceProjectGroups(projectId, jids) {
    tx(() => {
      stmt.clearProjectGroups.run(projectId);
      for (const jid of jids) stmt.insertProjectGroup.run(projectId, jid);
    });
  }

  function replaceAllowlist(jids, now) {
    tx(() => {
      stmt.clearAllowedGroups.run();
      for (const jid of jids) stmt.insertAllowedGroup.run(jid, now);
    });
  }

  function replaceDmAllowlist(jids, now) {
    tx(() => {
      stmt.clearDmAllowed.run();
      for (const jid of jids) stmt.insertDmAllowed.run(jid, null, now);
    });
  }

  function replaceReadableChats(chats, now) {
    tx(() => {
      stmt.clearReadableChats.run();
      for (const chat of chats) {
        stmt.insertReadableChat.run(chat.jid, chat.kind, chat.label ?? null, now);
      }
    });
  }

  return {
    listProjects() {
      const rows = stmt.listProjects.all();
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        groupJids: stmt.listProjectGroups.all(r.id).map((g) => g.group_jid),
      }));
    },

    createProject(name, groupJids) {
      const token = mintToken();
      const now = Date.now();
      const info = stmt.insertProject.run(name, hashToken(token), now);
      const id = Number(info.lastInsertRowid);
      replaceProjectGroups(id, groupJids);
      return { id, name, token, createdAt: now, groupJids };
    },

    deleteProject(id) {
      const info = stmt.deleteProject.run(id);
      return info.changes > 0;
    },

    rotateProjectToken(id) {
      const exists = stmt.getProjectById.get(id);
      if (!exists) return null;
      const token = mintToken();
      stmt.rotateProjectToken.run(hashToken(token), id);
      return token;
    },

    setProjectGroups(id, groupJids) {
      const exists = stmt.getProjectById.get(id);
      if (!exists) return false;
      replaceProjectGroups(id, groupJids);
      return true;
    },

    findProjectByToken(token) {
      const row = stmt.getProjectByTokenHash.get(hashToken(token));
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        groupJids: stmt.listProjectGroups.all(row.id).map((g) => g.group_jid),
      };
    },

    listAllowedGroups() {
      return stmt.listAllowedGroups.all().map((r) => r.jid);
    },

    setAllowedGroups(jids) {
      replaceAllowlist(jids, Date.now());
    },

    addAllowedGroup(jid) {
      stmt.insertAllowedGroup.run(jid, Date.now());
    },

    addProjectGroup(projectId, jid) {
      stmt.insertProjectGroup.run(projectId, jid);
    },

    removeProjectGroup(projectId, jid) {
      return stmt.deleteProjectGroup.run(projectId, jid).changes > 0;
    },

    logMessage({ projectName, groupJid, title, status, error, mediaCount }) {
      stmt.insertMessage.run(
        projectName,
        groupJid,
        title,
        status,
        error ?? null,
        Date.now(),
        mediaCount ?? 0
      );
      stmt.pruneMessages.run(MESSAGE_LOG_CAP);
    },

    listMessages({ project, group, limit }) {
      const lim = Math.max(1, Math.min(500, limit ?? 100));
      return stmt.listMessages.all(
        project ?? null,
        project ?? null,
        group ?? null,
        group ?? null,
        lim
      );
    },

    listDmAllowed() {
      return stmt.listDmAllowed.all().map((r) => r.jid);
    },

    setDmAllowed(jids) {
      replaceDmAllowlist(jids, Date.now());
    },

    isDmAllowed(jid) {
      return stmt.isDmAllowed.get(jid) != null;
    },

    enqueueDm({ batchId, toJid, body, idempotencyKey }) {
      const info = stmt.enqueueDm.run(
        batchId,
        toJid,
        body,
        idempotencyKey,
        Date.now()
      );
      return { inserted: info.changes > 0 };
    },

    nextPendingDm() {
      const row = stmt.nextPendingDm.get();
      if (!row) return null;
      return { id: row.id, batchId: row.batch_id, toJid: row.to_jid, body: row.body };
    },

    markDmSent(id) {
      stmt.markDmSent.run(Date.now(), id);
    },

    markDmFailed(id, error) {
      stmt.markDmFailed.run(error ?? null, id);
    },

    markDmSkipped(id, error) {
      stmt.markDmSkipped.run(error ?? null, id);
    },

    countDmSentSince(ts) {
      return stmt.countDmSentSince.get(ts).n;
    },

    pendingDmCount() {
      return stmt.pendingDmCount.get().n;
    },

    listDmQueue({ batchId, status, limit }) {
      const lim = Math.max(1, Math.min(500, limit ?? 100));
      return stmt.listDmQueue.all(
        batchId ?? null,
        batchId ?? null,
        status ?? null,
        status ?? null,
        lim
      );
    },

    cancelDmBatch(batchId, error) {
      return stmt.cancelDmBatch.run(error ?? null, batchId).changes;
    },

    getDmState() {
      const row = stmt.getDmState.get();
      return {
        paused: row.paused === 1,
        pauseReason: row.pause_reason,
        pausedAt: row.paused_at,
      };
    },

    setDmPaused(reason) {
      stmt.setDmPaused.run(reason ?? null, Date.now());
    },

    clearDmPause() {
      stmt.clearDmPause.run();
    },

    listReadableChats() {
      return stmt.listReadableChats.all().map((r) => ({
        jid: r.jid,
        kind: r.kind,
        label: r.label,
        addedAt: r.added_at,
      }));
    },

    isReadableChat(jid) {
      // READ_ALL_CHATS=true captures every chat except Status updates;
      // otherwise only chats opted in via set_readable_chats.
      if (process.env.READ_ALL_CHATS === 'true') return jid !== 'status@broadcast';
      return stmt.getReadableChat.get(jid) != null;
    },

    setReadableChats(chats) {
      replaceReadableChats(chats, Date.now());
    },

    insertInboundMessage(msg) {
      const info = stmt.insertInbound.run(
        msg.waId,
        msg.chatJid,
        msg.senderJid ?? null,
        msg.fromMe ? 1 : 0,
        msg.timestamp,
        msg.text ?? null,
        msg.mediaType ?? null,
        msg.quotedWaId ?? null,
        msg.mime ?? null,
        msg.raw ?? null
      );
      if (info.changes === 0) return null;
      stmt.pruneInbound.run(INBOUND_CAP);
      return Number(info.lastInsertRowid);
    },

    getInboundMedia(id) {
      const row = stmt.getInboundMedia.get(id);
      if (!row || !row.media_type) return null;
      return {
        id: row.id,
        mediaType: row.media_type,
        mime: row.media_mime,
        raw: row.media_raw,
        path: row.media_path,
      };
    },

    setInboundMediaPath(id, filePath) {
      stmt.setInboundMediaPath.run(filePath, id);
    },

    listInboundMessages({ jid, since, fromMe, limit }) {
      const lim = Math.max(1, Math.min(500, limit ?? 100));
      const sinceVal = since == null ? null : Number(since);
      const fromMeVal = fromMe == null ? null : (fromMe ? 1 : 0);
      return stmt.listInbound.all(
        jid ?? null,
        jid ?? null,
        sinceVal,
        sinceVal,
        fromMeVal,
        fromMeVal,
        lim
      );
    },
  };
}
