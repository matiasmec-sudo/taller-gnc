# Mi Taller GNC — cómo publicarlo en tu propio sitio

Esta carpeta ya tiene todo armado. Vas a usar **Vercel** (tiene un plan gratis
de sobra para este uso, no pide tarjeta de crédito para el plan gratuito).

## Paso 1 — Conseguí tu clave de API de Anthropic
1. Entrá a https://console.anthropic.com y creá una cuenta (es distinta de tu
   cuenta de claude.ai — esta es para desarrolladores).
2. Cargá una forma de pago ahí (esto es lo que te va a cobrar, por uso, cada
   vez que leas fotos con IA — son centavos de dólar por lectura).
3. Andá a "API Keys" → "Create Key" → copiá la clave (empieza con `sk-ant-...`).
   Guardala en un lugar seguro, no la compartas.

## Paso 2 — Subí este proyecto a Vercel
1. Entrá a https://vercel.com y creá una cuenta gratis (podés entrar con tu
   cuenta de GitHub, Google, etc.)
2. Necesitás que esta carpeta esté en un repositorio de GitHub:
   - Si no usás GitHub todavía, creá una cuenta gratis en https://github.com
   - Creá un repositorio nuevo (por ejemplo "taller-gnc")
   - Subí todos los archivos de esta carpeta ahí (se puede arrastrar y soltar
     desde la propia web de GitHub, en "Add file" → "Upload files")
3. En Vercel: "Add New..." → "Project" → elegí el repositorio que acabás de crear.
4. Antes de darle a "Deploy", buscá la sección "Environment Variables" y agregá:
   - Nombre: `ANTHROPIC_API_KEY`
   - Valor: la clave que copiaste en el Paso 1
5. Dale a "Deploy". En 1-2 minutos te da una URL tipo
   `https://taller-gnc-tu-nombre.vercel.app` — esa es tu app, ya online.

## Paso 3 — Instalarla en tu celular
1. Abrí esa URL en Chrome (Android) o Safari (iPhone) desde tu celular.
2. Agregala a la pantalla de inicio (en Chrome: los 3 puntitos → "Añadir a
   pantalla de inicio"; en Safari: compartir → "Añadir a pantalla de inicio").
3. Como ahora es tu propio sitio (no una página dentro de Claude), esta vez sí
   debería funcionar como una app real, con las fotos y la lectura con IA
   andando normalmente.

## Cosas para tener en cuenta
- **Los datos se guardan en el navegador de cada celular/computadora donde
  entres.** Si entrás desde el celular y después desde una notebook, vas a
  ver bases de datos distintas (no se sincronizan solas). Si eso te complica,
  avisame y vemos cómo sumar una base de datos compartida más adelante.
- **Cada lectura de fotos con IA tiene un costo real** (se descuenta de la
  tarjeta que cargaste en la consola de Anthropic). Para uso personal de un
  taller es un costo bajísimo, pero es bueno que lo sepas.
- Si en algún momento querés que esto lo usen **varios talleres, cada uno con
  su cuenta y sus propios clientes separados**, hay que sumar un sistema de
  login y una base de datos compartida — es la "Etapa 2" de la que hablamos,
  avisame cuando quieras encararla.
