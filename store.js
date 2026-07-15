// Selección de backend de datos.
//
//   - Con SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY → Postgres (Supabase),
//     para hosting serverless (Vercel) con estado persistente.
//   - Sin eso → SQLite local (node:sqlite), cero configuración: dev, tests
//     y cualquier host con disco.
//
// El import de SQLite es dinámico a propósito: node:sqlite es experimental
// y no debe cargarse en el path serverless.

export async function openStore() {
  if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)) {
    const { openSupabaseStore } = await import('./store-supabase.js');
    return openSupabaseStore();
  }
  const { openSqliteStore } = await import('./store-sqlite.js');
  return openSqliteStore();
}
