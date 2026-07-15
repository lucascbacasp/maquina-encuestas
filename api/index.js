// Entry point serverless (Vercel): una sola función atiende todas las
// rutas (vercel.json reescribe todo acá). El estado vive en Supabase;
// el scheduler corre de forma perezosa por request y vía /api/cron.

import { openStore } from '../store.js';
import { createApp } from '../handler.js';

let appPromise;

export default async function vercelHandler(req, res) {
  appPromise ??= (async () => {
    const store = await openStore();
    if (store.kind !== 'supabase') {
      console.warn('[vercel] sin SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY: usando SQLite efímero (los datos NO persisten entre invocaciones)');
    }
    const app = createApp(store);
    await app.ensureReady();
    return app;
  })();
  const app = await appPromise;
  return app.handle(req, res);
}
