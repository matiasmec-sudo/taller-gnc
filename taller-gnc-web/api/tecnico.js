// App del técnico: vinculación de dispositivos, órdenes de revisión y
// notificaciones push. Guarda todo en el mismo store privado de Vercel Blob
// que el respaldo, bajo el prefijo taller/<hash de la licencia>/.
//
// Seguridad: el técnico NUNCA conoce el código de licencia del taller. Se
// vincula con un código de 6 dígitos de un solo uso (15 minutos de vida) y
// recibe un token propio que solo sirve para este endpoint — no habilita la
// lectura con IA, ni el respaldo, ni la activación de Estelita.
import { put, list, del } from '@vercel/blob';
import crypto from 'crypto';
import webpush from 'web-push';

const VINCULO_VIDA_MS = 15 * 60 * 1000;

function hashLicencia(license) {
  return crypto.createHash('sha256').update('estelita:' + license).digest('hex');
}

async function leerJson(pathname) {
  const l = await list({ prefix: pathname });
  const blob = l.blobs.find(b => b.pathname === pathname);
  if (!blob) return null;
  const r = await fetch(blob.url, { headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` } });
  if (!r.ok) return null;
  return { datos: await r.json(), url: blob.url, subido: blob.uploadedAt };
}

async function escribirJson(pathname, datos) {
  await put(pathname, JSON.stringify(datos), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
  });
}

// Valida el token del técnico ("<hashLicencia>.<secreto>") contra la lista
// de técnicos vinculados de ese taller. Devuelve el hash de la carpeta o null.
async function validarTecnico(tecnicoToken) {
  if (typeof tecnicoToken !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{48}$/.test(tecnicoToken)) return null;
  const [hash, secreto] = tecnicoToken.split('.');
  const t = await leerJson(`taller/${hash}/tecnicos.json`);
  if (!t || !Array.isArray(t.datos.tokens) || !t.datos.tokens.includes(secreto)) return null;
  return hash;
}

function configurarPush() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails('mailto:estelitagnc@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ error: 'Falta configurar BLOB_READ_WRITE_TOKEN en Vercel.' });

  const validCodes = (process.env.LICENSE_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
  const body = req.body || {};
  const { accion } = body;

  try {
    // ---- Acciones del TALLER (requieren licencia) ----
    if (['vincular-generar', 'tecnicos-estado', 'desvincular', 'revision-crear', 'revision-estado'].includes(accion)) {
      if (!validCodes.includes(body.license)) return res.status(403).json({ error: 'Código de licencia no válido.' });
      const hash = hashLicencia(body.license);

      if (accion === 'vincular-generar') {
        const codigo = String(crypto.randomInt(100000, 999999));
        await escribirJson(`vinculos/${codigo}.json`, { hash, expira: Date.now() + VINCULO_VIDA_MS });
        return res.status(200).json({ ok: true, codigo, minutos: 15 });
      }

      if (accion === 'tecnicos-estado') {
        const t = await leerJson(`taller/${hash}/tecnicos.json`);
        return res.status(200).json({ ok: true, vinculados: t ? (t.datos.tokens || []).length : 0 });
      }

      if (accion === 'desvincular') {
        const prefijos = [`taller/${hash}/tecnicos.json`, `taller/${hash}/push/`];
        for (const p of prefijos) {
          const l = await list({ prefix: p });
          if (l.blobs.length) await del(l.blobs.map(b => b.url));
        }
        return res.status(200).json({ ok: true });
      }

      if (accion === 'revision-crear') {
        const rev = body.revision || {};
        if (!rev.id || !/^[a-z0-9]+$/i.test(rev.id)) return res.status(400).json({ error: 'Falta el id de la revisión.' });
        await escribirJson(`taller/${hash}/revisiones/${rev.id}.json`, {
          ...rev, estado: 'pendiente', creadoEn: new Date().toISOString(),
        });
        // Notificar a los técnicos suscriptos (si el push está configurado).
        let notificados = 0;
        if (configurarPush()) {
          const subs = await list({ prefix: `taller/${hash}/push/` });
          for (const s of subs.blobs) {
            try {
              const r = await fetch(s.url, { headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` } });
              const sub = await r.json();
              await webpush.sendNotification(sub, JSON.stringify({
                title: 'Revisión pendiente',
                body: `${rev.patente || 'Vehículo'} — ${rev.vehiculo || ''}`.trim(),
              }));
              notificados++;
            } catch (e) {
              // Suscripción vencida o inválida: se limpia sola.
              if (e && (e.statusCode === 404 || e.statusCode === 410)) {
                try { await del(s.url); } catch (e2) { /* ok */ }
              }
            }
          }
        }
        return res.status(200).json({ ok: true, notificados });
      }

      if (accion === 'revision-estado') {
        if (!body.id || !/^[a-z0-9]+$/i.test(body.id)) return res.status(400).json({ error: 'Falta el id.' });
        const r = await leerJson(`taller/${hash}/revisiones/${body.id}.json`);
        if (!r) return res.status(404).json({ error: 'No existe esa revisión.' });
        return res.status(200).json({ ok: true, revision: r.datos });
      }
    }

    // ---- Canje del código de vinculación (no requiere licencia) ----
    if (accion === 'vincular-canjear') {
      const codigo = String(body.codigo || '').trim();
      if (!/^\d{6}$/.test(codigo)) return res.status(400).json({ error: 'El código debe tener 6 números.' });
      const v = await leerJson(`vinculos/${codigo}.json`);
      if (!v || v.datos.expira < Date.now()) {
        return res.status(404).json({ error: 'Ese código no existe o ya venció. Generá uno nuevo desde Estelita.' });
      }
      const hash = v.datos.hash;
      const secreto = crypto.randomBytes(24).toString('hex');
      const t = await leerJson(`taller/${hash}/tecnicos.json`);
      const tokens = (t && Array.isArray(t.datos.tokens)) ? t.datos.tokens : [];
      tokens.push(secreto);
      await escribirJson(`taller/${hash}/tecnicos.json`, { tokens });
      try { await del(v.url); } catch (e) { /* ya se usó, ok */ }
      return res.status(200).json({ ok: true, tecnicoToken: `${hash}.${secreto}`, vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
    }

    // ---- Acciones del TÉCNICO (requieren su token) ----
    if (['revision-pendientes', 'revision-responder', 'push-suscribir'].includes(accion)) {
      const hash = await validarTecnico(body.tecnicoToken);
      if (!hash) return res.status(403).json({ error: 'Este celular no está vinculado al taller. Pedí un código nuevo desde Estelita.' });

      if (accion === 'revision-pendientes') {
        const l = await list({ prefix: `taller/${hash}/revisiones/` });
        const revisiones = [];
        for (const b of l.blobs) {
          const r = await fetch(b.url, { headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` } });
          if (r.ok) revisiones.push(await r.json());
        }
        revisiones.sort((a, b) => (b.creadoEn || '').localeCompare(a.creadoEn || ''));
        return res.status(200).json({ ok: true, revisiones: revisiones.slice(0, 20) });
      }

      if (accion === 'revision-responder') {
        if (!body.id || !/^[a-z0-9]+$/i.test(body.id)) return res.status(400).json({ error: 'Falta el id.' });
        const r = await leerJson(`taller/${hash}/revisiones/${body.id}.json`);
        if (!r) return res.status(404).json({ error: 'No existe esa revisión.' });
        const resultado = body.resultado || {};
        await escribirJson(`taller/${hash}/revisiones/${body.id}.json`, {
          ...r.datos,
          estado: resultado.estado === 'observada' ? 'observada' : 'aprobada',
          items: resultado.items || null,
          observaciones: String(resultado.observaciones || '').slice(0, 1000),
          respondidoEn: new Date().toISOString(),
        });
        return res.status(200).json({ ok: true });
      }

      if (accion === 'push-suscribir') {
        const sub = body.subscription;
        if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Falta la suscripción.' });
        const id = crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 24);
        await escribirJson(`taller/${hash}/push/${id}.json`, sub);
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor.' });
  }
}
