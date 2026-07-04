# Sistema de licencias

Cada vez que un taller usa "Leer datos con IA" en la app, se gasta crédito de
la API de Anthropic (facturado a la cuenta del dueño del proyecto). Para
controlar qué talleres pueden usar esa función, hay un sistema simple de
códigos de licencia:

- **Pantalla de activación** (`taller-gnc-web/index.html`): al abrir la app,
  si no existe la clave `gnc_license_code` en `localStorage`, se muestra una
  pantalla que pide un código antes de cargar el resto de la app. El código
  ingresado se guarda tal cual en `localStorage`.
- **Cambiar código**: el link "Cambiar código de licencia" (junto al nombre
  del taller, arriba de todo) borra `gnc_license_code` de `localStorage` y
  vuelve a mostrar la pantalla de activación. Esto no borra clientes ni fotos
  guardadas — esos datos viven bajo otras claves de `localStorage`.
- **Validación en el servidor** (`taller-gnc-web/api/read-docs.js`): el
  código guardado se manda en el campo `license` del body al llamar a
  `/api/read-docs`. El endpoint lo compara contra la variable de entorno
  `LICENSE_CODES` de Vercel (lista de códigos válidos separados por coma,
  ej. `GNC-0001,GNC-0002`). Si el código no está en la lista, responde
  `403` sin llegar a llamar a la API de Anthropic. Si es válido, se descarta
  el campo `license` antes de reenviar el resto del body a Anthropic (esa
  API no lo espera).
- El front (`runScan`) muestra un error claro si la respuesta es `403`,
  indicando que el código de licencia no es válido.

**Importante:** la variable `LICENSE_CODES` se configura directamente en
Vercel (Project Settings → Environment Variables), no vive en este
repositorio. Sin esa variable configurada, todos los pedidos son rechazados
con 403 por defecto (fail-closed).
