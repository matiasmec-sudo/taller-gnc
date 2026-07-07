// Webhook de Mercado Pago: recibe los avisos de las suscripciones y actualiza
// la licencia. Siempre RE-CONSULTA el recurso a MP con nuestro token, así un
// aviso falso no puede activar nada (no existe la suscripción autorizada real).
import { leerSignups, activarLicenciaMP, renovarPorPreapproval, suspenderPorPreapproval, sumarDiasISO } from './_licencias.js';

const MP = 'https://api.mercadopago.com';

async function mpGet(path, token) {
  try {
    const r = await fetch(MP + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  const token = process.env.MP_ACCESS_TOKEN;
  // MP espera un 200 rápido; devolvemos 200 salvo error interno.
  try {
    if (!token) return res.status(200).json({ ok: false });
    const q = req.query || {};
    const b = req.body || {};
    const tipo = String(b.type || b.topic || q.type || q.topic || '');
    const id = (b.data && b.data.id) || b.id || q.id || q['data.id'] || '';
    if (!id) return res.status(200).json({ ok: true, ignored: true });

    if (tipo.includes('preapproval')) {
      const pre = await mpGet(`/preapproval/${id}`, token);
      if (!pre) return res.status(200).json({ ok: true });
      const extRef = pre.external_reference || '';
      if (pre.status === 'authorized') {
        const signups = await leerSignups();
        const plan = (signups[extRef] && signups[extRef].plan) || '';
        const pagoHasta = sumarDiasISO(new Date().toISOString().slice(0, 10), 14); // fin de la prueba
        await activarLicenciaMP({ token: extRef, preapprovalId: pre.id, email: pre.payer_email, plan, pagoHasta, prueba: true });
      } else if (pre.status === 'cancelled' || pre.status === 'paused') {
        await suspenderPorPreapproval(pre.id);
      }
      return res.status(200).json({ ok: true });
    }

    // Cobro mensual de la suscripción aprobado -> renueva un mes.
    if (tipo.includes('authorized_payment') || tipo.includes('subscription')) {
      const ap = await mpGet(`/authorized_payments/${id}`, token);
      if (ap && ap.status === 'approved' && ap.preapproval_id) {
        await renovarPorPreapproval(ap.preapproval_id);
      }
      return res.status(200).json({ ok: true });
    }

    if (tipo === 'payment') {
      const pay = await mpGet(`/v1/payments/${id}`, token);
      const preId = pay && pay.metadata && (pay.metadata.preapproval_id || pay.metadata.preapproval);
      if (pay && pay.status === 'approved' && preId) await renovarPorPreapproval(preId);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true, ignored: tipo });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
