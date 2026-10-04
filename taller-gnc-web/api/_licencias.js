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
import { put, list, del } from '@vercel/blob';
import crypto from 'crypto';

// El archivo único de licencias: ya NO se escribe, queda sólo como origen de la
// migración y como respaldo histórico. Ahora cada licencia vive en su propio
// archivo bajo LIC_PREFIX (ver más abajo el por qué).
const STORE_VIEJO_PATH = 'sistema/licencias.json';
const LIC_PREFIX = 'sistema/licencias/';
const LIC_MIGRADO_PATH = 'sistema/licencias-migrado.json';
// Índice de suscripciones de Mercado Pago → código de licencia. Ver
// licenciaPorPreapproval() más abajo: el list() de Blob tiene consistencia
// EVENTUAL y este puntero se lee por URL directa, que es consistente al instante.
const LIC_MP_PREFIX = 'sistema/licencias-mp/';
const SIGNUPS_PATH = 'sistema/signups.json';
const SUGERENCIAS_PATH = 'sistema/sugerencias.json';
const CREDITO_PATH = 'sistema/credito.json';
// Uso diario y consumo mensual: un archivo POR LICENCIA (sistema/uso/<fecha>/<cod>.json
// y sistema/consumo/<mes>/<cod>.json). Los "-viejo" son los archivos únicos que
// usábamos antes; se siguen leyendo para no perder el histórico.
const USO_PREFIX = 'sistema/uso/';
const CONSUMO_PREFIX = 'sistema/consumo/';
const USO_VIEJO_PREFIX = 'sistema/uso-';
const CONSUMO_VIEJO_PREFIX = 'sistema/consumo-';

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

// Un código normalizado: sin espacios y en MAYÚSCULA. Se generan siempre en
// mayúscula, así que cualquier comparación tiene que normalizar los dos lados.
// Sin esto, un taller que tipeaba su código en minúscula era rechazado por
// /api/licencia (que comparaba tal cual) y aceptado por Repuestos (que sí
// normalizaba): el mismo código valía o no según por dónde entrara.
export function normCodigo(c) {
  return String(c == null ? '' : c).trim().toUpperCase();
}
// 8 caracteres de azar (32⁸ ≈ 1,1 billones) partidos en dos grupos de cuatro:
// GNC-XXXX-XXXX es más fácil de dictar por teléfono que un bloque de ocho, y
// deja sin sentido probar códigos al voleo. Los códigos viejos de 4 caracteres
// (GNC-XXXX) siguen valiendo: acá sólo se decide el formato de los NUEVOS, la
// validación no mira el largo.
export function nuevoCodigo(existentes, producto = 'taller') {
  const set = new Set((existentes || []).map(normCodigo));
  const prefijo = PRODUCTOS[producto] || PRODUCTOS.taller;
  const azar = (n) => Array.from({ length: n }, () => ALFA_COD[crypto.randomInt(ALFA_COD.length)]).join('');
  let c;
  do { c = `${prefijo}-${azar(4)}-${azar(4)}`; } while (set.has(c));
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

// Lista blanca de modelos que /api/read-docs acepta, y techo de tokens de
// salida. Por qué: ese endpoint reenvía el cuerpo TAL CUAL a Anthropic, así que
// un código de licencia filtrado alcanzaba para pedirle a la API el modelo más
// caro con la salida más larga y hacernos la cuenta. La app pide
// claude-sonnet-4-6 con max_tokens 4000; el techo deja aire pero no cheque en
// blanco. Si se agrega un modelo acá, agregarle también el precio arriba.
export const MODELOS_IA = Object.keys(PRECIOS_IA);
export const MAX_TOKENS_IA = 8000;

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

// --- El store de licencias: UN ARCHIVO POR LICENCIA ---
//
// POR QUÉ. Antes todas las licencias vivían en sistema/licencias.json: trece
// caminos distintos (el panel, los webhooks de Mercado Pago, el vínculo del
// correo al primer uso) leían la lista entera, la modificaban y la volvían a
// escribir completa. Sin bloqueo y en serverless eso es una lotería: dos cosas
// a la vez y la que escribe última pisa a la otra. El peor caso ya pasó de ser
// teórico — un alta de Mercado Pago COBRADA que desaparece del panel porque un
// "registrar pago" hecho a mano un segundo después guardó la lista vieja.
//
// Con un archivo por licencia (sistema/licencias/<CODIGO>.json) cada mutación
// toca sólo el archivo de SU licencia: dos talleres nunca se pisan, y lo peor
// que puede pasar es que dos cambios a la MISMA licencia compitan entre sí.
// Es el mismo patrón que ya usamos para los signups (más abajo), por los mismos
// motivos y con el mismo resultado.

// El nombre del archivo sale del código, así que el código tiene que ser una
// ruta segura. Los códigos son prefijo + letras/números + guiones; si llega
// cualquier otra cosa preferimos tirar error antes que escribir en una ruta
// rara (o, peor, pisar otra licencia).
function rutaLicencia(codigo) {
  const cod = normCodigo(codigo);
  if (!/^[A-Z0-9][A-Z0-9_-]{0,58}$/.test(cod)) throw new Error('Código de licencia inválido: ' + codigo);
  return `${LIC_PREFIX}${cod}.json`;
}

function rutaPreapproval(preapprovalId) {
  const id = String(preapprovalId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return id ? `${LIC_MP_PREFIX}${id}.json` : null;
}

// Lista TODOS los blobs de un prefijo (list() devuelve 1000 por página).
async function listarTodo(prefijo) {
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix: prefijo, cursor });
    for (const b of r.blobs || []) out.push(b);
    cursor = r.hasMore ? r.cursor : null;
  } while (cursor);
  return out;
}

