# Costos a escala — análisis para ofrecerlo como servicio

Pregunta: ¿hay riesgo de costos si un cliente envía 1.000 encuestas/mes?
Respuesta corta: **la carga técnica de 1.000 encuestas/mes es trivial** para
este stack. Los riesgos reales de costo están en otros tres lugares:
el plan Hobby de Vercel, el canal de mensajería (WhatsApp API si se
adopta) y la arquitectura single-tenant. Precios en USD, aproximados a
principios de 2026 — verificar antes de comprometer pricing.

## 1. Qué genera 1.000 encuestas/mes, en números

| Recurso | Volumen mensual | Comentario |
|---|---|---|
| Filas en Postgres | ~1.000 encuestas + ~1.500 outbox ≈ 2-3 MB | El free tier de Supabase (500 MB) alcanza para **años** |
| Requests de encuesta | ~1.000 vistas + ~600 respuestas | Nada para serverless |
| Emails salientes | ~1.000 iniciales + ~400 recordatorios + alertas ≈ 1.500 | Ver §3 |
| Invocaciones de función | Ver §4 — el driver no son las encuestas | |

**Conclusión técnica**: cómputo, base y storage no son el problema ni a
1.000 ni a 10.000 encuestas/mes.

## 2. Riesgo #1 — El plan Hobby de Vercel no permite uso comercial

Hoy el deploy corre en Vercel **Hobby (gratis)**, cuyos términos
**prohíben uso comercial**. Para cobrar por el servicio hay que pasar a
**Pro (~USD 20/mes por miembro del equipo)**. No es un costo por cliente:
un solo team Pro puede alojar N proyectos/tenants. Es el primer costo
fijo real del negocio y conviene asumirlo desde el primer cliente pago.

Supabase free tiene su propia trampa: los proyectos gratis **se pausan
tras ~1 semana sin actividad** (con uso real + el cron diario no pasa,
pero un cliente inactivo un mes se encuentra la base pausada). Pro:
~USD 25/mes por organización.

## 3. Riesgo #2 — La mensajería es el único costo variable real

| Canal | Costo por mensaje | 1.000 encuestas/mes (~1.500 envíos) |
|---|---|---|
| **wa.me tap-to-send** (actual) | $0 | **$0** — pero es trabajo manual del operador |
| **Email** (Resend directo) | Free: 3.000/mes · Pro ~USD 20/mes: 50.000 | $0 en free; un plan pago cubre a **todos** los tenants |
| **Email vía Zapier** | ~centavos por "task", planes chicos | ❌ **No viable a escala**: 1.500 tasks/mes rompe cualquier plan chico. Zapier sirve para probar, no para operar |
| **WhatsApp Business API** (gateway) | ~USD 0,03-0,06 por mensaje utility en LatAm + fees del BSP | **USD 45-90/mes por cliente** — el único costo que escala linealmente con las encuestas |

**Lecturas:**
- El **email directo con Resend** (u otro transaccional) es el canal
  barato: un plan de USD 20/mes cubre ~30 clientes de 1.000 encuestas.
  Requiere dominio propio con SPF/DKIM (costo ~$10/año, y cuida la
  reputación de envío).
- **WhatsApp API es el riesgo grande**: si un cliente exige envío
  automático por WhatsApp, ese costo (~USD 50/mes por cada 1.000
  encuestas) debe estar **en el precio del plan o facturado aparte**
  (passthrough), nunca absorbido. El modo tap-to-send actual es gratis
  para siempre y para un SMB con 5-30 trabajos/día es perfectamente
  operable — es un diferenciador de costo, no una limitación.

## 4. El driver oculto de invocaciones: el polling del tablero

Las encuestas casi no generan invocaciones. **Una pestaña del tablero
abierta todo el día sí**: 1 request cada 8 segundos ≈ 3.800/día ≈
**110.000 invocaciones/mes por pestaña siempre abierta**. Con 10 clientes
mirando el tablero, eso — no las encuestas — es lo que consume la cuota
de Vercel.

Mitigaciones baratas (en orden):
1. Subir el intervalo de polling a 30-60s cuando la pestaña no está
   visible (`document.visibilityState`) — 4-8× menos requests, 1 hora
   de trabajo.
2. Pausar el polling tras N minutos sin interacción.
3. (Más adelante) reemplazar polling por Supabase Realtime.

## 5. Riesgo #3 — Single-tenant: el costo escala por cliente, no por uso

Hoy la arquitectura es **una instancia por cliente** (un proyecto Vercel +
un set de tablas + credenciales por env vars). Vendible para los primeros
2-3 clientes (un proyecto Vercel extra cuesta $0 en el mismo team Pro;
un schema extra en el mismo proyecto Supabase cuesta $0). Pero:

- Cada tenant nuevo = deploy + migración + env vars a mano (costo
  operativo tuyo, que es el caro).
- Proyectos Supabase separados por cliente: ~USD 10/mes cada uno en Pro.

**La palanca**: refactor **multi-tenant** — columna `tenant_id` en las
tablas + tabla de usuarios/tenants + el tenant resuelto en el login. Con
eso el costo marginal por cliente nuevo es ≈ $0 y el alta es crear un
registro, no un deploy. Es el trabajo de ingeniería a hacer **entre el
cliente 2 y el 5**, antes de que el alta manual duela.

## 6. El modelo, resumido

| Escenario | Costo infra total/mes | Por cliente |
|---|---|---|
| Hoy (demo) | $0 | — |
| 1er cliente pago (email directo, wa.me manual) | Vercel Pro 20 + Supabase Pro 25 + Resend 0-20 ≈ **USD 45-65 fijos** | 45-65 |
| 10 clientes × 1.000 enc/mes (multi-tenant, email) | Los mismos ~USD 65 fijos | **~USD 6,5** |
| Ídem + WhatsApp API en todos | ~65 + ~500 variables | ~56 → cobrar WhatsApp aparte |

Con un precio tipo **USD 29-49/mes por SMB** (referencia de mercado para
este tipo de herramienta), el margen sobre infra es >80% desde ~3 clientes
en multi-tenant — **siempre que WhatsApp API no se regale**.

## 7. Recomendaciones en orden

1. **Antes de cobrar el primer peso**: Vercel Pro (compliance) y dominio
   propio + Resend directo para email (saltear Zapier).
2. **Guard-rail de abuso**: límite blando de encuestas/mes por tenant en
   el backend (hoy nada impide 100.000). Barato de agregar y protege
   tanto la cuota como el modelo de precios por plan.
3. **Polling inteligente** (§4) — una hora de trabajo, evita el driver
   de invocaciones más tonto.
4. **WhatsApp API como add-on con precio propio**, nunca incluido "gratis"
   en el plan. El tap-to-send queda como el default sin costo.
5. **Refactor multi-tenant entre el cliente 2 y el 5** — convierte el
   costo por cliente en ~$0 y el alta en un formulario.
6. Revisar precios reales de Vercel/Supabase/Resend/Meta al momento de
   definir pricing: estas cifras son de referencia, no cotización.
