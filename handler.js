// Handler HTTP compartido: toda la lógica de negocio y las rutas, sin
// atarse ni al runtime (node:http local o función serverless en Vercel)
// ni al backend de datos (store SQLite o Supabase).
//
// Env: BASE_URL, SEND_DELAY_MINUTES, AUTO_REMINDER_HOURS, CASE_FOLLOWUP_DAYS,
//      GOOGLE_REVIEW_URL, OWNER_CONTACT, ADMIN_USER, ADMIN_PASS, DEMO_SEED,
//      CRON_SECRET, SEND_WEBHOOK_URL, WHATSAPP_WEBHOOK_URL, ALERT_WEBHOOK_URL

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, createHash } from 'node:crypto';
import {
  deliver, waLink, hasWhatsAppGateway,
  surveyMessage, alertMessage, followupMessage, resolutionMessage,
} from './notify.js';
import { dispatchDue, canAutoSend, tickOnce } from './scheduler.js';
import {
  newToken, nowIso, isoPlus, normalizePhone, channelFor, surveyCode, computeMetrics,
} from './util.js';
import { seedDemo } from './seed.js';

// OJO: la carpeta se llama ui/ (no public/) a propósito — Vercel sirve un
// public/ raíz como estáticos en '/', pisando las rutas de la función
// (nos tapó la landing en producción). Todo asset pasa por el handler.
const PUBLIC_DIR = join(import.meta.dirname, 'ui');

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

// HTML y JSON dependen de la sesión: jamás se cachean (un frontend viejo
// cacheado polleando con código viejo fue un bug real en producción).
const sendHtml = (res, status, html) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
};
const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
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
    font-family: 'Segoe UI Variable Display', 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif;
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

// Escala CSAT clásica 1-5. El puntaje se guarda exacto y se mapea a los
// buckets del sistema: 1-2 insatisfecho (alerta + caso), 3 bueno, 4-5 excelente.
const CSAT = [
  ['1', '😠 Muy insatisfecho'],
  ['2', '🙁 Insatisfecho'],
  ['3', '😐 Neutral'],
  ['4', '🙂 Satisfecho'],
  ['5', '🤩 Muy satisfecho'],
];

export const csatToRating = (score) =>
  score <= 2 ? 'insatisfecho' : score === 3 ? 'bueno' : 'excelente';

function surveyPageHtml(survey, job) {
  const isCsat = survey.format === 'csat';
  const options = isCsat ? CSAT : RATINGS;
  const field = isCsat ? 'score' : 'rating';
  return publicPage('¿Cómo salió el trabajo?', `
  <h1>${isCsat
    ? `¿Qué tan satisfecho quedaste con el ${job.type ? esc(job.type) : 'servicio'}?`
    : `¿Cómo salió el trabajo${job.type ? ` de ${esc(job.type)}` : ''}?`}</h1>
  <p class="muted">Un solo toque y listo. Sin registrarse.</p>
  <div class="btns">
    ${options.map(([value, label]) => `
      <form method="post" action="/s/${esc(survey.token)}">
        <input type="hidden" name="${field}" value="${value}">
        <button>${label}</button>
      </form>`).join('')}
  </div>`);
}

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