// Migración al vuelo, idempotente. Corre una vez por proceso y a lo sumo una
// vez en la vida del store: deja una marca (sistema/licencias-migrado.json) y
// NO borra el archivo viejo — queda como respaldo del día que migramos.
//
// El orden importa: primero la marca (lectura por URL, consistente al
// instante), después el listado. Si mirásemos sólo el listado, un list() que
// devuelve vacío por un hipo de Blob volvería a migrar desde el archivo viejo
// y pisaría licencias nuevas con datos de hace meses.
let migracionHecha = false;
async function migrarLicenciasSiHaceFalta() {
  // Sin storage configurado no hay nada que migrar ni que leer: los caminos de
  // validación caen al respaldo del env, como siempre.
  if (migracionHecha || !process.env.BLOB_READ_WRITE_TOKEN) return;
  const marca = await leerJsonBlob(LIC_MIGRADO_PATH);
  if (marca) { migracionHecha = true; return; }
  const { blobs } = await list({ prefix: LIC_PREFIX, limit: 1 });
  if (blobs && blobs.length) {
    // Ya hay archivos por licencia (migración anterior sin marca): sólo marcar.
    await escribirJsonBlob(LIC_MIGRADO_PATH, { migrado: new Date().toISOString(), licencias: null, nota: 'ya habia archivos por licencia' });
    migracionHecha = true;
    return;
  }
  const viejo = await leerJsonBlob(STORE_VIEJO_PATH);
  const lista = viejo && Array.isArray(viejo.licencias) ? viejo.licencias : [];
  for (const l of lista) {
    if (!l || !normCodigo(l.codigo)) continue;
    await escribirJsonBlob(rutaLicencia(l.codigo), l);
    // Y el puntero de Mercado Pago, para que los webhooks no dependan de list().
    const rutaMp = l.mpPreapprovalId && rutaPreapproval(l.mpPreapprovalId);
    if (rutaMp) await escribirJsonBlob(rutaMp, { codigo: normCodigo(l.codigo) });
  }
  await escribirJsonBlob(LIC_MIGRADO_PATH, { migrado: new Date().toISOString(), licencias: lista.length, desde: STORE_VIEJO_PATH });
  migracionHecha = true;
}

// Una sola licencia por su código: UN pedido al storage en vez de la lista
// entera. Es lo que usan los caminos de validación (el camino caliente).
// null = no existe de verdad; tira si el storage no contesta.
export async function leerLicencia(codigo) {
  const cod = normCodigo(codigo);
  if (!cod || !process.env.BLOB_READ_WRITE_TOKEN) return null;
  await migrarLicenciasSiHaceFalta();
  return leerJsonBlobFirme(rutaLicencia(cod), 2);
}

// ¿El store conoce AL MENOS una licencia? Sirve para decidir si el store es la
// fuente autoritativa (y entonces un código que no está ahí no vale) o si está
// vacío y hay que caer al respaldo del env. Un solo pedido, sin leer nada.
async function hayLicenciasEnStore() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  await migrarLicenciasSiHaceFalta();
  const { blobs } = await list({ prefix: LIC_PREFIX, limit: 1 });
  return !!(blobs && blobs.length);
}

