// Valida un código de licencia (panel de admin + respaldo LICENSE_CODES).
// Lo usa la pantalla de activación de Estelita (antes aceptaba cualquier
// texto y la validación real recién ocurría al usar la IA o el respaldo —
// cualquiera podía "activar" la app con un código inventado).
import { licenciaValida } from './_licencias.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  const { license } = req.body || {};
  if (!(await licenciaValida(license))) {
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }
  return res.status(200).json({ ok: true });
}
