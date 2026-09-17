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

// Planes y precios (ARS/mes) de Estelita (taller). Fuente única, usada por el checkout de MP y el panel.
export const PLAN_PRECIOS = { basico: 48000, profesional: 85000, full: 120000 };
export const PLAN_NOMBRES = { basico: 'Básico', profesional: 'Profesional', full: 'Full' };

// Planes de Estelita Repuestos. Cada plan dice qué funciones incluye y el
// tope de usuarios de la app por local. `lecturasDia` (lecturas de listas con
// IA por día) va en 0 = sin tope: por ahora no se limita (decisión del
// 17/09/2026); se puede poner un tope a un cliente puntual desde el panel.
// Lo base (stock, mostrador, clientes, encargos, compras, caja, estadísticas)
// va en todos y no se lista. La app lee esto por /api/servidor (derechos) y
// corta del lado del servidor lo que el plan no incluye. La misma tabla vive
// en repuestos/src/lib/constantes.ts para la pantalla de Ajustes y la landing:
// si cambia acá, cambiarla allá. El checkout de MP (api/mp.js) también la usa.
export const FUNCIONES_REPUESTOS = {
  facturacion: 'Facturación ARCA',
  ia: 'Lectura de listas con IA',
  whatsapp: 'WhatsApp (CRM y agente)',
  mercadopago: 'Cobros con Mercado Pago',
  vidriera: 'Vidriera pública',
  mercadolibre: 'Mercado Libre',
  tiendanube: 'Tienda Nube',
  multilocal: 'Multilocal',
};
export const PLANES_REPUESTOS = {
  basico: { nombre: 'Básica', precio: 80000, usuarios: 3, lecturasDia: 0, funciones: ['facturacion', 'ia'] },
  profesional: { nombre: 'Profesional', precio: 150000, usuarios: 5, lecturasDia: 0, funciones: ['facturacion', 'ia', 'whatsapp', 'mercadopago', 'vidriera'] },
  full: { nombre: 'Full', precio: 220000, usuarios: 10, lecturasDia: 0, funciones: ['facturacion', 'ia', 'whatsapp', 'mercadopago', 'vidriera', 'mercadolibre', 'tiendanube', 'multilocal'] },
};

/**
 * Los derechos efectivos de una licencia de Repuestos: lo que trae el plan
 * más las excepciones cargadas a mano en el panel (`l.funciones` = { funcion:
 * true|false } sólo para las que se pisan; `l.topes` = { usuarios, lecturasDia }
 * sólo si se pisan). Sin plan devuelve null: la app lo toma como "legado, todo
 * habilitado" hasta que se le asigne uno.
 */
export function derechosDe(l) {
  if (!l || productoDe(l) !== 'repuestos') return null;
  const plan = PLANES_REPUESTOS[l.plan];
  if (!plan) return null;
  const funciones = {};
  const excepciones = l.funciones && typeof l.funciones === 'object' ? l.funciones : {};
  for (const f of Object.keys(FUNCIONES_REPUESTOS)) {
    funciones[f] = typeof excepciones[f] === 'boolean' ? excepciones[f] : plan.funciones.includes(f);
  }
  const topes = l.topes && typeof l.topes === 'object' ? l.topes : {};
  return {
    plan: l.plan,
    nombre: plan.nombre,
    precio: plan.precio,
    funciones,
    usuarios: Number(topes.usuarios) > 0 ? Number(topes.usuarios) : plan.usuarios,
    lecturasDia: Number(topes.lecturasDia) >= 0 && topes.lecturasDia !== undefined && topes.lecturasDia !== null && topes.lecturasDia !== '' ? Number(topes.lecturasDia) : plan.lecturasDia,
    excepciones: Object.keys(excepciones).filter(f => typeof excepciones[f] === 'boolean'),
  };
}

// Genera un código de licencia único (sin O/0/I/1/L, fácil de dictar).
// El prefijo dice de qué producto es: GNC- (Estelita, el taller) o REP-
// (Estelita Repuestos, la casa de repuestos). Los dos se validan igual por
// /api/licencia; el prefijo es para que a simple vista se sepa cuál es cuál.
const ALFA_COD = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PRODUCTOS = { taller: 'GNC', repuestos: 'REP' };
export function nuevoCodigo(existentes, producto = 'taller') {
  const set = new Set(existentes || []);
  const prefijo = PRODUCTOS[producto] || PRODUCTOS.taller;
  let c;
  do { c = prefijo + '-' + Array.from({ length: 4 }, () => ALFA_COD[crypto.randomInt(ALFA_COD.length)]).join(''); } while (set.has(c));
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
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};
const PRECIO_DEFECTO = { in: 3, out: 15 };

