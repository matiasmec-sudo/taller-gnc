// Valida un código de licencia (panel de admin + respaldo LICENSE_CODES).
// Lo usa la pantalla de activación de Estelita (antes aceptaba cualquier
// texto y la validación real recién ocurría al usar la IA o el respaldo —
// cualquiera podía "activar" la app con un código inventado).
//
// Este endpoint es el más sensible de todos aunque no devuelva ningún dato:
// contesta sí o no sobre si un código existe, así que sirve para PROBAR
// códigos hasta encontrar uno válido. Y un código válido hoy habilita la
// lectura con IA, el respaldo, los datos del CRM y la facturación ante ARCA.
// Por eso tiene límite de intentos y retardo creciente: ver _ratelimit.js.
import { licenciaValida } from './_licencias.js';
import { chequearIntentos, registrarFallo, registrarAcierto, esperar } from './_ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const limite = chequearIntentos(req, { max: 10, ventanaMs: 10 * 60 * 1000, bloqueoMs: 15 * 60 * 1000 });
  if (!limite.ok) {
    res.setHeader('Retry-After', String(limite.segundos));
    return res.status(429).json({
      error: 'Demasiados intentos con códigos que no existen. Esperá unos minutos y probá de nuevo.',
    });
  }

  const { license } = req.body || {};
  if (!(await licenciaValida(license))) {
    // El retardo va DESPUÉS de decidir, y solo cuando falla: un taller que
    // pone bien su código entra al instante.
    await esperar(registrarFallo(req));
    return res.status(403).json({ error: 'Código de licencia no válido.' });
  }

  registrarAcierto(req);
  return res.status(200).json({ ok: true });
}
