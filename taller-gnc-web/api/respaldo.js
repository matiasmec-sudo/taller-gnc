// Respaldo cifrado en la nube (Vercel Blob, store PRIVADO).
//
// Importante para la privacidad: el contenido llega YA CIFRADO desde el
// dispositivo del taller (AES-GCM con una clave que solo el taller conoce).
// Este servidor solo guarda y devuelve paquetes cifrados — ni nosotros ni
// Vercel podemos leer los datos. El store es privado: los archivos no son
// accesibles por URL sin el token del servidor.
import { put, list, del } from '@vercel/blob';
import crypto from 'crypto';

const NOMBRE_VALIDO = /^[a-z0-9][a-z0-9-]{0,80}\.json$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Falta configurar BLOB_READ_WRITE_TOKEN en Vercel.' });
  }

  // Solo talleres con licencia válida pueden usar el respaldo.
  const validCodes = (process.env.LICENSE_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
  const { license, accion, nombre, contenido, vigentes } = req.body || {};
  if (!validCodes.includes(license)) {
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
      const l = await list({ prefix: `${carpeta}/${nombre}` });
      const blob = l.blobs.find(b => b.pathname === `${carpeta}/${nombre}`);
      if (!blob) return res.status(404).json({ error: 'No hay ninguna copia guardada con ese nombre.' });
      const r = await fetch(blob.url, {
        headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      });
      if (!r.ok) return res.status(500).json({ error: 'No se pudo leer la copia del storage.' });
      const datos = await r.json();
      return res.status(200).json({ ok: true, contenido: datos, subido: blob.uploadedAt });
    }

    if (accion === 'depurar') {
      // Borra los archivos que ya no forman parte de la copia (por ejemplo,
      // fotos de clientes eliminados). "vigentes" es la lista de nombres que
      // deben conservarse.
      const setVigentes = new Set(Array.isArray(vigentes) ? vigentes : []);
      const l = await list({ prefix: carpeta + '/' });
      const aBorrar = l.blobs.filter(b => !setVigentes.has(b.pathname.slice(carpeta.length + 1)));
      if (aBorrar.length) await del(aBorrar.map(b => b.url));
      return res.status(200).json({ ok: true, borrados: aBorrar.length });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor de respaldo.' });
  }
}
