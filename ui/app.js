// Tablero — vanilla JS, sin build.
// Vistas: #operacion (colas de acción), #encuestas (registro CRM filtrable),
// #clientes / #cliente/<id> (agregados + ficha con timeline), #resultados
// (general, por tipo de servicio y por cliente).

const app = document.getElementById('app');
const configLine = document.getElementById('config-line');

let statePayload = null;  // /api/state  → operación
let crmPayload = null;    // /api/crm    → encuestas / clientes / resultados
let lastStateText = '';
let lastCrmText = '';
let role = null; // 'gerente' | 'operador' (lo informa /api/state)

// Filtros de la vista Encuestas (persisten entre renders).
const F = { status: '', type: '', q: '' };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (s) => {
  if (!s) return '—';
  // Acepta ISO 8601 (backends actuales) y el formato legado de SQLite.
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const contact = (r) => esc(r.client_email || r.email || ((r.client_phone || r.phone) ? `+${r.client_phone || r.phone}` : 'sin datos'));
const channelBadge = (ch) =>
  ch ? `<span class="badge"><i class="chip ${ch === 'email' ? 'accent' : 'good'}"></i>${ch}</span>` : '';

const STATUS_LABEL = {
  pending_contact: 'sin contacto', scheduled: 'programada', ready: 'lista (whatsapp)',
  sent: 'enviada', responded: 'respondida',
};
const RATING_CHIP = { insatisfecho: 'crit', bueno: 'warn', excelente: 'good' };
const ratingPill = (r, score) =>
  r ? `<span class="rating-pill ${r}"><i class="chip ${RATING_CHIP[r]}"></i>${score ? `CSAT ${score}/5` : r}</span>`
    : '<span class="muted">—</span>';

// Un 401 en cualquier llamada corta el polling y muestra la salida clara —
// jamás un skeleton infinito.
let sessionLost = false;
let pollTimer = null;

function sessionExpired() {
  if (sessionLost) return;
  sessionLost = true;
  clearInterval(pollTimer);
  configLine.textContent = '';
  app.innerHTML = `
    <div class="empty-state">
      <div class="mark" aria-hidden="true"></div>
      <h2 style="margin:.2rem 0 .3rem">Tu sesión expiró</h2>
      <p class="muted">Volvé a ingresar para seguir usando el tablero.</p>
      <p style="margin-top:1.1rem"><a href="/"><button class="primary">Ingresar de nuevo</button></a></p>
    </div>`;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

const miniDist = (i, b, e) => {
  const total = i + b + e;
  if (!total) return '<span class="muted">—</span>';
  const flex = (n) => Math.max((n / total) * 100, n ? 4 : 0);
  return `<div class="mini-dist" role="img" aria-label="${i} insatisfecho, ${b} bueno, ${e} excelente">
    ${i ? `<span style="flex:${flex(i)};background:var(--status-crit)"></span>` : ''}
    ${b ? `<span style="flex:${flex(b)};background:var(--status-warn)"></span>` : ''}
    ${e ? `<span style="flex:${flex(e)};background:var(--status-good)"></span>` : ''}
  </div>`;
};

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) { sessionExpired(); return {}; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) toast(data.error || 'No se pudo completar la acción.');
  return data;
}

document.getElementById('logout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
});

// ================================================================ Operación

