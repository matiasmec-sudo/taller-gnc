// Esta función corre en el servidor de Vercel, NO en el celular del usuario.
// Por eso la clave de API (ANTHROPIC_API_KEY) queda oculta y segura:
// nunca viaja al navegador ni queda visible en el código de la página.
import { licenciaValida, chequearTope, registrarConsumo } from './_licencias.js';

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

  // Cada llamada acá gasta crédito de la API de Anthropic, así que solo se
  // procesan pedidos con un código de licencia válido (activo en el panel o,
  // como respaldo, en LICENSE_CODES).
  const { license, ...anthropicBody } = req.body || {};
  if (!(await licenciaValida(license))) {
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }

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
