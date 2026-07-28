// Respaldo cifrado en la nube (Vercel Blob, store PRIVADO).
//
// Importante para la privacidad: el contenido llega YA CIFRADO desde el
// dispositivo del taller (AES-GCM con una clave que solo el taller conoce).
// Este servidor solo guarda y devuelve paquetes cifrados — ni nosotros ni
// Vercel podemos leer los datos. El store es privado: los archivos no son
// accesibles por URL sin el token del servidor.
import { put, list, del } from '@vercel/blob';
import crypto from 'crypto';
import { licenciaValida } from './_licencias.js';

const NOMBRE_VALIDO = /^[a-z0-9][a-z0-9-]{0,80}\.json$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Falta configurar BLOB_READ_WRITE_TOKEN en Vercel.' });
  }

  // Solo talleres con licencia válida pueden usar el respaldo.
  const { license, accion, nombre, contenido, vigentes } = req.body || {};
  if (!(await licenciaValida(license))) {
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }

  // Cada licencia tiene su carpeta propia (hash de la licencia — el código
  // en sí no queda expuesto en las rutas del storage).
  const carpeta = 'respaldos/' + crypto.createHash('sha256').update('estelita:' + license).digest('hex');

  try {
    if (accion === 'subir') {
      if (!NOMBRE_VALIDO.test(nombre || '')) return res.status(400).json({ error: 'Nombre de archivo inválido.' });
      if (!contenido || typeof contenido !== 'object') return res.status(400).json({ error: 'Falta el contenido.' });
      await put(`${carpeta}/${nombre}`, JSON.stringify(contenido), {
        access: 'private', addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json',
        // Evita que el CDN sirva una copia vieja tras sobrescribir.
        cacheControlMaxAge: 0,
      });
      return res.status(200).json({ ok: true });
    }

    if (accion === 'listar') {
      const l = await list({ prefix: carpeta + '/' });
      return res.status(200).json({
        ok: true,
        archivos: l.blobs.map(b => ({
          nombre: b.pathname.slice(carpeta.length + 1),
          subido: b.uploadedAt,
          tam: b.size,
        })),
      });
    }

    if (accion === 'bajar') {
      if (!NOMBRE_VALIDO.test(nombre || '')) return res.status(400).json({ error: 'Nombre de archivo inválido.' });
      // Lectura por URL directa (consistente al instante) en vez de list()
      // (consistencia eventual: puede no ver archivos recién subidos).
      const partes = (process.env.BLOB_READ_WRITE_TOKEN || '').split('_');
      const url = `https://${(partes[3] || '').toLowerCase()}.private.blob.vercel-storage.com/${carpeta}/${nombre}`;
      // El parámetro anti-caché evita 404 viejos o versiones anteriores
      // servidas por el CDN; el reintento cubre el caché negativo (~1s) de
      // rutas consultadas antes de existir.
      let r;
      for (let intento = 0; ; intento++) {
        r = await fetch(`${url}?nc=${Date.now()}`, {
          headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
          cache: 'no-store',
        });
        if (r.status !== 404 || intento >= 2) break;
        await new Promise(res2 => setTimeout(res2, 800));
      }
      if (r.status === 404) return res.status(404).json({ error: 'No hay ninguna copia guardada con ese nombre.' });
      if (!r.ok) return res.status(500).json({ error: 'No se pudo leer la copia del storage.' });
      const datos = await r.json();
      const lm = r.headers.get('last-modified');
      return res.status(200).json({ ok: true, contenido: datos, subido: lm ? new Date(lm).toISOString() : null });
    }

    if (accion === 'depurar') {
      // Borra los archivos que ya no forman parte de la copia (por ejemplo,
      // fotos de clientes eliminados). "vigentes" es la lista de nombres que
      // deben conservarse.
      //
      // GUARDAS: esta acción es la única que borra, y no tiene papelera ni
      // versionado. Un cliente que mande una lista vacía o incompleta (app
      // recién instalada, datos todavía sin cargar, bug) se llevaba puesto el
      // respaldo entero del taller. Antes de borrar, dos controles.
      if (!Array.isArray(vigentes) || !vigentes.length) {
        return res.status(400).json({ error: 'No se depuró nada: la lista de archivos vigentes vino vacía.' });
      }
      // La copia siempre tiene que incluir el archivo principal. Si no está,
      // el cliente no sabe realmente qué conservar.
      if (!vigentes.includes('datos.json')) {
        return res.status(400).json({ error: 'No se depuró nada: la lista de archivos vigentes no incluye la copia principal.' });
      }

      const setVigentes = new Set(vigentes);
      const l = await list({ prefix: carpeta + '/' });
      const aBorrar = l.blobs.filter(b => !setVigentes.has(b.pathname.slice(carpeta.length + 1)));

      // Freno de mano: si el borrado se lleva más del 60% de lo guardado, casi
      // seguro es un error del cliente y no una limpieza legítima.
      const total = l.blobs.length;
      if (total > 1 && aBorrar.length > Math.ceil(total * 0.6)) {
        return res.status(409).json({
          error: `Se frenó la limpieza por seguridad: iba a borrar ${aBorrar.length} de ${total} archivos guardados. Si de verdad querés depurar tanto, escribinos.`,
          borrados: 0,
        });
      }

      if (aBorrar.length) await del(aBorrar.map(b => b.url));
      return res.status(200).json({ ok: true, borrados: aBorrar.length });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor de respaldo.' });
  }
}
