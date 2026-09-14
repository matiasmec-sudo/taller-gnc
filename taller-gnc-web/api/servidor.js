// La puerta para los OTROS servidores de Estelita (Estelita Repuestos, el CRM).
//
// /api/licencia es público y contesta sólo "sí o no", con límite de intentos
// por IP porque cualquiera puede probar códigos. Un servidor nuestro necesita
// más que eso: saber POR QUÉ una licencia no vale (suspendida, vencida, el
// correo no es el del titular), avisar el consumo de IA para que el panel lo
// sume, y pedir permiso contra el tope diario. Y no puede quedar bloqueado por
// el límite de intentos: un servidor que verifica todas sus licencias una vez
// por día desde una sola IP haría saltar el límite con seis suspendidas.
//
// Por eso este endpoint se protege con un secreto compartido (SERVIDOR_SECRET
// en Vercel; la misma variable en el .env de cada servidor) en vez de con
// límite por IP. Sin la variable configurada, no contesta nada (fail-closed).
//
//   POST /api/servidor   header x-servidor-secret: <secreto>
//   { accion: 'verificar', license, email?, producto? }
//       → 200 { ok: true, motivo: 'ok', licencia: {...} }
//       → 403 { ok: false, motivo: 'inexistente'|'suspendida'|'vencida'|'producto'|'email', licencia? }
//   { accion: 'tope', license }          → { ok, usado, tope }   (cuenta UNA lectura si hay tope)
//   { accion: 'consumo', license, model, usage: { input_tokens, output_tokens } } → { ok: true }
import crypto from 'crypto';
import { licenciaDetalle, chequearTope, registrarConsumo, PRODUCTOS } from './_licencias.js';

function secretoOk(req) {
  const recibido = String(req.headers['x-servidor-secret'] || '');
  const esperado = String(process.env.SERVIDOR_SECRET || '');
  if (!esperado || esperado.length < 16 || !recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!secretoOk(req)) {
    // Retardo fijo: un secreto mal puesto no se adivina a fuerza de intentos.
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'Secreto de servidor incorrecto o no configurado.' });
  }
  const body = req.body || {};
  const license = String(body.license || '').trim().toUpperCase();
  if (!license) return res.status(400).json({ error: 'Falta license.' });

  try {
    if (body.accion === 'verificar') {
      const producto = PRODUCTOS[body.producto] ? body.producto : undefined;
      const r = await licenciaDetalle(license, { email: body.email, producto });
      return res.status(r.ok ? 200 : 403).json(r);
    }
    if (body.accion === 'tope') {
      const t = await chequearTope(license);
      return res.status(200).json({ ok: !!t.ok, usado: t.usado ?? null, tope: t.tope ?? null });
    }
    if (body.accion === 'consumo') {
      await registrarConsumo(license, String(body.model || ''), body.usage);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor.' });
  }
}
