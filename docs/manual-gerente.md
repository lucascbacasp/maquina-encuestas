# Manual del Gerente

Tu lugar en el sistema: **leer el estado del negocio en un vistazo y
asegurarte de que ningún cliente insatisfecho quede sin respuesta**.
Tenés acceso total: todo lo que hace el operador, más las vistas de
empresa.

## Cómo entrar

1. Abrí `https://maquina-encuestas.vercel.app` (o el dominio de tu empresa).
2. En la caja **Ingresar**: usuario `admin` y tu clave.
3. Entrás al tablero con las **cuatro pestañas**: Operación · Encuestas ·
   Clientes · Resultados. Sesión de 7 días; **Salir** arriba a la derecha.

## Tus cuatro vistas

### Operación — lo de hoy

La misma vista del operador (podés hacer todo lo que hace él: cerrar
trabajos, enviar WhatsApps, cargar contactos, reenviar, trabajar casos).
Para vos funciona como control diario: ¿hay casos abiertos? ¿se están
vaciando las colas?

### Encuestas — todo lo enviado

El registro completo. Cada encuesta tiene un **ID citable** (`ENC-0042`)
para referenciarla en una llamada o un chat.

- **Filtrar**: por estado (todas / enviadas / respondidas / pendientes),
  por tipo de servicio, o buscando por ID, cliente o número de trabajo.
  Los filtros se combinan.
- **Exportar CSV**: baja exactamente lo que estás viendo filtrado — para
  Excel, para el contador, para donde sea. Los datos son tuyos.
- Click en cualquier fila abre la ficha del cliente.

Usos típicos: *"¿le mandamos algo a García?"* → buscá "García".
*"¿Qué pasó con la ENC-0031?"* → buscá el ID.

**Crear una encuesta y mandar el link** (arriba de todo en esta vista):

1. Completá el cliente (email/WhatsApp opcionales; si ya existe, usa el
   contacto guardado) y el motivo.
2. Elegí el formato: **Simple** (3 opciones, un tap) o **CSAT** (escala
   1 a 5: Muy insatisfecho → Muy satisfecho).
3. **Crear encuesta → obtener link**: te devuelve el link listo para
   copiar y mandar por donde quieras (y el botón de WhatsApp si cargaste
   teléfono). Si hay email, además sale por el canal automático.
4. Los puntajes CSAT alimentan las mismas métricas: 1-2 cuenta como
   insatisfecho (dispara alerta y caso), 3 bueno, 4-5 excelente — y el
   puntaje exacto queda guardado.

**Ver la respuesta de una encuesta**: en el registro, el link **ver →**
de cada fila abre el detalle: puntaje exacto (ej: CSAT 2/5), fecha y
tiempo de respuesta, el caso vinculado con sus notas, y la historia
completa de envíos de esa encuesta.

### Clientes — el contexto de cada uno

- Lista con agregados: cuántas encuestas, % de respuesta, desglose de
  resultados y el badge **en riesgo** (2 o más insatisfechos — esa es tu
  lista de llamadas preventivas).
- Click en un cliente → **ficha con línea de tiempo completa**: cada
  trabajo cerrado, cada envío, cada respuesta, cada caso con sus notas.
  La historia entera antes de levantar el teléfono.

### Resultados — cómo viene la empresa

- **General**: % enviadas, % respondidas, % satisfacción y el desglose
  insatisfecho/bueno/excelente.
- **Por tipo de servicio**: el corte que el promedio esconde. Si pintura
  tiene 0% de satisfacción y limpieza 100%, ya sabés qué revisar el lunes.
- **Por cliente**: quién responde, quién está conforme, quién no.

## Lo que el sistema hace solo (y te avisa)

- **Alerta inmediata** por cada respuesta "Insatisfecho", con nombre y
  contacto del cliente. Hoy queda en la Actividad del tablero; al conectar
  el webhook de salida te llega por email/WhatsApp.
- **Seguimiento semanal**: si un caso sigue abierto a los 7 días, te lo
  recuerda hasta que se resuelva.
- **Reenvío automático** a las 48 hs a quien no respondió (máximo 1).
- **Reseña de Google**: a quien responde "Excelente" le pide la reseña
  (configurable con `GOOGLE_REVIEW_URL`).

## Administración (una vez, o cada tanto)

- **Claves**: se cambian en Vercel → Settings → Environment Variables
  (`ADMIN_PASS`, `OPERATOR_PASS`) + Redeploy. Cambiar una clave cierra
  todas las sesiones abiertas.
- **Verificar el sistema**: `/api/selftest` responde `ok: true` con el
  estado del backend y los conteos.
- **Integración**: tu sistema de gestión puede disparar encuestas solo
  con `POST /api/jobs/close` — pedile a tu proveedor que lo conecte.

## Tu journey: la semana tipo

> **Lunes 8:30** — Abrís **Resultados** con el café. Satisfacción general
> 78%. Pero el corte por tipo muestra pintura en 40% mientras el resto está
> arriba de 85%. Anotás hablar con la cuadrilla de pintura.
>
> **Lunes 8:40** — Pestaña **Clientes**: "Clínica San Justo" tiene el badge
> **en riesgo** (2 insatisfechos en el mes). Abrís su ficha: las dos quejas
> son de limpieza de vidrios, las dos resueltas, pero el patrón está. La
> llamás vos antes de que se vaya a la competencia.
>
> **Miércoles 15:20** — Te suena la alerta: insatisfecho nuevo de un
> trabajo de hoy. Miras **Operación**: el operador ya lo llamó y el caso
> está "en tratamiento" con notas. No hacés nada — el sistema ya te
> mostrará si en una semana sigue abierto.
>
> **Viernes 17:00** — El contador pide los datos del mes. **Encuestas** →
> filtro "respondidas" → **Exportar CSV**. Treinta segundos.
>
> **Fin de mes** — En **Resultados**, pintura subió a 75% después del
> cambio de cuadrilla. El corte por tipo te lo confirma con datos, no con
> sensaciones.

La regla que paga el sistema: **un insatisfecho contactado el mismo día es
un cliente recuperado; el mismo insatisfecho descubierto a fin de mes es un
cliente perdido.** Todo el tablero está ordenado alrededor de eso.
