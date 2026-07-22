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
import crypto from 'crypto';

const STORE_PATH = 'sistema/licencias.json';
const SIGNUPS_PATH = 'sistema/signups.json';
const SUGERENCIAS_PATH = 'sistema/sugerencias.json';
const CREDITO_PATH = 'sistema/credito.json';
const USO_PREFIX = 'sistema/uso-';
const CONSUMO_PREFIX = 'sistema/consumo-';

// Planes y precios (ARS/mes). Fuente única, usada por el checkout de MP y el panel.
export const PLAN_PRECIOS = { basico: 15000, profesional: 22000, full: 35000 };
export const PLAN_NOMBRES = { basico: 'Básico', profesional: 'Profesional', full: 'Full' };

// Genera un código de licencia único (sin O/0/I/1/L, fácil de dictar).
const ALFA_COD = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function nuevoCodigo(existentes) {
  const set = new Set(existentes || []);
  let c;
  do { c = 'GNC-' + Array.from({ length: 4 }, () => ALFA_COD[crypto.randomInt(ALFA_COD.length)]).join(''); } while (set.has(c));
  return c;
}

// Suma un mes a una fecha ISO (AAAA-MM-DD), ajustando fin de mes.
export function sumarMesISO(iso) {
  const d = new Date(iso + 'T00:00:00');
  const dia = d.getDate();
  d.setMonth(d.getMonth() + 1);
  if (d.getDate() < dia) d.setDate(0);
  return d.toISOString().slice(0, 10);
}
export function sumarDiasISO(iso, dias) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

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

// --- Suscripciones de Mercado Pago ---
// Registro de "signups" web: mapea el token de un registro al código de
// licencia que se le creó, para que la página de "gracias" lo muestre.
export async function leerSignups() { try { return (await leerJsonBlob(SIGNUPS_PATH)) || {}; } catch (e) { return {}; } }
export async function guardarSignups(s) { await escribirJsonBlob(SIGNUPS_PATH, s); }

export async function crearSignup(token, datos) {
  const s = await leerSignups();
  s[token] = { ...datos, estado: 'pendiente', codigo: null, creado: new Date().toISOString() };
  await guardarSignups(s);
}

// Cuando MP autoriza la suscripción: crea la licencia (una sola vez por
// preapproval) y la vincula al signup. Devuelve el código.
export async function activarLicenciaMP({ token, preapprovalId, email, plan, pagoHasta, prueba }) {
  const lics = await leerLicencias();
  let l = lics.find(x => x.mpPreapprovalId === preapprovalId);
  if (!l) {
    const codigo = nuevoCodigo(lics.map(x => x.codigo).concat(codigosEnv()));
    l = {
      codigo, taller: '', estado: 'activo', alta: new Date().toISOString().slice(0, 10),
      topeDia: 50, notas: '', plan: plan || '', medioPago: 'mp', email: email || '',
      origen: 'web', mpPreapprovalId: preapprovalId, prueba: !!prueba, pagoHasta: pagoHasta || null,
    };
    lics.push(l);
    await guardarLicencias(lics);
  }
  if (token) {
    const s = await leerSignups();
    if (s[token]) { s[token].codigo = l.codigo; s[token].estado = 'activa'; await guardarSignups(s); }
    else { s[token] = { estado: 'activa', codigo: l.codigo, creado: new Date().toISOString() }; await guardarSignups(s); }
  }
  return l.codigo;
}

// Cobro mensual aprobado: renueva un mes y saca de prueba.
export async function renovarPorPreapproval(preapprovalId) {
  const lics = await leerLicencias();
  const l = lics.find(x => x.mpPreapprovalId === preapprovalId);
  if (!l) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  const base = (l.pagoHasta && l.pagoHasta > hoy) ? l.pagoHasta : hoy;
  l.pagoHasta = sumarMesISO(base);
  l.prueba = false;
  l.estado = 'activo';
  await guardarLicencias(lics);
  return true;
}

// Suscripción cancelada/pausada: suspende la licencia.
export async function suspenderPorPreapproval(preapprovalId) {
  const lics = await leerLicencias();
  const l = lics.find(x => x.mpPreapprovalId === preapprovalId);
  if (!l) return false;
  l.estado = 'suspendido';
  await guardarLicencias(lics);
  return true;
}

// --- Sugerencias de los talleres ---
// Las manda el taller desde Estelita (Mi taller → Sugerencias). Se guardan en
// un único JSON (array) y se leen desde el panel de admin. Sin datos sensibles:
// solo el texto, el código de licencia y el nombre del taller para poder
// identificar quién la mandó y contestarle si hace falta.
export async function leerSugerencias() {
  try {
    const data = await leerJsonBlob(SUGERENCIAS_PATH);
    return data && Array.isArray(data.sugerencias) ? data.sugerencias : [];
  } catch (e) {
    return [];
  }
}
export async function guardarSugerencias(sugerencias) {
  await escribirJsonBlob(SUGERENCIAS_PATH, { sugerencias, actualizado: new Date().toISOString() });
}

