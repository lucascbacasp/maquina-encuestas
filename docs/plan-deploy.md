# Plan de trabajo — GitHub propio + URL pública + demo end-to-end

Objetivo: repo propio en GitHub, una URL compartible con el sistema real
corriendo, datos de prueba poblables en un comando, y un guión de demo
end-to-end para mostrar el flujo completo.

## Por qué el hosting necesita un servidor (no Pages/Vercel)

El sistema es un proceso Node persistente: SQLite en disco + scheduler
interno (envíos diferidos, recordatorios 48hs, seguimientos). GitHub Pages
solo sirve estáticos y los serverless (Vercel/Netlify) matan el proceso
entre requests — el scheduler y SQLite no sobreviven. Hace falta un host de
procesos: **Render** (free), **Railway** (~USD 5/mes con disco persistente),
**Fly.io**, o cualquier VPS.

Recomendación para esta etapa: **Render free** — costo cero, deploy
automático desde GitHub. Trade-off: el filesystem es efímero y el servicio
duerme tras 15 min sin tráfico → la base se resetea en cada reinicio. Para
una **demo** eso se vuelve ventaja con el seed automático (`DEMO_SEED=1`):
cada vez que despierta, la demo está poblada y prolija. Cuando se pase de
demo a uso real: Railway/Fly con volumen persistente, o el mismo Render
pago con disco.

---

## Fase 1 — Repo propio en GitHub

| # | Tarea | Quién |
|---|---|---|
| 1.1 | Crear repo `maquina-encuestas` en tu GitHub (público o privado) | Lucas (1 min) o Claude vía API si la sesión lo permite |
| 1.2 | Extraer `encuestas/` como raíz del nuevo repo (código + docs + demo) | Claude |
| 1.3 | README de portada con capturas, quickstart y link a la demo | Claude (ya casi todo existe) |
| 1.4 | Licencia (MIT sugerida) y `.gitignore` | Claude |

Resultado: `github.com/lucascbacasp/maquina-encuestas` clonable y corriendo
con `node server.js`.

## Fase 2 — Preparación para deploy (código)

| # | Tarea | Quién |
|---|---|---|
| 2.1 | `seed.js`: puebla encuestas de prueba realistas (clientes, respuestas, casos, riesgo) — corre con `npm run seed` o solo (`DEMO_SEED=1`) al arrancar con la base vacía | Claude |
| 2.2 | Protección del tablero: Basic Auth con `ADMIN_USER`/`ADMIN_PASS` (las rutas públicas `/s/:token` quedan abiertas — el cliente no debe loguearse jamás) | Claude |
| 2.3 | `Dockerfile` (Node 22 alpine, sin dependencias) + `render.yaml` blueprint para deploy en 1 click | Claude |
| 2.4 | Endpoint `/healthz` para el health-check del host | Claude |
| 2.5 | Test de los nuevos comportamientos (auth, seed) | Claude |

## Fase 3 — Deploy

| # | Tarea | Quién |
|---|---|---|
| 3.1 | Cuenta en Render (login con GitHub) | Lucas (2 min) |
| 3.2 | "New Web Service" → elegir el repo → Render lee `render.yaml` solo | Lucas (2 min) |
| 3.3 | Setear env: `ADMIN_PASS`, `BASE_URL` (la URL que asigna Render), `DEMO_SEED=1`, `GOOGLE_REVIEW_URL` | Lucas, guiado por el README |
| 3.4 | Verificar la URL pública end-to-end | Juntos |

Resultado: `https://maquina-encuestas.onrender.com` (o similar) compartible.

## Fase 4 — Demo end-to-end

| # | Tarea | Quién |
|---|---|---|
| 4.1 | Envío real de email: conectar `SEND_WEBHOOK_URL` a un flujo de Zapier/Make/n8n → Gmail (gratis, 5 min) o directo a Resend cuando haya dominio. Mientras tanto, la sección "Actividad" muestra todo lo que sale | Lucas + Claude (guía) |
| 4.2 | WhatsApp tap-to-send funciona ya en producción sin configurar nada (wa.me) | — |
| 4.3 | Guión de demo (`docs/guion-demo.md`): cerrar trabajo → llega encuesta → responder insatisfecho → alerta + caso → tratar y resolver → ver Resultados por tipo/cliente | Claude |
| 4.4 | Ensayo del guión contra la URL pública | Juntos |

## Fase 5 — Después de la demo (cuando haga falta)

- Persistencia real: Render con disco pago o Railway con volumen (`DB_PATH` a un mount; cambio de config, no de código).
- Email transaccional propio (Resend + dominio verificado).
- Dominio propio (`encuestas.tudominio.com`).
- Auth multiusuario con roles (operario/dueño) si se suma gente.

## Decisiones para arrancar

1. **Nombre y visibilidad del repo** (sugerido: `maquina-encuestas`, público).
2. **Hosting**: Render free (recomendado para la demo) vs Railway pago (persistencia desde el día 1).
