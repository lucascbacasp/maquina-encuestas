// Smoke test end-to-end contra el server real.
//   node --test test.js
//
// Server A (:3777): envío inmediato — flujos de negocio.
// Server B (:3778): tiempos acelerados — scheduler (diferido, recordatorio,
// seguimiento de casos).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const A = 'http://localhost:3777';
const B = 'http://localhost:3778';
const C = 'http://localhost:3779';
const DBS = ['test-a.db', 'test-b.db', 'test-c.db'];
const REVIEW_URL = 'https://g.page/r/test-review';
const servers = [];

function startServer(port, dbPath, env) {
  const proc = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT: port, DB_PATH: dbPath,
      SEND_WEBHOOK_URL: '', WHATSAPP_WEBHOOK_URL: '', ALERT_WEBHOOK_URL: '',
      ...env,
    },
    stdio: 'ignore',
  });
  servers.push(proc);
  return proc;
}

async function waitUp(base) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/metrics'); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`no levantó ${base}`);
}

async function poll(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('poll timeout');
}

const state = (base) => fetch(base + '/api/state').then((r) => r.json());
const closeJob = (base, body) =>
  fetch(base + '/api/jobs/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const post = (base, path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
const respond = (surveyUrl, rating) =>
  fetch(surveyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `rating=${rating}`,
  });

before(async () => {
  for (const f of DBS.flatMap((d) => [d, `${d}-wal`, `${d}-shm`])) rmSync(f, { force: true });
  startServer(3777, 'test-a.db', {
    SEND_DELAY_MINUTES: '0', AUTO_REMINDER_HOURS: '0', TICK_MS: '100000',
    GOOGLE_REVIEW_URL: REVIEW_URL,
  });
  startServer(3778, 'test-b.db', {
    SEND_DELAY_MINUTES: '0.03',        // ~2s de envío diferido
    AUTO_REMINDER_HOURS: '0.0008',     // recordatorio ~3s después del envío
    CASE_FOLLOWUP_DAYS: '0.00003',     // seguimiento ~2.6s después de abrir caso
    TICK_MS: '300',
  });
  startServer(3779, 'test-c.db', {
    SEND_DELAY_MINUTES: '0', AUTO_REMINDER_HOURS: '0', TICK_MS: '100000',
    ADMIN_PASS: 'secreta123', OPERATOR_USER: 'operador', OPERATOR_PASS: 'op456', DEMO_SEED: '1',
  });
  await Promise.all([waitUp(A), waitUp(B), waitUp(C)]);
});

after(() => {
  for (const p of servers) p.kill();
  for (const f of DBS.flatMap((d) => [d, `${d}-wal`, `${d}-shm`])) rmSync(f, { force: true });
});

// --------------------------------------------------------- flujos (server A)