function tiles(m) {
  const d = m.desglose;
  const total = d.insatisfecho + d.bueno + d.excelente;
  const flex = (n) => (total ? Math.max((n / total) * 100, n ? 3 : 0) : 0);
  return `
  <div class="tiles">
    <div class="tile"><b>${m.pct_enviadas}%</b><small>enviadas · ${m.enviadas} de ${m.total}</small></div>
    <div class="tile"><b>${m.pct_respondidas}%</b><small>respondidas · ${m.respondidas} de ${m.enviadas}</small></div>
    <div class="tile"><b>${m.pct_satisfaccion}%</b><small>satisfacción (bueno + excelente)</small></div>
    <div class="tile ${m.casos_abiertos ? 'crit' : ''}"><b>${m.casos_abiertos}</b><small>casos abiertos</small></div>
  </div>
  ${total ? `
  <div class="dist">
    <div class="dist-bar" role="img" aria-label="Desglose: ${d.insatisfecho} insatisfecho, ${d.bueno} bueno, ${d.excelente} excelente">
      ${d.insatisfecho ? `<span style="flex:${flex(d.insatisfecho)};background:var(--status-crit)"></span>` : ''}
      ${d.bueno ? `<span style="flex:${flex(d.bueno)};background:var(--status-warn)"></span>` : ''}
      ${d.excelente ? `<span style="flex:${flex(d.excelente)};background:var(--status-good)"></span>` : ''}
    </div>
    <div class="dist-legend">
      <span><i class="chip crit"></i>Insatisfecho · ${d.insatisfecho}</span>
      <span><i class="chip warn"></i>Bueno · ${d.bueno}</span>
      <span><i class="chip good"></i>Excelente · ${d.excelente}</span>
    </div>
  </div>` : ''}`;
}

function casesSection(cases) {
  if (!cases.length) return '';
  const open = cases.filter((k) => k.status !== 'resuelto');
  const resolved = cases.filter((k) => k.status === 'resuelto').slice(0, 5);
  const card = (k) => `
    <div class="card ${k.status === 'resuelto' ? 'case-resolved' : 'case-open'}">
      <a class="who" href="#cliente/${k.client_id}">${esc(k.client_name)}</a>
      <span class="badge">${esc(k.status.replace('_', ' '))}</span>
      <span class="muted">trabajo ${esc(k.job_ref)}${k.job_type ? ` · ${esc(k.job_type)}` : ''}
        · respondió ${fmt(k.responded_at)} · ${contact(k)}</span>
      ${k.status === 'resuelto' ? `<div class="muted">resuelto ${fmt(k.resolved_at)}</div>` : `
      <div class="row">
        <textarea data-case-notes="${k.id}" placeholder="Notas del caso…">${esc(k.notes)}</textarea>
      </div>
      <div class="row">
        ${k.status === 'abierto' ? `<button data-case="${k.id}" data-status="en_tratamiento">Pasar a en tratamiento</button>` : ''}
        <button class="primary" data-case="${k.id}" data-status="resuelto">Marcar resuelto</button>
        <button class="ghost" data-case="${k.id}" data-status="${k.status}">Guardar notas</button>
      </div>`}
    </div>`;
  return `<h2>Casos de insatisfechos${open.length ? ` (${open.length} abiertos — llamar hoy)` : ''}</h2>
    ${open.map(card).join('') || '<p class="empty">Sin casos abiertos.</p>'}
    ${resolved.length ? resolved.map(card).join('') : ''}`;
}

function readySection(ready) {
  if (!ready.length) return '';
  return `<h2>Para enviar por WhatsApp (un tap)</h2>
    <p class="muted">El botón abre WhatsApp con el mensaje y el link ya armados; solo tocás enviar.</p>
    ${ready.map((r) => `
    <div class="card">
      <span class="who">${esc(r.client_name)}</span> ${channelBadge(r.channel)}
      <span class="code">${esc(r.code)}</span>
      <span class="muted">trabajo ${esc(r.job_ref)} · +${esc(r.client_phone)}</span>
      <div class="row"><a class="wa" href="/wa/${r.id}" target="_blank" data-refresh>Enviar por WhatsApp →</a></div>
    </div>`).join('')}`;
}

function pendingSection(pending) {
  if (!pending.length) return '';
  return `<h2>Sin contacto — cargar para enviar</h2>
    <p class="muted">El dato queda guardado: el próximo trabajo de este cliente sale automático.</p>
    ${pending.map((r) => `
    <div class="card">
      <span class="who">${esc(r.client_name)}</span>
      <span class="code">${esc(r.code)}</span>
      <span class="muted">trabajo ${esc(r.job_ref)}</span>
      <form class="row" data-contact="${r.id}">
        <input name="email" type="email" placeholder="email@cliente.com">
        <input name="phone" type="tel" placeholder="WhatsApp ej: 5491122334455">
        <button class="primary">Guardar y enviar</button>
      </form>
    </div>`).join('')}`;
}

