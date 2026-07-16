// Datos de demo: puebla el store con encuestas de prueba realistas,
// repartidas en los últimos 30 días para que las vistas tengan historia.
//
//   node seed.js            (no toca una base que ya tiene datos)
//
// El server también lo corre solo al arrancar con DEMO_SEED=1 y base
// vacía. Con Supabase los datos persisten: el seed corre una sola vez.

import { newToken } from './util.js';

const DAY = 86_400_000;
const iso = (daysAgo, extraMs = 0) => new Date(Date.now() - daysAgo * DAY + extraMs).toISOString();

const DATA = [
  // [ref, tipo, cliente, email, phone, díasAtrás, estadoFinal, rating]
  ['T-1001', 'plomería',     'Ana García',        'ana.garcia@mail.com',  null,            28, 'responded', 'excelente'],
  ['T-1002', 'electricidad', 'Marcos Peralta',    'mperalta@mail.com',    null,            26, 'responded', 'bueno'],
  ['T-1003', 'pintura',      'Dario Sosa',        'dario.sosa@mail.com',  null,            24, 'responded', 'insatisfecho'],
  ['T-1004', 'limpieza',     'Clínica San Justo', 'admin@sanjusto.com',   null,            21, 'responded', 'excelente'],
  ['T-1005', 'plomería',     'Marta Ledesma',     'marta.l@mail.com',     null,            19, 'responded', 'bueno'],
  ['T-1006', 'pintura',      'Dario Sosa',        null,                   null,            15, 'responded', 'insatisfecho'],
  ['T-1007', 'electricidad', 'Estudio Ferreyra',  'info@ferreyra.com.ar', null,            13, 'responded', 'excelente'],
  ['T-1008', 'limpieza',     'Clínica San Justo', null,                   null,            10, 'responded', 'bueno'],
  ['T-1009', 'plomería',     'Rocío Benítez',     'rbenitez@mail.com',    null,             7, 'responded', 'excelente'],
  ['T-1010', 'pintura',      'Hugo Almada',       'halmada@mail.com',     null,             5, 'responded', 'insatisfecho'],
  ['T-1011', 'electricidad', 'Marta Ledesma',     null,                   null,             4, 'sent',      null],
  ['T-1012', 'limpieza',     'Beto Ruiz',         null,                   '5491133445566',  1, 'ready',     null],
  ['T-1013', 'plomería',     'Carla Paz',         null,                   null,             1, 'pending',   null],
  ['T-1014', 'pintura',      'Ana García',        null,                   null,             0, 'sent',      null],
  // Encuestas CSAT creadas por el gerente (link directo, escala 1-5).
  ['DIR-C1', 'post-obra',    'Estudio Ferreyra',  null,                   null,             3, 'responded', 'excelente', 'csat', 5],
  ['DIR-C2', 'post-obra',    'Hugo Almada',       null,                   null,             2, 'responded', 'insatisfecho', 'csat', 2],
];

export async function seedDemo(store) {
  let caseNum = 0;
  let count = 0;

  for (const [ref, type, name, email, phone, days, state, rating, format = 'simple', score = null] of DATA) {
    let client = await store.clientByName(name);
    if (!client) {
      client = await store.insertClient({ name, email, phone, created_at: iso(days) });
    } else if ((email && !client.email) || (phone && !client.phone)) {
      await store.updateClient(client.id, {
        email: client.email || email,
        phone: client.phone || phone,
      });
      client = await store.clientById(client.id);
    }

    const job = await store.insertJob({ ref, type, client_id: client.id, closed_at: iso(days) });
    const channel = client.email ? 'email' : (client.phone ? 'whatsapp' : null);
    const wasSent = ['sent', 'responded'].includes(state);

    const survey = await store.insertSurvey({
      job_id: job.id,
      client_id: client.id,
      token: newToken(),
      channel,
      status: state === 'pending' ? 'pending_contact' : state,
      rating,
      format,
      score,
      scheduled_at: channel ? iso(days) : null,
      sent_at: wasSent ? iso(days, 45 * 60_000) : null,
      responded_at: state === 'responded' ? iso(Math.max(days - 1, 0)) : null,
      created_at: iso(days),
    });
    count++;

    const recipient = client.email || (client.phone ? `+${client.phone}` : 'sin datos');
    if (wasSent) {
      await store.outboxInsert({
        survey_id: survey.id, kind: 'initial', channel: channel ?? 'email', recipient,
        subject: '¿Cómo salió el trabajo? Respondé con un toque',
        body: `Hola ${name}! Terminamos el trabajo de ${type} (${ref}). Es una sola pregunta: /s/${survey.token}`,
        created_at: iso(days, 45 * 60_000),
      });
    }

    if (rating === 'insatisfecho') {
      caseNum++;
      // Primer caso: resuelto con notas; segundo: en tratamiento; resto: abiertos.
      const caseState = caseNum === 1 ? 'resuelto' : caseNum === 2 ? 'en_tratamiento' : 'abierto';
      const notes = caseNum === 1
        ? 'Lo llamé el mismo día. Se repintó la pared del living sin cargo.'
        : caseNum === 2 ? 'Hablé con él, coordinamos visita para el jueves.' : '';
      await store.insertCaseIgnore({
        survey_id: survey.id,
        client_id: client.id,
        status: caseState,
        notes,
        opened_at: iso(Math.max(days - 1, 0)),
        resolved_at: caseState === 'resuelto' ? iso(Math.max(days - 3, 0)) : null,
      });
      await store.outboxInsert({
        survey_id: survey.id, kind: 'alert', channel: 'interno', recipient: 'dueño',
        subject: `Cliente insatisfecho: ${name}`,
        body: `${name} respondió INSATISFECHO por el trabajo ${ref} (${type}). Llamalo hoy.`,
        created_at: iso(Math.max(days - 1, 0)),
      });
      if (caseState === 'resuelto') {
        await store.outboxInsert({
          survey_id: survey.id, kind: 'resolution', channel: channel ?? 'email', recipient,
          subject: 'Queríamos contarte que lo resolvimos',
          body: `Hola ${name}! Nos tomamos en serio tu respuesta sobre ${ref} y lo resolvimos. Gracias por avisarnos.`,
          created_at: iso(Math.max(days - 3, 0)),
        });
      }
    }
  }
  return count;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openStore } = await import('./store.js');
  const store = await openStore();
  if (!(await store.isEmpty())) {
    console.log(`La base (${store.kind}) ya tiene datos; no se toca. Para repoblar, vaciala primero.`);
    process.exit(1);
  }
  console.log(`Listo: ${await seedDemo(store)} encuestas de prueba cargadas en ${store.kind}.`);
}
