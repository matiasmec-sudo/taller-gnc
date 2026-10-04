// Intermediario para el aviso de "tu turno quedó confirmado" por WhatsApp.
//
// POR QUÉ EXISTE. Hasta ahora la app del taller llamaba DERECHO desde el
// navegador a https://crm.estelita.net.ar/api/turno-confirmado, con el código
// de licencia como única llave. Y ese endpoint del CRM manda un WhatsApp DESDE
// EL NÚMERO DEL TALLER. O sea: el código de licencia (que viaja en cada pedido
// del navegador, queda en localStorage y se dicta por teléfono) alcanzaba para
// mandar mensajes de WhatsApp firmados por el taller a cualquier número.
//
// Ahora el navegador llama acá. Este endpoint valida la licencia con el mismo
// límite de intentos que /api/licencia y reenvía al CRM con el secreto
// compartido del servidor (SERVIDOR_SECRET), que nunca sale de Vercel. El CRM
// pasa a exigir ese secreto, así que el código de licencia solo ya no sirve
// para disparar mensajes.
//
//   POST /api/turno-wa   { license, telefono, texto }
//     → 200 { ok: true }            el CRM lo tomó
//     → 200 { ok: false, error }    no se pudo avisar (el turno YA quedó
//                                   guardado en la app: esto es un extra, no
//                                   puede romperle la pantalla al dueño)
//     → 403 código de licencia no válido
//     → 429 demasiados intentos con códigos que no existen
import { licenciaValida } from './_licencias.js';
import { chequearIntentos, registrarFallo, registrarAciertoSiHaceFalta, esperar } from './_ratelimit.js';

const CRM_URL = (process.env.CRM_BASE_URL || 'https://crm.estelita.net.ar').replace(/\/+$/, '') + '/api/turno-confirmado';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const limite = await chequearIntentos(req, { max: 6, ventanaMs: 10 * 60 * 1000, bloqueoMs: 5 * 60 * 1000 });
  if (!limite.ok) {
    res.setHeader('Retry-After', String(limite.segundos));
    return res.status(429).json({ error: 'Demasiados intentos con códigos que no existen. Esperá unos minutos y probá de nuevo.' });
  }

  const { license, telefono, texto } = req.body || {};
  if (!(await licenciaValida(license))) {
    await esperar(await registrarFallo(req, { reiniciar: limite.reiniciar, datos: limite.datos }));
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }
  await registrarAciertoSiHaceFalta(req, limite);

  const tel = String(telefono || '').trim().slice(0, 30);
  const msg = String(texto || '').trim().slice(0, 1000);
  if (!tel || !msg) return res.status(400).json({ error: 'Faltan el teléfono o el texto del mensaje.' });

  const secreto = String(process.env.SERVIDOR_SECRET || '');
  if (!secreto) return res.status(200).json({ ok: false, error: 'Falta SERVIDOR_SECRET en Vercel: no se puede avisar al cliente.' });

  // Best-effort a propósito: el turno ya se guardó en la app del taller, el
  // aviso es el yapa. Si el CRM está caído devolvemos 200 con ok:false para
  // que el navegador no muestre un error rojo por algo secundario.
  try {
    const r = await fetch(CRM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-servidor-secret': secreto },
      body: JSON.stringify({ license, telefono: tel, texto: msg }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(200).json({ ok: false, error: (data && (data.error || data.message)) || `el CRM contestó ${r.status}` });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.name === 'TimeoutError' ? 'el CRM no contestó en 15 segundos' : (e.message || 'no se pudo contactar al CRM') });
  }
}