// Lectura ESTRICTA de la lista completa: distingue "no hay licencias" de "no
// se pudo leer". Si el storage falla, TIRA el error en vez de devolver una
// lista vacía — es lo que usan el panel y los webhooks, y un [] por un hipo de
// red seguido de un guardado dejaba el store en la nada.
export async function leerLicenciasEstricto() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  await migrarLicenciasSiHaceFalta();
  const blobs = await listarTodo(LIC_PREFIX);
  const rutas = blobs.map(b => b.pathname).filter(p => p.endsWith('.json'));
  const leidas = await Promise.all(rutas.map(p => leerJsonBlobFirme(p, 2)));
  return leidas.filter(l => l && normCodigo(l.codigo));
}

// La licencia de una suscripción de Mercado Pago.
//
// POR QUÉ NO ES UN find() SOBRE LA LISTA. El list() de Blob tiene consistencia
// EVENTUAL: un archivo recién escrito puede tardar en aparecer. Mercado Pago
// repite los avisos y a veces manda dos en el mismo segundo, así que buscar por
// la lista podía NO ver la licencia que se acababa de crear y crear una
// SEGUNDA para la misma suscripción (el cliente con dos códigos y nosotros
// cobrando uno). El puntero sistema/licencias-mp/<id>.json se lee por URL
// directa, que sí es consistente al instante.
//
// La lista queda como respaldo, para las licencias de antes de que existiera el
// puntero; cuando aparece por ahí, se le escribe el puntero (se cura sola).
export async function licenciaPorPreapproval(preapprovalId) {
  const ruta = rutaPreapproval(preapprovalId);
  if (!ruta) return null;
  const puntero = await leerJsonBlobFirme(ruta, 2);
  if (puntero && puntero.codigo) {
    const l = await leerLicencia(puntero.codigo);
    if (l) return l;
    // El puntero apunta a una licencia borrada: no vale, seguimos por la lista.
  }
  const lics = await leerLicenciasEstricto();
  const l = lics.find(x => String(x.mpPreapprovalId || '') === String(preapprovalId));
  if (l) {
    try { await escribirJsonBlob(ruta, { codigo: normCodigo(l.codigo) }); } catch (e) { /* se vuelve a intentar la próxima */ }
  }
  return l || null;
}

// Lectura TOLERANTE: ante un error de storage devuelve [] para que los caminos
// de validación caigan al respaldo del env en vez de dejar a un taller afuera.
// OJO: solo para LEER, y nunca para decidir qué escribir.
export async function leerLicencias() {
  try {
    return await leerLicenciasEstricto();
  } catch (e) {
    return [];
  }
}

// Guarda UNA licencia (su archivo y nada más). Toda mutación pasa por acá.
export async function guardarLicencia(l) {
  if (!l || !normCodigo(l.codigo)) throw new Error('Licencia sin código.');
  await escribirJsonBlob(rutaLicencia(l.codigo), l);
}

// Varias de una (el sembrado inicial y la migración). Igual escribe un archivo
// por licencia: no existe más el "guardar la lista completa".
export async function guardarVariasLicencias(licencias) {
  for (const l of licencias || []) await guardarLicencia(l);
}

// Marca de "ya se sembró el store con los códigos del env".
//
// POR QUÉ HACE FALTA. El panel siembra cuando ve la lista vacía, y la lista
// ahora sale de un list(), que tiene consistencia eventual: justo después de
// sembrar puede volver a verse vacía por un segundo y el panel sembraría de
// nuevo, pisando con `alta: hoy` cualquier cambio hecho en el medio. Esta marca
// se lee por URL directa, que es consistente al instante.
const LIC_SEMBRADO_PATH = 'sistema/licencias-sembrado.json';
export async function yaSeSembro() {
  try { return !!(await leerJsonBlob(LIC_SEMBRADO_PATH)); } catch (e) { return true; /* ante la duda, no sembrar */ }
}
export async function marcarSembrado(cuantas) {
  await escribirJsonBlob(LIC_SEMBRADO_PATH, { sembrado: new Date().toISOString(), licencias: Number(cuantas) || 0 });
}

