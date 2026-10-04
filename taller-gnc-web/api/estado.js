// Estado de trámites por patente (Nivel 2: integración con el CRM de WhatsApp).
//
// POST: Estelita empuja el índice de estados del taller {license, estados}.
//   estados = { "AA123BB": { nombre, estado, obleaLista, obleaListaEn, proximoTurno,
//                            vencOblea, vencCilindro, vencReal, aniosCilindro, sinGnc }, ... }
// GET ?license=X&patente=Y: el CRM consulta el estado de una patente para que
//   el agente responda "¿está lista tu oblea?" con datos reales.
//
// Autenticado con el código de licencia del taller (el mismo que ya usa la app).
// El índice es NO sensible (no lleva fotos ni DNI), solo estado del trámite.
//
// Igual que /api/licencia, este endpoint es un "oráculo": contesta distinto
// según si el código existe o no, así que sirve para probar códigos hasta dar
// con uno válido. Por eso tiene el mismo límite de intentos por IP.
import { licenciaValida, leerEstadoTramites, guardarEstadoTramites } from './_licencias.js';
import { chequearIntentos, registrarFallo, registrarAciertoSiHaceFalta, esperar } from './_ratelimit.js';

export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Falta BLOB_READ_WRITE_TOKEN en Vercel.' });
  }

  const limite = await chequearIntentos(req, { max: 6, ventanaMs: 10 * 60 * 1000, bloqueoMs: 5 * 60 * 1000 });
  if (!limite.ok) {
    res.setHeader('Retry-After', String(limite.segundos));
    return res.status(429).json({ error: 'Demasiados intentos con códigos que no existen. Esperá unos minutos y probá de nuevo.' });
  }

  if (req.method === 'POST') {
    const { license, estados } = req.body || {};
    if (!(await licenciaValida(license))) {
      await esperar(await registrarFallo(req, { reiniciar: limite.reiniciar, datos: limite.datos }));
      return res.status(403).json({ error: 'Código de licencia no válido.' });
    }
    await registrarAciertoSiHaceFalta(req, limite);
    if (!estados || typeof estados !== 'object' || Array.isArray(estados)) {
      return res.status(400).json({ error: 'Faltan los estados.' });
    }
    // Tope defensivo: hasta 5000 patentes por taller.
    const claves = Object.keys(estados).slice(0, 5000);
    const limpio = {};
    for (const k of claves) limpio[k] = estados[k];
    await guardarEstadoTramites(license, limpio);
    return res.status(200).json({ ok: true, guardadas: claves.length });
  }

  if (req.method === 'GET') {
    const license = req.query.license;
    if (!(await licenciaValida(license))) {
      await esperar(await registrarFallo(req, { reiniciar: limite.reiniciar, datos: limite.datos }));
      return res.status(403).json({ error: 'Código de licencia no válido.' });
    }
    await registrarAciertoSiHaceFalta(req, limite);
    const patente = String(req.query.patente || '').trim().toUpperCase().replace(/\s+/g, '');
    const data = await leerEstadoTramites(license);
    const estados = (data && data.estados) || {};
    if (patente) {
      const rec = estados[patente] || null;
      return res.status(200).json({
        ok: true, patente, encontrado: !!rec,
        estado: rec, actualizado: (data && data.actualizado) || null,
      });
    }
    return res.status(200).json({ ok: true, estados, actualizado: (data && data.actualizado) || null });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
