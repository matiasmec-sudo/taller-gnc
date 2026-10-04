// Webhook de Mercado Pago: recibe los avisos de las suscripciones y actualiza
// la licencia. Siempre RE-CONSULTA el recurso a MP con nuestro token, así un
// aviso falso no puede activar nada (no existe la suscripción autorizada real).
import crypto from 'crypto';
import { leerSignup, activarLicenciaMP, renovarPorPreapproval, suspenderPorPreapproval, sumarDiasISO, anotarEnLicencia, productoDe, PLANES_REPUESTOS, PLAN_NOMBRES, PLAN_PRECIOS } from './_licencias.js';
import { enviarCorreo, armarCorreoLicencia, armarAvisoVenta, casillaAvisos } from './_correo.js';

// Al crearse la licencia: el correo al cliente con su código y el aviso al dueño.
// Nunca tira: si el correo falla, la licencia igual quedó creada y se ve en /gracias.
async function avisarLicenciaNueva(l) {
  try {
    const producto = productoDe(l);
    const planRep = producto === 'repuestos' ? PLANES_REPUESTOS[l.plan] : null;
    const planNombre = planRep ? planRep.nombre : (PLAN_NOMBRES[l.plan] || '');
    const precio = planRep ? planRep.precio : PLAN_PRECIOS[l.plan];
    const hoy = new Date().toISOString().slice(0, 10).split('-').reverse().join('/');
    const c = armarCorreoLicencia(l, { producto, planNombre });
    const r = await enviarCorreo({ para: l.email, asunto: c.asunto, html: c.html, texto: c.texto });
    await anotarEnLicencia(l.codigo, r.ok ? `Correo con la licencia enviado el ${hoy}` : `NO se pudo enviar el correo con la licencia (${r.motivo}) el ${hoy}`);
    const a = armarAvisoVenta(l, { producto, planNombre, precio });
    await enviarCorreo({ para: casillaAvisos(), asunto: a.asunto, html: a.html, texto: a.texto, responderA: l.email });
  } catch (e) { /* best-effort */ }
}

const MP = 'https://api.mercadopago.com';

