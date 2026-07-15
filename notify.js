// Salida de mensajes (encuestas, recordatorios, alertas, seguimientos).
//
// El sistema no está atado a ningún proveedor: todo mensaje queda en la
// tabla `outbox` (auditable) y se POSTea al webhook que corresponda. El
// canal WhatsApp funciona en dos modos:
//
//   - Sin gateway (default): NO requiere API de Meta. El sistema arma un
//     link wa.me con el mensaje listo; el operario lo toca y el mensaje
//     sale desde su propio WhatsApp. Un solo tap.
//   - Con gateway: si WHATSAPP_WEBHOOK_URL está configurada (Twilio, n8n,
//     Zapier, un proveedor de WhatsApp Business), el envío es 100%
//     automático igual que el email.
//
//   SEND_WEBHOOK_URL      transporte de email (encuestas, recordatorios, resolución)
//   WHATSAPP_WEBHOOK_URL  gateway de WhatsApp (opcional; sin esto, modo tap)
//   ALERT_WEBHOOK_URL     alertas y seguimientos al dueño (default: SEND_WEBHOOK_URL)
//   OWNER_CONTACT         a quién le llegan alertas/seguimientos

export const hasWhatsAppGateway = () => Boolean(process.env.WHATSAPP_WEBHOOK_URL);

function webhookFor(kind, channel) {
  if (kind === 'alert' || kind === 'followup')
    return process.env.ALERT_WEBHOOK_URL || process.env.SEND_WEBHOOK_URL;
  if (channel === 'whatsapp') return process.env.WHATSAPP_WEBHOOK_URL;
  return process.env.SEND_WEBHOOK_URL;
}

export async function deliver(db, { surveyId, kind, channel, recipient, subject, body }) {
  db.prepare(
    'INSERT INTO outbox (survey_id, kind, channel, recipient, subject, body) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(surveyId ?? null, kind, channel, recipient, subject, body);

  const url = webhookFor(kind, channel);
  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, channel, recipient, subject, body }),
      });
    } catch (err) {
      // El mensaje ya quedó en outbox; no frenamos el flujo por el webhook.
      console.error(`[notify] fallo el webhook (${kind}/${channel} -> ${recipient}):`, err.message);
    }
  }
  console.log(`[notify] ${kind}/${channel} -> ${recipient}: ${subject}`);
}

// Link wa.me con el mensaje prearmado — WhatsApp sin API de Meta.
export function waLink(phone, text) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

// ------------------------------------------------------------- mensajes

export function surveyMessage(baseUrl, survey, client, job, kind) {
  const link = `${baseUrl}/s/${survey.token}`;
  const subject =
    kind === 'reminder'
      ? '¿Nos das tu opinión? Es una sola pregunta'
      : '¿Cómo salió el trabajo? Respondé con un toque';
  const body =
    `Hola ${client.name}!\n\n` +
    (kind === 'reminder'
      ? `Hace unos días terminamos el trabajo${job.type ? ` de ${job.type}` : ''} (${job.ref}) y nos encantaría saber cómo salió. `
      : `Terminamos el trabajo${job.type ? ` de ${job.type}` : ''} (${job.ref}). ¿Cómo salió? `) +
    `Es una sola pregunta, sin registrarse:\n\n${link}\n\nGracias!`;
  return { subject, body };
}

export function alertMessage(survey, client, job) {
  return {
    subject: `⚠ Cliente insatisfecho: ${client.name}`,
    body:
      `${client.name} respondió INSATISFECHO por el trabajo ${job.ref}` +
      `${job.type ? ` (${job.type})` : ''}.\n` +
      `Contacto: ${client.email || client.phone || 'sin datos'}\n` +
      `Respondió: ${survey.responded_at}\n\n` +
      `Llamalo hoy para recuperarlo. El caso quedó abierto en el tablero.`,
  };
}

export function followupMessage(kase, client, job) {
  return {
    subject: `⏰ Caso sin resolver: ${client.name} (${kase.status})`,
    body:
      `El caso de ${client.name} (trabajo ${job.ref}) sigue ${kase.status} ` +
      `desde ${kase.opened_at}.\n` +
      `Contacto: ${client.email || client.phone || 'sin datos'}\n` +
      (kase.notes ? `Notas: ${kase.notes}\n` : '') +
      `\nMarcalo como resuelto en el tablero cuando lo cierres.`,
  };
}

export function resolutionMessage(client, job) {
  return {
    subject: 'Queríamos contarte que lo resolvimos',
    body:
      `Hola ${client.name}!\n\n` +
      `Nos tomamos en serio tu respuesta sobre el trabajo${job.type ? ` de ${job.type}` : ''} ` +
      `(${job.ref}) y trabajamos para resolverlo. Gracias por avisarnos: ` +
      `nos ayudó a mejorar.\n\nQuedamos a disposición por lo que necesites.`,
  };
}
