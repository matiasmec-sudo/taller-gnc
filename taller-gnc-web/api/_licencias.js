// Store de licencias en Vercel Blob + validación compartida por los endpoints.
//
// Diseño a prueba de fallos: los códigos de la variable LICENSE_CODES siguen
// funcionando como respaldo. El store en Blob es la fuente autoritativa para
// los códigos que conoce (permite suspender/dar de baja al instante desde el
// panel). Si un código NO está en el store, se cae al respaldo del env. Si el
// Blob falla, los códigos del env nunca se bloquean.
//
// Este archivo empieza con "_" a propósito: Vercel no lo trata como una
// función/ruta, solo lo importan los demás endpoints.
import { put } from '@vercel/blob';

const STORE_PATH = 'sistema/licencias.json';
const USO_PREFIX = 'sistema/uso-';
const CONSUMO_PREFIX = 'sistema/consumo-';

// Precios de la IA en US$ por millón de tokens (entrada/salida). Aproximados
// — actualizá acá si Anthropic cambia las tarifas. Sirven para estimar el
// costo real de cada lectura en el panel.
const PRECIOS_IA = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};
const PRECIO_DEFECTO = { in: 3, out: 15 };

function blobBaseUrl() {
  const partes = (process.env.BLOB_READ_WRITE_TOKEN || '').split('_');
  return `https://${(partes[3] || '').toLowerCase()}.private.blob.vercel-storage.com`;
}

async function leerJsonBlob(path) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const url = `${blobBaseUrl()}/${path}?nc=${Date.now()}`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('No se pudo leer ' + path);
  return r.json();
}

async function escribirJsonBlob(path, obj) {
  await put(path, JSON.stringify(obj), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 0,
  });
}

export function codigosEnv() {
  return (process.env.LICENSE_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
}

export async function leerLicencias() {
  try {
    const data = await leerJsonBlob(STORE_PATH);
    return data && Array.isArray(data.licencias) ? data.licencias : [];
  } catch (e) {
    return [];
  }
}

export async function guardarLicencias(licencias) {
  await escribirJsonBlob(STORE_PATH, { licencias, actualizado: new Date().toISOString() });
}

// ¿La licencia puede usar los servicios pagos?
// - Si el store tiene datos: es la fuente autoritativa (así suspender/eliminar
//   desde el panel surte efecto al instante). El panel siembra el store con
//   TODOS los códigos del env la primera vez, así no se pierde ninguno.
// - Si el store está vacío o no se puede leer (Blob caído): respaldo del env
//   (LICENSE_CODES), para que los talleres existentes nunca queden afuera.
export async function licenciaValida(codigo) {
  const cod = (codigo || '').trim();
  if (!cod) return false;
  const lics = await leerLicencias();
  if (lics.length) {
    const l = lics.find(x => x.codigo === cod);
    return !!(l && l.estado === 'activo');
  }
  return codigosEnv().includes(cod);
}

// Actividad por código: agrega los contadores diarios de lecturas de IA
// (los archivos uso-YYYY-MM-DD.json que escribe chequearTope) de los últimos
// `dias` días. Devuelve { codigo: { total, hoy, ultimo } }. Solo lectura: no
// toca el camino caliente, así que no afecta el rendimiento de la app.
export async function leerActividad(dias = 30) {
  const out = {};
  const hoy = new Date();
  const fechas = [];
  for (let i = 0; i < dias; i++) {
    fechas.push(new Date(hoy.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  const hoyStr = fechas[0];
  await Promise.all(fechas.map(async (fecha) => {
    let uso = null;
    try { uso = await leerJsonBlob(`${USO_PREFIX}${fecha}.json`); } catch (e) { uso = null; }
    if (!uso || typeof uso !== 'object') return;
    for (const [cod, n] of Object.entries(uso)) {
      const c = out[cod] || (out[cod] = { total: 0, hoy: 0, ultimo: null });
      c.total += Number(n) || 0;
      if (fecha === hoyStr) c.hoy = Number(n) || 0;
      if (!c.ultimo || fecha > c.ultimo) c.ultimo = fecha;
    }
  }));
  return out;
}

// Registra el consumo real de IA de una lectura (tokens + costo estimado en
// US$) por código, acumulado por mes (sistema/consumo-YYYY-MM.json). Se llama
// DESPUÉS de la respuesta de Anthropic (que trae el detalle de tokens).
// Best-effort: nunca tira error para no afectar la respuesta de la lectura.
export async function registrarConsumo(codigo, model, usage) {
  try {
    const cod = (codigo || '').trim();
    if (!cod || !usage) return;
    const inTok = Number(usage.input_tokens) || 0;
    const outTok = Number(usage.output_tokens) || 0;
    const p = PRECIOS_IA[model] || PRECIO_DEFECTO;
    const costo = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
    const mes = new Date().toISOString().slice(0, 7);
    const path = `${CONSUMO_PREFIX}${mes}.json`;
    let data = {};
    try { data = (await leerJsonBlob(path)) || {}; } catch (e) { data = {}; }
    const c = data[cod] || (data[cod] = { reads: 0, inTok: 0, outTok: 0, costoUSD: 0 });
    c.reads += 1; c.inTok += inTok; c.outTok += outTok; c.costoUSD += costo;
    await escribirJsonBlob(path, data);
  } catch (e) { /* best-effort */ }
}

// Consumo del mes indicado (por defecto el actual): { codigo: {reads, costoUSD, ...} }.
export async function leerConsumoMes(mes) {
  try {
    const m = mes || new Date().toISOString().slice(0, 7);
    return (await leerJsonBlob(`${CONSUMO_PREFIX}${m}.json`)) || {};
  } catch (e) {
    return {};
  }
}

// Tope diario de lecturas por código (anti-abuso de un código filtrado).
// Best-effort sobre Blob y FALLA ABIERTO (permite) ante cualquier error, para
// no bloquear a un taller legítimo por un problema de storage. Los códigos sin
// tope (topeDia 0 / desconocidos) no se limitan.
export async function chequearTope(codigo) {
  try {
    const cod = (codigo || '').trim();
    const lics = await leerLicencias();
    const l = lics.find(x => x.codigo === cod);
    const tope = l && Number(l.topeDia) > 0 ? Number(l.topeDia) : 0;
    if (!tope) return { ok: true };
    const dia = new Date().toISOString().slice(0, 10);
    const path = `${USO_PREFIX}${dia}.json`;
    let uso = {};
    try { uso = (await leerJsonBlob(path)) || {}; } catch (e) { uso = {}; }
    const usado = Number(uso[cod] || 0);
    if (usado >= tope) return { ok: false, usado, tope };
    uso[cod] = usado + 1;
    await escribirJsonBlob(path, uso);
    return { ok: true, usado: usado + 1, tope };
  } catch (e) {
    return { ok: true };
  }
}
