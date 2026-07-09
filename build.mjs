// Paso de compilacion de Estelita.
//
// Lee el codigo LEGIBLE (taller-gnc-web/index.src.html), lo minifica y ofusca
// (quita comentarios, junta todo y renombra las variables internas), y escribe
// el archivo que se publica (taller-gnc-web/index.html).
//
// IMPORTANTE: editar SIEMPRE index.src.html (el legible). index.html se genera
// solo con `npm run build` y NO se edita a mano.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { minify } from 'html-minifier-terser';

const raiz = dirname(fileURLToPath(import.meta.url));
const origen = join(raiz, 'taller-gnc-web', 'index.src.html');
const destino = join(raiz, 'taller-gnc-web', 'index.html');

// Aviso legal que se conserva arriba de todo, incluso en el archivo publicado.
const BANNER = '<!-- (c) Estelita - Matias Agustin Casimir. Software propietario. Todos los derechos reservados. Prohibida su reproduccion o distribucion total o parcial. -->\n';

const fuente = (await readFile(origen, 'utf8')).replace(/^﻿/, '');

const minificado = await minify(fuente, {
  collapseWhitespace: true,
  conservativeCollapse: true,   // no borra espacios significativos entre elementos
  removeComments: true,
  minifyCSS: true,
  minifyJS: {
    compress: true,
    mangle: true,               // renombra variables LOCALES (no toplevel: no rompe globals entre <script>)
    format: { comments: false },
  },
  ignoreCustomFragments: [/<%[\s\S]*?%>/, /<\?[\s\S]*?\?>/],
});

await writeFile(destino, BANNER + minificado, 'utf8');

const antes = fuente.length;
const despues = (BANNER + minificado).length;
console.log(`Build OK: index.src.html (${antes} bytes) -> index.html (${despues} bytes, ${Math.round((1 - despues / antes) * 100)}% mas chico)`);
