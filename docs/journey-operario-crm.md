# Journey del operario + modelo CRM

Complementa a [`user-journey.md`](user-journey.md) (que sigue el recorrido de la
**encuesta**) con el recorrido del **usuario que opera el sistema**, y define el
modelo de vistas CRM y las prácticas que se implementan.

**Actor:** operario/administrativo que entra al sistema a diario. El dueño usa
las mismas vistas con foco en Resultados.

---

## Journey del operario

### Etapa 1 — Entrada

| | |
|---|---|
| **Acción** | Abre el tablero para ver "qué hay que hacer hoy" |
| **Touchpoint** | Vista **Operación** |
| **Objetivo** | Que lo accionable esté arriba y ordenado por urgencia: casos abiertos → WhatsApp por enviar → contactos faltantes |
| **Fricción** | Si entra y tiene que buscar qué hacer, deja de entrar. La vista se ordena por acción requerida, no por cronología |
| **Métrica** | Ítems accionables resueltos por visita |

### Etapa 2 — Disparo de encuestas

| | |
|---|---|
| **Acción** | Cierra trabajos (o el sistema externo lo hace por API); cada cierre genera una encuesta **con ID propio** (`ENC-0042`) |
| **Touchpoint** | Form de cierre / `POST /api/jobs/close` |
| **Objetivo** | Cero fricción: contacto en memoria, canal inferido, envío diferido automático |
| **Fricción** | Si el ID no es legible/citable, la encuesta no se puede referenciar en una conversación ("te llamo por la ENC-0042") |
| **Métrica** | % de cierres sin carga manual |

### Etapa 3 — Gestión de colas

| | |
|---|---|
| **Acción** | Toca los "Enviar por WhatsApp", carga contactos faltantes, reenvía |
| **Touchpoint** | Vista Operación (colas de acción) |
| **Objetivo** | Vaciar las colas en minutos |
| **Fricción** | Cada ítem debe resolverse en ≤2 taps desde la misma pantalla |
| **Métrica** | Tiempo de permanencia de un ítem en cola |

### Etapa 4 — Consulta puntual (el momento CRM)

| | |
|---|---|
| **Acción** | Un cliente llama: "¿me mandaron algo?" / el dueño pregunta "¿qué pasó con el trabajo de García?" → busca por cliente, trabajo o ID |
| **Touchpoint** | Vista **Encuestas** (registro filtrable) y ficha de **Cliente** |
| **Objetivo** | Encontrar cualquier encuesta en <10 segundos y ver su historia completa |
| **Fricción** | Sin búsqueda + filtros, el registro es un log inútil. Sin ficha por cliente, el contexto se reconstruye a mano |
| **Métrica** | Tiempo hasta encontrar el registro |

### Etapa 5 — Gestión de casos

| | |
|---|---|
| **Acción** | Trabaja los insatisfechos: llama, anota, cambia estado, resuelve |
| **Touchpoint** | Casos en Operación + ficha del cliente |
| **Objetivo** | Ningún caso abierto sin actividad por más de una semana (el seguimiento automático lo garantiza) |
| **Métrica** | Tiempo de resolución de casos |

### Etapa 6 — Lectura de resultados (dueño)

| | |
|---|---|
| **Acción** | Mira cómo viene el negocio: general, por tipo de servicio, por cliente |
| **Touchpoint** | Vista **Resultados** |
| **Objetivo** | Responder en un vistazo: ¿estamos bien? ¿qué servicio anda mal? ¿qué cliente está en riesgo? |
| **Fricción** | El promedio general esconde el problema puntual: el corte por tipo y por cliente es lo que hace accionable el número |
| **Métrica** | Decisiones tomadas a partir del corte (ej: revisar un servicio con satisfacción baja) |

---

## Modelo de vistas

```
Operación   →  hacer      colas de acción + casos (lo de hoy)
Encuestas   →  buscar     registro CRM: toda encuesta con ID, estado, filtros
Clientes    →  contexto   lista con agregados + ficha con timeline por cliente
Resultados  →  decidir    general (empresa) · por tipo de servicio · por cliente
```

Separación deliberada por *job-to-be-done*: **hacer** (operario, varias veces
por día), **buscar** (operario, cuando alguien pregunta), **decidir** (dueño,
semanal). Mezclarlas en una sola pantalla es lo que vuelve inusables los CRM
chicos.

## Mejores prácticas CRM aplicadas

1. **ID legible y citable por registro** (`ENC-0042`): una encuesta se
   referencia en una llamada, un ticket o un chat. Interno sigue siendo el
   `id` numérico; el código es presentación.
2. **El cliente es la entidad central, no la encuesta.** La ficha de cliente
   unifica: contacto, trabajos, encuestas, respuestas, casos y actividad en
   una sola línea de tiempo. La pregunta real nunca es "¿qué pasó con la
   encuesta X?" sino "¿qué pasa con este cliente?".
3. **Pipeline con estados explícitos y excluyentes**, validados en la base
   (`CHECK`): `pendiente de contacto → programada → lista → enviada →
   respondida`, y para casos `abierto → en tratamiento → resuelto`. Ningún
   registro "en el limbo".
4. **Todo contacto saliente queda registrado** (tabla `outbox` = activity
   log). Auditabilidad: se puede reconstruir qué se le mandó a quién y cuándo.
5. **Deduplicación en el ingreso, no después**: cliente único por nombre
   normalizado; el contacto cargado una vez queda en memoria y se completa
   (nunca se pisa con vacío). Un CRM con duplicados deja de ser confiable.
6. **Métricas derivadas, nunca cacheadas**: los agregados se calculan por
   consulta sobre la fuente de verdad. Sin contadores que se desincronizan.
7. **Accionable > vanity**: el corte por tipo de servicio y por cliente
   existe para decidir (qué servicio revisar, a qué cliente llamar), no para
   decorar. Los clientes en riesgo son una lista de llamadas, no un número.
8. **Los datos son del negocio**: export CSV de cualquier vista filtrada.
   Sin lock-in ni "pedile el dump al programador".
9. **Filtros que combinan**: estado × tipo de servicio × búsqueda de texto
   (cliente, trabajo, ID). Hoy client-side (volumen SMB); si el registro
   crece a decenas de miles, pasar a filtros server-side con paginación —
   la API ya devuelve el dataset completo desde un solo endpoint, el corte
   es transparente para la UI.

### Pendientes conocidos (decisión consciente, no olvido)

- ~~Roles y permisos (operario vs dueño)~~ **Implementado**: dos
  credenciales (operador → Operación; gerente → todo), con la restricción
  aplicada en el server.
- **Timeline con notas manuales por cliente** ("llamé, no atendió"): hoy las
  notas viven en el caso; si se pide, se generaliza a nota por cliente.
- **Merge manual de clientes duplicados** (mismo cliente con dos nombres):
  agregar cuando aparezca el primer duplicado real.
