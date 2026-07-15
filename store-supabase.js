// Store Supabase (Postgres vía PostgREST, con fetch nativo — sin SDK).
// Backend para hosting serverless (Vercel): estado persistente fuera del
// proceso. Tablas con prefijo enc_ y RLS activado sin políticas: solo la
// service key (que vive en el server) puede tocarlas.
//
//   SUPABASE_URL                p.ej. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service key (¡nunca al navegador!)
//
// Los agregados corren como funciones SQL (enc_metrics, enc_at_risk,
// enc_client_aggregates, enc_type_aggregates) creadas por la migración.

const T = (name) => `enc_${name}`;

export function openSupabaseStore(
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY,
) {
  if (!url || !key) throw new Error('faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const base = url.replace(/\/$/, '') + '/rest/v1';
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };

  async function req(method, path, { body, prefer } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: prefer ? { ...headers, prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`supabase ${method} ${path}: ${res.status} ${detail.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const rows = (path) => req('GET', path);
  const first = async (path) => (await rows(path))[0] ?? null;
  const insertInto = async (table, fields) =>
    (await req('POST', `/${T(table)}`, { body: fields, prefer: 'return=representation' }))[0];
  const updateIn = (table, id, fields) =>
    Object.keys(fields).length
      ? req('PATCH', `/${T(table)}?id=eq.${id}`, { body: fields, prefer: 'return=minimal' })
      : Promise.resolve();
  const rpc = (fn) => req('POST', `/rpc/${fn}`, { body: {} });

  // Aplana el embedding de PostgREST a las columnas planas que usa la UI.
  const flatSurvey = (r) => {
    const { enc_clients: c, enc_jobs: j, ...s } = r;
    return {
      ...s,
      client_name: c?.name, client_email: c?.email, client_phone: c?.phone,
      job_ref: j?.ref, job_type: j?.type, closed_at: j?.closed_at,
    };
  };
  const SURVEY_EMBED = 'select=*,enc_clients(name,email,phone),enc_jobs(ref,type,closed_at)';

  return {
    kind: 'supabase',
    async isEmpty() {
      return (await rows(`/${T('surveys')}?select=id&limit=1`)).length === 0;
    },

    clientByName: (name) =>
      first(`/${T('clients')}?name=ilike.${encodeURIComponent(name.trim().replace(/[%_]/g, ''))}&limit=1`),
    clientById: (id) => first(`/${T('clients')}?id=eq.${id}`),
    insertClient: (f) => insertInto('clients', f),
    updateClient: (id, f) => updateIn('clients', id, f),

    jobByRef: (ref) => first(`/${T('jobs')}?ref=eq.${encodeURIComponent(ref)}`),
    jobById: (id) => first(`/${T('jobs')}?id=eq.${id}`),
    insertJob: (f) => insertInto('jobs', f),

    surveyById: (id) => first(`/${T('surveys')}?id=eq.${id}`),
    surveyByToken: (token) => first(`/${T('surveys')}?token=eq.${encodeURIComponent(token)}`),
    insertSurvey: (f) => insertInto('surveys', f),
    updateSurvey: (id, f) => updateIn('surveys', id, f),
    async surveysJoined(limit = 2000) {
      return (await rows(`/${T('surveys')}?${SURVEY_EMBED}&order=id.desc&limit=${limit}`)).map(flatSurvey);
    },
    surveysDue: (now) =>
      rows(`/${T('surveys')}?status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(now)}`),
    surveysReminderDue: (cutoff) =>
      rows(`/${T('surveys')}?status=eq.sent&resend_count=eq.0&sent_at=lte.${encodeURIComponent(cutoff)}`),

    caseById: (id) => first(`/${T('cases')}?id=eq.${id}`),
    insertCaseIgnore: (f) =>
      req('POST', `/${T('cases')}?on_conflict=survey_id`, {
        body: f,
        prefer: 'resolution=ignore-duplicates,return=minimal',
      }),
    updateCase: (id, f) => updateIn('cases', id, f),
    async casesJoined() {
      const data = await rows(
        `/${T('cases')}?select=*,enc_clients(name,email,phone),enc_surveys(responded_at,enc_jobs(ref,type))` +
        `&order=opened_at.desc&limit=50`
      );
      return data
        .map((r) => {
          const { enc_clients: c, enc_surveys: s, ...k } = r;
          return {
            ...k,
            client_name: c?.name, client_email: c?.email, client_phone: c?.phone,
            responded_at: s?.responded_at, job_ref: s?.enc_jobs?.ref, job_type: s?.enc_jobs?.type,
          };
        })
        .sort((a, b) => (a.status === 'resuelto') - (b.status === 'resuelto'));
    },
    casesFollowupDue: (cutoff) => {
      const c = encodeURIComponent(cutoff);
      return rows(
        `/${T('cases')}?status=neq.resuelto&or=(and(last_followup_at.is.null,opened_at.lte.${c}),last_followup_at.lte.${c})`
      );
    },

    outboxInsert: (f) => req('POST', `/${T('outbox')}`, { body: f, prefer: 'return=minimal' }),
    outboxList: (limit = 15) => rows(`/${T('outbox')}?order=id.desc&limit=${limit}`),

    metricsRaw: async () => (await rpc('enc_metrics')),
    atRisk: () => rpc('enc_at_risk'),
    clientAggregates: () => rpc('enc_client_aggregates'),
    typeAggregates: () => rpc('enc_type_aggregates'),
  };
}
