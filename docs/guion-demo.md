# Guión de demo end-to-end (5-7 minutos)

Contra la URL pública. La base ya viene poblada con datos de prueba
(`DEMO_SEED=1`), así que las vistas tienen historia desde el arranque.

## 0. Preparación (antes de la demo)

- Tener la URL abierta y logueada (Basic Auth) en una pestaña.
- Tener el celular a mano (o una segunda pestaña angosta) para el rol "cliente".
- Verificar que la sección Operación muestre casos abiertos del seed.

## 1. El gancho (30 seg) — vista Operación

> "Cada trabajo que se termina dispara una encuesta de una pregunta, solo.
> Esto es lo que ve el dueño al abrir el sistema."

Mostrar: los 4 números, la barra de desglose y, sobre todo, **los casos de
insatisfechos arriba de todo con nombre y teléfono** — "el sistema no te da
un porcentaje, te da a quién llamar hoy".

## 2. El flujo completo en vivo (3 min)

1. **Cerrar un trabajo** (form al pie de Operación): nro `T-2001`, tipo
   `plomería`, cliente nuevo con TU email real.
   > "En producción esto lo hace el sistema del operario solo, por API."
2. Mostrar que quedó **Programada** (envío diferido 45 min).
   > "Espera a que el cliente ya haya visto el trabajo terminado."
   *(Para la demo, con `SEND_DELAY_MINUTES=0` sale al instante; si está en
   45, mostrar la cola de programadas y usar una encuesta `sent` del seed.)*
3. **Abrir el link de la encuesta como cliente** (desde el email si está
   conectado el webhook, o copiando el link de la Actividad): una pregunta,
   tres botones, sin login. Responder **Insatisfecho**.
4. Volver al tablero: **alerta en Actividad + caso abierto arriba de todo**
   con el dato del cliente. "Esto es lo que un negocio paga: enterarse hoy,
   no a fin de mes."
5. **Tratar el caso**: anotar "lo llamé, coordinamos visita", pasar a
   en tratamiento → marcar resuelto. Mostrar que al cliente le sale el
   agradecimiento con foco en la resolución (Actividad).

## 3. WhatsApp sin API de Meta (1 min)

Cerrar otro trabajo con **solo teléfono** (el tuyo). Aparece en la cola
"Para enviar por WhatsApp": tocar el botón → se abre WhatsApp con el
mensaje y el link ya escritos. Enviártelo y responder desde el celular.

> "Cero integración con Meta, cero aprobación. Y si mañana quieren
> automatizarlo del todo, se enchufa un gateway por webhook sin tocar nada."

## 4. La cara CRM (1-2 min)

- **Encuestas**: buscar por ID (`ENC-0003`), filtrar respondidas, exportar CSV.
- **Clientes**: entrar a un cliente "en riesgo" → ficha con timeline completa.
- **Resultados**: el corte por tipo de servicio — "pintura anda mal, limpieza
  bien: esto te dice qué revisar, el promedio general te lo esconde".

## 5. Cierre

> "Responder excelente pide reseña en Google — la satisfacción se convierte
> en marketing. Todo lo que sale queda auditado. Y esto corre sin una sola
> dependencia: un proceso Node y un archivo SQLite."

## Reset

En Render free la base se resetea sola al dormirse el servicio. Para forzar
un reset inmediato: "Manual Deploy → Clear build cache & deploy" o reiniciar
el servicio (el seed repuebla al arrancar).