function unansweredSection(unanswered, cfg) {
  if (!unanswered.length) return '';
  return `<h2>Enviadas sin respuesta</h2>
    ${cfg.auto_reminder_hours > 0 ? `<p class="muted">Reenvío automático a las ${cfg.auto_reminder_hours} hs por los canales automáticos (máximo 1 y corta).</p>` : ''}
    <table><tr><th>ID</th><th>Cliente</th><th>Trabajo</th><th>Canal</th><th>Enviada</th><th></th></tr>
    ${unanswered.map((r) => `
      <tr><td class="code">${esc(r.code)}</td><td>${esc(r.client_name)}</td><td>${esc(r.job_ref)}</td>
      <td>${channelBadge(r.channel)}</td><td class="num">${fmt(r.sent_at)}</td>
      <td>${r.resend_count >= 1
        ? '<span class="muted">reenviada (límite: 1)</span>'
        : r.can_auto
          ? `<button data-resend="${r.id}">Reenviar</button>`
          : `<a class="wa" href="/wa/${r.id}" target="_blank" data-refresh>Reenviar por WhatsApp →</a>`
      }</td></tr>`).join('')}</table>`;
}

function scheduledSection(scheduled) {
  if (!scheduled.length) return '';
  return `<h2>Programadas (envío diferido)</h2>
    <table><tr><th>ID</th><th>Cliente</th><th>Trabajo</th><th>Canal</th><th>Sale</th></tr>
    ${scheduled.map((r) => `
      <tr><td class="code">${esc(r.code)}</td><td>${esc(r.client_name)}</td><td>${esc(r.job_ref)}</td>
      <td>${channelBadge(r.channel)}</td><td class="num">${fmt(r.scheduled_at)}</td></tr>`).join('')}</table>`;
}

function activitySection(activity) {
  if (!activity.length) return '';
  const KIND = {
    initial: 'encuesta', reminder: 'recordatorio', alert: 'alerta',
    followup: 'seguimiento', resolution: 'resolución',
  };
  const KCHIP = { initial: 'accent', reminder: 'mutedc', alert: 'crit', followup: 'warn', resolution: 'good' };
  return `<details class="activity"><summary>Actividad reciente (${activity.length})</summary>
    ${activity.map((a) => `
      <div class="activity-item"><i class="chip ${KCHIP[a.kind] || 'mutedc'}"></i><b>${KIND[a.kind] || a.kind}</b>
        <span class="muted">${esc(a.channel)} → ${esc(a.recipient)} · ${fmt(a.created_at)}</span><br>
        ${esc(a.subject)}</div>`).join('')}</details>`;
}

function closeJobSection() {
  return `<h2>Cerrar trabajo</h2>
    <p class="muted">En producción esto lo dispara tu sistema con <code>POST /api/jobs/close</code>.
    Si el cliente ya existe, no hace falta cargar el contacto de nuevo.</p>
    <form class="close-job card" id="close-job">
      <input name="ref" placeholder="Nro de trabajo" required>
      <input name="type" placeholder="Tipo (ej: plomería)">
      <input name="client_name" placeholder="Cliente" required>
      <input name="client_email" type="email" placeholder="Email (opcional)">
      <input name="client_phone" type="tel" placeholder="WhatsApp (opcional)">
      <button class="primary">Cerrar trabajo → disparar encuesta</button>
    </form>`;
}

function viewOperacion() {
  if (!statePayload) return '<p class="muted">Cargando…</p>';
  const s = statePayload;
  return [
    tiles(s.metrics),
    casesSection(s.cases),
    readySection(s.ready),
    pendingSection(s.pending_contact),
    unansweredSection(s.unanswered, s.config),
    scheduledSection(s.scheduled),
    activitySection(s.activity),
    closeJobSection(),
  ].join('');
}

// ================================================================ Encuestas

