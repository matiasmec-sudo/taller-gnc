// Límite de intentos para los endpoints que sirven de "oráculo": los que
// responden sí/no sobre si un código existe. Sin esto, probar el millón de
// combinaciones posibles de un código de licencia es cuestión de horas.
//
// Cómo funciona y qué esperar de esto:
// Las funciones de Vercel son sin estado, pero la MISMA instancia se reutiliza
// entre pedidos mientras está caliente, así que un contador en memoria del
// módulo aguanta perfectamente el caso normal (alguien martillando desde una
// IP). Un atacante que reparta el ataque entre muchas instancias puede
// escaparse en parte del contador — por eso además hay un RETARDO CRECIENTE en
// cada fallo, que no depende de la memoria compartida y le pone un techo al
// ritmo por conexión.
//
// Si algún día hace falta algo a prueba de todo, esto se reemplaza por Vercel
// KV / Redis con INCR atómico sin tocar los endpoints: la firma queda igual.
//
// Este archivo empieza con "_" a propósito: Vercel no lo trata como una ruta.

const intentos = new Map(); // ip -> { n, desde, bloqueadoHasta }

const LIMPIEZA_CADA_MS = 10 * 60 * 1000;
let ultimaLimpieza = Date.now();

// La memoria no puede crecer sin techo: cada tanto se tiran las entradas
// vencidas, y si aun así hay demasiadas, se vacía entera (perder el conteo es
// preferible a quedarse sin memoria).
function limpiar(ahora, ventanaMs) {
  if (ahora - ultimaLimpieza < LIMPIEZA_CADA_MS) return;
  ultimaLimpieza = ahora;
  for (const [ip, d] of intentos) {
    const vencido = ahora - d.desde > ventanaMs && (!d.bloqueadoHasta || ahora > d.bloqueadoHasta);
    if (vencido) intentos.delete(ip);
  }
  if (intentos.size > 20000) intentos.clear();
}

export function ipDe(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'desconocida';
}

export function esperar(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ¿Esta IP puede seguir intentando?
// Devuelve { ok: true } o { ok: false, segundos } si está bloqueada.
// NO cuenta el intento: eso lo hace registrarFallo(), para que los aciertos
// no penalicen a un taller que se equivocó una vez y después acertó.
export function chequearIntentos(req, { max = 10, ventanaMs = 10 * 60 * 1000, bloqueoMs = 15 * 60 * 1000 } = {}) {
  const ahora = Date.now();
  limpiar(ahora, ventanaMs);
  const ip = ipDe(req);
  const d = intentos.get(ip);
  if (!d) return { ok: true, ip };
  if (d.bloqueadoHasta && ahora < d.bloqueadoHasta) {
    return { ok: false, ip, segundos: Math.ceil((d.bloqueadoHasta - ahora) / 1000) };
  }
  // Se cumplió el bloqueo o venció la ventana: se arranca de cero.
  if (ahora - d.desde > ventanaMs || (d.bloqueadoHasta && ahora >= d.bloqueadoHasta)) {
    intentos.delete(ip);
    return { ok: true, ip };
  }
  if (d.n >= max) {
    d.bloqueadoHasta = ahora + bloqueoMs;
    return { ok: false, ip, segundos: Math.ceil(bloqueoMs / 1000) };
  }
  return { ok: true, ip };
}

// Registra un intento fallido y devuelve cuántos ms conviene esperar antes de
// responder. El retardo crece con los fallos (0,4 s, 0,8 s, 1,2 s...) hasta un
// tope, así una persona que se equivocó no lo nota y un script sí.
export function registrarFallo(req, { retardoBaseMs = 400, retardoMaxMs = 4000 } = {}) {
  const ahora = Date.now();
  const ip = ipDe(req);
  const d = intentos.get(ip);
  if (!d) {
    intentos.set(ip, { n: 1, desde: ahora, bloqueadoHasta: 0 });
    return retardoBaseMs;
  }
  d.n += 1;
  return Math.min(retardoBaseMs * d.n, retardoMaxMs);
}

// Un acierto limpia el historial de esa IP.
export function registrarAcierto(req) {
  intentos.delete(ipDe(req));
}