test('cierre con email envía automático de inmediato (delay 0)', async () => {
  const res = await closeJob(A, { ref: 'A-1', type: 'plomería', client_name: 'Ana', client_email: 'ana@x.com' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.status, 'sent');
  assert.equal(body.channel, 'email');
  assert.match(body.survey_url, /\/s\/[a-f0-9]{32}$/);
});

test('cierre duplicado devuelve 409', async () => {
  assert.equal((await closeJob(A, { ref: 'A-1', client_name: 'Ana' })).status, 409);
});

test('whatsapp sin gateway: queda ready; el POST marca y devuelve wa.me', async () => {
  const res = await closeJob(A, { ref: 'A-2', client_name: 'Beto', client_phone: '+54 9 11 2233-4455' });
  const body = await res.json();
  assert.equal(body.channel, 'whatsapp');
  assert.equal(body.status, 'ready');

  const s = await state(A);
  const item = s.ready.find((r) => r.job_ref === 'A-2');
  assert.equal(item.client_phone, '5491122334455');

  // El GET /wa ya no existe (marcaba "enviada" ante cualquier prefetch).
  assert.equal((await fetch(`${A}/wa/${item.id}`)).status, 404);
  const still = await state(A);
  assert.ok(still.ready.some((r) => r.id === item.id), 'un GET no debe marcar nada');

  // Tap real = POST: marca y devuelve el link wa.me con la encuesta.
  const tap = await post(A, `/api/surveys/${item.id}/wa`);
  assert.equal(tap.status, 200);
  const { wa_link } = await tap.json();
  assert.match(wa_link, /^https:\/\/wa\.me\/5491122334455\?text=/);
  assert.match(decodeURIComponent(wa_link), /\/s\/[a-f0-9]{32}/);

  // Quedó enviada; segundo POST = recordatorio; tercero = límite.
  const tap2 = await post(A, `/api/surveys/${item.id}/wa`);
  assert.equal(tap2.status, 200);
  const tap3 = await post(A, `/api/surveys/${item.id}/wa`);
  assert.equal(tap3.status, 409);
});

test('encuesta pública: token inválido muestra página amigable, nunca JSON de auth', async () => {
  for (const p of ['/s/idquenoexiste12345', '/s/x', '/s/' + 'a'.repeat(32)]) {
    const res = await fetch(A + p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers.get('content-type'), /text\/html/, p);
    const html = await res.text();
    assert.match(html, /[Nn]o encontramos esta encuesta|no encontrada/i, p);
    assert.doesNotMatch(html, /autenticación requerida/, p);
  }
  // También con auth activada (server C) el link roto es página pública amigable.
  const resC = await fetch(`${C}/s/idquenoexiste12345`);
  assert.equal(resC.status, 404);
  assert.match(resC.headers.get('content-type'), /text\/html/);
});

test('respuesta excelente muestra CTA de reseña de Google', async () => {
  const res = await closeJob(A, { ref: 'A-3', client_name: 'Caro', client_email: 'caro@x.com' });
  const { survey_url } = await res.json();
  const html = await (await respond(survey_url, 'excelente')).text();
  assert.match(html, /Gracias/);
  assert.ok(html.includes(REVIEW_URL), 'falta el link de reseña');
});

test('insatisfecho abre caso + alerta; el caso se trata y resuelve', async () => {
  const res = await closeJob(A, { ref: 'A-4', client_name: 'Dario', client_email: 'dario@x.com' });
  const { survey_url } = await res.json();
  await respond(survey_url, 'insatisfecho');

  let s = await state(A);
  const kase = s.cases.find((k) => k.job_ref === 'A-4');
  assert.equal(kase.status, 'abierto');
  assert.ok(s.activity.some((a) => a.kind === 'alert' && a.subject.includes('Dario')));
  assert.equal(s.metrics.casos_abiertos >= 1, true);

  // Idempotencia de la respuesta: la primera gana.
  const again = await respond(survey_url, 'excelente');
  assert.match(await again.text(), /Ya habíamos registrado/);

  await post(A, `/api/cases/${kase.id}`, { status: 'en_tratamiento', notes: 'lo llamé' });
  const r2 = await post(A, `/api/cases/${kase.id}`, { status: 'resuelto' });
  assert.equal((await r2.json()).ok, true);

  s = await state(A);
  const resolved = s.cases.find((k) => k.id === kase.id);
  assert.equal(resolved.status, 'resuelto');
  assert.ok(resolved.resolved_at);
  assert.equal(resolved.notes, 'lo llamé');
  // Agradecimiento post-resolución al cliente.
  assert.ok(s.activity.some((a) => a.kind === 'resolution' && a.recipient === 'dario@x.com'));
});

test('sin contacto: rescate lo envía y queda en memoria para el próximo', async () => {
  await closeJob(A, { ref: 'A-5', client_name: 'Elsa' });
  let s = await state(A);
  const item = s.pending_contact.find((r) => r.job_ref === 'A-5');
  assert.ok(item);

  const r = await post(A, `/api/surveys/${item.id}/contact`, { email: 'elsa@x.com' });
  assert.equal((await r.json()).status, 'sent');

  // Memoria de contactos: el próximo trabajo de Elsa sale solo.
  const next = await (await closeJob(A, { ref: 'A-6', client_name: 'Elsa' })).json();
  assert.equal(next.status, 'sent');
});

test('reenvío manual por email: máximo 1', async () => {
  await closeJob(A, { ref: 'A-7', client_name: 'Fede', client_email: 'fede@x.com' });
  const s = await state(A);
  const item = s.unanswered.find((r) => r.job_ref === 'A-7');
  assert.equal(item.can_auto, true);
  assert.equal((await post(A, `/api/surveys/${item.id}/resend`)).status, 200);
  assert.equal((await post(A, `/api/surveys/${item.id}/resend`)).status, 409);
});

test('clientes en riesgo: aparece con 2 insatisfechos', async () => {
  for (const ref of ['A-8', 'A-9']) {
    const { survey_url } = await (await closeJob(A, { ref, client_name: 'Gina', client_email: 'gina@x.com' })).json();
    await respond(survey_url, 'insatisfecho');
  }
  const s = await state(A);
  const risk = s.at_risk.find((c) => c.name === 'Gina');
  assert.equal(risk.insatisfechos, 2);
});

test('CRM: registro con IDs legibles y agregados por cliente y tipo', async () => {
  const crm = await (await fetch(`${A}/api/crm`)).json();

  // Toda encuesta tiene código citable ENC-nnnn.
  assert.ok(crm.surveys.length >= 9);
  for (const s of crm.surveys) assert.match(s.code, /^ENC-\d{4}$/);

  // Agregados por cliente: Gina tiene 2 encuestas, 2 respondidas, 2 insatisfechos.
  const gina = crm.clients.find((c) => c.name === 'Gina');
  assert.equal(gina.encuestas, 2);
  assert.equal(gina.respondidas, 2);
  assert.equal(gina.insatisfecho, 2);

  // Agregados por tipo: A-1 fue el único trabajo de plomería.
  const plomeria = crm.by_type.find((t) => t.type === 'plomería');
  assert.equal(plomeria.encuestas, 1);
  const sinTipo = crm.by_type.find((t) => t.type === '(sin tipo)');
  assert.ok(sinTipo.encuestas >= 1);

  // Los casos y la actividad vienen para armar la timeline del cliente.
  assert.ok(crm.cases.length >= 1);
  assert.ok(crm.activity.length >= 1);
  assert.ok(crm.metrics.total >= 9);
});

// ------------------------------------- auth + seed de demo (server C)

test('auth: tablero y API protegidos, encuesta del cliente pública', async () => {
  // Sin credenciales: 401 en API y wa; /app redirige a la landing.
  for (const p of ['/api/state', '/api/crm', '/wa/1']) {
    assert.equal((await fetch(C + p)).status, 401, `${p} debería pedir auth`);
  }
  const appRedirect = await fetch(`${C}/app`, { redirect: 'manual' });
  assert.equal(appRedirect.status, 302);
  assert.equal(appRedirect.headers.get('location'), '/');
  // Landing pública con la caja de login; /healthz siempre público.
  const landing = await (await fetch(C + '/')).text();
  assert.match(landing, /sistema automático de encuestas/);
  assert.match(landing, /id="login"/);
  assert.equal((await fetch(`${C}/healthz`)).status, 200);

  // Con credenciales: pasa.
  const auth = { authorization: 'Basic ' + Buffer.from('admin:secreta123').toString('base64') };
  const state = await (await fetch(`${C}/api/state`, { headers: auth })).json();
  assert.ok(state.metrics);

  // La encuesta del cliente final NO pide login jamás. El token no viaja
  // por la API (correcto): lo sacamos directo de la base de test.
  const crm = await (await fetch(`${C}/api/crm`, { headers: auth })).json();
  const sent = crm.surveys.find((s) => s.status === 'sent');
  const { DatabaseSync } = await import('node:sqlite');
  const cdb = new DatabaseSync('test-c.db');
  const tok = cdb.prepare('SELECT token FROM surveys WHERE id = ?').get(sent.id).token;
  cdb.close();
  assert.equal((await fetch(`${C}/s/${tok}`)).status, 200);
});

test('seed de demo: DEMO_SEED=1 puebla encuestas de prueba al arrancar', async () => {
  const auth = { authorization: 'Basic ' + Buffer.from('admin:secreta123').toString('base64') };
  const m = await (await fetch(`${C}/api/metrics`, { headers: auth })).json();
  assert.ok(m.total >= 14, `esperaba >=14 encuestas seed, hay ${m.total}`);
  assert.ok(m.respondidas >= 10);
  assert.ok(m.desglose.insatisfecho >= 2);

  const crm = await (await fetch(`${C}/api/crm`, { headers: auth })).json();
  assert.ok(crm.cases.some((k) => k.status === 'abierto'));
  assert.ok(crm.cases.some((k) => k.status === 'resuelto'));
  assert.ok(crm.by_type.length >= 3, 'seed cubre varios tipos de servicio');
  // Cliente en riesgo (2 insatisfechos del mismo cliente).
  assert.ok(crm.clients.some((c) => c.insatisfecho >= 2));
});

test('roles: operador opera; las vistas globales son solo del gerente', async () => {
  const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
  const gerente = basic('admin', 'secreta123');
  const operador = basic('operador', 'op456');

  // Credenciales inválidas: 401.
  assert.equal((await fetch(`${C}/api/state`, { headers: basic('x', 'y') })).status, 401);

  // El server informa el rol de cada credencial.
  const sG = await (await fetch(`${C}/api/state`, { headers: gerente })).json();
  assert.equal(sG.config.role, 'gerente');
  const sO = await (await fetch(`${C}/api/state`, { headers: operador })).json();
  assert.equal(sO.config.role, 'operador');

  // El operador dispara encuestas (su función central).
  const close = await fetch(`${C}/api/jobs/close`, {
    method: 'POST',
    headers: { ...operador, 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'C-OP-1', type: 'plomería', client_name: 'Op Cliente', client_email: 'op@x.com' }),
  });
  assert.equal(close.status, 201);

  // Vistas globales de empresa: 403 para operador, 200 para gerente.
  assert.equal((await fetch(`${C}/api/crm`, { headers: operador })).status, 403);
  assert.equal((await fetch(`${C}/api/selftest`, { headers: operador })).status, 403);
  assert.equal((await fetch(`${C}/api/crm`, { headers: gerente })).status, 200);
});

