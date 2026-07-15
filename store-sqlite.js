// Store SQLite (node:sqlite): backend por defecto para desarrollo local,
// VPS y tests. API asíncrona idéntica a store-supabase.js; los timestamps
// se guardan como ISO 8601 UTC generados en JS (misma convención que
// Postgres devuelve, así el frontend no distingue backends).
//
// Nota: si venís de una versión anterior, borrá encuestas.db.

import { DatabaseSync } from 'node:sqlite';
import { nowIso } from './util.js';

const SCHEMA = `
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT,
    phone      TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS clients_name ON clients(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY,
    ref        TEXT NOT NULL UNIQUE,
    type       TEXT,
    client_id  INTEGER NOT NULL REFERENCES clients(id),
    closed_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS surveys (
    id           INTEGER PRIMARY KEY,
    job_id       INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    client_id    INTEGER NOT NULL REFERENCES clients(id),
    token        TEXT NOT NULL UNIQUE,
    channel      TEXT CHECK (channel IN ('email','whatsapp')),
    status       TEXT NOT NULL DEFAULT 'pending_contact'
                 CHECK (status IN ('pending_contact','scheduled','ready','sent','responded')),
    rating       TEXT CHECK (rating IN ('insatisfecho','bueno','excelente')),
    resend_count INTEGER NOT NULL DEFAULT 0,
    scheduled_at TEXT,
    sent_at      TEXT,
    responded_at TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cases (
    id               INTEGER PRIMARY KEY,
    survey_id        INTEGER NOT NULL UNIQUE REFERENCES surveys(id),
    client_id        INTEGER NOT NULL REFERENCES clients(id),
    status           TEXT NOT NULL DEFAULT 'abierto'
                     CHECK (status IN ('abierto','en_tratamiento','resuelto')),
    notes            TEXT NOT NULL DEFAULT '',
    opened_at        TEXT NOT NULL,
    resolved_at      TEXT,
    last_followup_at TEXT
  );

  CREATE TABLE IF NOT EXISTS outbox (
    id         INTEGER PRIMARY KEY,
    survey_id  INTEGER REFERENCES surveys(id),
    kind       TEXT NOT NULL CHECK (kind IN ('initial','reminder','alert','followup','resolution')),
    channel    TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

const SURVEY_JOIN = `
  SELECT s.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
         j.ref AS job_ref, j.type AS job_type, j.closed_at
  FROM surveys s JOIN clients c ON c.id = s.client_id JOIN jobs j ON j.id = s.job_id