// Landing pública: mínima explicación + caja de login (gerente u operador).
function landingPage() {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Tu sistema automático de encuestas post-servicio: cada trabajo terminado dispara una encuesta de una pregunta.">
<title>Máquina de Encuestas</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232a6fc4'/%3E%3Cpath d='M9 17l4.5 4.5L23 12' stroke='%23fff' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
  :root {
    color-scheme: light;
    --page: #f7f6f2; --surface: #fdfdfb; --raised: #ffffff; --ink: #1c1b18;
    --ink-2: #5f5c55; --muted: #8f8c83; --hairline: #e7e5de;
    --accent: #2a6fc4; --accent-ink: #fff; --crit: #c73a3a;
    --shadow: 0 1px 2px rgba(28,27,24,.04), 0 10px 28px -14px rgba(28,27,24,.10);
    --ring: 0 0 0 2px var(--page), 0 0 0 4px var(--accent);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --page: #131311; --surface: #1b1b18; --raised: #21211e; --ink: #f4f3ef;
      --ink-2: #b8b5ac; --muted: #8f8c83; --hairline: #2b2b27;
      --accent: #5b96e0; --accent-ink: #10131a; --crit: #d96666;
      --shadow: 0 1px 2px rgba(0,0,0,.25), 0 12px 32px -16px rgba(0,0,0,.45);
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI Variable Display', 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif;
    background: var(--page); color: var(--ink); margin: 0; line-height: 1.55;
    min-height: 100dvh; display: grid; place-items: center; padding: 2rem 1.2rem;
  }
  .wrap {
    display: grid; grid-template-columns: 1fr; gap: 2.5rem;
    max-width: 880px; width: 100%; align-items: center;
  }
  @media (min-width: 760px) { .wrap { grid-template-columns: 1.2fr 1fr; gap: 4rem; } }
  .mark { width: 44px; height: 44px; border-radius: 12px; background: var(--accent);
    display: grid; place-items: center; margin-bottom: 1.1rem; }
  .mark svg { width: 26px; height: 26px; }
  h1 { font-size: 1.9rem; font-weight: 650; letter-spacing: -0.025em; line-height: 1.12; margin: 0 0 .4rem; text-wrap: balance; }
  .sub { color: var(--ink-2); font-size: 1.05rem; margin: 0 0 1.6rem; max-width: 38ch; }
  ul.feats { list-style: none; padding: 0; margin: 0; display: grid; gap: .65rem; color: var(--ink-2); font-size: .93rem; }
  ul.feats li { display: flex; gap: .6rem; align-items: baseline; }
  ul.feats li::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 3px; background: var(--accent); transform: translateY(-1px); }
  .login {
    background: var(--surface); border-radius: 16px; box-shadow: var(--shadow);
    padding: 1.6rem 1.5rem; display: grid; gap: .8rem;
  }
  .login h2 { margin: 0 0 .2rem; font-size: 1.02rem; font-weight: 600; letter-spacing: -0.01em; }
  .login label { font-size: .82rem; font-weight: 550; color: var(--ink-2); display: grid; gap: .3rem; }
  .login input {
    font: inherit; color: var(--ink); background: var(--raised);
    border: 1px solid var(--hairline); border-radius: 9px; padding: .55rem .7rem;
    transition: border-color .18s ease;
  }
  .login input:hover { border-color: var(--accent); }
  .login button {
    font: inherit; font-weight: 600; cursor: pointer; margin-top: .3rem;
    background: var(--accent); color: var(--accent-ink); border: 1px solid var(--accent);
    border-radius: 9px; padding: .6rem; transition: filter .18s ease, transform .12s ease;
  }
  .login button:hover { filter: brightness(1.07); }
  .login button:active { transform: translateY(1px) scale(.99); }
  .hint { color: var(--muted); font-size: .8rem; margin: 0; }
  .error { color: var(--crit); font-size: .85rem; min-height: 1.2em; margin: 0; }
  :focus-visible { outline: none; box-shadow: var(--ring); border-radius: 6px; }
</style>
</head><body>
<div class="wrap">
  <section>
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 32 32"><path d="M6 17l6 6L26 9" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <h1>Máquina de Encuestas</h1>
    <p class="sub">Tu sistema automático de encuestas post-servicio.</p>
    <ul class="feats">
      <li>Cada trabajo terminado dispara una encuesta de una sola pregunta, por email o WhatsApp.</li>
      <li>El cliente responde con un toque, sin registrarse.</li>
      <li>Cada insatisfecho se convierte en una alerta y un caso para recuperarlo el mismo día.</li>
      <li>Resultados por tipo de servicio y por cliente, en un vistazo.</li>
    </ul>
  </section>
  <form class="login" id="login" autocomplete="on">
    <h2>Ingresar</h2>
    <label>Usuario
      <input name="user" autocomplete="username" placeholder="operador o admin" required>
    </label>
    <label>Clave
      <input name="pass" type="password" autocomplete="current-password" required>
    </label>
    <p class="error" id="error" role="alert"></p>
    <button>Entrar</button>
    <p class="hint">Operador: cierra trabajos y gestiona los envíos. Gerente: además ve el registro completo y los resultados de la empresa.</p>
  </form>