function filteredSurveys() {
  const q = F.q.trim().toLowerCase();
  return crmPayload.surveys.filter((s) => {
    if (F.status === 'enviadas' && !['sent', 'responded'].includes(s.status)) return false;
    if (F.status === 'respondidas' && s.status !== 'responded') return false;
    if (F.status === 'pendientes' && !['pending_contact', 'scheduled', 'ready'].includes(s.status)) return false;
    if (F.type && (s.job_type || '(sin tipo)') !== F.type) return false;
    if (q && ![s.code, s.client_name, s.job_ref, s.job_type].some((v) => (v || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

let lastCreated = null; // resultado del último "Crear encuesta"

function createSurveySection() {
  const r = lastCreated;
  return `
  <h2>Crear encuesta</h2>
  <p class="muted">Genera el link para mandarle al cliente por donde quieras.
  Formato Simple (3 opciones) o CSAT (escala 1 a 5).</p>
  <form class="close-job card" id="create-survey">
    <input name="client_name" placeholder="Cliente" required>
    <input name="client_email" type="email" placeholder="Email (opcional)">
    <input name="client_phone" type="tel" placeholder="WhatsApp (opcional)">
    <input name="type" placeholder="Motivo / servicio (opcional)">
    <select name="format" aria-label="Formato">
      <option value="simple">Simple — 3 opciones</option>
      <option value="csat">CSAT — escala 1 a 5</option>
    </select>
    <button class="primary">Crear encuesta → obtener link</button>
  </form>
  ${r ? `
  <div class="card" style="border-left:4px solid var(--accent)">
    <span class="who">${esc(r.code)}</span>
    <span class="badge">${r.format === 'csat' ? 'CSAT 1-5' : 'simple'}</span>
    <span class="muted">creada — mandale este link al cliente:</span>
    <div class="row">
      <input readonly value="${esc(r.survey_url)}" style="flex:1;min-width:220px" onclick="this.select()">
      <button data-copy="${esc(r.survey_url)}">Copiar link</button>
      ${r.wa_link ? `<a class="wa" href="${esc(r.wa_link)}" target="_blank">Enviar por WhatsApp →</a>` : ''}
    </div>
  </div>` : ''}`;
}

function viewEncuestas() {
  if (!crmPayload) return '<p class="muted">Cargando…</p>';
  const types = [...new Set(crmPayload.surveys.map((s) => s.job_type || '(sin tipo)'))].sort();
  const rows = filteredSurveys();
  return `
  ${createSurveySection()}
  <h2>Registro de encuestas</h2>
  <div class="filters">
    <select id="f-status" aria-label="Estado">
      <option value="">Todas</option>
      <option value="enviadas" ${F.status === 'enviadas' ? 'selected' : ''}>Enviadas</option>
      <option value="respondidas" ${F.status === 'respondidas' ? 'selected' : ''}>Respondidas</option>
      <option value="pendientes" ${F.status === 'pendientes' ? 'selected' : ''}>Pendientes de envío</option>
    </select>
    <select id="f-type" aria-label="Tipo de servicio">
      <option value="">Todos los tipos</option>
      ${types.map((t) => `<option value="${esc(t)}" ${F.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
    </select>
    <input id="f-q" type="search" placeholder="Buscar por ID, cliente o trabajo…" value="${esc(F.q)}">
    <button id="csv">Exportar CSV</button>
    <span class="count-note">${rows.length} de ${crmPayload.surveys.length}</span>
  </div>
  ${rows.length ? `
  <table>
    <tr><th>ID</th><th>Cliente</th><th>Trabajo</th><th>Tipo</th><th>Canal</th><th>Estado</th><th>Enviada</th><th>Respondida</th><th>Resultado</th><th></th></tr>
    ${rows.map((s) => `
    <tr class="clickable" data-goto="#cliente/${s.client_id}">
      <td class="code">${esc(s.code)}</td>
      <td>${esc(s.client_name)}</td>
      <td>${esc(s.job_ref)}</td>
      <td>${esc(s.job_type || '—')}</td>
      <td>${channelBadge(s.channel)}</td>
      <td><span class="badge">${STATUS_LABEL[s.status]}</span></td>
      <td class="num">${fmt(s.sent_at)}</td>
      <td class="num">${fmt(s.responded_at)}</td>
      <td>${ratingPill(s.rating, s.score)}</td>
      <td><a href="#encuesta/${s.id}" class="code" onclick="event.stopPropagation()">ver →</a></td>
    </tr>`).join('')}
  </table>
  <p class="muted">Click en la fila abre la ficha del cliente; "ver" abre el detalle de la encuesta.</p>`
  : '<p class="empty">Nada que coincida con los filtros.</p>'}`;
}

function exportCsv() {
  const cols = ['code', 'client_name', 'job_ref', 'job_type', 'channel', 'status', 'sent_at', 'responded_at', 'rating'];
  const head = 'id,cliente,trabajo,tipo,canal,estado,enviada,respondida,resultado';
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head, ...filteredSurveys().map((s) => cols.map((c) => cell(s[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'encuestas.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ================================================================= Clientes

function viewClientes() {
  if (!crmPayload) return '<p class="muted">Cargando…</p>';
  const rows = crmPayload.clients;
  if (!rows.length) return '<p class="empty">Todavía no hay clientes.</p>';
  return `
  <h2>Clientes</h2>
  <table>
    <tr><th>Cliente</th><th>Contacto</th><th>Encuestas</th><th>Respondidas</th><th>% resp.</th><th>Desglose</th><th>Último mov.</th></tr>
    ${rows.map((c) => `
    <tr class="clickable" data-goto="#cliente/${c.id}">
      <td>${esc(c.name)}${c.insatisfecho >= 2 ? ' <span class="rating-pill insatisfecho">en riesgo</span>' : ''}</td>
      <td>${contact(c)}</td>
      <td class="num">${c.encuestas}</td>
      <td class="num">${c.respondidas}</td>
      <td class="num">${pct(c.respondidas, c.enviadas)}%</td>
      <td>${miniDist(c.insatisfecho, c.bueno, c.excelente)}</td>
      <td class="num">${fmt(c.ultimo)}</td>
    </tr>`).join('')}
  </table>`;
}

function clientTimeline(surveys, cases, activity) {
  const ev = [];
  for (const s of surveys) {
    ev.push({ at: s.closed_at, cls: '', html: `Trabajo <b>${esc(s.job_ref)}</b>${s.job_type ? ` (${esc(s.job_type)})` : ''} cerrado → <a class="code" href="#encuesta/${s.id}">${esc(s.code)}</a>` });
    if (s.sent_at) ev.push({ at: s.sent_at, cls: '', html: `<span class="code">${esc(s.code)}</span> enviada por ${s.channel === 'email' ? 'email' : 'WhatsApp'}` });
    if (s.responded_at) ev.push({
      at: s.responded_at,
      cls: s.rating === 'insatisfecho' ? 'ev-crit' : s.rating === 'excelente' ? 'ev-good' : 'ev-warn',
      html: `Respondió ${ratingPill(s.rating)} (<span class="code">${esc(s.code)}</span>)`,
    });
  }
  const sids = new Set(surveys.map((s) => s.id));
  for (const k of cases.filter((k) => sids.has(k.survey_id))) {
    ev.push({ at: k.opened_at, cls: 'ev-crit', html: `Caso abierto por insatisfacción (trabajo ${esc(k.job_ref)})` });
    if (k.resolved_at) ev.push({ at: k.resolved_at, cls: 'ev-good', html: `Caso resuelto${k.notes ? ` — <span class="muted">${esc(k.notes)}</span>` : ''}` });
  }
  for (const a of activity.filter((a) => sids.has(a.survey_id) && ['reminder', 'resolution'].includes(a.kind))) {
    ev.push({ at: a.created_at, cls: '', html: a.kind === 'reminder' ? 'Recordatorio enviado' : 'Agradecimiento post-resolución enviado' });
  }
  ev.sort((a, b) => (a.at < b.at ? 1 : -1));
  return ev;
}

function viewCliente(id) {
  if (!crmPayload) return '<p class="muted">Cargando…</p>';
  const c = crmPayload.clients.find((x) => x.id === id);
  if (!c) return '<p class="empty">Cliente no encontrado.</p>';
  const surveys = crmPayload.surveys.filter((s) => s.client_id === id);
  const ev = clientTimeline(surveys, crmPayload.cases, crmPayload.activity);
  return `
  <a class="back-link" href="#clientes">← Clientes</a>
  <h2>${esc(c.name)}${c.insatisfecho >= 2 ? ' <span class="rating-pill insatisfecho">en riesgo</span>' : ''}</h2>
  <p class="muted">${contact(c)}</p>
  <div class="tiles">
    <div class="tile"><b>${c.encuestas}</b><small>encuestas · ${c.enviadas} enviadas</small></div>
    <div class="tile"><b>${pct(c.respondidas, c.enviadas)}%</b><small>respondidas · ${c.respondidas} de ${c.enviadas}</small></div>
    <div class="tile"><b>${pct(c.bueno + c.excelente, c.respondidas)}%</b><small>satisfacción</small></div>
    <div class="tile ${c.insatisfecho ? 'crit' : ''}"><b>${c.insatisfecho} / ${c.bueno} / ${c.excelente}</b><small>insatisfecho / bueno / excelente</small></div>
  </div>
  <h2>Historia</h2>
  ${ev.length ? `<ul class="timeline">
    ${ev.map((e) => `<li class="${e.cls}">${e.html}<br><span class="when">${fmt(e.at)}</span></li>`).join('')}
  </ul>` : '<p class="empty">Sin movimientos todavía.</p>'}`;
}

// ============================================================ Detalle encuesta

const FORMAT_LABEL = { simple: 'Simple — 3 opciones', csat: 'CSAT — escala 1 a 5' };
const CSAT_LABEL = { 1: 'Muy insatisfecho', 2: 'Insatisfecho', 3: 'Neutral', 4: 'Satisfecho', 5: 'Muy satisfecho' };

function viewEncuesta(id) {
  if (!crmPayload) return '<p class="muted">Cargando…</p>';
  const s = crmPayload.surveys.find((x) => x.id === id);
  if (!s) return '<p class="empty">Encuesta no encontrada.</p>';
  const kase = crmPayload.cases.find((k) => k.survey_id === id);
  const activity = crmPayload.activity.filter((a) => a.survey_id === id);

  const responseTime = s.sent_at && s.responded_at
    ? Math.round((new Date(s.responded_at) - new Date(s.sent_at)) / 3_600_000 * 10) / 10
    : null;

  return `
  <a class="back-link" href="#encuestas">← Encuestas</a>
  <h2>${esc(s.code)} <span class="badge">${FORMAT_LABEL[s.format] || s.format}</span>
    <span class="badge">${STATUS_LABEL[s.status]}</span></h2>
  <p class="muted"><a class="who" href="#cliente/${s.client_id}">${esc(s.client_name)}</a>
    · trabajo ${esc(s.job_ref)}${s.job_type ? ` · ${esc(s.job_type)}` : ''} · ${contact(s)} ${channelBadge(s.channel)}</p>

  ${s.status === 'responded' ? `
  <div class="tiles">
    <div class="tile ${s.rating === 'insatisfecho' ? 'crit' : ''}">
      <b>${s.score ? `${s.score}/5` : { insatisfecho: '😞', bueno: '🙂', excelente: '🤩' }[s.rating]}</b>
      <small>${s.score ? `${CSAT_LABEL[s.score]} (${s.rating})` : s.rating}</small>
    </div>
    <div class="tile"><b>${fmt(s.responded_at)}</b><small>respondida</small></div>
    ${responseTime !== null ? `<div class="tile"><b>${responseTime} h</b><small>tiempo de respuesta desde el envío</small></div>` : ''}
  </div>` : `
  <div class="card"><span class="muted">Todavía sin respuesta.
    ${s.status === 'sent' ? `Enviada ${fmt(s.sent_at)}${s.resend_count ? ' · reenviada 1 vez' : ''}.` : ''}</span></div>`}

  ${kase ? `
  <h2>Caso vinculado</h2>
  <div class="card ${kase.status === 'resuelto' ? 'case-resolved' : 'case-open'}">
    <span class="badge">${esc(kase.status.replace('_', ' '))}</span>
    <span class="muted">abierto ${fmt(kase.opened_at)}${kase.resolved_at ? ` · resuelto ${fmt(kase.resolved_at)}` : ''}</span>
    ${kase.notes ? `<div class="muted" style="margin-top:.4rem">Notas: ${esc(kase.notes)}</div>` : ''}
  </div>` : ''}

  <h2>Historia de esta encuesta</h2>
  ${activity.length ? `<ul class="timeline">
    ${activity.map((a) => `<li class="${a.kind === 'alert' ? 'ev-crit' : a.kind === 'resolution' ? 'ev-good' : ''}">
      ${esc({ initial: 'Encuesta enviada', reminder: 'Recordatorio enviado', alert: 'Alerta al dueño', followup: 'Seguimiento al dueño', resolution: 'Agradecimiento post-resolución' }[a.kind] || a.kind)}
      <span class="muted">(${esc(a.channel)} → ${esc(a.recipient)})</span><br>
      <span class="when">${fmt(a.created_at)}</span>
    </li>`).join('')}
  </ul>` : '<p class="empty">Sin envíos registrados.</p>'}`;
}

// ================================================================ Resultados

function resultTable(title, rows, nameCol, nameKey, linkable) {
  if (!rows.length) return '';
  return `<h2>${title}</h2>
  <table>
    <tr><th>${nameCol}</th><th>Enviadas</th><th>Respondidas</th><th>% resp.</th><th>% satisf.</th><th>Desglose</th></tr>
    ${rows.map((r) => `
    <tr ${linkable ? `class="clickable" data-goto="#cliente/${r.id}"` : ''}>
      <td>${esc(r[nameKey])}</td>
      <td class="num">${r.enviadas ?? 0}</td>
      <td class="num">${r.respondidas ?? 0}</td>
      <td class="num">${pct(r.respondidas, r.enviadas)}%</td>
      <td class="num">${pct((r.bueno ?? 0) + (r.excelente ?? 0), r.respondidas)}%</td>
      <td>${miniDist(r.insatisfecho ?? 0, r.bueno ?? 0, r.excelente ?? 0)}</td>
    </tr>`).join('')}
  </table>`;
}

function viewResultados() {
  if (!crmPayload) return '<p class="muted">Cargando…</p>';
  const clientsWithData = crmPayload.clients.filter((c) => c.enviadas > 0);
  return [
    '<h2>General (empresa)</h2>',
    tiles(crmPayload.metrics),
    resultTable('Por tipo de servicio', crmPayload.by_type, 'Tipo', 'type', false),
    resultTable('Por cliente', clientsWithData, 'Cliente', 'name', true),
  ].join('');
}

// ==================================================================== Router

const routes = () => {
  const h = location.hash || '#operacion';
  const m = h.match(/^#cliente\/(\d+)$/);
  if (m) return { view: 'cliente', id: Number(m[1]), tab: '#clientes' };
  const e = h.match(/^#encuesta\/(\d+)$/);
  if (e) return { view: 'encuesta', id: Number(e[1]), tab: '#encuestas' };
  if (['#operacion', '#encuestas', '#clientes', '#resultados'].includes(h)) return { view: h.slice(1), tab: h };
  return { view: 'operacion', tab: '#operacion' };
};

const MANAGER_TABS = ['#encuestas', '#clientes', '#resultados'];

function applyRole() {
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (MANAGER_TABS.includes(a.getAttribute('href'))) {
      a.style.display = role === 'operador' ? 'none' : '';
    }
  });
}

function renderCurrent() {
  const r = routes();
  // El operador solo tiene la vista Operación (el server igual lo aplica con 403).
  if (role === 'operador' && r.tab !== '#operacion') {
    location.hash = '#operacion';
    return;
  }
  document.querySelectorAll('.tabs a').forEach((a) =>
    a.getAttribute('href') === r.tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  app.innerHTML =
    r.view === 'operacion' ? viewOperacion()
    : r.view === 'encuestas' ? viewEncuestas()
    : r.view === 'clientes' ? viewClientes()
    : r.view === 'cliente' ? viewCliente(r.id)
    : r.view === 'encuesta' ? viewEncuesta(r.id)
    : viewResultados();
}

async function refresh(force = false) {
  if (sessionLost) return;
  // No pisar lo que el usuario está tipeando.
  if (!force && app.contains(document.activeElement) &&
      /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const view = routes().view;
  try {
    if (view === 'operacion' || role === null) {
      const res = await fetch('/api/state');
      if (res.status === 401) { sessionExpired(); return; }
      const text = await res.text();
      if (force || text !== lastStateText) {
        lastStateText = text;
        statePayload = JSON.parse(text);
        const cfg = statePayload.config;
        role = cfg.role || 'gerente';
        applyRole();
        configLine.textContent =
          `${role === 'operador' ? 'Operador · ' : ''}Envío diferido: ${cfg.delay_minutes} min · ` +
          `WhatsApp: ${cfg.wa_gateway ? 'gateway automático' : 'tap-to-send (wa.me)'}` +
          ` · Reseña Google: ${cfg.google_review ? 'activa' : 'sin configurar'}`;
      }
    }
    if (view !== 'operacion' && role !== 'operador') {
      const res = await fetch('/api/crm');
      if (res.status === 401) { sessionExpired(); return; }
      if (res.status === 403) { role = 'operador'; applyRole(); renderCurrent(); return; }
      if (!res.ok) { toast('No se pudo cargar la vista. Reintentando…'); return; }
      const text = await res.text();
      if (force || text !== lastCrmText) {
        lastCrmText = text;
        crmPayload = JSON.parse(text);
      }
    }
    renderCurrent();
  } catch {
    /* servidor reiniciando: el próximo poll lo levanta */
  }
}

window.addEventListener('hashchange', () => { refresh(true); renderCurrent(); });

// ------------------------------------------------------------- acciones

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  if (form.id === 'close-job') {
    const r = await post('/api/jobs/close', data);
    if (r.survey_url) form.reset();
  } else if (form.id === 'create-survey') {
    const r = await post('/api/surveys', data);
    if (r.survey_url) {
      lastCreated = r;
      form.reset();
      toast(`${r.code} creada — copiá el link y mandáselo al cliente.`);
    }
  } else if (form.dataset.contact) {
    await post(`/api/surveys/${form.dataset.contact}/contact`, data);
  }
  refresh(true);
});

app.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-goto]');
  if (row && !e.target.closest('button, a, input')) { location.hash = row.dataset.goto; return; }

  const btn = e.target.closest('button, a[data-refresh]');
  if (!btn) return;

  if (btn.id === 'csv') return exportCsv();
  if (btn.dataset.copy) {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      toast('Link copiado.');
    } catch {
      toast('No se pudo copiar: seleccioná el link y copialo a mano.');
    }
    return;
  }
  if (btn.dataset.resend) {
    await post(`/api/surveys/${btn.dataset.resend}/resend`);
    refresh(true);
  } else if (btn.dataset.case) {
    const notes = document.querySelector(`[data-case-notes="${btn.dataset.case}"]`)?.value;
    const r = await post(`/api/cases/${btn.dataset.case}`, { status: btn.dataset.status, notes });
    if (r.wa_link) window.open(r.wa_link, '_blank');
    refresh(true);
  } else if (btn.dataset.refresh !== undefined) {
    setTimeout(() => refresh(true), 800); // el /wa/:id marca enviada al abrirse
  }
});

// Filtros de Encuestas: re-render inmediato conservando foco en la búsqueda.
app.addEventListener('input', (e) => {
  if (e.target.id !== 'f-q') return;
  F.q = e.target.value;
  renderCurrent();
  const q = document.getElementById('f-q');
  q.focus();
  q.setSelectionRange(q.value.length, q.value.length);
});
app.addEventListener('change', (e) => {
  if (e.target.id === 'f-status') { F.status = e.target.value; renderCurrent(); }
  if (e.target.id === 'f-type') { F.type = e.target.value; renderCurrent(); }
});

refresh(true);
pollTimer = setInterval(refresh, 8000);