export async function borrarLicencia(codigo) {
  // El puntero de Mercado Pago se va con ella: si queda apuntando a un archivo
  // que no existe, el webhook crearía una licencia nueva creyendo que se perdió.
  let l = null;
  try { l = await leerLicencia(codigo); } catch (e) { l = null; }
  await del(rutaLicencia(codigo));
  const ruta = l && l.mpPreapprovalId && rutaPreapproval(l.mpPreapprovalId);
  if (ruta) { try { await del(ruta); } catch (e) { /* ya no estaba */ } }
}

// --- Suscripciones de Mercado Pago ---
// Registro de "signups" web: mapea el token de un registro al código de
// licencia que se le creó, para que la página de "gracias" lo muestre.
//
// Cada signup vive en SU archivo (sistema/signups/<token>.json). Antes iban todos
// en un solo JSON que se leía, se modificaba y se reescribía: una lectura fallida
// (pasa de forma intermitente con Blob) devolvía {} y el guardado siguiente
// BORRABA los demás, o el webhook no encontraba el plan y el producto y creaba
// una licencia de taller sin plan para una compra de Repuestos. Con un archivo
// por signup no hay nada que pisar. El JSON viejo se sigue leyendo como respaldo.
const SIGNUP_PREFIX = 'sistema/signups/';
const tokenSignupOk = (t) => /^S[0-9a-f]{6,40}$/.test(String(t || ''));
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

// Lee un JSON de Blob insistiendo: reintenta ante error Y ante "no existe"
// (un archivo recién escrito puede tardar en verse). null = no existe de verdad.
async function leerJsonBlobFirme(path, intentos = 4) {
  let ultimoError = null;
  for (let i = 0; i < intentos; i++) {
    try {
      const d = await leerJsonBlob(path);
      if (d) return d;
      ultimoError = null;
    } catch (e) { ultimoError = e; }
    if (i < intentos - 1) await pausa(350 * (i + 1));
  }
  if (ultimoError) throw ultimoError;
  return null;
}

export async function leerSignups() { try { return (await leerJsonBlob(SIGNUPS_PATH)) || {}; } catch (e) { return {}; } }

// Un signup por token. Tira si Blob no contesta (para que el que llama decida
// reintentar); devuelve null si de verdad no existe.
export async function leerSignup(token) {
  if (!tokenSignupOk(token)) return null;
  const propio = await leerJsonBlobFirme(`${SIGNUP_PREFIX}${token}.json`);
  if (propio) return propio;
  const viejos = await leerJsonBlobFirme(SIGNUPS_PATH, 2);
  return (viejos && viejos[token]) || null;
}

export async function guardarSignup(token, datos) {
  if (!tokenSignupOk(token)) throw new Error('Token de signup inválido.');
  await escribirJsonBlob(`${SIGNUP_PREFIX}${token}.json`, datos);
}

export async function crearSignup(token, datos) {
  await guardarSignup(token, { ...datos, estado: 'pendiente', codigo: null, creado: new Date().toISOString() });
}