// Saldo de crédito de Anthropic, declarado A MANO desde el panel.
// Por qué a mano: la API de Anthropic NO expone el saldo restante (no existe
// endpoint de balance), y la Usage & Cost Admin API solo informa lo YA gastado,
// necesita otra clave (sk-ant-admin01-...) y no está disponible para cuentas
// individuales. Así que el dueño anota lo que ve en la consola y desde ahí
// estimamos: saldo - (ritmo diario x días transcurridos).
export async function leerCredito() {
  try { return (await leerJsonBlob(CREDITO_PATH)) || null; } catch (e) { return null; }
}
export async function guardarCredito(usd) {
  const dato = { usd: Number(usd) || 0, fecha: new Date().toISOString() };
  await escribirJsonBlob(CREDITO_PATH, dato);
  return dato;
}

// --- Estado de trámites por patente (Nivel 2: integración con el CRM) ---
// Índice liviano y NO sensible (sin fotos ni DNI): por patente, el nombre, el
// estado del último trámite, si la oblea está lista y el próximo turno.
// Estelita lo empuja al guardar; el CRM lo consulta por patente para que el
// agente de WhatsApp responda con datos reales. Un archivo por licencia/taller.
function estadoPath(license) {
  return 'sistema/estado-' + String(license || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) + '.json';
}
export async function leerEstadoTramites(license) {
  try { return (await leerJsonBlob(estadoPath(license))) || null; } catch (e) { return null; }
}
export async function guardarEstadoTramites(license, estados) {
  await escribirJsonBlob(estadoPath(license), { estados: estados || {}, actualizado: new Date().toISOString() });
}

// --- Pedidos de turno desde WhatsApp (Nivel 2) ---
// El CRM empuja acá los pedidos de turno que hace el cliente por WhatsApp;
// Estelita los lee y el dueño los carga a su agenda con un toque. Un archivo
// por licencia/taller. NO sensible: solo nombre, teléfono y qué pidió.
function turnosWaPath(license) {
  return 'sistema/turnoswa-' + String(license || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) + '.json';
}
export async function leerTurnosWa(license) {
  try {
    const data = await leerJsonBlob(turnosWaPath(license));
    return data && Array.isArray(data.turnos) ? data.turnos : [];
  } catch (e) { return []; }
}
export async function guardarTurnosWa(license, turnos) {
  await escribirJsonBlob(turnosWaPath(license), { turnos: turnos || [], actualizado: new Date().toISOString() });
}
export async function agregarTurnoWa(license, turno) {
  const lista = await leerTurnosWa(license);
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + crypto.randomInt(1e9)),
    creado: new Date().toISOString(),
    nombre: String(turno?.nombre || '').trim().slice(0, 120),
    telefono: String(turno?.telefono || '').trim().slice(0, 40),
    patente: String(turno?.patente || '').trim().slice(0, 15).toUpperCase(),
    vehiculo: String(turno?.vehiculo || '').trim().slice(0, 120),
    detalle: String(turno?.detalle || '').trim().slice(0, 500),
  };
  lista.unshift(item); // el más nuevo primero
  await guardarTurnosWa(license, lista.slice(0, 200)); // tope de resguardo
  return item;
}
export async function quitarTurnoWa(license, id) {
  const lista = await leerTurnosWa(license);
  const filtrada = lista.filter(t => t.id !== id);
  await guardarTurnosWa(license, filtrada);
  return lista.length !== filtrada.length;
}
export async function agregarSugerencia({ license, taller, texto }) {
  const lista = await leerSugerencias();
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + crypto.randomInt(1e9)),
    fecha: new Date().toISOString(),
    license: String(license || '').trim().slice(0, 40),
    taller: String(taller || '').trim().slice(0, 120),
    texto: String(texto || '').trim().slice(0, 2000),
    estado: 'nueva',
  };
  lista.unshift(item); // la más nueva primero
  await guardarSugerencias(lista.slice(0, 1000)); // tope de resguardo
  return item;
}

// ¿La licencia puede usar los servicios pagos?
// - Si el store tiene datos: es la fuente autoritativa (así suspender/eliminar
//   desde el panel surte efecto al instante). El panel siembra el store con
//   TODOS los códigos del env la primera vez, así no se pierde ninguno.
// - Si el store está vacío o no se puede leer (Blob caído): respaldo del env
//   (LICENSE_CODES), para que los talleres existentes nunca queden afuera.
// Días de gracia después de la fecha de "pago al día hasta" antes de cortar,
// por si un cobro se atrasa un par de días o un webhook llega tarde.
export const GRACIA_DIAS = 5;

export async function licenciaValida(codigo) {
  const cod = (codigo || '').trim();
  if (!cod) return false;
  const lics = await leerLicencias();
  if (lics.length) {
    const l = lics.find(x => x.codigo === cod);
    if (!l || l.estado !== 'activo') return false;
    // Corte automático por vencimiento: si tiene fecha de "pago al día hasta"
    // y ya pasó (más la gracia), deja de valer aunque figure activa. Las
    // licencias sin pagoHasta (ej. las viejas) no se ven afectadas.
    if (l.pagoHasta) {
      const limite = new Date(l.pagoHasta + 'T00:00:00');
      limite.setDate(limite.getDate() + GRACIA_DIAS);
      if (new Date() > limite) return false;
    }
    return true;
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
