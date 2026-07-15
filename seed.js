// Datos de demo: puebla la base con encuestas de prueba realistas.
//
//   node seed.js            (no toca una base que ya tiene datos)
//   node seed.js --force    (borra y repuebla)
//
// El server también lo corre solo al arrancar con DEMO_SEED=1 y base
// vacía — pensado para hosting efímero (Render free): cada vez que el
// servicio despierta, la demo está poblada.

import { openDb, newToken } from './db.js';

// Repartidos en los últimos 30 días para que las vistas tengan historia.
const DATA = [
  // [ref, tipo, cliente, email, phone, díasAtrás, estadoFinal, rating]
  ['T-1001', 'plomería',     'Ana García',      'ana.garcia@mail.com',    null,            28, 'responded', 'excelente'],
  ['T-1002', 'electricidad', 'Marcos Peralta',  'mperalta@mail.com',      null,            26, 'responded', 'bueno'],
  ['T-1003', 'pintura',      'Dario Sosa',      'dario.sosa@mail.com',    null,            24, 'responded', 'insatisfecho'],
  ['T-1004', 'limpieza',     'Clínica San Justo', 'admin@sanjusto.com',   null,            21, 'responded', 'excelente'],
  ['T-1005', 'plomería',     'Marta Ledesma',   'marta.l@mail.com',       null,            19, 'responded', 'bueno'],
  ['T-1006', 'pintura',      'Dario Sosa',      null,                     null,            15, 'responded', 'insatisfecho'],
  ['T-1007', 'electricidad', 'Estudio Ferreyra', 'info@ferreyra.com.ar',  null,            13, 'responded', 'excelente'],
  ['T-1008', 'limpieza',     'Clínica San Justo', null,                   null,            10, 'responded', 'bueno'],
  ['T-1009', 'plomería',     'Rocío Benítez',   'rbenitez@mail.com',      null,             7, 'responded', 'excelente'],
  ['T-1010', 'pintura',      'Hugo Almada',     'halmada@mail.com',       null,             5, 'responded', 'insatisfecho'],
  ['T-1011', 'electricidad', 'Marta Ledesma',   null,                     null,             4, 'sent',      null],
  ['T-1012', 'limpieza',     'Beto Ruiz',       null,                     '5491133445566',  1, 'ready',     null],
  ['T-1013', 'plomería',     'Carla Paz',       null,                     null,             1, 'pending',   null],
  ['T-1014', 'pintura',      'Ana García',      null,                     null,             0, 'sent',      null],
];

export function seedDemo(db) {
  const insClient = db.prepare('INSERT INTO clients (name, email, phone, created_at) VALUES (?, ?, ?, datetime(\'now\', ?))');
  const findClient = db.prepare('SELECT * FROM clients WHERE name = ? COLLATE NOCASE');
  const insJob = db.prepare('INSERT INTO jobs (ref, type, client_id, closed_at) VALUES (?, ?, ?, datetime(\'now\', ?))');
  const insCase = db.prepare(`
    INSERT INTO cases (survey_id, client_id, status, notes, opened_at, resolved_at)
    VALUES (?, ?, ?, ?, datetime('now', ?), ?)
  `);
  const insOutbox = db.prepare(`
    INSERT INTO outbox (survey_id, kind, channel, recipient, subject, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);

  let caseNum = 0;
  for (const [ref, type, name, email, phone, days, state, rating] of DATA) {
    let client = findClient.get(name);
    if (!client) {
      insClient.run(name, email, phone, `-${days} days`);
      client = findClient.get(name);
    } else if (email || phone) {
      db.prepare('UPDATE clients SET email = coalesce(email, ?), phone = coalesce(phone, ?) WHERE id = ?')
        .run(email, phone, client.id);
      client = findClient.get(name);
    }

    const jobOffset = `-${days} days`;
    const { lastInsertRowid: jobId } = insJob.run(ref, type, client.id, jobOffset);
    const token = newToken();
    const channel = client.email ? 'email' : (client.phone ? 'whatsapp' : null);

    const sentOffset = `-${days} days`;
    const respondedOffset = `-${Math.max(days - 1, 0)} days`;
    const status = state === 'pending' ? 'pending_contact' : state;
    const sentAt = ['sent', 'responded'].includes(state) ? `datetime('now', '${sentOffset}', '+45 minutes')` : 'NULL';
    const respondedAt = state === 'responded' ? `datetime('now', '${respondedOffset}')` : 'NULL';

    // sent_at/responded_at van como SQL crudo controlado por este archivo.
    const { lastInsertRowid: surveyId } = db.prepare(`
      INSERT INTO surveys (job_id, client_id, token, channel, status, rating, resend_count, scheduled_at, sent_at, responded_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now', '${sentOffset}'), ${sentAt}, ${respondedAt}, datetime('now', '${sentOffset}'))
    `).run(jobId, client.id, token, channel, status, rating);

    if (['sent', 'responded'].includes(state)) {
      insOutbox.run(surveyId, 'initial', channel ?? 'email',
        client.email || (client.phone ? `+${client.phone}` : 'sin datos'),
        '¿Cómo salió el trabajo? Respondé con un toque',
        `Hola ${name}! Terminamos el trabajo de ${type} (${ref}). Es una sola pregunta: /s/${token}`,
        sentOffset);
    }

    if (rating === 'insatisfecho') {
      caseNum++;
      // Primer caso: resuelto con notas; segundo: en tratamiento; resto: abiertos.
      const caseState = caseNum === 1 ? 'resuelto' : caseNum === 2 ? 'en_tratamiento' : 'abierto';
      const notes = caseNum === 1
        ? 'Lo llamé el mismo día. Se repintó la pared del living sin cargo.'
        : caseNum === 2 ? 'Hablé con él, coordinamos visita para el jueves.' : '';
      insCase.run(surveyId, client.id, caseState, notes, respondedOffset,
        caseState === 'resuelto' ? db.prepare(`SELECT datetime('now', '${respondedOffset}', '+2 days') AS d`).get().d : null);
      insOutbox.run(surveyId, 'alert', 'interno', 'dueño',
        `Cliente insatisfecho: ${name}`,
        `${name} respondió INSATISFECHO por el trabajo ${ref} (${type}). Llamalo hoy.`,
        respondedOffset);
      if (caseState === 'resuelto') {
        insOutbox.run(surveyId, 'resolution', channel ?? 'email',
          client.email || 'sin datos',
          'Queríamos contarte que lo resolvimos',
          `Hola ${name}! Nos tomamos en serio tu respuesta sobre ${ref} y lo resolvimos. Gracias por avisarnos.`,
          `-${Math.max(days - 3, 0)} days`);
      }
    }
  }
  return db.prepare('SELECT COUNT(*) AS n FROM surveys').get().n;
}

export function isEmpty(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM surveys').get().n === 0;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  if (!isEmpty(db) && !process.argv.includes('--force')) {
    console.log('La base ya tiene datos. Usá --force para borrar y repoblar.');
    process.exit(1);
  }
  if (process.argv.includes('--force')) {
    db.exec('DELETE FROM outbox; DELETE FROM cases; DELETE FROM surveys; DELETE FROM jobs; DELETE FROM clients;');
  }
  const n = seedDemo(db);
  console.log(`Listo: ${n} encuestas de prueba cargadas.`);
}