// Cuando MP autoriza la suscripción: crea la licencia (una sola vez por
// preapproval) y la vincula al signup. Devuelve el código.
// `producto` ('taller' o 'repuestos') decide el prefijo del código y el plan
// que se guarda; `nombre` es el del taller o negocio que se cargó en el
// formulario, para que en el panel se sepa quién es sin abrir MP.
export async function activarLicenciaMP({ token, preapprovalId, email, plan, pagoHasta, prueba, producto, nombre }) {
  // Por el puntero, no por la lista: ver licenciaPorPreapproval(). Si la
  // lectura falla, tira — preferimos que el webhook devuelva error y Mercado
  // Pago reintente, antes que crear una licencia duplicada para una suscripción
  // que ya tenía la suya.
  let l = await licenciaPorPreapproval(preapprovalId);
  const nueva = !l;
  let reactivada = false;
  if (!l) {
    // Acá sí hace falta la lista entera, para que nuevoCodigo no repita uno.
    const lics = await leerLicenciasEstricto();
    const prod = PRODUCTOS[producto] ? producto : 'taller';
    const codigo = nuevoCodigo(lics.map(x => x.codigo).concat(codigosEnv()), prod);
    l = {
      codigo, taller: String(nombre || '').slice(0, 80), estado: 'activo', alta: new Date().toISOString().slice(0, 10),
      topeDia: prod === 'repuestos' ? 0 : 50, notas: '', plan: plan || '', medioPago: 'mp', email: email || '',
      origen: 'web', producto: prod, mpPreapprovalId: preapprovalId, prueba: !!prueba, pagoHasta: pagoHasta || null,
    };
    await guardarLicencia(l);
    // El puntero DESPUÉS de la licencia: si se corta en el medio, el próximo
    // aviso la encuentra por la lista y escribe el puntero que falta.
    const rutaMp = rutaPreapproval(preapprovalId);
    if (rutaMp) await escribirJsonBlob(rutaMp, { codigo: normCodigo(codigo) });
  } else if (l.estado === 'suspendido' && l.suspendidaMotivo === 'mercadopago') {
    // Reactivación. A esta función sólo se llega con el preapproval en
    // 'authorized' (el webhook y la reconciliación del panel lo chequean), así
    // que si la licencia figura suspendida POR Mercado Pago es porque el cliente
    // pausó y volvió. Antes acá no se tocaba nada: la suscripción quedaba
    // autorizada y cobrando, y la licencia suspendida para siempre.
    l.estado = 'activo';
    delete l.suspendidaDesde;
    delete l.suspendidaMotivo;
    await guardarLicencia(l);
    reactivada = true;
  }
  if (token && tokenSignupOk(token)) {
    let previo = null;
    try { previo = await leerSignup(token); } catch (e) { previo = null; }
    await guardarSignup(token, { ...(previo || { creado: new Date().toISOString() }), estado: 'activa', codigo: l.codigo });
  }
  // `nueva` dice si se creó en ESTA llamada: Mercado Pago repite los avisos, y el
  // correo con la licencia se manda una sola vez.
  return { codigo: l.codigo, nueva, reactivada, licencia: l };
}

// Deja constancia en las notas de una licencia (ej. "correo enviado"). Best-effort.
export async function anotarEnLicencia(codigo, texto) {
  try {
    const l = await leerLicencia(codigo);
    if (!l) return;
    l.notas = [l.notas, texto].filter(Boolean).join(' · ').slice(0, 400);
    await guardarLicencia(l);
  } catch (e) { /* best-effort */ }
}

// Cobro mensual aprobado: renueva un mes y saca de prueba.
//
// IDEMPOTENTE POR PAGO. Mercado Pago repite los avisos por diseño (y manda el
// mismo cobro por dos vías: authorized_payment y payment), así que antes cada
// aviso repetido sumaba OTRO mes: reenviar a mano el mismo aviso regalaba
// meses de suscripción. Ahora el id del pago queda anotado en la licencia
// (`pagosAplicados`, los últimos 20) y un id ya visto no suma nada.
//
// `pagoId` es obligatorio: sin él no se puede distinguir un cobro nuevo de un
// aviso repetido, y preferimos no renovar antes que volver a regalar meses. Los
// dos caminos del webhook siempre tienen uno (si no, ni llegan hasta acá).
export async function renovarPorPreapproval(preapprovalId, pagoId) {
  const idPago = String(pagoId || '').trim().slice(0, 80);
  if (!idPago) return { aplicado: false, motivo: 'sin-id-de-pago' };
  const l = await licenciaPorPreapproval(preapprovalId);
  if (!l) return { aplicado: false, motivo: 'inexistente' };
  const aplicados = Array.isArray(l.pagosAplicados) ? l.pagosAplicados.map(String) : [];
  if (aplicados.includes(idPago)) return { aplicado: false, motivo: 'repetido', codigo: l.codigo };
  const hoy = new Date().toISOString().slice(0, 10);
  const base = (l.pagoHasta && l.pagoHasta > hoy) ? l.pagoHasta : hoy;
  l.pagoHasta = sumarMesISO(base);
  l.prueba = false;
  l.estado = 'activo';
  l.pagosAplicados = aplicados.concat(idPago).slice(-20);
  // Volvió a pagar: deja de figurar suspendida.
  delete l.suspendidaDesde;
  delete l.suspendidaMotivo;
  await guardarLicencia(l);
  return { aplicado: true, motivo: 'renovada', codigo: l.codigo, pagoHasta: l.pagoHasta };
}

