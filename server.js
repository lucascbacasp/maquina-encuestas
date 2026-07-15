// Máquina de Encuestas — backend + API + páginas públicas de encuesta.
//
//   node server.js          # tablero en http://localhost:3000
//
// Flujo: cierre del trabajo -> encuesta programada (envío diferido) ->
// envío automático (email / gateway WhatsApp) o tap-to-send (wa.me sin
// API de Meta) -> respuesta de 1 tap -> alerta + caso si es insatisfecho ->
// reseña de Google si es excelente. Scheduler interno para envíos
// diferidos, reenvío a las 48hs y seguimiento semanal de casos.
//
// Env: PORT, BASE_URL, DB_PATH, SEND_DELAY_MINUTES, AUTO_REMINDER_HOURS,
//      CASE_FOLLOWUP_DAYS, GOOGLE_REVIEW_URL, OWNER_CONTACT,
//      SEND_WEBHOOK_URL, WHATSAPP_WEBHOOK_URL, ALERT_WEBHOOK_URL

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  openDb, newToken, upsertClient, channelFor, normalizePhone, metrics, atRiskClients,
  surveyCode, surveysList, clientAggregates, typeAggregates,
} from './db.js';
import {
  deliver, waLink, hasWhatsAppGateway,
  surveyMessage, alertMessage, followupMessage, resolutionMessage,
} from './notify.js';
import { startScheduler, dispatchDue, canAutoSend } from './scheduler.js';
import { seedDemo, isEmpty } from './seed.js';

const PORT = Number(process.env.PORT || 3000);
// RENDER_EXTERNAL_URL la inyecta Render automáticamente.
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const DELAY_SECONDS = Math.round(Number(process.env.SEND_DELAY_MINUTES ?? 45) * 60);
const PUBLIC_DIR = join(import.meta.dirname, 'public');
const db = openDb();

// Hosting efímero (Render free): con DEMO_SEED=1, cada arranque con base
// vacía repuebla los datos de prueba — la demo siempre despierta poblada.
if (process.env.DEMO_SEED === '1' && isEmpty(db)) {
  console.log(`[seed] base vacía: ${seedDemo(db)} encuestas de demo cargadas`);
}

// ---------------------------------------------------------------- auth
// Basic Auth para el tablero y la API del operario (ADMIN_PASS lo activa).
// Lo que ve el cliente final queda SIEMPRE público: /s/:token, /fonts, /healthz.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const PUBLIC_ROUTES = /^\/(s\/[a-f0-9]{32}|fonts\/|healthz$)/;

function isAuthorized(req) {
  if (!ADMIN_PASS) return true; // sin ADMIN_PASS no hay auth (modo dev)
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return user === ADMIN_USER && rest.join(':') === ADMIN_PASS;
}

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100_000) reject(new Error('body demasiado grande'));
    });
    req.on('end', () => {
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) resolve(JSON.parse(data || '{}'));
        else resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch {
        reject(new Error('body inválido'));
      }
    });
    req.on('error', reject);
  });
}

const sendHtml = (res, status, html) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
};
const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const redirect = (res, to) => {
  res.writeHead(302, { location: to });
  res.end();
};

const getSurvey = (id) => db.prepare('SELECT * FROM surveys WHERE id = ?').get(Number(id));
const getClient = (id) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
const getJob = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

// ------------------------------------------------------------- flujo core

async function sendSurvey(survey, kind) {
  const client = getClient(survey.client_id);
  const job = getJob(survey.job_id);
  const msg = surveyMessage(BASE_URL, survey, client, job, kind);
  const recipient = survey.channel === 'email' ? client.email : client.phone;
  await deliver(db, { surveyId: survey.id, kind, channel: survey.channel, recipient, ...msg });
  if (kind === 'initial') {
    db.prepare(
      "UPDATE surveys SET status = 'sent', sent_at = datetime('now') WHERE id = ? AND status IN ('scheduled','ready')"
    ).run(survey.id);
  } else {
    db.prepare('UPDATE surveys SET resend_count = resend_count + 1 WHERE id = ?').run(survey.id);
  }
}

async function sendFollowup(kase) {
  const client = getClient(kase.client_id);
  const survey = getSurvey(kase.survey_id);
  const job = getJob(survey.job_id);
  await deliver(db, {
    surveyId: survey.id,
    kind: 'followup',
    channel: 'interno',
    recipient: process.env.OWNER_CONTACT || 'dueño',
    ...followupMessage(kase, client, job),
  });
}

