# Comparación: journey "Máquina de Encuestas" vs. flujo BERLIM (Miro)

Referencia: board de Miro "BERLIM" (bot conversacional NPS para BERLIM Limpieza).

## El flujo del board, resumido

```
Trabajo finalizado
  → Disparo automático (30-60 min después)
  → Activación de bot conversacional (WhatsApp)
      · P1: ¿Qué tan satisfecho? (Mala / Regular / Buena / Excelente)
      · P2: ¿Se resolvió en el primer contacto? (Sí / No / Parcial)
      · P3: Del 0 al 10, ¿recomendarías? (NPS)
  → Clasificación por NPS:
      · PROMOTOR (9-10)  → agradecimiento automático → link a reseña pública en Google
      · PASIVO (7-8)     → nueva encuesta más adelante → ¿mejoró la posición?
      · DETRACTOR (1-6)  → derivación a gestión de clientes → tratamiento del caso
                           → seguimiento semanal → ¿resuelto? → agradecimiento
                           con foco en la resolución (si no, sigue el loop)
  → Cierre del caso → procesamiento → base de datos → reportería → revisión mensual
```

Dashboard del board: CSAT promedio, NPS, FCR (resolución en primer contacto),
tasa de respuesta, CSAT semanal, distribución NPS y **clientes en riesgo**
(CSAT bajo recurrente).

## Dónde coinciden

Ambos flujos comparten la columna vertebral y las convicciones clave:

- **El cierre del trabajo dispara todo, sin pasos extra** (etapa 1 del journey
  = "input de trabajo finalizado → disparo automático" del board).
- **El insatisfecho/detractor no es un número, es un caso a accionar.** Es el
  riesgo #2 del journey y el camino rojo completo del board.
- **Cierre en dashboard/reportería** para leer el negocio de un vistazo.

## Diferencias importantes

| Dimensión | Journey / MVP construido | Flujo BERLIM | Lectura |
|---|---|---|---|
| **Instrumento** | 1 pregunta, 3 opciones, un tap | 3 preguntas (CSAT + FCR + NPS 0-10) | Contradicción directa. El journey argumenta que "cada pregunta extra baja la tasa de respuesta". El board apuesta a más señal (NPS comparable + FCR operativo) a costa de conversión. La tasa de respuesta del propio mockup de BERLIM (61%) sugiere que el costo es real. |
| **Canal** | Email con link a página web | Bot conversacional de WhatsApp | En LATAM, WhatsApp responde mucho mejor que email. En el MVP el transporte ya está desacoplado por webhook, así que es un cambio de consumidor, no de core. |
| **Timing del envío** | Inmediato al cierre | 30-60 min después | El delay del board es más fino: llega cuando el cliente ya "vivió" el resultado del trabajo y no parece un recibo automático. |
| **Respuesta positiva** | Termina en "gracias" | Promotor → pedido de **reseña pública en Google** | El board convierte la satisfacción en growth. Es la idea más valiosa que el journey no tiene, y es barata de agregar. |
| **Respuesta negativa** | Alerta inmediata al dueño (one-shot) | Caso derivado + tratamiento + **seguimiento semanal hasta resolver** + agradecimiento post-resolución | El board cierra el loop completo; el journey solo lo abre. A cambio, la alerta inmediata del journey tiene mejor "tiempo de reacción" — el board no la explicita. |
| **Pasivos** | No existen (3 opciones, sin zona media medible) | Re-encuesta posterior: ¿mejoró la posición? | Solo tiene sentido si se adopta NPS. |
| **Contacto faltante** | Riesgo #1: carga manual con memoria de contactos | **No aparece en el board** | El flujo BERLIM asume que siempre hay WhatsApp del cliente. Para el journey ese supuesto es justo donde "muere la adopción". |
| **Límite de reintentos** | Regla explícita: 1 reenvío y cortar | No aparece | Otro riesgo (reputación del número/dominio) que el board no cubre. |
| **Métricas** | 4 números: % enviadas, % respondidas, % satisfacción, desglose | CSAT, NPS, FCR, tasa de respuesta, tendencia semanal, clientes en riesgo | El board es un dashboard de madurez 2-3; el journey es deliberadamente v1. "Clientes en riesgo" (bajo puntaje recurrente) es la segunda mejor idea del board. |
| **Mejora continua** | No contemplada | Revisión mensual del proceso | Proceso humano, no requiere software. |

## Síntesis

Son dos fotos del mismo producto en momentos distintos: el journey es la
**v1 lean** (maximizar adopción y tasa de respuesta, riesgos operativos
explícitos), el board es la **v2/v3 madura** (más señal, más automatización
del ciclo de recuperación, growth loop). El board no invalida el MVP; le
marca el roadmap. Y el journey cubre dos agujeros que el board tiene:
contacto faltante y límite de reintentos.

## Qué conviene adoptar del board, en orden

1. **Reseña de Google para respuestas "excelente"** — mínimo esfuerzo, valor
   directo. En el MVP: un link en la página de agradecimiento cuando
   `rating = excelente` ("excelente" funciona como proxy de promotor).
2. **Delay de 30-60 min en el envío** — hoy el MVP envía en el mismo request
   del cierre; pasar a un envío diferido mejora la percepción sin tocar el flujo.
3. **Caso con estado para insatisfechos** — evolucionar la alerta one-shot a
   `abierto → en tratamiento → resuelto`, con recordatorio semanal mientras
   siga abierto y agradecimiento al cliente al resolver. Mantener la alerta
   inmediata del journey: es el mejor "tiempo de reacción" de los dos flujos.
4. **Clientes en riesgo** — vista de clientes con insatisfacción recurrente;
   con el modelo actual (`clients` ← `surveys`) es una consulta, no una migración.
5. **WhatsApp como canal** — ya previsto: es un consumidor del webhook de salida.

## Qué NO adoptar (todavía)

- **Las 3 preguntas / NPS 0-10.** Es la disyuntiva central y el journey ya la
  laudó para la v1: una pregunta, tres opciones, un tap. Migrar a NPS después
  es posible (el desglose actual mapea a detractor/pasivo/promotor), pero
  hacerlo antes de tener tasa de respuesta medida es renunciar a conversión
  sin datos que lo justifiquen.
- **Bot conversacional multivuelta.** Requiere infraestructura de WhatsApp
  Business API + manejo de estado de conversación; para el volumen de un SMB,
  el link de un tap rinde igual con una fracción de la complejidad.
