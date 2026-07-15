// Handler HTTP compartido: toda la lógica de negocio y las rutas, sin
// atarse ni al runtime (node:http local o función serverless en Vercel)
// ni al backend de datos (store SQLite o Supabase).
//
// Env: BASE_URL, SEND_DELAY_MINUTES, AUTO_REMINDER_HOURS, CASE_FOLLOWUP_DAYS,
//      GOOGLE_REVIEW_URL, OWNER_CONTACT, ADMIN_USER, ADMIN_PASS, DEMO_SEED,
//      CRON_SECRET, SEND_WEBHOOK_URL, WHATSAPP_WEBHOOK_URL, ALERT_WEBHOOK_URL

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deliver, waLink, hasWhatsAppGateway,
  surveyMessage, alertMessage, followupMessage, resolutionMessage,
} from './notify.js';
import { dispatchDue, canAutoSend, tickOnce } from './scheduler.js';
import {
  newToken, nowIso, isoPlus, normalizePhone, channelFor, surveyCode, computeMetrics,
} from './util.js';
import { seedDemo } from './seed.js';

const PUBLIC_DIR = join(import.meta.dirname, 'public');

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

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

// =====================================================================

export function createApp(store) {
  const PORT = Number(process.env.PORT || 3000);
  const BASE_URL =
    process.env.BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${PORT}`;
  const DELAY_SECONDS = Math.round(Number(process.env.SEND_DELAY_MINUTES ?? 45) * 60);
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || '';
  const PUBLIC_ROUTES = /^\/(s\/[a-f0-9]{32}|fonts\/|healthz$)/;

  // ------------------------------------------------------------- flujo core

  async function sendSurvey(survey, kind) {
    const client = await store.clientById(survey.client_id);
    const job = await store.jobById(survey.job_id);
    const msg = surveyMessage(BASE_URL, survey, client, job, kind);
    const recipient = survey.channel === 'email' ? client.email : client.phone;
    await deliver(store, { surveyId: survey.id, kind, channel: survey.channel, recipient, ...msg });
    if (kind === 'initial') {
      if (['scheduled', 'ready'].includes(survey.status)) {
        await store.updateSurvey(survey.id, { status: 'sent', sent_at: nowIso() });
      }
    } else {
      await store.updateSurvey(survey.id, { resend_count: (survey.resend_count ?? 0) + 1 });
    }
  }

  async function sendFollowup(kase) {
    const client = await store.clientById(kase.client_id);
    const survey = await store.surveyById(kase.survey_id);
    const job = await store.jobById(survey.job_id);
    await deliver(store, {
      surveyId: survey.id,
      kind: 'followup',
      channel: 'interno',
      recipient: process.env.OWNER_CONTACT || 'dueño',
      ...followupMessage(kase, client, job),
    });
  }

  const actions = { sendSurvey, sendFollowup };

  // Cliente único por nombre; el contacto se completa, nunca se pisa.
  async function upsertClient({ name, email, phone }) {
    email = (email || '').trim() || null;
    phone = normalizePhone(phone);
    const existing = await store.clientByName(name);
    if (existing) {
      const merged = { email: email || existing.email, phone: phone || existing.phone };
      if (merged.email !== existing.email || merged.phone !== existing.phone) {
        await store.updateClient(existing.id, merged);
      }
      return { ...existing, ...merged };
    }
    return store.insertClient({ name: name.trim(), email, phone });
  }

  // Etapa 1: el cierre del trabajo dispara todo, sin pasos extra.
  async function closeJob({ ref, type, clientName, clientEmail, clientPhone }) {
    const client = await upsertClient({ name: clientName, email: clientEmail, phone: clientPhone });
    if (await store.jobByRef(ref)) return { duplicated: true };

    const job = await store.insertJob({ ref, type: type || null, client_id: client.id });
    const channel = channelFor(client);
    const survey = await store.insertSurvey({
      job_id: job.id,
      client_id: client.id,
      token: newToken(),
      channel,
      status: channel ? 'scheduled' : 'pending_contact',
      scheduled_at: channel ? isoPlus(DELAY_SECONDS) : null,
    });
    // Con delay 0 sale en este mismo request; con delay, la levanta el scheduler.
    await dispatchDue(store, sendSurvey);
    return { survey: await store.surveyById(survey.id) };
  }

  // Etapa 4: registrar respuesta. Idempotente: la primera respuesta gana.
  async function recordResponse(token, rating) {
    const survey = await store.surveyByToken(token);
    if (!survey) return { error: 'not_found' };
    if (survey.status === 'responded') return { survey, already: true };

    await store.updateSurvey(survey.id, { status: 'responded', rating, responded_at: nowIso() });
    const updated = await store.surveyById(survey.id);

    // Insatisfecho = alerta inmediata al dueño + caso abierto (recuperación).
    if (rating === 'insatisfecho') {
      await store.insertCaseIgnore({ survey_id: survey.id, client_id: survey.client_id });
      const client = await store.clientById(survey.client_id);
      const job = await store.jobById(survey.job_id);
      await deliver(store, {
        surveyId: survey.id,
        kind: 'alert',
        channel: 'interno',
        recipient: process.env.OWNER_CONTACT || 'dueño',
        ...alertMessage(updated, client, job),
      });
    }
    return { survey: updated };
  }

  // wa.me con el mensaje prearmado (modo tap-to-send, sin API de Meta).
  async function surveyWaLink(survey, kind) {
    const client = await store.clientById(survey.client_id);
    const job = await store.jobById(survey.job_id);
    const { body } = surveyMessage(BASE_URL, survey, client, job, kind);
    return waLink(client.phone, body);
  }

  // ----------------------------------------------------------- estado (API)

  async function metrics() {
    return computeMetrics(await store.metricsRaw());
  }

  const brief = (r) => ({
    id: r.id, code: surveyCode(r.id), status: r.status, channel: r.channel, rating: r.rating,
    resend_count: r.resend_count, scheduled_at: r.scheduled_at, sent_at: r.sent_at,
    responded_at: r.responded_at, client_name: r.client_name,
    client_email: r.client_email, client_phone: r.client_phone,
    job_ref: r.job_ref, job_type: r.job_type,
  });

  async function stateForDashboard() {
    const rows = await store.surveysJoined(200);
    return {
      metrics: await metrics(),
      at_risk: await store.atRisk(),
      cases: await store.casesJoined(),
      pending_contact: rows.filter((r) => r.status === 'pending_contact').map(brief),
      ready: rows.filter((r) => r.status === 'ready').map(brief),
      scheduled: rows.filter((r) => r.status === 'scheduled').map(brief),
      unanswered: rows.filter((r) => r.status === 'sent')
        .map((r) => ({ ...brief(r), can_auto: canAutoSend(r.channel) })),
      responded: rows.filter((r) => r.status === 'responded').slice(0, 20).map(brief),
      activity: await store.outboxList(15),
      config: {
        delay_minutes: DELAY_SECONDS / 60,
        wa_gateway: hasWhatsAppGateway(),
        google_review: Boolean(process.env.GOOGLE_REVIEW_URL),
        auto_reminder_hours: Number(process.env.AUTO_REMINDER_HOURS ?? 48),
      },
    };
  }

  // ------------------------------------------------------------- auth

  function isAuthorized(req) {
    if (!ADMIN_PASS) return true; // sin ADMIN_PASS no hay auth (modo dev)
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return user === ADMIN_USER && rest.join(':') === ADMIN_PASS;
  }

  function isCronAuthorized(req, url) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      return req.headers.authorization === `Bearer ${secret}` ||
             url.searchParams.get('secret') === secret;
    }
    return isAuthorized(req);
  }

  // --------------------------------------------- arranque perezoso + tick

  let ready = null;
  async function ensureReady() {
    ready ??= (async () => {
      if (process.env.DEMO_SEED === '1' && (await store.isEmpty())) {
        const n = await seedDemo(store);
        console.log(`[seed] base vacía: ${n} encuestas de demo cargadas`);
      }
    })();
    return ready;
  }

  // En serverless no hay intervalo: el tick corre acoplado a los requests
  // del tablero (como mucho una vez por minuto) y/o vía /api/cron.
  let lastTick = 0;
  async function lazyTick() {
    if (Date.now() - lastTick < 60_000) return;
    lastTick = Date.now();
    await tickOnce(store, actions);
  }

  // ------------------------------------------------------------------ rutas

  async function handle(req, res) {
    const url = new URL(req.url, BASE_URL);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true });

      await ensureReady();

      // Cron externo (Vercel cron / cron-job.org / GitHub Actions).
      if (req.method === 'GET' && path === '/api/cron') {
        if (!isCronAuthorized(req, url)) return sendJson(res, 401, { error: 'no autorizado' });
        lastTick = Date.now();
        await tickOnce(store, actions);
        return sendJson(res, 200, { ok: true, ran_at: nowIso() });
      }

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

      // Diagnóstico post-deploy: ejercita todos los paths de lectura del store.
      if (req.method === 'GET' && path === '/api/selftest') {
        const checks = {};
        checks.backend = store.kind;
        checks.metrics = await metrics();
        checks.surveys = (await store.surveysJoined(5)).length;
        checks.cases = (await store.casesJoined()).length;
        checks.by_type = (await store.typeAggregates()).length;
        checks.clients = (await store.clientAggregates()).length;
        checks.at_risk = (await store.atRisk()).length;
        checks.activity = (await store.outboxList(3)).length;
        return sendJson(res, 200, { ok: true, base_url: BASE_URL, ...checks });
      }

      if (req.method === 'GET' && path === '/api/state') {
        await lazyTick();
        return sendJson(res, 200, await stateForDashboard());
      }
      if (req.method === 'GET' && path === '/api/metrics') return sendJson(res, 200, await metrics());

      // Vistas CRM: registro + agregados en un solo call (filtrado client-side).
      if (req.method === 'GET' && path === '/api/crm') {
        await lazyTick();
        return sendJson(res, 200, {
          surveys: (await store.surveysJoined(2000)).map((r) => ({ ...r, code: surveyCode(r.id) })),
          clients: await store.clientAggregates(),
          by_type: await store.typeAggregates(),
          cases: await store.casesJoined(),
          activity: await store.outboxList(200),
          metrics: await metrics(),
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
        const s = result.survey;
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
        const survey = await store.surveyById(Number(m[1]));
        const b = await readBody(req);
        const email = (b.email || '').trim();
        const phone = normalizePhone(b.phone);
        if (!survey || survey.status !== 'pending_contact')
          return sendJson(res, 400, { error: 'encuesta inválida' });
        if (!email && !phone)
          return sendJson(res, 400, { error: 'hace falta email o teléfono' });

        const client = await store.clientById(survey.client_id);
        await store.updateClient(client.id, {
          email: email || client.email,
          phone: phone || client.phone,
        });
        const channel = channelFor(await store.clientById(client.id));
        // Ya esperó bastante: sale ahora, sin delay extra.
        await store.updateSurvey(survey.id, { channel, status: 'scheduled', scheduled_at: nowIso() });
        await dispatchDue(store, sendSurvey);
        const s = await store.surveyById(survey.id);
        return sendJson(res, 200, { status: s.status, channel: s.channel });
      }

      // ------- WhatsApp tap-to-send: marca y redirige a wa.me (sin API de Meta)
      m = path.match(/^\/wa\/(\d+)$/);
      if (req.method === 'GET' && m) {
        const survey = await store.surveyById(Number(m[1]));
        if (!survey || survey.channel !== 'whatsapp')
          return sendHtml(res, 404, publicPage('Error', '<p>Encuesta no encontrada.</p>'));
        if (survey.status === 'ready') {
          const link = await surveyWaLink(survey, 'initial');
          await sendSurvey(survey, 'initial');
          return redirect(res, link);
        }
        if (survey.status === 'sent' && survey.resend_count === 0) {
          const link = await surveyWaLink(survey, 'reminder');
          await sendSurvey(survey, 'reminder');
          return redirect(res, link);
        }
        return sendHtml(res, 409, publicPage('Límite', '<p>Esta encuesta ya se envió (máximo 1 reenvío).</p>'));
      }

      // ------- Reenvío manual por canal automático (máximo 1)
      m = path.match(/^\/api\/surveys\/(\d+)\/resend$/);
      if (req.method === 'POST' && m) {
        const survey = await store.surveyById(Number(m[1]));
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
        const kase = await store.caseById(Number(m[1]));
        if (!kase) return sendJson(res, 404, { error: 'caso no encontrado' });
        const b = await readBody(req);
        if (b.status && !['abierto', 'en_tratamiento', 'resuelto'].includes(b.status))
          return sendJson(res, 400, { error: 'estado inválido' });

        const status = b.status || kase.status;
        const notes = b.notes !== undefined ? String(b.notes).slice(0, 2000) : kase.notes;
        await store.updateCase(kase.id, {
          status,
          notes,
          resolved_at: status === 'resuelto' && !kase.resolved_at ? nowIso() : kase.resolved_at,
        });

        // Al resolver: agradecimiento al cliente con foco en la resolución.
        let waResolution = null;
        if (status === 'resuelto' && kase.status !== 'resuelto') {
          const client = await store.clientById(kase.client_id);
          const survey = await store.surveyById(kase.survey_id);
          const job = await store.jobById(survey.job_id);
          const channel = channelFor(client) || 'email';
          const msg = resolutionMessage(client, job);
          await deliver(store, {
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
        const survey = await store.surveyByToken(m[1]);
        if (!survey) return sendHtml(res, 404, publicPage('No encontrada', '<p>Encuesta no encontrada.</p>'));
        if (req.method === 'GET') {
          if (survey.status === 'responded')
            return sendHtml(res, 200, thanksPageHtml({ already: true, rating: survey.rating }));
          return sendHtml(res, 200, surveyPageHtml(survey, await store.jobById(survey.job_id)));
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
  }

  return { handle, actions, ensureReady, BASE_URL, DELAY_SECONDS, ADMIN_PASS };
}