// Etapa 1: el cierre del trabajo dispara todo, sin pasos extra.
async function closeJob({ ref, type, clientName, clientEmail, clientPhone }) {
  const client = upsertClient(db, { name: clientName, email: clientEmail, phone: clientPhone });

  if (db.prepare('SELECT id FROM jobs WHERE ref = ?').get(ref)) return { duplicated: true };

  const { lastInsertRowid: jobId } = db
    .prepare('INSERT INTO jobs (ref, type, client_id) VALUES (?, ?, ?)')
    .run(ref, type || null, client.id);

  const channel = channelFor(client);
  const token = newToken();
  db.prepare(`
    INSERT INTO surveys (job_id, client_id, token, channel, status, scheduled_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' seconds') END)
  `).run(jobId, client.id, token, channel, channel ? 'scheduled' : 'pending_contact', channel, DELAY_SECONDS);

  // Con delay 0 sale en este mismo request; con delay, la levanta el scheduler.
  await dispatchDue(db, sendSurvey);
  const survey = db.prepare('SELECT * FROM surveys WHERE token = ?').get(token);
  return { survey };
}

// Etapa 4: registrar respuesta. Idempotente: la primera respuesta gana.
async function recordResponse(token, rating) {
  const survey = db.prepare('SELECT * FROM surveys WHERE token = ?').get(token);
  if (!survey) return { error: 'not_found' };
  if (survey.status === 'responded') return { survey, already: true };

  db.prepare(
    "UPDATE surveys SET status = 'responded', rating = ?, responded_at = datetime('now') WHERE id = ?"
  ).run(rating, survey.id);
  const updated = getSurvey(survey.id);

  // Insatisfecho = alerta inmediata al dueño + caso abierto (recuperación).
  if (rating === 'insatisfecho') {
    db.prepare('INSERT OR IGNORE INTO cases (survey_id, client_id) VALUES (?, ?)')
      .run(survey.id, survey.client_id);
    const client = getClient(survey.client_id);
    const job = getJob(survey.job_id);
    await deliver(db, {
      surveyId: survey.id,
      kind: 'alert',
      channel: 'interno',
      recipient: process.env.OWNER_CONTACT || 'dueño',
      ...alertMessage(updated, client, job),
    });
  }
  return { survey: updated };
}

// wa.me con el mensaje prearmado para una encuesta (modo tap-to-send).
function surveyWaLink(survey, kind) {
  const client = getClient(survey.client_id);
  const job = getJob(survey.job_id);
  const { body } = surveyMessage(BASE_URL, survey, client, job, kind);
  return waLink(client.phone, body);
}

// --------------------------------------------------- páginas públicas (SSR)

