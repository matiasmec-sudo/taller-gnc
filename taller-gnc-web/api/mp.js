// Endpoint del front para las suscripciones de Mercado Pago.
// - crear-suscripcion: crea una preapproval en MP y devuelve el link de pago.
// - estado-signup: la página de "gracias" pregunta acá si ya se creó el código.
//
// Sirve para los dos productos. `producto` ('taller', el default, o
// 'repuestos') elige la tabla de precios, el nombre que ve el cliente en MP y
// a dónde vuelve después de pagar: Estelita vuelve a gracias.html de este
// sitio; Repuestos vuelve a su propia página /gracias (en repuestos.estelita.
// net.ar), que consulta el estado por su servidor. El webhook es el mismo.
import crypto from 'crypto';
import { PLAN_PRECIOS, PLAN_NOMBRES, PLANES_REPUESTOS, crearSignup, leerSignup } from './_licencias.js';

const BASE = 'https://estelita.net.ar';
const REPUESTOS_BASE = (process.env.REPUESTOS_BASE_URL || 'https://repuestos.estelita.net.ar').replace(/\/+$/, '');

// Precio y nombre del plan según el producto; null si el plan no existe.
function planDe(producto, plan) {
  if (producto === 'repuestos') {
    const p = PLANES_REPUESTOS[plan];
    return p ? { precio: p.precio, nombre: p.nombre, razon: 'Estelita Repuestos — Plan ' + p.nombre } : null;
  }
  return PLAN_PRECIOS[plan] ? { precio: PLAN_PRECIOS[plan], nombre: PLAN_NOMBRES[plan] || plan, razon: 'Estelita — Plan ' + (PLAN_NOMBRES[plan] || plan) } : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Falta MP_ACCESS_TOKEN en Vercel.' });
  const { accion } = req.body || {};

  try {
    if (accion === 'crear-suscripcion') {
      const producto = req.body.producto === 'repuestos' ? 'repuestos' : 'taller';
      const plan = String(req.body.plan || '').toLowerCase();
      const email = String(req.body.email || '').trim().slice(0, 120);
      // "taller" es el nombre histórico del campo; Repuestos manda "negocio".
      const taller = String(req.body.taller || req.body.negocio || '').trim().slice(0, 80);
      const p = planDe(producto, plan);
      if (!p) return res.status(400).json({ error: 'Plan inválido.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Poné un email válido.' });

      const sTok = 'S' + crypto.randomBytes(9).toString('hex');
      await crearSignup(sTok, { taller, email, plan, producto });

      const backUrl = producto === 'repuestos' ? `${REPUESTOS_BASE}/gracias?s=${sTok}` : `${BASE}/gracias.html?s=${sTok}`;
      const body = {
        reason: p.razon,
        external_reference: sTok,
        payer_email: email,
        auto_recurring: {
          frequency: 1, frequency_type: 'months',
          transaction_amount: p.precio, currency_id: 'ARS',
          free_trial: { frequency: 14, frequency_type: 'days' },
        },
        back_url: backUrl,
        notification_url: `${BASE}/api/mp-webhook`,
        status: 'pending',
      };
      const r = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.init_point) {
        return res.status(502).json({ error: (data && data.message) || 'Mercado Pago no aceptó la suscripción.', detalle: data });
      }
      return res.status(200).json({ ok: true, token: sTok, init_point: data.init_point });
    }

    if (accion === 'estado-signup') {
      let rec = null;
      try { rec = await leerSignup(String(req.body.token || '')); }
      catch (e) { return res.status(503).json({ error: 'No se pudo consultar en este momento. Probá de nuevo.' }); }
      if (!rec) return res.status(404).json({ error: 'No encontrado' });
      return res.status(200).json({ ok: true, estado: rec.estado, codigo: rec.codigo || null, producto: rec.producto || 'taller', plan: rec.plan || '' });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor.' });
  }
}
