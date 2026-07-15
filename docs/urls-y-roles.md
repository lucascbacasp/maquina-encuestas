# URLs y roles — referencia rápida

Base: `https://maquina-encuestas.vercel.app` (si tu proyecto de Vercel tiene
otro dominio, reemplazá la base; las rutas son las mismas).

La entrada es la **landing** en `/`: explica el sistema y tiene la caja de
login. Al ingresar (operador o gerente) se crea una sesión de 7 días por
cookie y se pasa al tablero en `/app`. El botón **Salir** del tablero cierra
la sesión — cambiar de usuario ya no requiere incógnito. Las vistas del
tablero son rutas `#hash` sobre `/app`.

## Mapa de URLs

| URL | Quién accede | Qué es |
|---|---|---|
| `/s/<token>` | **Público** (cada link es único) | La encuesta del cliente: 1 pregunta, 3 botones, sin login |
| `/healthz` | Público | Health check del hosting |
| `/` | **Público** | Landing: qué es el sistema + caja de login (con sesión activa redirige a `/app`) |
| `/app` o `/app#operacion` | Operador y gerente | Vista **Operación** |
| `/app#encuestas` | Solo gerente | Registro CRM completo con filtros y export |
| `/app#clientes` | Solo gerente | Clientes con agregados |
| `/app#cliente/<id>` | Solo gerente | Ficha del cliente con línea de tiempo |
| `/app#resultados` | Solo gerente | Resultados globales de la empresa |
| `/api/selftest` | Solo gerente | Diagnóstico del deploy (backend, conteos) |
| `/api/cron?secret=<CRON_SECRET>` | Sistema (cron externo) | Dispara el tick del scheduler |
| `POST /api/jobs/close` | Operador, gerente o sistema externo | El hook que cierra un trabajo y dispara la encuesta |

Si el operador escribe a mano una URL de gerente, el servidor responde
`403` — la restricción vive en el backend, no en el menú.

## Perfil: Cliente final — sin usuario, sin clave

Solo toca el link que le llega por email o WhatsApp.

- Responde la encuesta con **un tap** (Insatisfecho / Bueno / Excelente).
- Si responde Excelente, ve la invitación a dejar **reseña en Google**.
- Si su caso de insatisfacción se resuelve, recibe el agradecimiento.
- Idempotente: la primera respuesta vale; reabrir el link muestra "ya
  registramos tu respuesta". No puede ver ni tocar nada más.

## Perfil: Operador — usuario `operador`

Su trabajo: **terminar servicios y que la encuesta salga sola**. Ve
únicamente la vista Operación:

| Función | Cómo |
|---|---|
| Cerrar trabajo → disparar encuesta | Form al pie (o su sistema vía API). Contacto conocido = sale sola con envío diferido |
| Enviar por WhatsApp (un tap) | Botón que abre su WhatsApp con mensaje y link ya escritos — sin API de Meta |
| Cargar contactos faltantes | Form inline; el dato queda en memoria para el próximo trabajo del cliente |
| Reenviar no respondidas | Botón manual (máximo 1; el automático de 48 hs corre solo) |
| Trabajar casos de insatisfechos | Notas, pasar a "en tratamiento", marcar resuelto (dispara el agradecimiento al cliente) |
| Ver KPIs del día y actividad | Tiles + desglose + registro de todo lo que salió |

No ve: registro completo de encuestas, fichas de clientes, resultados
globales (el servidor se lo bloquea con `403`).

## Perfil: Gerente — usuario `admin`

Todo lo del operador **más** las vistas de empresa:

| Vista | Función |
|---|---|
| **Encuestas** | Registro completo: cada encuesta con ID citable (`ENC-0042`), estado, canal, fechas y resultado. Filtros combinables (estado × tipo × búsqueda) y **export CSV** |
| **Clientes** | Agregados por cliente (% respuesta, desglose, badge "en riesgo") y ficha con la línea de tiempo completa: trabajos, envíos, respuestas, casos y notas |
| **Resultados** | Los números globales de la empresa: % enviadas, % respondidas, % satisfacción, desglose; **corte por tipo de servicio** y **por cliente**; clientes en riesgo |
| Alertas y seguimientos | Alerta inmediata por cada insatisfecho + recordatorio semanal por caso abierto (en Actividad; por email/WhatsApp al conectar el webhook) |
| Diagnóstico | `/api/selftest` para verificar deploy y backend |

## Perfil: Sistema externo — sin UI

El software de gestión que ya usen puede integrarse con la clave de
operador o gerente:

- `POST /api/jobs/close` con `{ref, type?, client_name, client_email?, client_phone?}` → crea el trabajo y dispara la encuesta.
- `GET /api/state` (ambos roles) y `GET /api/crm` (gerente) para leer datos.
- `GET /api/cron?secret=…` para el tick del scheduler desde un cron externo.