function publicPage(title, content) {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232a6fc4'/%3E%3Cpath d='M9 17l4.5 4.5L23 12' stroke='%23fff' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
  @font-face {
    font-family: 'Outfit';
    src: url('/fonts/Outfit-Variable.woff2') format('woff2');
    font-weight: 300 800;
    font-display: swap;
  }
  :root {
    color-scheme: light;
    --page: #f7f6f2; --surface: #fdfdfb; --ink: #1c1b18; --muted: #8f8c83;
    --hairline: #e7e5de; --accent: #2a6fc4; --warn: #d99a00;
    --shadow: 0 1px 2px rgba(28,27,24,.04), 0 10px 28px -14px rgba(28,27,24,.10);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --page: #131311; --surface: #1b1b18; --ink: #f4f3ef; --muted: #8f8c83;
      --hairline: #2b2b27; --accent: #5b96e0; --warn: #e0b23e;
      --shadow: 0 1px 2px rgba(0,0,0,.25), 0 12px 32px -16px rgba(0,0,0,.45);
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Outfit', 'Segoe UI Variable Display', 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif;
    background: var(--page); color: var(--ink);
    max-width: 480px; margin: 0 auto; padding: 10vh 1.2rem 3rem; line-height: 1.5;
  }
  h1 { font-size: 1.45rem; font-weight: 650; letter-spacing: -0.02em; line-height: 1.2; text-wrap: balance; }
  .muted { color: var(--muted); font-size: .9rem; }
  .btns { display: grid; gap: .9rem; margin-top: 2rem; }
  .btns button, .cta {
    font: inherit; font-size: 1.2rem; font-weight: 550; padding: 1.05rem; border-radius: 14px;
    border: 1px solid var(--hairline); background: var(--surface); box-shadow: var(--shadow);
    cursor: pointer; width: 100%; text-align: center; text-decoration: none; display: block;
    color: inherit; transition: border-color .18s ease, transform .12s ease;
  }
  .btns button:hover, .cta:hover { border-color: var(--accent); }
  .btns button:active, .cta:active { transform: translateY(1px) scale(.99); }
  :focus-visible { outline: none; box-shadow: 0 0 0 2px var(--page), 0 0 0 4px var(--accent); }
  .cta { border-color: var(--warn); margin-top: 1.5rem; }
</style>
</head><body>${content}</body></html>`;
}

const RATINGS = [
  ['insatisfecho', '😞 Insatisfecho'],
  ['bueno', '🙂 Bueno'],
  ['excelente', '🤩 Excelente'],
];

const surveyPageHtml = (survey, job) => publicPage('¿Cómo salió el trabajo?', `
  <h1>¿Cómo salió el trabajo${job.type ? ` de ${esc(job.type)}` : ''}?</h1>
  <p class="muted">Un solo toque y listo. Sin registrarse.</p>
  <div class="btns">
    ${RATINGS.map(([value, label]) => `
      <form method="post" action="/s/${esc(survey.token)}">
        <input type="hidden" name="rating" value="${value}">
        <button>${label}</button>
      </form>`).join('')}
  </div>`);

// Excelente -> pedido de reseña pública (growth loop adoptado de BERLIM).
function thanksPageHtml({ already, rating }) {
  const review = rating === 'excelente' && process.env.GOOGLE_REVIEW_URL
    ? `<a class="cta" href="${esc(process.env.GOOGLE_REVIEW_URL)}">⭐ ¿Nos dejás una reseña en Google?<br>
       <span class="muted">Nos ayuda muchísimo y toma 1 minuto</span></a>`
    : '';
  return publicPage('¡Gracias!', `
    <h1>¡Gracias por tu respuesta! 🙌</h1>
    <p class="muted">${already ? 'Ya habíamos registrado tu respuesta anterior.' : 'Tu opinión nos ayuda a mejorar.'}</p>
    ${review}`);
}

// ----------------------------------------------------------- estado (API)

function stateForDashboard() {
  const rows = db.prepare(`
    SELECT s.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
           j.ref AS job_ref, j.type AS job_type
    FROM surveys s JOIN clients c ON c.id = s.client_id JOIN jobs j ON j.id = s.job_id
    ORDER BY s.created_at DESC LIMIT 200
  `).all();

  const brief = (r) => ({
    id: r.id, code: surveyCode(r.id), status: r.status, channel: r.channel, rating: r.rating,
    resend_count: r.resend_count, scheduled_at: r.scheduled_at, sent_at: r.sent_at,
    responded_at: r.responded_at, client_name: r.client_name,
    client_email: r.client_email, client_phone: r.client_phone,
    job_ref: r.job_ref, job_type: r.job_type,
  });

  const cases = db.prepare(`
    SELECT k.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
           j.ref AS job_ref, j.type AS job_type, s.responded_at
    FROM cases k
    JOIN surveys s ON s.id = k.survey_id
    JOIN clients c ON c.id = k.client_id
    JOIN jobs j ON j.id = s.job_id
    ORDER BY (k.status = 'resuelto'), k.opened_at DESC LIMIT 50
  `).all();

  return {
    metrics: metrics(db),
    at_risk: atRiskClients(db),
    cases,
    pending_contact: rows.filter((r) => r.status === 'pending_contact').map(brief),
    ready: rows.filter((r) => r.status === 'ready').map(brief),
    scheduled: rows.filter((r) => r.status === 'scheduled').map(brief),
    unanswered: rows.filter((r) => r.status === 'sent')
      .map((r) => ({ ...brief(r), can_auto: canAutoSend(r.channel) })),
    responded: rows.filter((r) => r.status === 'responded').slice(0, 20).map(brief),
    activity: db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 15').all(),
    config: {
      delay_minutes: DELAY_SECONDS / 60,
      wa_gateway: hasWhatsAppGateway(),
      google_review: Boolean(process.env.GOOGLE_REVIEW_URL),
      auto_reminder_hours: Number(process.env.AUTO_REMINDER_HOURS ?? 48),
    },
  };
}

// ------------------------------------------------------------------ rutas

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true });

    if (!PUBLIC_ROUTES.test(path) && !isAuthorized(req)) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="Máquina de Encuestas"',
        'content-type': 'application/json',
      });
      return res.end(JSON.stringify({ error: 'autenticación requerida' }));
    }

    // ------- tablero (SPA estática, sin build)
    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      res.writeHead(200, { 'content-type': type });
      return res.end(await readFile(join(PUBLIC_DIR, file)));
    }

    // Fuentes self-hosteadas (opcional: soltar los .woff2 en public/fonts/).
    const fontMatch = path.match(/^\/fonts\/([\w-]+\.woff2)$/);
    if (req.method === 'GET' && fontMatch) {
      try {
        const buf = await readFile(join(PUBLIC_DIR, 'fonts', fontMatch[1]));
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
        return res.end(buf);
      } catch {
        return sendJson(res, 404, { error: 'fuente no encontrada' });
      }
    }

    if (req.method === 'GET' && path === '/api/state') return sendJson(res, 200, stateForDashboard());
    if (req.method === 'GET' && path === '/api/metrics') return sendJson(res, 200, metrics(db));

    // Vistas CRM: registro de encuestas + agregados por cliente y por tipo.
    // Un solo endpoint con el dataset completo; el filtrado es client-side
    // (volumen SMB — si crece a decenas de miles, pasa a filtros server-side).
    if (req.method === 'GET' && path === '/api/crm') {
      const cases = db.prepare(`
        SELECT k.*, s.id AS survey_id, j.ref AS job_ref
        FROM cases k JOIN surveys s ON s.id = k.survey_id JOIN jobs j ON j.id = s.job_id
      `).all();
      return sendJson(res, 200, {
        surveys: surveysList(db),
        clients: clientAggregates(db),
        by_type: typeAggregates(db),
        cases,
        activity: db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 200').all(),
        metrics: metrics(db),
      });
    }

    // ------- Etapa 1: hook de cierre de trabajo
    if (req.method === 'POST' && path === '/api/jobs/close') {
      const b = await readBody(req);
      const ref = (b.ref || '').trim();
      const clientName = (b.client_name || '').trim();
      if (!ref || !clientName)
        return sendJson(res, 400, { error: 'ref y client_name son obligatorios' });
      const result = await closeJob({
        ref,
        type: (b.type || '').trim(),
        clientName,
        clientEmail: b.client_email,
        clientPhone: b.client_phone,
      });
      if (result.duplicated) return sendJson(res, 409, { error: 'trabajo ya cerrado' });
      const s = getSurvey(result.survey.id);
      return sendJson(res, 201, {
        survey_id: s.id,
        survey_url: `${BASE_URL}/s/${s.token}`,
        status: s.status,
        channel: s.channel,
      });
    }

    // ------- Etapa 3: rescate de contacto faltante (queda guardado)
    let m = path.match(/^\/api\/surveys\/(\d+)\/contact$/);
    if (req.method === 'POST' && m) {
      const survey = getSurvey(m[1]);
      const b = await readBody(req);
      const email = (b.email || '').trim();
      const phone = normalizePhone(b.phone);
      if (!survey || survey.status !== 'pending_contact')
        return sendJson(res, 400, { error: 'encuesta inválida' });
      if (!email && !phone)
        return sendJson(res, 400, { error: 'hace falta email o teléfono' });

      const client = getClient(survey.client_id);
      db.prepare('UPDATE clients SET email = coalesce(?, email), phone = coalesce(?, phone) WHERE id = ?')
        .run(email || null, phone, client.id);
      const channel = channelFor(getClient(client.id));
      // Ya esperó bastante: sale ahora, sin delay extra.
      db.prepare("UPDATE surveys SET channel = ?, status = 'scheduled', scheduled_at = datetime('now') WHERE id = ?")
        .run(channel, survey.id);
      await dispatchDue(db, sendSurvey);
      const s = getSurvey(survey.id);
      return sendJson(res, 200, { status: s.status, channel: s.channel });
    }

    // ------- WhatsApp tap-to-send: marca y redirige a wa.me (sin API de Meta)
    m = path.match(/^\/wa\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const survey = getSurvey(m[1]);
      if (!survey || survey.channel !== 'whatsapp')
        return sendHtml(res, 404, publicPage('Error', '<p>Encuesta no encontrada.</p>'));
      if (survey.status === 'ready') {
        const link = surveyWaLink(survey, 'initial');
        await sendSurvey(survey, 'initial');
        return redirect(res, link);
      }
      if (survey.status === 'sent' && survey.resend_count === 0) {
        const link = surveyWaLink(survey, 'reminder');
        await sendSurvey(survey, 'reminder');
        return redirect(res, link);
      }
      return sendHtml(res, 409, publicPage('Límite', '<p>Esta encuesta ya se envió (máximo 1 reenvío).</p>'));
    }

    // ------- Reenvío manual por canal automático (máximo 1)
    m = path.match(/^\/api\/surveys\/(\d+)\/resend$/);
    if (req.method === 'POST' && m) {
      const survey = getSurvey(m[1]);
      if (!survey || survey.status !== 'sent')
        return sendJson(res, 400, { error: 'encuesta inválida' });
      if (survey.resend_count >= 1)
        return sendJson(res, 409, { error: 'ya se reenvió una vez (la regla es 1 y cortar)' });
      if (!canAutoSend(survey.channel))
        return sendJson(res, 400, { error: 'canal sin vía automática: usá el botón de WhatsApp' });
      await sendSurvey(survey, 'reminder');
      return sendJson(res, 200, { ok: true });
    }

    // ------- Casos de insatisfechos: estado + notas
    m = path.match(/^\/api\/cases\/(\d+)$/);
    if (req.method === 'POST' && m) {
      const kase = db.prepare('SELECT * FROM cases WHERE id = ?').get(Number(m[1]));
      if (!kase) return sendJson(res, 404, { error: 'caso no encontrado' });
      const b = await readBody(req);
      if (b.status && !['abierto', 'en_tratamiento', 'resuelto'].includes(b.status))
        return sendJson(res, 400, { error: 'estado inválido' });

      const status = b.status || kase.status;
      const notes = b.notes !== undefined ? String(b.notes).slice(0, 2000) : kase.notes;
      db.prepare(`
        UPDATE cases SET status = ?, notes = ?,
          resolved_at = CASE WHEN ? = 'resuelto' AND resolved_at IS NULL THEN datetime('now') ELSE resolved_at END
        WHERE id = ?
      `).run(status, notes, status, kase.id);

      // Al resolver: agradecimiento al cliente con foco en la resolución.
      let waResolution = null;
      if (status === 'resuelto' && kase.status !== 'resuelto') {
        const client = getClient(kase.client_id);
        const survey = getSurvey(kase.survey_id);
        const job = getJob(survey.job_id);
        const channel = channelFor(client) || 'email';
        const msg = resolutionMessage(client, job);
        await deliver(db, {
          surveyId: survey.id,
          kind: 'resolution',
          channel,
          recipient: channel === 'email' ? client.email : client.phone,
          ...msg,
        });
        if (channel === 'whatsapp' && !hasWhatsAppGateway())
          waResolution = waLink(client.phone, msg.body);
      }
      return sendJson(res, 200, { ok: true, wa_link: waResolution });
    }

    // ------- Etapa 4: encuesta pública (1 pregunta, 3 botones, sin login)
    m = path.match(/^\/s\/([a-f0-9]{32})$/);
    if (m) {
      const survey = db.prepare('SELECT * FROM surveys WHERE token = ?').get(m[1]);
      if (!survey) return sendHtml(res, 404, publicPage('No encontrada', '<p>Encuesta no encontrada.</p>'));
      if (req.method === 'GET') {
        if (survey.status === 'responded')
          return sendHtml(res, 200, thanksPageHtml({ already: true, rating: survey.rating }));
        return sendHtml(res, 200, surveyPageHtml(survey, getJob(survey.job_id)));
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (!['insatisfecho', 'bueno', 'excelente'].includes(b.rating))
          return sendHtml(res, 400, publicPage('Error', '<p>Respuesta inválida.</p>'));
        const result = await recordResponse(m[1], b.rating);
        return sendHtml(res, 200, thanksPageHtml({
          already: result.already,
          rating: result.survey.rating,
        }));
      }
    }

    sendJson(res, 404, { error: 'no encontrado' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'error interno' });
  }
});

startScheduler(db, { sendSurvey, sendFollowup });

server.listen(PORT, () => {
  console.log(`Máquina de Encuestas corriendo en ${BASE_URL}`);
  console.log(`  envío diferido: ${DELAY_SECONDS / 60} min · gateway WhatsApp: ${hasWhatsAppGateway() ? 'sí' : 'modo tap-to-send'}`);
  if (!ADMIN_PASS) console.warn('  ADVERTENCIA: sin ADMIN_PASS el tablero queda abierto (solo para desarrollo)');
});
