// Scheduler: los tres trabajos de tiempo del sistema.
//
//   1. Despachar encuestas programadas vencidas (envío diferido).
//   2. Reenvío automático a las AUTO_REMINDER_HOURS (default 48) sin
//      respuesta — máximo 1 reenvío total, la regla anti-spam del journey.
//   3. Seguimiento semanal al dueño por caso de insatisfecho abierto.
//
// En el server local corre por intervalo (startScheduler). En serverless
// corre `tickOnce` de forma perezosa por request y/o vía /api/cron.
// Los canales sin vía automática (whatsapp sin gateway) no se envían solos:
// pasan a `ready` y quedan como tap-to-send en el tablero.

import { hasWhatsAppGateway } from './notify.js';
import { nowIso, isoMinus } from './util.js';

const REMINDER_SECONDS = () =>
  Math.round(Number(process.env.AUTO_REMINDER_HOURS ?? 48) * 3600);
const FOLLOWUP_SECONDS = () =>
  Math.round(Number(process.env.CASE_FOLLOWUP_DAYS ?? 7) * 86400);

export function canAutoSend(channel) {
  return channel === 'email' || (channel === 'whatsapp' && hasWhatsAppGateway());
}

// Paso 1 — también se invoca inline tras cerrar un trabajo con delay 0.
export async function dispatchDue(store, sendSurvey) {
  const due = await store.surveysDue(nowIso());
  for (const survey of due) {
    if (canAutoSend(survey.channel)) await sendSurvey(survey, 'initial');
    else await store.updateSurvey(survey.id, { status: 'ready' });
  }
  return due.length;
}

async function sendReminders(store, sendSurvey) {
  const secs = REMINDER_SECONDS();
  if (secs <= 0) return;
  const due = await store.surveysReminderDue(isoMinus(secs));
  // Sin vía automática, el reenvío queda como botón manual en el tablero.
  for (const survey of due.filter((s) => canAutoSend(s.channel))) {
    await sendSurvey(survey, 'reminder');
  }
}

async function sendCaseFollowups(store, sendFollowup) {
  const secs = FOLLOWUP_SECONDS();
  if (secs <= 0) return;
  for (const kase of await store.casesFollowupDue(isoMinus(secs))) {
    await sendFollowup(kase);
    await store.updateCase(kase.id, { last_followup_at: nowIso() });
  }
}

let running = false;

export async function tickOnce(store, { sendSurvey, sendFollowup }) {
  if (running) return;
  running = true;
  try {
    await dispatchDue(store, sendSurvey);
    await sendReminders(store, sendSurvey);
    await sendCaseFollowups(store, sendFollowup);
  } catch (err) {
    console.error('[scheduler]', err);
  } finally {
    running = false;
  }
}

export function startScheduler(store, actions) {
  const tickMs = Number(process.env.TICK_MS || 30_000);
  const timer = setInterval(() => tickOnce(store, actions), tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