test('login: la caja de la landing crea sesión por cookie y respeta roles', async () => {
  // Credenciales malas: 401.
  const bad = await fetch(`${C}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'nope' }),
  });
  assert.equal(bad.status, 401);

  // Login de operador: cookie de sesión que funciona sin Basic Auth.
  const login = await fetch(`${C}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'operador', pass: 'op456' }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).role, 'operador');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^sesion=operador\./);

  const state = await (await fetch(`${C}/api/state`, { headers: { cookie } })).json();
  assert.equal(state.config.role, 'operador');
  assert.equal((await fetch(`${C}/api/crm`, { headers: { cookie } })).status, 403);
  assert.equal((await fetch(`${C}/app`, { headers: { cookie }, redirect: 'manual' })).status, 200);

  // Con sesión activa, '/' redirige directo al tablero.
  const home = await fetch(C + '/', { headers: { cookie }, redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/app');

  // Una cookie adulterada no vale.
  const forged = cookie.replace('operador', 'gerente\u002e').split('.').slice(0, 2).join('.') + '.abc';
  assert.equal((await fetch(`${C}/api/state`, { headers: { cookie: forged } })).status, 401);

  // Logout: la cookie queda vencida.
  const out = await fetch(`${C}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('cache: HTML y API no-store; assets del tablero revalidan siempre', async () => {
  assert.equal((await fetch(C + '/')).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${C}/api/state`)).headers.get('cache-control'), 'no-store');
  const basic = { authorization: 'Basic ' + Buffer.from('admin:secreta123').toString('base64') };
  assert.equal((await fetch(`${C}/app`, { headers: basic })).headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${C}/app.js`)).headers.get('cache-control'), 'no-cache');
});

test('CSAT: el gerente crea la encuesta, obtiene el link y la respuesta mapea', async () => {
  const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
  const gerente = basic('admin', 'secreta123');
  const operador = basic('operador', 'op456');

  // Crear encuestas es función del gerente.
  const denied = await fetch(`${C}/api/surveys`, {
    method: 'POST', headers: { ...operador, 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'X', format: 'csat' }),
  });
  assert.equal(denied.status, 403);

  const created = await fetch(`${C}/api/surveys`, {
    method: 'POST', headers: { ...gerente, 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Link Cliente', client_phone: '5491199887766', type: 'post-obra', format: 'csat' }),
  });
  assert.equal(created.status, 201);
  const r = await created.json();
  assert.match(r.code, /^ENC-\d{4}$/);
  assert.match(r.survey_url, /\/s\/[a-f0-9]{32}$/);
  assert.match(r.wa_link, /^https:\/\/wa\.me\/5491199887766/);
  assert.equal(r.format, 'csat');

  // La página pública muestra la escala 1-5.
  const page = await (await fetch(r.survey_url)).text();
  assert.match(page, /satisfecho quedaste/);
  assert.match(page, /Muy satisfecho/);
  assert.match(page, /name="score"/);

  // Puntaje inválido: 400. Puntaje 2: registra, mapea a insatisfecho y abre caso.
  const bad = await fetch(r.survey_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'score=9',
  });
  assert.equal(bad.status, 400);
  const answer = await fetch(r.survey_url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'score=2',
  });
  assert.match(await answer.text(), /Gracias/);

  const crm = await (await fetch(`${C}/api/crm`, { headers: gerente })).json();
  const s = crm.surveys.find((x) => x.id === r.survey_id);
  assert.equal(s.format, 'csat');
  assert.equal(Number(s.score), 2);
  assert.equal(s.rating, 'insatisfecho');
  assert.ok(crm.cases.some((k) => k.survey_id === r.survey_id), 'CSAT <= 2 abre caso');
  // La alerta incluye el puntaje exacto.
  assert.ok(crm.activity.some((a) => a.kind === 'alert' && a.body.includes('CSAT 2/5')));
});

// ------------------------------------------------- scheduler (server B)

test('scheduler: diferido → enviada → recordatorio → caso → seguimiento', async () => {
  const res = await closeJob(B, { ref: 'B-1', client_name: 'Hugo', client_email: 'hugo@x.com' });
  const body = await res.json();
  assert.equal(body.status, 'scheduled', 'con delay > 0 queda programada');

  // 1. El scheduler la envía cuando vence el diferido.
  await poll(async () => {
    const s = await state(B);
    return s.unanswered.some((r) => r.job_ref === 'B-1');
  });

  // 2. Sin respuesta, dispara el recordatorio automático (máx. 1).
  await poll(async () => {
    const s = await state(B);
    return s.activity.some((a) => a.kind === 'reminder' && a.recipient === 'hugo@x.com');
  });

  // 3. Responde insatisfecho → caso; el scheduler manda el seguimiento al dueño.
  await respond(body.survey_url, 'insatisfecho');
  await poll(async () => {
    const s = await state(B);
    return s.activity.some((a) => a.kind === 'followup' && a.subject.includes('Hugo'));
  });
});
