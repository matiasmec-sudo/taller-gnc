// Buzón de pedidos de turno desde WhatsApp (Nivel 2: CRM → Estelita).
//
// POST: el CRM empuja un pedido de turno del cliente.
//   { license, turno: { nombre, telefono, patente, vehiculo, detalle } }
//   { license, accion: 'quitar', id }  → Estelita saca uno ya cargado a la agenda.
// GET ?license=X: Estelita lee los pedidos pendientes.
//
// Autenticado con el código de licencia del taller (el mismo que usa la app).
// NO lleva datos sensibles (sin fotos ni DNI): solo nombre, teléfono y qué pidió.
import { licenciaValida, agregarTurnoWa, leerTurnosWa, quitarTurnoWa } from './_licencias.js';

export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Falta BLOB_READ_WRITE_TOKEN en Vercel.' });
  }

  if (req.method === 'POST') {
    const { license, turno, id, accion } = req.body || {};
    if (!(await licenciaValida(license))) {
      return res.status(403).json({ error: 'Código de licencia no válido.' });
    }
    if (accion === 'quitar') {
      if (!id) return res.status(400).json({ error: 'Falta el id.' });
      const quitado = await quitarTurnoWa(license, id);
      return res.status(200).json({ ok: true, quitado });
    }
    if (!turno || typeof turno !== 'object') {
      return res.status(400).json({ error: 'Falta el turno.' });
    }
    const item = await agregarTurnoWa(license, turno);
    return res.status(200).json({ ok: true, id: item.id });
  }

  if (req.method === 'GET') {
    const license = req.query.license;
    if (!(await licenciaValida(license))) {
      return res.status(403).json({ error: 'Código de licencia no válido.' });
    }
    const turnos = await leerTurnosWa(license);
    return res.status(200).json({ ok: true, turnos });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
