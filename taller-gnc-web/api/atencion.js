// "Te necesitan": charlas de WhatsApp que el asistente del CRM le pasó a una
// persona. Sin esto, el aviso quedaba en el CRM y se pasaba de largo: el que
// atiende el taller vive en Estelita, no en el CRM.
//
//   POST /api/atencion   header x-servidor-secret (SÓLO el CRM)
//     { accion: 'crm', license, conversationId, contacto?, telefono?, motivo?, estado: 'pendiente'|'cerrada' }
//     → guarda (o borra) el cartel y manda un push a los aparatos del taller.
//
//   POST /api/atencion   con el código de licencia (la app del taller)
//     { accion: 'listar', license }                → { pendientes: [...], clave }
//     { accion: 'atendida', license, conversationId } → baja el cartel
//     { accion: 'suscribir', license, sub }         → guarda el aparato para push
//     { accion: 'desuscribir', license, endpoint }
//     { accion: 'probar', license }                 → push de prueba a todos
//
// Se guarda en el store privado de Vercel Blob, bajo taller/<hash>/atencion/ y
// taller/<hash>/avisos/ (los aparatos del dueño; los del técnico van aparte en
// taller/<hash>/push/ y no reciben esto).
import { put, list, del } from '@vercel/blob';
import crypto from 'crypto';
import webpush from 'web-push';
import { licenciaValida } from './_licencias.js';

// Un cartel viejo no sirve de nada: a los 3 días se da por atendido solo.
const VIDA_MS = 3 * 24 * 60 * 60 * 1000;

function hashLicencia(license) {
  return crypto.createHash('sha256').update('estelita:' + license).digest('hex');
}

