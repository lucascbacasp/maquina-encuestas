# Manual del Operador

Tu trabajo en el sistema: **terminar un servicio y que la encuesta salga
sola**. Todo lo tuyo vive en una sola pantalla.

## Cómo entrar

1. Abrí `https://maquina-encuestas.vercel.app` (o el dominio de tu empresa).
2. En la caja **Ingresar**: usuario `operador` y tu clave.
3. Entrás directo a la vista **Operación**. La sesión dura 7 días; para
   cerrar la sesión usá el botón **Salir** arriba a la derecha.

## Qué ves al entrar

De arriba hacia abajo, ordenado por urgencia:

1. **Los números de hoy**: % enviadas, % respondidas, % satisfacción y
   casos abiertos, con la barra de colores (rojo/amarillo/verde).
2. **Casos de insatisfechos** — lo más urgente, siempre primero.
3. **Para enviar por WhatsApp** — encuestas esperando tu tap.
4. **Sin contacto** — encuestas frenadas por falta de email/teléfono.
5. **Enviadas sin respuesta** — con botón de reenvío.
6. **Programadas** — las que van a salir solas (envío diferido).
7. **Actividad** — registro de todo lo que salió del sistema.
8. **Cerrar trabajo** — el form para disparar una encuesta nueva.

## Acciones, paso a paso

### 1. Cerrar un trabajo (dispara la encuesta)

1. Bajá hasta **Cerrar trabajo**.
2. Completá: número de trabajo, tipo (ej: plomería), nombre del cliente.
3. Email y WhatsApp son opcionales **si el cliente ya existe** — el sistema
   recuerda los contactos: escribí el mismo nombre y usa el guardado.
4. Botón **Cerrar trabajo → disparar encuesta**. Listo:
   - Cliente con **email** → la encuesta sale sola a los 45 minutos.
   - Cliente con **solo WhatsApp** → a los 45 minutos aparece en tu cola
     de "Para enviar por WhatsApp".
   - **Sin contacto** → queda en "Sin contacto" hasta que lo cargues.

> Si tu empresa conectó su sistema de gestión, este paso es automático:
> cada trabajo cerrado allá dispara la encuesta acá, sin que hagas nada.

### 2. Enviar por WhatsApp (un tap)

1. En **Para enviar por WhatsApp**, tocá **Enviar por WhatsApp →**.
2. Se abre tu WhatsApp con el mensaje y el link ya escritos.
3. Tocá enviar en WhatsApp. Nada más — el sistema ya la marcó como enviada.

### 3. Cargar un contacto faltante

1. En **Sin contacto**, escribí el email **o** el WhatsApp del cliente
   (el WhatsApp con código de país, ej: `5491122334455`).
2. **Guardar y enviar**. La encuesta sale al instante y el dato queda
   guardado: el próximo trabajo de ese cliente sale solo.

### 4. Reenviar una encuesta sin respuesta

- Las de **email** se reenvían solas a las 48 hs (una vez y corta).
- Si querés adelantarte: botón **Reenviar** (email) o **Reenviar por
  WhatsApp →** (tap). El límite es **1 reenvío por encuesta** — el sistema
  no deja mandar más, para no quemar la base.

### 5. Trabajar un caso de insatisfecho

Cuando un cliente responde "Insatisfecho", aparece arriba de todo con su
nombre y contacto. La regla de oro: **llamarlo hoy**.

1. Llamalo. Anotá el resultado en **Notas del caso** y tocá **Guardar notas**.
2. Si el tema quedó en proceso: **Pasar a en tratamiento**.
3. Cuando lo solucionaste: **Marcar resuelto** — el sistema le manda al
   cliente un agradecimiento contando que se resolvió (si es de WhatsApp,
   se te abre el mensaje listo para enviar).
4. Si un caso queda abierto más de una semana, el sistema le recuerda al
   gerente solo — mejor resolverlo antes.

## Qué NO vas a ver

El registro completo de encuestas, las fichas de clientes y los resultados
globales son vistas del gerente. Si necesitás un dato de ahí (ej: "¿qué
respondió tal cliente el mes pasado?"), pedíselo.

## Tu journey: un día tipo

> **8:55** — Entrás al tablero con el mate. Hay **1 caso abierto** en rojo:
> Dario Sosa respondió insatisfecho anoche por la pintura del living.
>
> **9:00** — Lo llamás. Se queja de una mancha que quedó. Coordinás pasar
> el jueves. Anotás "coordinada visita jueves" y pasás el caso a
> **en tratamiento**.
>
> **9:05** — Hay 2 encuestas en la cola de WhatsApp. Dos taps, dos enviadas.
> Una tercera está "Sin contacto": buscás el teléfono en el cuaderno de la
> camioneta, lo cargás, **Guardar y enviar**. Ese cliente ya queda para
> siempre.
>
> **12:30** — Terminás una instalación eléctrica. Antes de arrancar la
> camioneta: **Cerrar trabajo**, `T-2041`, `electricidad`, `Marta Ledesma`.
> Marta ya existe: cero datos extra. La encuesta le va a llegar sola a las
> 13:15, cuando ya haya probado las luces.
>
> **Jueves** — Fuiste a lo de Dario, se repintó la pared. **Marcar
> resuelto**: Dario recibe un mensaje agradeciéndole el aviso. De paso ves
> en los números de hoy que la satisfacción de la semana está en verde.

El sistema está diseñado para que tu parte tome **menos de un minuto por
trabajo**. Todo lo demás sale solo.
