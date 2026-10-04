// Límite de intentos para los endpoints que sirven de "oráculo": los que
// responden sí/no sobre si un código existe. Sin esto, probar el millón de
// combinaciones posibles de un código de licencia es cuestión de horas.
//
// POR QUÉ ESTÁ HECHO ASÍ (medido en producción, no supuesto)
// La primera versión llevaba el contador solo en memoria del módulo. Falla:
// Vercel reparte los pedidos entre varias instancias y cada una arranca su
// contador en cero. Medido el 28/07: sobre 12 intentos seguidos, algunos
// cayeron en una instancia caliente y comieron el retardo máximo de 4 s, pero
// otros cayeron en instancias frescas y respondieron en 0,35 s. Nunca se llegó
// al bloqueo. O sea: el contador en memoria no sirve para esto.
//
// Ahora el conteo vive en Vercel Blob, que es compartido por todas las
// instancias, con la memoria del módulo como caché de lectura para no ir al
// storage cuando ya sabemos que la IP está bloqueada.
//
// El costo se mantiene bajo porque SOLO SE ESCRIBE CUANDO HAY UN FALLO. Un
// taller que pone bien su código no crea ningún archivo ni paga ninguna
// escritura. Los archivos que se acumulan son, por definición, de quien está
// probando códigos.
//
// Este archivo empieza con "_" a propósito: Vercel no lo trata como una ruta.
import { put } from '@vercel/blob';
import crypto from 'crypto';

const PREFIJO = 'sistema/rl-';

// Caché de lectura en memoria. Guarda lo último que se leyó del storage para
// esta IP; se usa solo mientras no venza, y nunca para PERMITIR algo que el
// storage diría que está bloqueado.
const cache = new Map();
const CACHE_MS = 5000;

// SEGUNDA CAPA: contador de fallos en memoria del proceso.
//
// El conteo en Blob falla ABIERTO a propósito (ver chequearIntentos): dejar
// afuera a un taller legítimo por un hipo de red es peor que el abuso que
// evita. Pero fallar abierto sin más significaba intentos ILIMITADOS mientras
// el storage no conteste: basta con tirarle abajo el camino al storage (o
// esperar a que Blob tenga un mal día) para volver a tener un oráculo de
// códigos sin límite.
//
// Esta capa no reemplaza a la de Blob —ya sabemos que sola no sirve, porque
// Vercel reparte los pedidos entre instancias y cada una arranca en cero— pero
// SÍ acota lo que puede hacer una instancia caliente: un atacante tiene que
// repartirse entre instancias frescas en vez de machacar sin techo. Se aplica
// sólo cuando el storage no contestó.
const memoria = new Map();
const MEM_MAX_IPS = 5000;

function memLeer(ip, ventanaMs) {
  const m = memoria.get(ip);
  if (!m) return { n: 0, desde: Date.now() };
  if (Date.now() - m.desde > ventanaMs) return { n: 0, desde: Date.now() };
  return m;
}

function memSumar(ip, ventanaMs) {
  const m = memLeer(ip, ventanaMs);
  const nuevo = { n: m.n + 1, desde: m.desde };
  // Tope de tamaño: el Map vive lo que vive la instancia, pero una ráfaga de
  // IPs distintas no tiene por qué comerse la memoria. Al llenarse se tira la
  // entrada más vieja (la primera que insertó el Map).
  if (!memoria.has(ip) && memoria.size >= MEM_MAX_IPS) {
    const primera = memoria.keys().next();
    if (!primera.done) memoria.delete(primera.value);
  }
  memoria.set(ip, nuevo);
  return nuevo.n;
}

function rutaDe(ip) {
  const h = crypto.createHash('sha256').update('rl:' + ip).digest('hex').slice(0, 32);
  return `${PREFIJO}${h}.json`;
}

function blobBaseUrl() {
  const partes = (process.env.BLOB_READ_WRITE_TOKEN || '').split('_');
  return `https://${(partes[3] || '').toLowerCase()}.private.blob.vercel-storage.com`;
}

