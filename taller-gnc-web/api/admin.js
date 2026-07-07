// Panel de administración de licencias (privado, solo para el dueño).
// Protegido por ADMIN_TOKEN (variable de entorno en Vercel). Gestiona el
// store de licencias en Blob: listar, agregar, editar, suspender/reactivar y
// eliminar. La primera vez importa (seed) los códigos de LICENSE_CODES para
// que el panel muestre también los que ya estaban en uso.
import crypto from 'crypto';
import { leerLicencias, guardarLicencias, codigosEnv, leerActividad, leerConsumoMes } from './_licencias.js';

function tokenOk(req) {
  const provided = String((req.headers['x-admin-token'] || (req.body && req.body.token) || ''));
  const expected = String(process.env.ADMIN_TOKEN || '');
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O/0/I/1/L, para dictar por teléfono
function nuevoCodigo(existentes) {
  const set = new Set(existentes);
  let c;
  do {
    c = 'GNC-' + Array.from({ length: 4 }, () => ALFA[crypto.randomInt(ALFA.length)]).join('');
  } while (set.has(c));
  return c;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  // Retardo fijo en cada intento: frena el probado por fuerza bruta de la clave.
  await new Promise(r => setTimeout(r, 400));
  if (!tokenOk(req)) return res.status(401).json({ error: 'Contraseña incorrecta.' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ error: 'Falta BLOB_READ_WRITE_TOKEN en Vercel.' });

  try {
    let lics = await leerLicencias();

    // Seed: si el store está vacío, traer los códigos que ya estaban en el env.
    if (!lics.length) {
      const hoy = new Date().toISOString().slice(0, 10);
      const env = codigosEnv();
      if (env.length) {
        lics = env.map(c => ({ codigo: c, taller: '', estado: 'activo', alta: hoy, topeDia: 50, notas: '' }));
        await guardarLicencias(lics);
      }
    }

    const { accion } = req.body || {};

    if (accion === 'listar') {
      const [act, consumo] = await Promise.all([leerActividad(30), leerConsumoMes()]);
      let costoTotalMes = 0;
      const conAct = lics.map(l => {
        const a = act[l.codigo] || {};
        const c = consumo[l.codigo] || {};
        costoTotalMes += Number(c.costoUSD) || 0;
        return {
          ...l,
          usoTotal: a.total || 0, usoHoy: a.hoy || 0, ultimoUso: a.ultimo || null,
          costoMesUSD: Number(c.costoUSD) || 0, readsMes: Number(c.reads) || 0,
        };
      });
      return res.status(200).json({ ok: true, licencias: conAct, costoTotalMes, mes: new Date().toISOString().slice(0, 7) });
    }

    if (accion === 'agregar') {
      const taller = String(req.body.taller || '').trim();
      const topeDia = Number(req.body.topeDia) > 0 ? Number(req.body.topeDia) : 50;
      const codigo = nuevoCodigo(lics.map(l => l.codigo).concat(codigosEnv()));
      lics.push({ codigo, taller, estado: 'activo', alta: new Date().toISOString().slice(0, 10), topeDia, notas: '' });
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true, codigo });
    }

    if (accion === 'editar') {
      const l = lics.find(x => x.codigo === req.body.codigo);
      if (!l) return res.status(404).json({ error: 'No existe esa licencia.' });
      if (typeof req.body.taller === 'string') l.taller = req.body.taller.trim();
      if (typeof req.body.notas === 'string') l.notas = req.body.notas.trim();
      if (req.body.topeDia !== undefined && Number(req.body.topeDia) >= 0) l.topeDia = Number(req.body.topeDia);
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'estado') {
      const l = lics.find(x => x.codigo === req.body.codigo);
      if (!l) return res.status(404).json({ error: 'No existe esa licencia.' });
      l.estado = req.body.estado === 'activo' ? 'activo' : 'suspendido';
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'eliminar') {
      const antes = lics.length;
      lics = lics.filter(x => x.codigo !== req.body.codigo);
      if (lics.length === antes) return res.status(404).json({ error: 'No existe esa licencia.' });
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor.' });
  }
}
