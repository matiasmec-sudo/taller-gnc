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

// URL directa de un archivo del store privado (el id del store viene dentro
// del propio token: vercel_blob_rw_<STOREID>_<secreto>). Leer por URL directa
// es consistente al instante; list() puede tardar en ver archivos recién
// escritos (consistencia eventual) y eso rompía la vinculación en producción.
function urlBlob(pathname) {
  const partes = (process.env.BLOB_READ_WRITE_TOKEN || '').split('_');
  return `https://${(partes[3] || '').toLowerCase()}.private.blob.vercel-storage.com/${pathname}`;
}

async function leerJson(pathname) {
  const url = urlBlob(pathname);
  // El parámetro anti-caché evita respuestas viejas del CDN, y el reintento
  // cubre el caché negativo: tras consultar una ruta inexistente, el storage
  // puede responder 404 durante ~1 segundo aunque el archivo recién se haya
  // creado (verificado empíricamente).
  for (let intento = 0; ; intento++) {
    const r = await fetch(`${url}?nc=${Date.now()}`, { headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store' });
    if (r.ok) return { datos: await r.json(), url };
    if (r.status !== 404 || intento >= 4) return null;
    await new Promise(res => setTimeout(res, 1000));
  }
}

async function escribirJson(pathname, datos) {
  await put(pathname, JSON.stringify(datos), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    // Sin esto, el CDN puede servir versiones viejas del archivo durante un
    // rato después de una sobrescritura (verificado empíricamente).
    cacheControlMaxAge: 0,
  });
}

// Valida el token del técnico ("<hashLicencia>.<secreto>"). Cada técnico
// vinculado es un archivo propio (taller/<hash>/tecnicos/<secreto>.json):
// así el canje nunca necesita leer-antes-de-escribir, que era vulnerable al
// caché negativo del storage (~1s de 404 tras crear un archivo que ya se
// había consultado). Devuelve el hash de la carpeta del taller o null.
async function validarTecnico(tecnicoToken) {
  if (typeof tecnicoToken !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{48}$/.test(tecnicoToken)) return null;
  const [hash, secreto] = tecnicoToken.split('.');
  const t = await leerJson(`taller/${hash}/tecnicos/${secreto}.json`);
  return t ? hash : null;
}

// El trim() es defensivo: una clave pegada con un salto de línea al final
// (pasa fácil al cargar variables por consola) rompe web-push.
function vapidPublica() { return (process.env.VAPID_PUBLIC_KEY || '').trim(); }
function configurarPush() {
  const pub = vapidPublica();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) return false;
  webpush.setVapidDetails('mailto:estelitagnc@gmail.com', pub, priv);
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
        const l = await list({ prefix: `taller/${hash}/tecnicos/` });
        return res.status(200).json({ ok: true, vinculados: l.blobs.length });
      }

      if (accion === 'desvincular') {
        const prefijos = [`taller/${hash}/tecnicos/`, `taller/${hash}/push/`];
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
      if (!v || v.datos.expira < Date.now() || v.datos.usado) {
        return res.status(404).json({ error: 'Ese código no existe, ya venció o ya se usó. Generá uno nuevo desde Estelita.' });
      }
      const hash = v.datos.hash;
      // Marcar el código como usado SOBRESCRIBIENDO (no borrando): las
      // sobrescrituras se propagan más rápido que los borrados en el
      // storage, y así el "un solo uso" es efectivo casi al instante.
      await escribirJson(`vinculos/${codigo}.json`, { ...v.datos, usado: true });
      const secreto = crypto.randomBytes(24).toString('hex');
      // Archivo propio por técnico: se crea sin leer nada antes (ver
      // comentario de validarTecnico).
      await escribirJson(`taller/${hash}/tecnicos/${secreto}.json`, { creadoEn: new Date().toISOString() });
      return res.status(200).json({ ok: true, tecnicoToken: `${hash}.${secreto}`, vapidPublicKey: vapidPublica() || null });
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
        // La lectura previa es solo para conservar los datos originales de
        // la revisión: si el storage justo no la devuelve (consistencia
        // eventual), la respuesta del técnico se guarda igual — es lo único
        // que Estelita necesita para destrabar el trámite.
        const r = await leerJson(`taller/${hash}/revisiones/${body.id}.json`);
        const base = r ? r.datos : { id: body.id };
        const resultado = body.resultado || {};
        await escribirJson(`taller/${hash}/revisiones/${body.id}.json`, {
          ...base,
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