// Suscripción cancelada/pausada (o pago devuelto/desconocido): suspende la licencia.
export async function suspenderPorPreapproval(preapprovalId, motivoTexto) {
  const l = await licenciaPorPreapproval(preapprovalId);
  if (!l) return false;
  l.estado = 'suspendido';
  // Desde cuándo: el panel muestra "suspendida hace N días". Si ya estaba
  // suspendida, se respeta la fecha original.
  if (!l.suspendidaDesde) l.suspendidaDesde = new Date().toISOString().slice(0, 10);
  l.suspendidaMotivo = 'mercadopago';
  if (motivoTexto) {
    const hoy = new Date().toISOString().slice(0, 10).split('-').reverse().join('/');
    l.notas = [l.notas, `${motivoTexto} el ${hoy}`].filter(Boolean).join(' · ').slice(0, 400);
  }
  await guardarLicencia(l);
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
// En MAYÚSCULA: desde que licenciaValida acepta el código tipeado en minúscula,
// el mismo taller podría escribir dos archivos distintos (uno por cada forma de
// tipear su código) y el CRM leer el que no se actualiza. Los códigos son
// siempre en mayúscula, así que normalizar deja la ruta de siempre.
function estadoPath(license) {
  return 'sistema/estado-' + normCodigo(license).replace(/[^A-Z0-9_-]/g, '').slice(0, 60) + '.json';
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
// En MAYÚSCULA, por lo mismo que estadoPath.
function turnosWaPath(license) {
  return 'sistema/turnoswa-' + normCodigo(license).replace(/[^A-Z0-9_-]/g, '').slice(0, 60) + '.json';
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
  // MAYÚSCULAS a propósito: los códigos se generan siempre en mayúscula y el
  // taller los tipea como le sale. Comparar tal cual dejaba afuera a quien
  // escribía en minúscula (ver normCodigo).
  const cod = normCodigo(codigo);
  if (!cod) return false;
  let l = null;
  try {
    // Un solo pedido al storage (el archivo de ESA licencia) en vez de la lista
    // completa: este es el camino caliente, lo llaman todos los endpoints.
    l = await leerLicencia(cod);
  } catch (e) {
    // Blob no contesta: respaldo del env, para no dejar afuera a un taller real.
    return codigosEnv().map(normCodigo).includes(cod);
  }
  if (l) {
    if (l.estado !== 'activo') return false;
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
  // No está en el store. Si el store conoce otras licencias es la fuente
  // autoritativa y este código no vale (así "eliminar" desde el panel surte
  // efecto al instante); si está vacío, respaldo del env.
  try {
    if (await hayLicenciasEnStore()) return false;
  } catch (e) { /* no se pudo averiguar: caemos al env */ }
  return codigosEnv().map(normCodigo).includes(cod);
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
  const cod = normCodigo(codigo);
  if (!cod) return { ok: false, motivo: 'inexistente' };
  const mail = String(email || '').trim().toLowerCase();
  const enEnv = codigosEnv().map(normCodigo).includes(cod);
  let l;
  try {
    l = await leerLicencia(cod);
  } catch (e) {
    // Sin storage se contesta con el respaldo del env, sin detalle.
    return enEnv ? { ok: true, motivo: 'ok', licencia: { codigo: cod } } : { ok: false, motivo: 'inexistente' };
  }
  if (!l) {
    return enEnv ? { ok: true, motivo: 'ok', licencia: { codigo: cod } } : { ok: false, motivo: 'inexistente' };
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
      await guardarLicencia(l);
    }
  }
  return { ok: true, motivo: 'ok', licencia: publica() };
}

// --- Uso diario y consumo mensual: UN ARCHIVO POR LICENCIA ---
//
// POR QUÉ. Antes el tope diario y el gasto de IA se llevaban en UN archivo
// compartido por todos los talleres (uso-FECHA.json, consumo-MES.json) con el
// clásico leer-modificar-escribir. Sin bloqueo eso significa dos cosas malas:
// el tope se podía evadir (200 pedidos a la vez leen todos el contador en cero
// y pasan todos) y el gasto que muestra el panel quedaba POR DEBAJO del real
// (cada escritura pisaba lo que había sumado otro taller en el medio).
//
// Con un archivo por licencia dos talleres no se pisan nunca. Queda la carrera
// de un MISMO taller contra sí mismo, que es acotada y no es el agujero: lo que
// se evitaba era que el tope de uno lo abriera el tráfico de otro.
//
// El nombre del archivo tiene que ser una ruta segura, pero acá llegan códigos
// cualesquiera (el CRM manda 'CRM-SIN-LICENCIA' para lo que no tiene licencia),
// así que esto limpia en vez de tirar: un contador no justifica un error.
function codArchivo(codigo) {
  return normCodigo(codigo).replace(/[^A-Z0-9_-]/g, '').slice(0, 60);
}

// Junta los archivos por licencia de una carpeta. Devuelve { codigo: contenido }.
// Si un archivo no se puede leer, se lo saltea: son contadores, no vale tirar
// el panel entero por uno.
async function leerCarpetaPorLicencia(prefijo) {
  const blobs = await listarTodo(prefijo);
  const rutas = blobs.map(b => b.pathname).filter(p => p.endsWith('.json'));
  const out = {};
  await Promise.all(rutas.map(async (p) => {
    const cod = p.slice(prefijo.length).replace(/\.json$/, '');
    if (!cod) return;
    try {
      const d = await leerJsonBlob(p);
      if (d && typeof d === 'object') out[cod] = d;
    } catch (e) { /* ese contador se saltea */ }
  }));
  return out;
}

// Actividad por código: agrega los contadores diarios de lecturas de IA que
// escribe chequearTope, de los últimos `dias` días. Devuelve
// { codigo: { total, hoy, ultimo } }. Solo lectura: no toca el camino caliente.
// Lee el formato nuevo (sistema/uso/<fecha>/<cod>.json) Y el archivo único
// viejo (sistema/uso-<fecha>.json), así el histórico no se pierde.
export async function leerActividad(dias = 30) {
  const out = {};
  const hoy = new Date();
  const fechas = [];
  for (let i = 0; i < dias; i++) {
    fechas.push(new Date(hoy.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  const hoyStr = fechas[0];
  // Clave normalizada, por lo mismo que en leerConsumoMes.
  const sumar = (codRaw, fecha, n) => {
    const cod = normCodigo(codRaw);
    const v = Number(n) || 0;
    if (!cod || !v) return;
    const c = out[cod] || (out[cod] = { total: 0, hoy: 0, ultimo: null });
    c.total += v;
    if (fecha === hoyStr) c.hoy += v;
    if (!c.ultimo || fecha > c.ultimo) c.ultimo = fecha;
  };
  await Promise.all(fechas.map(async (fecha) => {
    // Formato nuevo: una carpeta por día con un archivo por licencia.
    try {
      const porLic = await leerCarpetaPorLicencia(`${USO_PREFIX}${fecha}/`);
      for (const [cod, d] of Object.entries(porLic)) sumar(cod, fecha, d.n);
    } catch (e) { /* sin datos de ese día */ }
    // Formato viejo: un archivo con todos los talleres.
    let uso = null;
    try { uso = await leerJsonBlob(`${USO_VIEJO_PREFIX}${fecha}.json`); } catch (e) { uso = null; }
    if (!uso || typeof uso !== 'object') return;
    for (const [cod, n] of Object.entries(uso)) sumar(cod, fecha, n);
  }));
  return out;
}

// Registra el consumo real de IA de una lectura (tokens + costo estimado en
// US$) por código, acumulado por mes (sistema/consumo/YYYY-MM/<cod>.json). Se llama
// DESPUÉS de la respuesta de Anthropic (que trae el detalle de tokens).
// `origen` separa de dónde salió el gasto: 'lecturas' (la app del taller),
// 'whatsapp' (el agente del CRM), 'listas' y 'mercadolibre' (Repuestos),
// 'laboratorio', 'inmobiliaria'. Queda en porOrigen dentro del mismo código.
// Best-effort: nunca tira error para no afectar la respuesta de la lectura.
export async function registrarConsumo(codigo, model, usage, origen) {
  try {
    const cod = codArchivo(codigo);
    if (!cod || !usage) return;
    const inTok = Number(usage.input_tokens) || 0;
    const outTok = Number(usage.output_tokens) || 0;
    const p = PRECIOS_IA[model] || PRECIO_DEFECTO;
    const costo = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
    const mes = new Date().toISOString().slice(0, 7);
    // Archivo propio de esta licencia: lo que sume otro taller en el mismo
    // momento ya no puede pisar esto (era la causa del gasto sub-reportado).
    const path = `${CONSUMO_PREFIX}${mes}/${cod}.json`;
    let c = null;
    try { c = await leerJsonBlob(path); } catch (e) { c = null; }
    if (!c || typeof c !== 'object') c = { reads: 0, inTok: 0, outTok: 0, costoUSD: 0 };
    c.reads = (Number(c.reads) || 0) + 1;
    c.inTok = (Number(c.inTok) || 0) + inTok;
    c.outTok = (Number(c.outTok) || 0) + outTok;
    c.costoUSD = (Number(c.costoUSD) || 0) + costo;
    const o = String(origen || 'lecturas').replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || 'lecturas';
    c.porOrigen = c.porOrigen && typeof c.porOrigen === 'object' ? c.porOrigen : {};
    const po = c.porOrigen[o] || (c.porOrigen[o] = { reads: 0, costoUSD: 0 });
    po.reads = (Number(po.reads) || 0) + 1;
    po.costoUSD = (Number(po.costoUSD) || 0) + costo;
    await escribirJsonBlob(path, c);
  } catch (e) { /* best-effort */ }
}

// Consumo del mes indicado (por defecto el actual): { codigo: {reads, costoUSD, ...} }.
// Suma el formato nuevo (un archivo por licencia) con el archivo único viejo del
// mismo mes, para que el panel siga mostrando el total y no se pierda histórico.
export async function leerConsumoMes(mes) {
  const m = mes || new Date().toISOString().slice(0, 7);
  const out = {};
  // La clave siempre normalizada: los archivos nuevos ya vienen así (el nombre
  // del archivo), y los del formato viejo pueden tener el código como lo mandó
  // el que consumió. Si no se normaliza, el mismo taller sale dos veces.
  const acumular = (codRaw, c) => {
    const cod = normCodigo(codRaw);
    if (!cod || !c || typeof c !== 'object') return;
    const d = out[cod] || (out[cod] = { reads: 0, inTok: 0, outTok: 0, costoUSD: 0, porOrigen: {} });
    d.reads += Number(c.reads) || 0;
    d.inTok += Number(c.inTok) || 0;
    d.outTok += Number(c.outTok) || 0;
    d.costoUSD += Number(c.costoUSD) || 0;
    for (const [o, po] of Object.entries(c.porOrigen || {})) {
      const t = d.porOrigen[o] || (d.porOrigen[o] = { reads: 0, costoUSD: 0 });
      t.reads += Number(po.reads) || 0;
      t.costoUSD += Number(po.costoUSD) || 0;
    }
  };
  try {
    const porLic = await leerCarpetaPorLicencia(`${CONSUMO_PREFIX}${m}/`);
    for (const [cod, c] of Object.entries(porLic)) acumular(cod, c);
  } catch (e) { /* seguimos con el viejo */ }
  try {
    const viejo = await leerJsonBlob(`${CONSUMO_VIEJO_PREFIX}${m}.json`);
    for (const [cod, c] of Object.entries(viejo || {})) acumular(cod, c);
  } catch (e) { /* nada */ }
  return out;
}

// Tope diario de lecturas por código (anti-abuso de un código filtrado).
// Best-effort sobre Blob y FALLA ABIERTO (permite) ante cualquier error, para
// no bloquear a un taller legítimo por un problema de storage. Los códigos sin
// tope (topeDia 0 / desconocidos) no se limitan.
export async function chequearTope(codigo) {
  try {
    const cod = codArchivo(codigo);
    if (!cod) return { ok: true };
    let l = null;
    try { l = await leerLicencia(cod); } catch (e) { l = null; }
    // Repuestos: el tope sale del plan (o del tope pisado a mano); taller: topeDia.
    const derechos = derechosDe(l);
    const tope = derechos ? Number(derechos.lecturasDia) : (l && Number(l.topeDia) > 0 ? Number(l.topeDia) : 0);
    if (!tope) return { ok: true };
    const dia = new Date().toISOString().slice(0, 10);
    // Contador propio de esta licencia: antes el archivo era compartido y el
    // tráfico de un taller podía dejar el contador de otro en cero.
    const path = `${USO_PREFIX}${dia}/${cod}.json`;
    let uso = null;
    try { uso = await leerJsonBlob(path); } catch (e) { uso = null; }
    const usado = Number((uso && uso.n) || 0);
    if (usado >= tope) return { ok: false, usado, tope };
    await escribirJsonBlob(path, { n: usado + 1, actualizado: new Date().toISOString() });
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
