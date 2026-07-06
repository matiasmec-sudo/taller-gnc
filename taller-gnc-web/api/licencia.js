// Valida un código de licencia contra la lista LICENSE_CODES de Vercel.
// Lo usa la pantalla de activación de Estelita (antes aceptaba cualquier
// texto y la validación real recién ocurría al usar la IA o el respaldo —
// cualquiera podía "activar" la app con un código inventado).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  const validCodes = (process.env.LICENSE_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
  const { license } = req.body || {};
  if (!validCodes.includes((license || '').trim())) {
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }
  return res.status(200).json({ ok: true });
}
