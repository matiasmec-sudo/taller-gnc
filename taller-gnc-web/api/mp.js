// Endpoint del front para las suscripciones de Mercado Pago.
// - crear-suscripcion: crea una preapproval en MP y devuelve el link de pago.
// - estado-signup: la página de "gracias" pregunta acá si ya se creó el código.
import crypto from 'crypto';
import { PLAN_PRECIOS, PLAN_NOMBRES, crearSignup, leerSignups } from './_licencias.js';

const BASE = 'https://taller-gnc.vercel.app';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Falta MP_ACCESS_TOKEN en Vercel.' });
  const { accion } = req.body || {};

  try {
    if (accion === 'crear-suscripcion') {
      const plan = String(req.body.plan || '').toLowerCase();
      const email = String(req.body.email || '').trim();
      const taller = String(req.body.taller || '').trim();
      if (!PLAN_PRECIOS[plan]) return res.status(400).json({ error: 'Plan inválido.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Poné un email válido.' });

      const sTok = 'S' + crypto.randomBytes(9).toString('hex');
      await crearSignup(sTok, { taller, email, plan });

      const body = {
        reason: 'Estelita — Plan ' + (PLAN_NOMBRES[plan] || plan),
        external_reference: sTok,
        payer_email: email,
        auto_recurring: {
          frequency: 1, frequency_type: 'months',
          transaction_amount: PLAN_PRECIOS[plan], currency_id: 'ARS',
          free_trial: { frequency: 14, frequency_type: 'days' },
        },
        back_url: `${BASE}/gracias.html?s=${sTok}`,
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
      const s = await leerSignups();
      const rec = s[String(req.body.token || '')];
      if (!rec) return res.status(404).json({ error: 'No encontrado' });
      return res.status(200).json({ ok: true, estado: rec.estado, codigo: rec.codigo || null });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor.' });
  }
}
