// Esta función corre en el servidor de Vercel, NO en el celular del usuario.
// Por eso la clave de API (ANTHROPIC_API_KEY) queda oculta y segura:
// nunca viaja al navegador ni queda visible en el código de la página.
import { licenciaValida, chequearTope, registrarConsumo, MODELOS_IA, MAX_TOKENS_IA } from './_licencias.js';
import { chequearIntentos, registrarFallo, registrarAciertoSiHaceFalta, esperar } from './_ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Falta configurar ANTHROPIC_API_KEY en las variables de entorno de Vercel.'
    });
  }

  // Igual que /api/licencia: contesta distinto según si el código existe, así
  // que sirve para probar códigos. Mismo límite de intentos por IP.
  const limite = await chequearIntentos(req, { max: 6, ventanaMs: 10 * 60 * 1000, bloqueoMs: 5 * 60 * 1000 });
  if (!limite.ok) {
    res.setHeader('Retry-After', String(limite.segundos));
    return res.status(429).json({ error: 'Demasiados intentos con códigos que no existen. Esperá unos minutos y probá de nuevo.' });
  }

  // Cada llamada acá gasta crédito de la API de Anthropic, así que solo se
  // procesan pedidos con un código de licencia válido (activo en el panel o,
  // como respaldo, en LICENSE_CODES).
  const { license, ...anthropicBody } = req.body || {};
  if (!(await licenciaValida(license))) {
    await esperar(await registrarFallo(req, { reiniciar: limite.reiniciar, datos: limite.datos }));
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }
  await registrarAciertoSiHaceFalta(req, limite);

  // El resto del cuerpo se reenvía TAL CUAL a Anthropic, así que acá se acota
  // QUÉ se le puede pedir. Sin esto, un código filtrado servía para pedir el
  // modelo más caro con la salida más larga y hacernos la cuenta: el tope
  // diario cuenta lecturas, no dólares, y una lectura puede costar cien veces
  // más que otra. La app pide claude-sonnet-4-6 con max_tokens 4000.
  const modelo = String(anthropicBody.model || '');
  if (!MODELOS_IA.includes(modelo)) {
    return res.status(400).json({ error: 'Modelo no permitido. Actualizá la app: los modelos habilitados son ' + MODELOS_IA.join(', ') + '.' });
  }
  const pedidos = Number(anthropicBody.max_tokens);
  if (!Number.isFinite(pedidos) || pedidos <= 0) {
    return res.status(400).json({ error: 'Falta max_tokens o no es un número.' });
  }
  anthropicBody.max_tokens = Math.min(pedidos, MAX_TOKENS_IA);

  // Tope diario por código: acota el gasto si un código se filtra (best-effort,
  // no bloquea a un taller legítimo si el storage falla).
  const tope = await chequearTope(license);
  if (!tope.ok) {
    return res.status(429).json({ error: `Se alcanzó el límite diario de lecturas (${tope.tope}) para este código. Volvé a intentar mañana o pedí que te lo amplíen.` });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(anthropicBody)
    });

    const data = await response.json();
    // Registrar el consumo real (tokens + costo) para el panel, antes de
    // responder. Solo si la llamada fue exitosa y trae el detalle de tokens.
    if (response.ok && data && data.usage) {
      await registrarConsumo(license, anthropicBody.model, data.usage);
    }
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error llamando a la API' });
  }
}
