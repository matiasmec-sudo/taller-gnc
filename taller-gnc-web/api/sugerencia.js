// Recibe una sugerencia de un taller desde Estelita (Mi taller → Sugerencias)
// y la guarda en la nube. Protegido por licencia válida para que solo puedan
// enviar los talleres reales (evita spam de cualquiera). El dueño las lee
// después desde el panel de administración.
import { licenciaValida, agregarSugerencia } from './_licencias.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  const { license, taller, texto } = req.body || {};
  if (!(await licenciaValida(license))) {
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }
  const t = String(texto || '').trim();
  if (t.length < 4) return res.status(400).json({ error: 'La sugerencia está vacía.' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'No se pudo guardar en este momento.' });
  }
  try {
    await agregarSugerencia({ license, taller, texto: t });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor.' });
  }
}
