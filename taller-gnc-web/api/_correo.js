// Envío de correos del panel (la licencia al cliente, el aviso de venta al dueño).
//
// Sale por Gmail con una "contraseña de aplicación" (no la contraseña de la
// cuenta): variables GMAIL_USER (ej. estelitagnc@gmail.com) y
// GMAIL_APP_PASSWORD en Vercel. Sin esas variables no manda nada y lo dice
// ({ ok:false, motivo:'sin_configurar' }); NUNCA tira error: un problema de
// correo no puede frenar la creación de una licencia.
//
// Empieza con "_": Vercel no lo expone como ruta.
import nodemailer from 'nodemailer';

const REPUESTOS_BASE = (process.env.REPUESTOS_BASE_URL || 'https://repuestos.estelita.net.ar').replace(/\/+$/, '');
const ESTELITA_BASE = 'https://estelita.net.ar';

export function correoConfigurado() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

// A dónde van los avisos internos ("se suscribió alguien"): AVISOS_EMAIL o la misma casilla que envía.
export function casillaAvisos() {
  return (process.env.AVISOS_EMAIL || process.env.GMAIL_USER || '').trim();
}

let transporte = null;
function transportar() {
  if (!transporte) {
    transporte = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
    });
  }
  return transporte;
}

export async function enviarCorreo({ para, asunto, html, texto, responderA }) {
  const destino = String(para || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) return { ok: false, motivo: 'sin_destinatario' };
  if (!correoConfigurado()) return { ok: false, motivo: 'sin_configurar' };
  try {
    const info = await transportar().sendMail({
      from: `"Estelita" <${process.env.GMAIL_USER}>`,
      to: destino,
      replyTo: responderA || process.env.GMAIL_USER,
      subject: asunto,
      text: texto,
      html,
    });
    return { ok: true, id: info.messageId };
  } catch (e) {
    return { ok: false, motivo: 'error', detalle: String((e && e.message) || e).slice(0, 300) };
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fechaAR = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : '');

/**
 * El correo con la licencia. `l` es la licencia del store; `producto` es
 * 'taller' o 'repuestos'; `planNombre` es el nombre visible del plan.
 * Devuelve { asunto, html, texto } (función pura: se puede probar sin enviar).
 */
export function armarCorreoLicencia(l, { producto, planNombre }) {
  const esRep = producto === 'repuestos';
  const marca = esRep ? 'Estelita Repuestos' : 'Estelita';
  const enlace = esRep ? `${REPUESTOS_BASE}/register?licencia=${encodeURIComponent(l.codigo)}` : ESTELITA_BASE;
  const pasos = esRep
    ? ['Tocá el botón de abajo: te lleva a crear tu cuenta con el código ya cargado.', 'Creá la cuenta con ESTE mismo correo: es el titular de la licencia.', 'Poné el nombre del negocio y entrás. Desde Ajustes sumás a tus vendedores.']
    : ['Abrí Estelita con el botón de abajo.', 'Pegá el código cuando te lo pida.', 'Listo: ya podés cargar tu primera ficha.'];
  const prueba = l.prueba && l.pagoHasta ? `Tu prueba gratis va hasta el ${fechaAR(l.pagoHasta)}. El primer cobro se hace al día siguiente, y podés cancelar antes desde tu cuenta de Mercado Pago (Suscripciones).` : '';
  const pago = !l.prueba && l.pagoHasta ? `Tu licencia está al día hasta el ${fechaAR(l.pagoHasta)}.` : '';
  const asunto = `Tu licencia de ${marca}: ${l.codigo}`;
  const texto = [
    `Hola${l.taller ? ', ' + l.taller : ''}.`,
    '',
    `Tu código de licencia de ${marca} es: ${l.codigo}`,
    planNombre ? `Plan: ${planNombre}` : '',
    '',
    ...pasos.map((p, i) => `${i + 1}. ${p}`),
    '',
    enlace,
    '',
    prueba || pago,
    '',
    'Guardá este correo: el código te lo van a pedir si entrás desde otro equipo. Si necesitás ayuda, respondé este mensaje.',
    '',
    'Estelita · Mar del Plata',
  ].filter((x) => x !== null && x !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#F4F6FA;font-family:Segoe UI,Arial,sans-serif;color:#16233B;">
<div style="max-width:520px;margin:0 auto;padding:28px 16px;">
  <p style="font-size:18px;font-weight:800;letter-spacing:2px;color:#123C8F;margin:0 0 16px;">${esc(marca.toUpperCase())}</p>
  <div style="background:#fff;border:1px solid #E3E8F0;border-radius:16px;padding:26px 22px;">
    <p style="font-size:16px;margin:0 0 6px;">Hola${l.taller ? ', <b>' + esc(l.taller) + '</b>' : ''}.</p>
    <p style="font-size:15px;color:#5A6B85;margin:0 0 16px;">Este es tu código de licencia${planNombre ? ' · Plan <b>' + esc(planNombre) + '</b>' : ''}:</p>
    <p style="font-family:Consolas,monospace;font-size:30px;font-weight:800;letter-spacing:5px;color:#123C8F;background:#EAF1FE;border:2px dashed #1D5BD8;border-radius:12px;padding:14px;text-align:center;margin:0 0 18px;">${esc(l.codigo)}</p>
    <ol style="font-size:14.5px;line-height:1.5;padding-left:20px;margin:0 0 20px;">${pasos.map((p) => `<li style="margin-bottom:6px;">${esc(p)}</li>`).join('')}</ol>
    <p style="text-align:center;margin:0 0 18px;"><a href="${esc(enlace)}" style="display:inline-block;background:#1D5BD8;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 24px;border-radius:12px;">${esRep ? 'Crear mi cuenta' : 'Abrir Estelita'}</a></p>
    ${prueba || pago ? `<p style="font-size:13.5px;color:#5A6B85;margin:0 0 10px;">${esc(prueba || pago)}</p>` : ''}
    <p style="font-size:13.5px;color:#5A6B85;margin:0;">Guardá este correo: el código te lo van a pedir si entrás desde otro equipo. Si necesitás ayuda, respondé este mensaje.</p>
  </div>
  <p style="font-size:12px;color:#5A6B85;text-align:center;margin:14px 0 0;">Estelita · Mar del Plata, Argentina</p>
</div></body></html>`;
  return { asunto, html, texto };
}

/** El aviso interno: alguien se suscribió por la web. */
export function armarAvisoVenta(l, { producto, planNombre, precio }) {
  const marca = producto === 'repuestos' ? 'Estelita Repuestos' : 'Estelita';
  const asunto = `Nueva suscripción de ${marca}: ${l.taller || l.email || l.codigo}`;
  const lineas = [
    `Se suscribió por la web: ${l.taller || '(sin nombre)'}`,
    `Correo: ${l.email || '—'}`,
    `Producto: ${marca}`,
    `Plan: ${planNombre || l.plan || '—'}${precio ? ' · $ ' + Number(precio).toLocaleString('es-AR') + ' por mes' : ''}`,
    `Licencia creada: ${l.codigo}`,
    l.prueba && l.pagoHasta ? `En prueba hasta el ${fechaAR(l.pagoHasta)} (primer cobro al día siguiente).` : '',
    '',
    `Panel: ${ESTELITA_BASE}/admin.html`,
  ].filter(Boolean);
  return { asunto, texto: lineas.join('\n'), html: `<pre style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;">${esc(lineas.join('\n'))}</pre>` };
}
