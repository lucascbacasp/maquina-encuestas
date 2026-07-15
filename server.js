// Runner local / VPS: proceso Node persistente con scheduler por intervalo.
//
//   node server.js          # tablero en http://localhost:3000
//
// El backend de datos lo decide store.js: SQLite (default) o Supabase si
// hay SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Para serverless (Vercel)
// el entry point es api/index.js.

import { createServer } from 'node:http';
import { openStore } from './store.js';
import { createApp } from './handler.js';
import { startScheduler } from './scheduler.js';
import { hasWhatsAppGateway } from './notify.js';

const store = await openStore();
const app = createApp(store);
await app.ensureReady();

startScheduler(store, app.actions);

createServer(app.handle).listen(Number(process.env.PORT || 3000), () => {
  console.log(`Máquina de Encuestas corriendo en ${app.BASE_URL} (datos: ${store.kind})`);
  console.log(`  envío diferido: ${app.DELAY_SECONDS / 60} min · gateway WhatsApp: ${hasWhatsAppGateway() ? 'sí' : 'modo tap-to-send'}`);
  if (!app.ADMIN_PASS) console.warn('  ADVERTENCIA: sin ADMIN_PASS el tablero queda abierto (solo para desarrollo)');
});
