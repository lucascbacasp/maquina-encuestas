// Utilidades compartidas sin dependencia de backend de datos.
import { randomBytes } from 'node:crypto';

export const newToken = () => randomBytes(16).toString('hex');

export const nowIso = () => new Date().toISOString();

export const isoMinus = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
export const isoPlus = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits.length >= 8 ? digits : null;
}

// Canal para un cliente: email si lo hay (100% automático), sino whatsapp.
export function channelFor(client) {
  if (client.email) return 'email';
  if (client.phone) return 'whatsapp';
  return null;
}

// ID legible y citable: interno sigue siendo el entero; esto es presentación.
export const surveyCode = (id) => `ENC-${String(id).padStart(4, '0')}`;

const pct = (num, den) => (den ? Math.round((num / den) * 100) : 0);

// Métricas derivadas a partir de los conteos crudos del store.
export function computeMetrics(raw) {
  const n = (x) => Number(x ?? 0);
  return {
    total: n(raw.total),
    enviadas: n(raw.enviadas),
    sin_contacto: n(raw.sin_contacto),
    en_cola: n(raw.en_cola),
    respondidas: n(raw.respondidas),
    casos_abiertos: n(raw.casos_abiertos),
    desglose: {
      insatisfecho: n(raw.insatisfecho),
      bueno: n(raw.bueno),
      excelente: n(raw.excelente),
    },
    pct_enviadas: pct(n(raw.enviadas), n(raw.total)),
    pct_respondidas: pct(n(raw.respondidas), n(raw.enviadas)),
    pct_satisfaccion: pct(n(raw.bueno) + n(raw.excelente), n(raw.respondidas)),
  };
}