// null = no hay intentos previos (404, que es el caso normal). Cualquier otra
// respuesta que no sea 200 TIRA: antes se devolvía null igual que un 404, así
// que un storage con problemas se veía como "esta IP nunca intentó nada" y el
// límite desaparecía sin que nadie se enterara. Ahora el que llama sabe que no
// pudo leer y aplica la capa en memoria.
async function leer(ruta) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('rl: falta BLOB_READ_WRITE_TOKEN');
  const r = await fetch(`${blobBaseUrl()}/${ruta}?nc=${Date.now()}`, {
    headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('rl: el storage respondió ' + r.status);
  return r.json().catch(() => null);
}

async function escribir(ruta, datos) {
  await put(ruta, JSON.stringify(datos), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 0,
  });
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
// Devuelve { ok: true } o { ok: false, segundos }.
//
// FALLA ABIERTO ante cualquier problema de storage: dejar afuera a un taller
// legítimo por un hipo de red sería peor que el abuso que evita. Quien intenta
// abusar igual se come el retardo creciente de registrarFallo.
export async function chequearIntentos(req, { max = 10, ventanaMs = 10 * 60 * 1000, bloqueoMs = 15 * 60 * 1000 } = {}) {
  const ip = ipDe(req);
  const ahora = Date.now();

  const enCache = cache.get(ip);
  if (enCache && ahora < enCache.hasta) {
    const d = enCache.datos;
    if (d?.bloqueadoHasta && ahora < d.bloqueadoHasta) {
      return { ok: false, ip, segundos: Math.ceil((d.bloqueadoHasta - ahora) / 1000) };
    }
  }

  let d;
  try {
    d = await leer(rutaDe(ip));
  } catch (e) {
    // Storage caído: seguimos fallando ABIERTO (es deliberado), pero con el
    // contador en memoria del proceso como techo (ver "SEGUNDA CAPA" arriba).
    const m = memLeer(ip, ventanaMs);
    if (m.n >= max) return { ok: false, ip, segundos: Math.ceil(bloqueoMs / 1000), soloMemoria: true };
    // datos: null para que registrarFallo no vuelva a pedirle nada al storage
    // (ya sabemos que no contesta).
    return { ok: true, ip, soloMemoria: true, datos: null };
  }

  cache.set(ip, { datos: d, hasta: ahora + CACHE_MS });

  if (!d) return { ok: true, ip, datos: null };
  if (d.bloqueadoHasta && ahora < d.bloqueadoHasta) {
    return { ok: false, ip, segundos: Math.ceil((d.bloqueadoHasta - ahora) / 1000) };
  }
  if (d.bloqueadoHasta && ahora >= d.bloqueadoHasta) return { ok: true, ip, reiniciar: true, datos: d };
  if (ahora - (d.desde || 0) > ventanaMs) return { ok: true, ip, reiniciar: true, datos: d };
  if ((d.n || 0) >= max) {
    // Alcanzó el límite: se marca el bloqueo. Es lectura-modificación-escritura
    // sin bloqueo, así que dos pedidos simultáneos pueden pisarse — no importa,
    // el peor caso es que el bloqueo arranque un intento más tarde.
    const nuevo = { ...d, bloqueadoHasta: ahora + bloqueoMs };
    try { await escribir(rutaDe(ip), nuevo); } catch (e) { /* best-effort */ }
    cache.set(ip, { datos: nuevo, hasta: ahora + CACHE_MS });
    return { ok: false, ip, segundos: Math.ceil(bloqueoMs / 1000) };
  }
  return { ok: true, ip, datos: d };
}

// Registra un intento fallido y devuelve cuántos ms conviene esperar antes de
// responder. El retardo crece con los fallos (0,4 s, 0,8 s, 1,2 s...) hasta un
// tope, así una persona que se equivocó no lo nota y un script sí.
//
// IMPORTANTE: se le pasa el `datos` que ya leyó chequearIntentos en vez de
// volver a leer. Con dos lecturas por pedido se perdían incrementos: el
// storage tiene consistencia eventual (~1 s), así que la segunda lectura
// devolvía un valor viejo y el contador subía uno cada tres o cuatro intentos.
// Medido en producción el 28/07: con dos lecturas, 38 intentos seguidos no
// llegaron a disparar el bloqueo. Con una sola, cada intento cuenta.
export async function registrarFallo(req, { retardoBaseMs = 400, retardoMaxMs = 4000, ventanaMs = 10 * 60 * 1000, reiniciar = false, datos = undefined } = {}) {
  const ip = ipDe(req);
  const ahora = Date.now();
  // El contador en memoria se suma SIEMPRE, no sólo cuando el storage falla:
  // es la segunda capa y tiene que estar al día para cuando haga falta.
  const nMemoria = memSumar(ip, ventanaMs);
  let d = datos;
  if (d === undefined) {
    try { d = await leer(rutaDe(ip)); } catch (e) { d = null; }
  }

  const vencido = reiniciar || !d || (ahora - (d.desde || 0) > ventanaMs) ||
                  (d.bloqueadoHasta && ahora >= d.bloqueadoHasta);
  const nuevo = vencido
    ? { n: 1, desde: ahora, bloqueadoHasta: 0 }
    : { n: (d.n || 0) + 1, desde: d.desde || ahora, bloqueadoHasta: d.bloqueadoHasta || 0 };

  try { await escribir(rutaDe(ip), nuevo); } catch (e) { /* best-effort */ }
  cache.set(ip, { datos: nuevo, hasta: ahora + CACHE_MS });
  // El retardo sale del contador más alto de los dos: si el storage no pudo
  // guardar nada, el de memoria es el único que sube.
  return Math.min(retardoBaseMs * Math.max(nuevo.n, nMemoria), retardoMaxMs);
}

// Un acierto sólo necesita limpiar si esta IP tenía algo anotado. Lo usan los
// endpoints que la app del taller llama todo el tiempo (respaldo, estado,
// lecturas): ahí, llamar a registrarAcierto a secas agregaba una operación de
// storage a CADA pedido bueno, y las operaciones de Blob se pagan.
export async function registrarAciertoSiHaceFalta(req, limite) {
  if (limite && (limite.datos || limite.soloMemoria)) await registrarAcierto(req);
}

// Un acierto limpia el historial de esa IP.
export async function registrarAcierto(req) {
  const ip = ipDe(req);
  cache.delete(ip);
  memoria.delete(ip);
  try {
    const d = await leer(rutaDe(ip));
    if (d) await escribir(rutaDe(ip), { n: 0, desde: Date.now(), bloqueadoHasta: 0 });
  } catch (e) { /* best-effort */ }
}
