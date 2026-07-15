// Scheduler interno: corre en el mismo proceso, sin cron externo.
//
//   1. Despacha encuestas programadas cuyo horario venció (envío diferido
//      de 30-60 min adoptado del flujo BERLIM).
//   2. Reenvío automático a las AUTO_REMINDER_HOURS (default 48) si no hubo
//      respuesta — máximo 1 reenvío total, la regla anti-spam del journey.
//   3. Seguimiento semanal al dueño por cada caso de insatisfecho abierto.
//
// Los canales sin vía automática (whatsapp sin gateway) no se envían solos:
// pasan a estado `ready` y quedan en el tablero como tap-to-send.

import { hasWhatsAppGateway } from './notify.js';

const REMINDER_SECONDS = () =>
  Math.round(Number(process.env.AUTO_REMINDER_HOURS ?? 48) * 3600);
const FOLLOWUP_SECONDS = () =>
  Math.round(Number(process.env.CASE_FOLLOWUP_DAYS ?? 7) * 86400);

export function canAutoSend(channel) {
  return channel === 'email' || (channel === 'whatsapp' && hasWhatsAppGateway());
}

// Paso 1 — también se invoca inline tras cerrar un trabajo con delay 0.
export async function dispatchDue(db, sendSurvey) {
  const due = db.prepare(`
    SELECT * FROM surveys
    WHERE status = 'scheduled' AND scheduled_at <= datetime('now')
  `).all();
  for (const survey of due) {
    if (canAutoSend(survey.channel)) {
      await sendSurvey(survey, 'initial');
    } else {
      db.prepare("UPDATE surveys SET status = 'ready' WHERE id = ? AND status = 'scheduled'")
        .run(survey.id);
    }
  }
  return due.length;
}

async function sendReminders(db, sendSurvey) {
  const secs = REMINDER_SECONDS();
  if (secs <= 0) return;
  const due = db.prepare(`
    SELECT * FROM surveys
    WHERE status = 'sent' AND resend_count = 0
      AND sent_at <= datetime('now', '-' || ? || ' seconds')
  `).all(secs);
  // Sin vía automática, el reenvío queda como botón manual en el tablero.
  for (const survey of due.filter((s) => canAutoSend(s.channel))) {
    await sendSurvey(survey, 'reminder');
  }
}

async function sendCaseFollowups(db, sendFollowup) {
  const secs = FOLLOWUP_SECONDS();
  if (secs <= 0) return;
  const due = db.prepare(`
    SELECT * FROM cases
    WHERE status != 'resuelto'
      AND coalesce(last_followup_at, opened_at) <= datetime('now', '-' || ? || ' seconds')
  `).all(secs);
  for (const kase of due) {
    await sendFollowup(kase);
    db.prepare("UPDATE cases SET last_followup_at = datetime('now') WHERE id = ?").run(kase.id);
  }
}

export function startScheduler(db, { sendSurvey, sendFollowup }) {
  const tickMs = Number(process.env.TICK_MS || 30_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchDue(db, sendSurvey);
      await sendReminders(db, sendSurvey);
      await sendCaseFollowups(db, sendFollowup);
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