`;

export function openSqliteStore(path = process.env.DB_PATH || 'encuestas.db') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const insert = (table, fields) => {
    const keys = Object.keys(fields);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => fields[k] ?? null));
    return one(`SELECT * FROM ${table} WHERE id = ?`, lastInsertRowid);
  };
  const update = (table, id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), id);
  };

  return {
    kind: 'sqlite',
    async isEmpty() { return one('SELECT COUNT(*) AS n FROM surveys').n === 0; },

    async clientByName(name) { return one('SELECT * FROM clients WHERE name = ? COLLATE NOCASE', name.trim()); },
    async clientById(id) { return one('SELECT * FROM clients WHERE id = ?', id); },
    async insertClient(f) { return insert('clients', { created_at: nowIso(), ...f }); },
    async updateClient(id, f) { update('clients', id, f); },

    async jobByRef(ref) { return one('SELECT * FROM jobs WHERE ref = ?', ref); },
    async jobById(id) { return one('SELECT * FROM jobs WHERE id = ?', id); },
    async insertJob(f) { return insert('jobs', { closed_at: nowIso(), ...f }); },

    async surveyById(id) { return one('SELECT * FROM surveys WHERE id = ?', id); },
    async surveyByToken(token) { return one('SELECT * FROM surveys WHERE token = ?', token); },
    async insertSurvey(f) { return insert('surveys', { created_at: nowIso(), ...f }); },
    async updateSurvey(id, f) { update('surveys', id, f); },
    async surveysJoined(limit = 2000) { return all(`${SURVEY_JOIN} ORDER BY s.id DESC LIMIT ?`, limit); },
    async surveysDue(now) {
      return all("SELECT * FROM surveys WHERE status = 'scheduled' AND scheduled_at <= ?", now);
    },
    async surveysReminderDue(cutoff) {
      return all("SELECT * FROM surveys WHERE status = 'sent' AND resend_count = 0 AND sent_at <= ?", cutoff);
    },

    async caseById(id) { return one('SELECT * FROM cases WHERE id = ?', id); },
    async insertCaseIgnore(f) {
      db.prepare('INSERT OR IGNORE INTO cases (survey_id, client_id, status, notes, opened_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(f.survey_id, f.client_id, f.status ?? 'abierto', f.notes ?? '', f.opened_at ?? nowIso(), f.resolved_at ?? null);
    },
    async updateCase(id, f) { update('cases', id, f); },
    async casesJoined() {
      return all(`
        SELECT k.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
               j.ref AS job_ref, j.type AS job_type, s.responded_at
        FROM cases k
        JOIN surveys s ON s.id = k.survey_id
        JOIN clients c ON c.id = k.client_id
        JOIN jobs j ON j.id = s.job_id
        ORDER BY (k.status = 'resuelto'), k.opened_at DESC LIMIT 50
      `);
    },
    async casesFollowupDue(cutoff) {
      return all("SELECT * FROM cases WHERE status != 'resuelto' AND coalesce(last_followup_at, opened_at) <= ?", cutoff);
    },

    async outboxInsert(f) { insert('outbox', { created_at: nowIso(), ...f }); },
    async outboxList(limit = 15) { return all('SELECT * FROM outbox ORDER BY id DESC LIMIT ?', limit); },

    async metricsRaw() {
      const row = one(`
        SELECT COUNT(*) AS total,
               SUM(status IN ('sent','responded'))  AS enviadas,
               SUM(status = 'pending_contact')      AS sin_contacto,
               SUM(status IN ('scheduled','ready')) AS en_cola,
               SUM(status = 'responded')            AS respondidas,
               SUM(rating = 'insatisfecho')         AS insatisfecho,
               SUM(rating = 'bueno')                AS bueno,
               SUM(rating = 'excelente')            AS excelente
        FROM surveys
      `);
      row.casos_abiertos = one("SELECT COUNT(*) AS n FROM cases WHERE status != 'resuelto'").n;
      return row;
    },
    async atRisk() {
      return all(`
        SELECT c.id, c.name, c.email, c.phone, COUNT(*) AS insatisfechos, MAX(s.responded_at) AS ultimo
        FROM surveys s JOIN clients c ON c.id = s.client_id
        WHERE s.rating = 'insatisfecho'
        GROUP BY c.id HAVING COUNT(*) >= 2 ORDER BY ultimo DESC
      `);
    },
    async clientAggregates() {
      return all(`
        SELECT c.id, c.name, c.email, c.phone,
               COUNT(s.id) AS encuestas,
               SUM(s.status IN ('sent','responded')) AS enviadas,
               SUM(s.status = 'responded') AS respondidas,
               SUM(s.rating = 'insatisfecho') AS insatisfecho,
               SUM(s.rating = 'bueno') AS bueno,
               SUM(s.rating = 'excelente') AS excelente,
               MAX(coalesce(s.responded_at, s.sent_at, s.created_at)) AS ultimo
        FROM clients c LEFT JOIN surveys s ON s.client_id = c.id
        GROUP BY c.id ORDER BY ultimo DESC
      `);
    },
    async typeAggregates() {
      return all(`
        SELECT coalesce(j.type, '(sin tipo)') AS type,
               COUNT(s.id) AS encuestas,
               SUM(s.status IN ('sent','responded')) AS enviadas,
               SUM(s.status = 'responded') AS respondidas,
               SUM(s.rating = 'insatisfecho') AS insatisfecho,
               SUM(s.rating = 'bueno') AS bueno,
               SUM(s.rating = 'excelente') AS excelente
        FROM surveys s JOIN jobs j ON j.id = s.job_id
        GROUP BY coalesce(j.type, '(sin tipo)') ORDER BY encuestas DESC
      `);
    },
  };
}
