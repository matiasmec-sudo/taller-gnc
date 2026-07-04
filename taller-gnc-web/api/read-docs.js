// Esta función corre en el servidor de Vercel, NO en el celular del usuario.
// Por eso la clave de API (ANTHROPIC_API_KEY) queda oculta y segura:
// nunca viaja al navegador ni queda visible en el código de la página.
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
  // procesan pedidos que traigan un código de licencia válido.
  const validCodes = (process.env.LICENSE_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
  const { license, ...anthropicBody } = req.body || {};
  if (!validCodes.includes(license)) {
    return res.status(403).json({ error: 'Código de licencia no válido.' });
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
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error llamando a la API' });
  }
}