async function mpGet(path, token) {
  try {
    const r = await fetch(MP + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Firma del aviso de Mercado Pago (capa OPCIONAL).
//
// MP firma cada aviso con una clave secreta que se saca del panel de MP
// (Tus integraciones → la aplicación → Webhooks → Clave secreta). El manifiesto
// que se firma es `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` y la firma
// viaja en el header x-signature como "ts=...,v1=<hmac sha256 en hexa>".
//
// POR QUÉ ES OPCIONAL: hoy MP_WEBHOOK_SECRET todavía no está configurada en
// Vercel, y rechazar sin ella dejaría las altas cobradas sin licencia. Así que
// mientras la variable no exista no se exige nada (la defensa de fondo sigue
// siendo que RE-CONSULTAMOS el recurso a MP con nuestro token: un aviso
// inventado no activa nada). En cuanto se cargue la variable, un aviso sin
// firma válida se rechaza. Configurala y esta capa se enciende sola.
function firmaOk(req, dataId) {
  const secreto = String(process.env.MP_WEBHOOK_SECRET || '');
  if (!secreto) return true;
  const partes = {};
  for (const p of String(req.headers['x-signature'] || '').split(',')) {
    const i = p.indexOf('=');
    if (i > 0) partes[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  const reqId = String(req.headers['x-request-id'] || '');
  // MP pide el id en minúscula cuando es alfanumérico.
  const manifiesto = `id:${String(dataId).toLowerCase()};request-id:${reqId};ts:${ts};`;
  const esperado = crypto.createHmac('sha256', secreto).update(manifiesto).digest();
  const recibido = Buffer.from(v1, 'hex');
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
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

    // 401 a propósito (y no 200): un aviso que no está firmado por MP no es un
    // aviso nuestro, y no queremos que MP lo dé por entregado si de verdad es suyo.
    if (!firmaOk(req, id)) return res.status(401).json({ ok: false, error: 'firma inválida' });

    if (tipo.includes('preapproval')) {
      const pre = await mpGet(`/preapproval/${id}`, token);
      if (!pre) return res.status(200).json({ ok: true });
      const extRef = pre.external_reference || '';
      if (pre.status === 'authorized') {
        // Sin el signup no se sabe el plan ni el producto: si Blob no contesta, se
        // devuelve error para que Mercado Pago repita el aviso, en vez de crear
        // una licencia equivocada.
        let s = null;
        try { s = await leerSignup(extRef); }
        catch (e) { return res.status(500).json({ ok: false, error: 'signup no disponible, reintentar' }); }
        s = s || {};
        const pagoHasta = sumarDiasISO(new Date().toISOString().slice(0, 10), 14); // fin de la prueba
        // El correo del formulario manda sobre el de la cuenta de MP: es el que el cliente eligió como titular.
        const r = await activarLicenciaMP({
          token: extRef, preapprovalId: pre.id, email: s.email || pre.payer_email, plan: s.plan || '', pagoHasta, prueba: true,
          producto: s.producto || 'taller', nombre: s.taller || '',
        });
        if (r && r.nueva) await avisarLicenciaNueva(r.licencia);
        return res.status(200).json({ ok: true, nueva: !!(r && r.nueva), reactivada: !!(r && r.reactivada) });
      } else if (pre.status === 'cancelled' || pre.status === 'paused') {
        await suspenderPorPreapproval(pre.id, pre.status === 'paused' ? 'Suspendida: suscripción pausada en Mercado Pago' : 'Suspendida: suscripción cancelada en Mercado Pago');
      }
      return res.status(200).json({ ok: true });
    }

    // Cobro mensual de la suscripción aprobado -> renueva un mes.
    //
    // La llave de idempotencia es el ID DEL PAGO, no el del aviso: Mercado Pago
    // avisa el MISMO cobro por dos vías (authorized_payment y payment), y
    // además repite los avisos. Por eso se usa ap.payment.id cuando viene —
    // es el mismo número que trae el aviso de tipo 'payment' — así los dos
    // caminos se reconocen entre sí y el mes se suma UNA sola vez.
    if (tipo.includes('authorized_payment') || tipo.includes('subscription')) {
      const ap = await mpGet(`/authorized_payments/${id}`, token);
      if (ap && ap.status === 'approved' && ap.preapproval_id) {
        const idPago = (ap.payment && ap.payment.id) ? `pago:${ap.payment.id}` : `ap:${ap.id || id}`;
        const r = await renovarPorPreapproval(ap.preapproval_id, idPago);
        return res.status(200).json({ ok: true, renovacion: r });
      }
      return res.status(200).json({ ok: true });
    }

    if (tipo === 'payment') {
      const pay = await mpGet(`/v1/payments/${id}`, token);
      const preId = pay && pay.metadata && (pay.metadata.preapproval_id || pay.metadata.preapproval);
      if (!pay || !preId) return res.status(200).json({ ok: true });
      if (pay.status === 'approved') {
        const r = await renovarPorPreapproval(preId, `pago:${pay.id || id}`);
        return res.status(200).json({ ok: true, renovacion: r });
      }
      // Plata que se fue: devolución, contracargo o pago cancelado. Antes estos
      // avisos se ignoraban, así que una devolución dejaba la licencia andando
      // con un mes que no cobramos. Se suspende y queda anotado en la licencia
      // para saber por qué (el panel la muestra como suspendida por Mercado Pago).
      const MOTIVOS_BAJA = {
        refunded: 'Suspendida: Mercado Pago devolvió el pago',
        charged_back: 'Suspendida: contracargo en Mercado Pago',
        cancelled: 'Suspendida: pago cancelado en Mercado Pago',
      };
      if (MOTIVOS_BAJA[pay.status]) {
        const suspendida = await suspenderPorPreapproval(preId, MOTIVOS_BAJA[pay.status]);
        return res.status(200).json({ ok: true, suspendida, estadoPago: pay.status });
      }
      return res.status(200).json({ ok: true, estadoPago: pay.status });
    }

    return res.status(200).json({ ok: true, ignored: tipo });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
