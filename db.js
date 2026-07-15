// Capa de datos — node:sqlite, sin dependencias externas.
//
// Nota: si venís del MVP v1, borrá encuestas.db (el esquema cambió).
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export function openDb(path = process.env.DB_PATH || 'encuestas.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;

    -- Memoria de contactos: cada contacto cargado a mano queda guardado
    -- para la próxima (riesgo #1 del journey).
    CREATE TABLE IF NOT EXISTS clients (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT,
      phone      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS clients_name ON clients(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS jobs (
      id         INTEGER PRIMARY KEY,
      ref        TEXT NOT NULL,
      type       TEXT,
      client_id  INTEGER NOT NULL REFERENCES clients(id),
      closed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_ref ON jobs(ref);

    -- Ciclo de vida:
    --   pending_contact  sin datos de contacto (rescate manual)
    --   scheduled        con contacto, esperando el envío diferido
    --   ready            vencida, canal whatsapp sin gateway: espera el tap del operario
    --   sent             enviada
    --   responded        respondida
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
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Caso de recuperación por respuesta "insatisfecho" (adoptado del flujo
    -- BERLIM): abierto -> en_tratamiento -> resuelto, con seguimiento
    -- semanal al dueño mientras siga abierto.
    CREATE TABLE IF NOT EXISTS cases (
      id               INTEGER PRIMARY KEY,
      survey_id        INTEGER NOT NULL UNIQUE REFERENCES surveys(id),
      client_id        INTEGER NOT NULL REFERENCES clients(id),
      status           TEXT NOT NULL DEFAULT 'abierto'
                       CHECK (status IN ('abierto','en_tratamiento','resuelto')),
      notes            TEXT NOT NULL DEFAULT '',
      opened_at        TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at      TEXT,
      last_followup_at TEXT
    );

    -- Todo lo que sale del sistema queda acá (auditable). El transporte
    -- real se enchufa por webhook; ver notify.js.
    CREATE TABLE IF NOT EXISTS outbox (
      id         INTEGER PRIMARY KEY,
      survey_id  INTEGER REFERENCES surveys(id),
      kind       TEXT NOT NULL CHECK (kind IN ('initial','reminder','alert','followup','resolution')),
      channel    TEXT NOT NULL,
      recipient  TEXT NOT NULL,
      subject    TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function newToken() {
  return randomBytes(16).toString('hex');
}

export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits.length >= 8 ? digits : null;
}

// Busca el cliente por nombre; si ya lo conocemos con contacto y esta vez
// no vino, reusamos el guardado (auto-completar todo lo auto-completable).
export function upsertClient(db, { name, email, phone }) {
  email = (email || '').trim() || null;
  phone = normalizePhone(phone);
  const existing = db
    .prepare('SELECT * FROM clients WHERE name = ? COLLATE NOCASE')
    .get(name.trim());
  if (existing) {
    const merged = { email: email || existing.email, phone: phone || existing.phone };
    if (merged.email !== existing.email || merged.phone !== existing.phone) {
      db.prepare('UPDATE clients SET email = ?, phone = ? WHERE id = ?')
        .run(merged.email, merged.phone, existing.id);
    }
    return { ...existing, ...merged };
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO clients (name, email, phone) VALUES (?, ?, ?)')
    .run(name.trim(), email, phone);
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(lastInsertRowid);
}

// Canal para un cliente: email si lo hay (100% automático), sino whatsapp.
export function channelFor(client) {
  if (client.email) return 'email';
  if (client.phone) return 'whatsapp';
  return null;
}

export function metrics(db) {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                            AS total,
      SUM(status IN ('sent','responded'))                 AS enviadas,
      SUM(status = 'pending_contact')                     AS sin_contacto,
      SUM(status IN ('scheduled','ready'))                AS en_cola,
      SUM(status = 'responded')                           AS respondidas,
      SUM(rating = 'insatisfecho')                        AS insatisfecho,
      SUM(rating = 'bueno')                               AS bueno,
      SUM(rating = 'excelente')                           AS excelente
    FROM surveys
  `).get();
  const abiertos = db
    .prepare("SELECT COUNT(*) AS n FROM cases WHERE status != 'resuelto'").get().n;
  const pct = (num, den) => (den ? Math.round((num / den) * 100) : 0);
  const n = (x) => x ?? 0;
  return {
    total: row.total,
    enviadas: n(row.enviadas),
    sin_contacto: n(row.sin_contacto),
    en_cola: n(row.en_cola),
    respondidas: n(row.respondidas),
    casos_abiertos: abiertos,
    desglose: {
      insatisfecho: n(row.insatisfecho),
      bueno: n(row.bueno),
      excelente: n(row.excelente),
    },
    pct_enviadas: pct(n(row.enviadas), row.total),
    pct_respondidas: pct(n(row.respondidas), n(row.enviadas)),
    pct_satisfaccion: pct(n(row.bueno) + n(row.excelente), n(row.respondidas)),
  };
}

// ID legible y citable: interno sigue siendo el entero; esto es presentación.
export const surveyCode = (id) => `ENC-${String(id).padStart(4, '0')}`;

// Registro CRM: toda encuesta con su cliente y trabajo.
export function surveysList(db, limit = 2000) {
  return db.prepare(`
    SELECT s.id, s.status, s.channel, s.rating, s.resend_count,
           s.scheduled_at, s.sent_at, s.responded_at, s.created_at,
           c.id AS client_id, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
           j.ref AS job_ref, j.type AS job_type, j.closed_at
    FROM surveys s JOIN clients c ON c.id = s.client_id JOIN jobs j ON j.id = s.job_id
    ORDER BY s.id DESC LIMIT ?
  `).all(limit).map((r) => ({ ...r, code: surveyCode(r.id) }));
}

// Agregados por cliente: la ficha resumida de cada uno.
export function clientAggregates(db) {
  return db.prepare(`
    SELECT c.id, c.name, c.email, c.phone,
           COUNT(s.id)                          AS encuestas,
           SUM(s.status IN ('sent','responded')) AS enviadas,
           SUM(s.status = 'responded')          AS respondidas,
           SUM(s.rating = 'insatisfecho')       AS insatisfecho,
           SUM(s.rating = 'bueno')              AS bueno,
           SUM(s.rating = 'excelente')          AS excelente,
           MAX(coalesce(s.responded_at, s.sent_at, s.created_at)) AS ultimo
    FROM clients c LEFT JOIN surveys s ON s.client_id = c.id
    GROUP BY c.id ORDER BY ultimo DESC
  `).all();
}

// Agregados por tipo de servicio: el corte que hace accionable el promedio.
export function typeAggregates(db) {
  return db.prepare(`
    SELECT coalesce(j.type, '(sin tipo)')       AS type,
           COUNT(s.id)                          AS encuestas,
           SUM(s.status IN ('sent','responded')) AS enviadas,
           SUM(s.status = 'responded')          AS respondidas,
           SUM(s.rating = 'insatisfecho')       AS insatisfecho,
           SUM(s.rating = 'bueno')              AS bueno,
           SUM(s.rating = 'excelente')          AS excelente
    FROM surveys s JOIN jobs j ON j.id = s.job_id
    GROUP BY coalesce(j.type, '(sin tipo)')
    ORDER BY encuestas DESC
  `).all();
}

// Clientes en riesgo (adoptado del flujo BERLIM): insatisfacción recurrente.
export function atRiskClients(db) {
  return db.prepare(`
    SELECT c.id, c.name, c.email, c.phone,
           COUNT(*) AS insatisfechos,
           MAX(s.responded_at) AS ultimo
    FROM surveys s JOIN clients c ON c.id = s.client_id
    WHERE s.rating = 'insatisfecho'
    GROUP BY c.id HAVING COUNT(*) >= 2
    ORDER BY ultimo DESC
  `).all();
}