function secretoOk(req) {
  const recibido = String(req.headers['x-servidor-secret'] || '');
  const esperado = String(process.env.SERVIDOR_SECRET || '');
  if (!esperado || esperado.length < 16 || !recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function urlBlob(pathname) {
  const partes = (process.env.BLOB_READ_WRITE_TOKEN || '').split('_');
  return `https://${(partes[3] || '').toLowerCase()}.private.blob.vercel-storage.com/${pathname}`;
}

async function leerJson(url) {
  try {
    const r = await fetch(`${url}?nc=${Date.now()}`, { headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function escribirJson(pathname, datos) {
  await put(pathname, JSON.stringify(datos), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 0,
  });
}

async function borrar(pathname) {
  try { await del(urlBlob(pathname)); } catch (e) { /* ya no estaba */ }
}

const idSeguro = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);
const texto = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

function vapidPublica() { return (process.env.VAPID_PUBLIC_KEY || '').trim(); }
function configurarPush() {
  const pub = vapidPublica();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) return false;
  webpush.setVapidDetails('mailto:estelitagnc@gmail.com', pub, priv);
  return true;
}

// Manda el aviso a todos los aparatos del dueño. Los que el navegador dio de
// baja (404/410) se borran para no seguir intentando.
async function empujar(hash, aviso) {
  if (!configurarPush()) return 0;
  let enviados = 0;
  try {
    const { blobs } = await list({ prefix: `taller/${hash}/avisos/` });
    for (const b of blobs) {
      const sub = await leerJson(urlBlob(b.pathname));
      if (!sub || !sub.endpoint) continue;
      try {
        await webpush.sendNotification(sub, JSON.stringify(aviso), { TTL: 60 * 60 * 24, urgency: 'high' });
        enviados++;
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await borrar(b.pathname);
      }
    }
  } catch (e) { /* sin push igual queda el cartel */ }
  return enviados;
}

const MOTIVOS = {
  cliente: 'pidió hablar con una persona.',
  modelo: 'preguntó algo que el asistente no supo contestar.',
  error: 'está esperando que alguien lo atienda.',
  ventana: 'escribió fuera de la ventana de WhatsApp: sólo puede contestarle una persona.',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ error: 'Falta configurar BLOB_READ_WRITE_TOKEN en Vercel.' });
  const body = req.body || {};
  const { accion, license } = body;

  // ---- Del CRM ----
  if (accion === 'crm') {
    if (!secretoOk(req)) {
      await new Promise(r => setTimeout(r, 400));
      return res.status(401).json({ error: 'Secreto de servidor incorrecto o no configurado.' });
    }
    if (!(await licenciaValida(license))) return res.status(403).json({ error: 'Licencia no válida.' });
    if (!idSeguro(body.conversationId)) return res.status(400).json({ error: 'Falta la conversación.' });
    const hash = hashLicencia(license);
    const ruta = `taller/${hash}/atencion/${body.conversationId}.json`;
    if (body.estado === 'cerrada') {
      await borrar(ruta);
      return res.status(200).json({ ok: true, estado: 'cerrada' });
    }
    const contacto = texto(body.contacto, 120);
    const motivo = MOTIVOS[body.motivo] ? body.motivo : 'cliente';
    const item = {
      conversationId: body.conversationId,
      contacto,
      telefono: texto(body.telefono, 30),
      motivo,
      creadoEn: new Date().toISOString(),
    };
    await escribirJson(ruta, item);
    const quien = contacto || (item.telefono ? '+' + item.telefono : 'Un cliente');
    const enviados = await empujar(hash, {
      title: 'Te necesitan en WhatsApp',
      body: `${quien} ${MOTIVOS[motivo]}`,
      tag: 'atencion-' + body.conversationId,
      url: `https://crm.estelita.net.ar/inbox?c=${encodeURIComponent(body.conversationId)}`,
    });
    return res.status(200).json({ ok: true, estado: 'pendiente', push: enviados });
  }

  // ---- De la app del taller ----
  if (!(await licenciaValida(license))) return res.status(403).json({ error: 'Código de licencia no válido.' });
  const hash = hashLicencia(license);

  if (accion === 'listar') {
    const pendientes = [];
    try {
      const { blobs } = await list({ prefix: `taller/${hash}/atencion/` });
      for (const b of blobs.slice(0, 30)) {
        const item = await leerJson(urlBlob(b.pathname));
        if (!item) continue;
        if (Date.now() - new Date(item.creadoEn).getTime() > VIDA_MS) { await borrar(b.pathname); continue; }
        pendientes.push(item);
      }
    } catch (e) { /* devolvemos lo que haya */ }
    pendientes.sort((a, b) => String(b.creadoEn).localeCompare(String(a.creadoEn)));
    return res.status(200).json({ pendientes, clave: vapidPublica() || null });
  }

  if (accion === 'atendida') {
    if (!idSeguro(body.conversationId)) return res.status(400).json({ error: 'Falta la conversación.' });
    await borrar(`taller/${hash}/atencion/${body.conversationId}.json`);
    return res.status(200).json({ ok: true });
  }

  if (accion === 'suscribir') {
    const sub = body.sub;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Suscripción inválida.' });
    }
    const id = crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 32);
    await escribirJson(`taller/${hash}/avisos/${id}.json`, { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
    return res.status(200).json({ ok: true });
  }

  if (accion === 'desuscribir') {
    if (typeof body.endpoint !== 'string') return res.status(400).json({ error: 'Falta el aparato.' });
    const id = crypto.createHash('sha256').update(body.endpoint).digest('hex').slice(0, 32);
    await borrar(`taller/${hash}/avisos/${id}.json`);
    return res.status(200).json({ ok: true });
  }

  if (accion === 'probar') {
    const enviados = await empujar(hash, {
      title: 'Te necesitan en WhatsApp',
      body: 'Prueba: así te va a llegar el aviso cuando el asistente le pase una charla a una persona.',
      tag: 'atencion-prueba',
      url: 'https://crm.estelita.net.ar/inbox',
    });
    return res.status(200).json({ ok: true, enviados });
  }

  return res.status(400).json({ error: 'Acción desconocida.' });
}