// De qué producto es una licencia: lo que guardó el panel o, para las viejas
// (que no tienen el campo), el prefijo del código.
export function productoDe(l) {
  if (l && PRODUCTOS[l.producto]) return l.producto;
  const cod = String((l && l.codigo) || '').toUpperCase();
  return cod.startsWith('REP-') ? 'repuestos' : 'taller';
}

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

// Lectura TOLERANTE: ante un error de storage devuelve [] para que los caminos
// de validación caigan al respaldo del env en vez de dejar a un taller afuera.
// OJO: solo para LEER. Para cualquier camino que después ESCRIBA la lista hay
// que usar leerLicenciasEstricto(), porque un [] por error de red seguido de un
// guardarLicencias() borra todas las licencias reales.
export async function leerLicencias() {
  try {
    const data = await leerJsonBlob(STORE_PATH);
    return data && Array.isArray(data.licencias) ? data.licencias : [];
  } catch (e) {
    return [];
  }
}

// Lectura ESTRICTA: distingue "no hay licencias" de "no se pudo leer".
// Si el storage falla, TIRA el error en vez de devolver una lista vacía. Es lo
// que usan todos los caminos que después sobrescriben el archivo (el panel de
// admin y los webhooks de Mercado Pago): sin esto, un hipo de red hacía que el
// llamador creyera que el store estaba vacío y lo pisara entero.
export async function leerLicenciasEstricto() {
  const data = await leerJsonBlob(STORE_PATH);
  return data && Array.isArray(data.licencias) ? data.licencias : [];
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
// `producto` ('taller' o 'repuestos') decide el prefijo del código y el plan
// que se guarda; `nombre` es el del taller o negocio que se cargó en el
// formulario, para que en el panel se sepa quién es sin abrir MP.
export async function activarLicenciaMP({ token, preapprovalId, email, plan, pagoHasta, prueba, producto, nombre }) {
  // Estricto: este camino escribe la lista completa. Si la lectura falla,
  // preferimos que el webhook devuelva error y Mercado Pago reintente, antes
  // que sobrescribir el archivo con una sola licencia.
  const lics = await leerLicenciasEstricto();
  let l = lics.find(x => x.mpPreapprovalId === preapprovalId);
  if (!l) {
    const prod = PRODUCTOS[producto] ? producto : 'taller';
    const codigo = nuevoCodigo(lics.map(x => x.codigo).concat(codigosEnv()), prod);
    l = {
      codigo, taller: String(nombre || '').slice(0, 80), estado: 'activo', alta: new Date().toISOString().slice(0, 10),
      topeDia: prod === 'repuestos' ? 0 : 50, notas: '', plan: plan || '', medioPago: 'mp', email: email || '',
      origen: 'web', producto: prod, mpPreapprovalId: preapprovalId, prueba: !!prueba, pagoHasta: pagoHasta || null,
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
  const lics = await leerLicenciasEstricto();
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
  const lics = await leerLicenciasEstricto();
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
  // Dedup: la extracción del CRM corre en cada mensaje, así que si ya hay un
  // pedido pendiente del mismo teléfono lo reemplazamos por el más nuevo.
  const sinDup = item.telefono ? lista.filter(t => t.telefono !== item.telefono) : lista;
  sinDup.unshift(item); // el más nuevo primero
  await guardarTurnosWa(license, sinDup.slice(0, 200)); // tope de resguardo
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

/**
 * Lo mismo que licenciaValida, pero contando el porqué. Es lo que usan los
 * servidores de Estelita (Repuestos, el CRM) por /api/servidor: además de
 * "sí/no" necesitan saber si está suspendida, vencida o si el correo que la
 * reclama no es el del titular.
 *
 *   motivo: 'ok' | 'inexistente' | 'suspendida' | 'vencida' | 'producto' | 'email'
 *
 * El correo: la primera vez que un servidor verifica una licencia con un
 * correo, ese correo queda como titular (si el panel no cargó uno). Desde ahí,
 * otro correo con el mismo código es rechazado. Así un código que se filtra no
 * alcanza para colgarse del negocio de otro.
 */
export async function licenciaDetalle(codigo, { email, producto } = {}) {
  const cod = (codigo || '').trim().toUpperCase();
  if (!cod) return { ok: false, motivo: 'inexistente' };
  const mail = String(email || '').trim().toLowerCase();
  let lics;
  try {
    lics = await leerLicenciasEstricto();
  } catch (e) {
    // Sin storage se contesta con el respaldo del env, sin detalle.
    return codigosEnv().includes(cod) ? { ok: true, motivo: 'ok', licencia: { codigo: cod } } : { ok: false, motivo: 'inexistente' };
  }
  const l = lics.find(x => x.codigo === cod);
  if (!l) {
    return codigosEnv().includes(cod) ? { ok: true, motivo: 'ok', licencia: { codigo: cod } } : { ok: false, motivo: 'inexistente' };
  }
  const publica = () => ({
    codigo: l.codigo, producto: productoDe(l), plan: l.plan || '', estado: l.estado,
    pagoHasta: l.pagoHasta || null, prueba: !!l.prueba, topeDia: Number(l.topeDia) || 0,
    taller: l.taller || '', emailVinculado: !!l.email,
    derechos: derechosDe(l),
  });
  if (l.estado !== 'activo') return { ok: false, motivo: 'suspendida', licencia: publica() };
  if (l.pagoHasta) {
    const limite = new Date(l.pagoHasta + 'T00:00:00');
    limite.setDate(limite.getDate() + GRACIA_DIAS);
    if (new Date() > limite) return { ok: false, motivo: 'vencida', licencia: publica() };
  }
  if (producto && PRODUCTOS[producto] && productoDe(l) !== producto) return { ok: false, motivo: 'producto', licencia: publica() };
  if (mail) {
    const titular = String(l.email || '').trim().toLowerCase();
    if (titular && titular !== mail) return { ok: false, motivo: 'email', licencia: publica() };
    if (!titular) {
      l.email = mail;
      l.notas = [l.notas, `Correo vinculado al primer uso (${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join(' · ');
      await guardarLicencias(lics);
    }
  }
  return { ok: true, motivo: 'ok', licencia: publica() };
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
// `origen` separa de dónde salió el gasto: 'lecturas' (la app del taller),
// 'whatsapp' (el agente del CRM), 'listas' y 'mercadolibre' (Repuestos),
// 'laboratorio', 'inmobiliaria'. Queda en porOrigen dentro del mismo código.
// Best-effort: nunca tira error para no afectar la respuesta de la lectura.
export async function registrarConsumo(codigo, model, usage, origen) {
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
    const o = String(origen || 'lecturas').replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || 'lecturas';
    c.porOrigen = c.porOrigen || {};
    const po = c.porOrigen[o] || (c.porOrigen[o] = { reads: 0, costoUSD: 0 });
    po.reads += 1; po.costoUSD += costo;
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
    // Repuestos: el tope sale del plan (o del tope pisado a mano); taller: topeDia.
    const derechos = derechosDe(l);
    const tope = derechos ? Number(derechos.lecturasDia) : (l && Number(l.topeDia) > 0 ? Number(l.topeDia) : 0);
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

// Ritmo de consumo de la IA. El consumo se guarda por MES (no por día), así que
// el ritmo se estima como: gastado del mes / días transcurridos del mes. Se
// compara con el mes anterior para ver si se está acelerando.
// La autonomía sale del saldo declarado a mano (Anthropic no expone el saldo):
// saldo - (ritmo x días desde que se declaró).
export function calcularRitmo(costoMesUSD, readsMes, costoMesAnteriorUSD, credito) {
  const hoy = new Date();
  const diaDelMes = hoy.getUTCDate(); // días transcurridos (el de hoy, parcial, cuenta)
  const diasDelMes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 0)).getUTCDate();
  const mesAnt = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0));
  const diasMesAnterior = mesAnt.getUTCDate();

  const ritmoEsteMes = diaDelMes > 0 ? costoMesUSD / diaDelMes : 0;
  const ritmoMesAnterior = diasMesAnterior > 0 ? costoMesAnteriorUSD / diasMesAnterior : 0;
  // Arranque de mes: 1-2 días es una muestra muy chica. Si todavía no hay
  // consumo este mes, el ritmo del mes pasado representa mejor la realidad.
  const muestraChica = diaDelMes <= 2;
  const ritmoUSDdia = (ritmoEsteMes > 0) ? ritmoEsteMes : ritmoMesAnterior;
  const lecturasDia = diaDelMes > 0 ? readsMes / diaDelMes : 0;

  let autonomia = null;
  if (credito && Number(credito.usd) > 0) {
    const diasDesde = Math.max(0, (hoy - new Date(credito.fecha)) / 86400000);
    const saldoEstimado = Math.max(0, Number(credito.usd) - ritmoUSDdia * diasDesde);
    autonomia = {
      declarado: Number(credito.usd),
      declaradoEn: credito.fecha,
      diasDesdeQueLoDeclaraste: Math.floor(diasDesde),
      saldoEstimadoUSD: saldoEstimado,
      // Sin consumo no se puede proyectar: días = null (no "infinito").
      dias: ritmoUSDdia > 0 ? Math.floor(saldoEstimado / ritmoUSDdia) : null,
    };
  }

  return {
    ritmoUSDdia, lecturasDia, muestraChica,
    ritmoMesAnteriorUSDdia: ritmoMesAnterior,
    proyeccionMesUSD: ritmoUSDdia * diasDelMes,
    diaDelMes, diasDelMes,
    autonomia,
  };
}
