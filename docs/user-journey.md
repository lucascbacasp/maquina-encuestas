# User Journey — Máquina de Encuestas

**Actores:** Operario/técnico (dispara el flujo), Cliente final (responde), Admin/dueño (mira el dashboard).

**Trigger:** El operario termina el laburo.

---

## Etapa 1 — Cierre del trabajo

| | |
|---|---|
| **Acción** | El operario marca el laburo como terminado |
| **Touchpoint** | App / sistema interno |
| **Objetivo** | Que el cierre del trabajo dispare el flujo sin pasos extra |
| **Fricción** | Si marcar "terminado" es un paso aparte, se olvida. Ideal: hook automático sobre el evento de cierre que ya existe |
| **Métrica** | % de trabajos cerrados que generan encuesta |

## Etapa 2 — Selección de encuesta

| | |
|---|---|
| **Acción** | Selecciona qué encuesta corresponde (por tipo de servicio, cliente, etc.) |
| **Touchpoint** | Selector en la app |
| **Objetivo** | Cero decisiones manuales cuando se puede inferir |
| **Fricción** | Elegir a mano es carga cognitiva. Oportunidad: mapear tipo de laburo → encuesta default, y que la selección manual sea la excepción |
| **Métrica** | Tiempo entre cierre y envío |

## Etapa 3 — Envío

| | |
|---|---|
| **Acción** | Envío automático usando el campo mail del cliente, o carga manual del contacto si no existe |
| **Touchpoint** | Email (o WhatsApp) saliente |
| **Objetivo** | Que el 90%+ salga por la vía automática |
| **Fricción** | La carga manual es el punto de mayor abandono del flujo. Cada contacto cargado a mano debería quedar guardado para la próxima |
| **Métrica** | % enviadas / % con datos faltantes |

## Etapa 4 — Respuesta del cliente

| | |
|---|---|
| **Acción** | El cliente abre y responde: Insatisfecho / Bueno / Excelente |
| **Touchpoint** | Link de la encuesta |
| **Objetivo** | Responder en menos de 30 segundos, sin login |
| **Fricción** | Cada pregunta extra baja la tasa de respuesta. Una sola pregunta con 3 opciones tap-to-answer es lo correcto |
| **Métrica** | % respondidas |

## Etapa 5 — Recolección y dashboard

| | |
|---|---|
| **Acción** | El admin ve métricas agregadas |
| **Touchpoint** | Dashboard: % enviadas, % respondidas, % satisfacción, desglose insatisfecho/bueno/excelente |
| **Objetivo** | Leer el estado del negocio en un vistazo |
| **Fricción** | Un % de insatisfechos agregado esconde el caso individual. Cada respuesta "insatisfecho" debería disparar una alerta inmediata (mail/WhatsApp al dueño) con el dato del cliente para recuperarlo en el día |
| **Métrica** | Tiempo de reacción ante un insatisfecho |

## Etapa 6 — Seguimiento (no respondidas)

| | |
|---|---|
| **Acción** | Reenvío automático a quienes no respondieron |
| **Touchpoint** | Email/WhatsApp de recordatorio |
| **Objetivo** | Levantar la tasa de respuesta sin quemar la base |
| **Fricción** | Sin límite de reintentos es spam. Regla sugerida: 1 solo reenvío, a las 48-72 hs, y cortar |
| **Métrica** | % recuperadas post-reenvío |

---

## Riesgos del flujo (en orden)

1. **Carga manual (Etapa 3):** es donde muere la adopción. Todo lo que se pueda auto-completar, auto-completarlo.
2. **Insatisfechos como métrica pasiva (Etapa 5):** el valor real del producto no es el %, es la alerta accionable. Eso es lo que un SMB paga.
3. **Reenvío sin límites (Etapa 6):** definir la regla antes de construir; después es un problema de reputación de dominio/número.

## MVP sugerido (lean)

Etapas 1, 3 (solo automático), 4 y un dashboard mínimo con los 4 números. Selección de encuesta hardcodeada a una sola, reenvío manual con un botón. El resto se agrega cuando alguien lo pida.