</div>
<script>
document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('error');
  err.textContent = '';
  const data = Object.fromEntries(new FormData(e.target));
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (res.ok) location.href = '/app';
  else err.textContent = 'Usuario o clave incorrectos.';
});
</script>
</body></html>`;
}

const STATIC = {
  '/app': ['index.html', 'text/html; charset=utf-8'],
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
  const OPERATOR_USER = process.env.OPERATOR_USER || 'operador';
  const OPERATOR_PASS = process.env.OPERATOR_PASS || '';
  const PUBLIC_ROUTES = /^\/($|s\/[a-f0-9]{32}$|fonts\/|healthz$|app\.js$|style\.css$|api\/login$)/;
  // Vistas globales de empresa: solo gerente (se aplica en el server).
  const MANAGER_ROUTES = new Set(['/api/crm', '/api/selftest', '/api/surveys']);

  // Sesión con cookie firmada (HMAC) — sin dependencias ni tabla de sesiones.
  // Rotar cualquiera de las claves invalida todas las sesiones.
  const SESSION_SECRET = process.env.SESSION_SECRET ||
    createHash('sha256').update(`mq-v1|${ADMIN_PASS}|${OPERATOR_PASS}`).digest('hex');
  const SESSION_DAYS = 7;
  const sign = (payload) => createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

  function sessionCookie(role) {
    const exp = Date.now() + SESSION_DAYS * 86_400_000;
    const payload = `${role}.${exp}`;
    const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
    return `sesion=${payload}.${sign(payload)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`;
  }

  function sessionRole(req) {
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('sesion='));
    if (!cookie) return null;
    const [role, exp, sig] = cookie.slice(7).split('.');
    if (!role || !exp || !sig) return null;
    if (sign(`${role}.${exp}`) !== sig) return null;
    if (Number(exp) < Date.now()) return null;
    return ['gerente', 'operador'].includes(role) ? role : null;
  }

  function credentialsRole(user, pass) {
    if (user === ADMIN_USER && pass === ADMIN_PASS) return 'gerente';
    if (OPERATOR_PASS && user === OPERATOR_USER && pass === OPERATOR_PASS) return 'operador';
    return null;
  }

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
  async function recordResponse(token, { rating, score }) {
    const survey = await store.surveyByToken(token);
    if (!survey) return { error: 'not_found' };
    if (survey.status === 'responded') return { survey, already: true };

    if (survey.format === 'csat') rating = csatToRating(score);
    await store.updateSurvey(survey.id, {
      status: 'responded', rating, score: score ?? null, responded_at: nowIso(),
    });
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
    format: r.format, score: r.score,
    resend_count: r.resend_count, scheduled_at: r.scheduled_at, sent_at: r.sent_at,
    responded_at: r.responded_at, client_name: r.client_name,
    client_email: r.client_email, client_phone: r.client_phone,
    job_ref: r.job_ref, job_type: r.job_type,
  });

  async function stateForDashboard(role) {
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
        role,
      },
    };
  }

  // ------------------------------------------------------------- auth

  // Rol del request: sesión (cookie del login) o Basic Auth (integraciones).
  function roleFor(req) {
    if (!ADMIN_PASS) return 'gerente'; // sin ADMIN_PASS no hay auth (modo dev)
    const fromSession = sessionRole(req);
    if (fromSession) return fromSession;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return null;
    const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return credentialsRole(user, rest.join(':'));
  }

  function isCronAuthorized(req, url) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      return req.headers.authorization === `Bearer ${secret}` ||
             url.searchParams.get('secret') === secret;
    }
    return roleFor(req) === 'gerente';
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

      // Landing pública con caja de login. Con sesión activa, directo al tablero.
      if (req.method === 'GET' && path === '/') {
        if (ADMIN_PASS && !sessionRole(req)) return sendHtml(res, 200, landingPage());
        return redirect(res, '/app');
      }

      if (req.method === 'POST' && path === '/api/login') {
        const b = await readBody(req);
        const role = ADMIN_PASS ? credentialsRole((b.user || '').trim(), b.pass || '') : 'gerente';
        if (!role) {
          await new Promise((r) => setTimeout(r, 350)); // frena fuerza bruta
          return sendJson(res, 401, { error: 'usuario o clave incorrectos' });
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': sessionCookie(role),
        });
        return res.end(JSON.stringify({ ok: true, role }));
      }

      if (req.method === 'POST' && path === '/api/logout') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'sesion=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      await ensureReady();

      // Cron externo (Vercel cron / cron-job.org / GitHub Actions).
      if (req.method === 'GET' && path === '/api/cron') {
        if (!isCronAuthorized(req, url)) return sendJson(res, 401, { error: 'no autorizado' });
        lastTick = Date.now();
        await tickOnce(store, actions);
        return sendJson(res, 200, { ok: true, ran_at: nowIso() });
      }

      const role = PUBLIC_ROUTES.test(path) ? null : roleFor(req);
      if (!PUBLIC_ROUTES.test(path) && !role) {
        if (path === '/app') return redirect(res, '/'); // a la landing con login
        return sendJson(res, 401, { error: 'autenticación requerida' });
      }
      if (MANAGER_ROUTES.has(path) && role !== 'gerente') {
        return sendJson(res, 403, { error: 'vista disponible solo para gerente' });
      }

      // ------- tablero (SPA estática, sin build)
      if (req.method === 'GET' && STATIC[path]) {
        const [file, type] = STATIC[path];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return res.end(await readFile(join(PUBLIC_DIR, file)));
      }

      // Fuentes self-hosteadas (opcional: soltar los .woff2 en ui/fonts/).
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
        return sendJson(res, 200, await stateForDashboard(role));
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

      // ------- Creación directa (gerente): encuesta simple o CSAT + link
      // No pasa por el envío diferido: nace enviada, con el link listo para
      // compartir. Si hay email, además sale por el canal automático.
      if (req.method === 'POST' && path === '/api/surveys') {
        const b = await readBody(req);
        const clientName = (b.client_name || '').trim();
        const format = b.format === 'csat' ? 'csat' : 'simple';
        if (!clientName) return sendJson(res, 400, { error: 'client_name es obligatorio' });

        const client = await upsertClient({ name: clientName, email: b.client_email, phone: b.client_phone });
        const job = await store.insertJob({
          ref: `DIR-${Date.now().toString(36).toUpperCase()}`,
          type: (b.type || '').trim() || null,
          client_id: client.id,
        });
        const channel = channelFor(client);
        const survey = await store.insertSurvey({
          job_id: job.id,
          client_id: client.id,
          token: newToken(),
          channel,
          format,
          status: 'sent',
          sent_at: nowIso(),
        });
        const msg = surveyMessage(BASE_URL, survey, client, job, 'initial');
        await deliver(store, {
          surveyId: survey.id,
          kind: 'initial',
          channel: channel ?? 'link',
          recipient: client.email || (client.phone ? `+${client.phone}` : 'link directo'),
          ...msg,
        });
        return sendJson(res, 201, {
          survey_id: survey.id,
          code: surveyCode(survey.id),
          survey_url: `${BASE_URL}/s/${survey.token}`,
          format,
          wa_link: client.phone ? waLink(client.phone, msg.body) : null,
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
          const score = Number(b.score);
          const valid = survey.format === 'csat'
            ? Number.isInteger(score) && score >= 1 && score <= 5
            : ['insatisfecho', 'bueno', 'excelente'].includes(b.rating);
          if (!valid)
            return sendHtml(res, 400, publicPage('Error', '<p>Respuesta inválida.</p>'));
          const result = await recordResponse(m[1], { rating: b.rating, score });
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
