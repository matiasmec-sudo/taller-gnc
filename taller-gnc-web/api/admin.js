// Panel de administración de licencias (privado, solo para el dueño).
// Protegido por ADMIN_TOKEN (variable de entorno en Vercel). Gestiona el
// store de licencias en Blob: listar, agregar, editar, suspender/reactivar y
// eliminar. La primera vez importa (seed) los códigos de LICENSE_CODES para
// que el panel muestre también los que ya estaban en uso.
import crypto from 'crypto';
import { leerLicenciasEstricto, guardarLicencias, codigosEnv, leerActividad, leerConsumoMes, nuevoCodigo, PRODUCTOS, productoDe, sumarMesISO, leerSugerencias, guardarSugerencias, leerCredito, guardarCredito, calcularRitmo, derechosDe, FUNCIONES_REPUESTOS, PLANES_REPUESTOS } from './_licencias.js';


function tokenOk(req) {
  const provided = String((req.headers['x-admin-token'] || (req.body && req.body.token) || ''));
  const expected = String(process.env.ADMIN_TOKEN || '');
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const PLANES = ['basico', 'profesional', 'full'];
const MEDIOS = ['mp', 'transferencia'];
function fechaValida(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  // Retardo fijo en cada intento: frena el probado por fuerza bruta de la clave.
  await new Promise(r => setTimeout(r, 400));
  if (!tokenOk(req)) return res.status(401).json({ error: 'Contraseña incorrecta.' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ error: 'Falta BLOB_READ_WRITE_TOKEN en Vercel.' });

  try {
    // Estricto a propósito: si la lectura del storage falla, tiene que tirar
    // error y cortar acá. Con la lectura tolerante, un hipo de red devolvía []
    // y el sembrado de abajo sobrescribía TODAS las licencias reales (las de
    // Mercado Pago incluidas) con los códigos sueltos del env.
    let lics;
    try {
      lics = await leerLicenciasEstricto();
    } catch (e) {
      return res.status(503).json({
        error: 'No se pudo leer la lista de licencias en este momento. Probá de nuevo en un minuto — no se modificó nada.',
      });
    }

    // Seed: si el store está REALMENTE vacío, traer los códigos que ya estaban
    // en el env. Llegar acá ahora garantiza que la lectura funcionó.
    if (!lics.length) {
      const hoy = new Date().toISOString().slice(0, 10);
      const env = codigosEnv();
      if (env.length) {
        lics = env.map(c => ({ codigo: c, taller: '', estado: 'activo', alta: hoy, topeDia: 50, notas: '' }));
        await guardarLicencias(lics);
      }
    }

    const { accion } = req.body || {};

    if (accion === 'credito-guardar') {
      const usd = Number(req.body.usd);
      if (!Number.isFinite(usd) || usd < 0) return res.status(400).json({ error: 'Poné el saldo en dólares (ej: 18.40).' });
      const dato = await guardarCredito(usd);
      return res.status(200).json({ ok: true, credito: dato });
    }

    if (accion === 'listar') {
      const mesActual = new Date().toISOString().slice(0, 7);
      const d = new Date();
      const mesAnterior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
      const [act, consumo, consumoAnt, credito] = await Promise.all([
        leerActividad(30), leerConsumoMes(), leerConsumoMes(mesAnterior), leerCredito(),
      ]);
      const costoMesAnteriorUSD = Object.values(consumoAnt || {})
        .reduce((s, c) => s + (Number(c.costoUSD) || 0), 0);
      let costoTotalMes = 0;
      let readsTotalMes = 0;
      const conAct = lics.map(l => {
        const a = act[l.codigo] || {};
        const c = consumo[l.codigo] || {};
        costoTotalMes += Number(c.costoUSD) || 0;
        readsTotalMes += Number(c.reads) || 0;
        return {
          ...l,
          producto: productoDe(l),
          derechos: derechosDe(l),
          usoTotal: a.total || 0, usoHoy: a.hoy || 0, ultimoUso: a.ultimo || null,
          costoMesUSD: Number(c.costoUSD) || 0, readsMes: Number(c.reads) || 0,
          porOrigen: c.porOrigen || {},
        };
      });
      // Lo que llegó con un código que no es una licencia (el CRM manda sus
      // pruebas y el Laboratorio como CRM-SIN-LICENCIA): se suma al total y se
      // muestra aparte, para que el gasto real no quede escondido.
      const codigosLic = new Set(lics.map(l => l.codigo));
      const consumoSinLicencia = { costoUSD: 0, reads: 0, porOrigen: {} };
      for (const [cod, c] of Object.entries(consumo || {})) {
        if (codigosLic.has(cod)) continue;
        consumoSinLicencia.costoUSD += Number(c.costoUSD) || 0;
        consumoSinLicencia.reads += Number(c.reads) || 0;
        for (const [o, po] of Object.entries(c.porOrigen || { [cod]: c })) {
          const d = consumoSinLicencia.porOrigen[o] || (consumoSinLicencia.porOrigen[o] = { reads: 0, costoUSD: 0 });
          d.reads += Number(po.reads) || 0; d.costoUSD += Number(po.costoUSD) || 0;
        }
      }
      costoTotalMes += consumoSinLicencia.costoUSD;
      readsTotalMes += consumoSinLicencia.reads;
      // "Infraestructura": costo de Vercel (plano, según el plan) y un ESTIMADO
      // de operaciones de nube (Blob) por la IA — cada lectura hace ~2 escrituras
      // (registro de uso + de costo). La sincronización suma más, pero eso no se
      // mide acá; el total exacto está en el panel de Vercel.
      const vercel = { plan: process.env.VERCEL_PLAN || 'Pro', costoUSD: Number.isFinite(Number(process.env.VERCEL_COSTO_USD)) && process.env.VERCEL_COSTO_USD !== undefined ? Number(process.env.VERCEL_COSTO_USD) : 20 };
      const opsIaMes = readsTotalMes * 2;
      const ritmo = calcularRitmo(costoTotalMes, readsTotalMes, costoMesAnteriorUSD, credito);
      return res.status(200).json({
        ok: true, licencias: conAct, costoTotalMes, readsTotalMes, consumoSinLicencia,
        planesRepuestos: PLANES_REPUESTOS, funcionesRepuestos: FUNCIONES_REPUESTOS,
        mes: mesActual,
        infra: { vercel, opsIaMes, limiteOpsGratis: 2000 },
        ritmo,
      });
    }

    if (accion === 'agregar') {
      const taller = String(req.body.taller || '').trim();
      const topeDia = Number(req.body.topeDia) > 0 ? Number(req.body.topeDia) : 50;
      const producto = Object.keys(PRODUCTOS).includes(req.body.producto) ? req.body.producto : 'taller';
      const codigo = nuevoCodigo(lics.map(l => l.codigo).concat(codigosEnv()), producto);
      lics.push({
        codigo, taller, producto, estado: 'activo', alta: new Date().toISOString().slice(0, 10),
        topeDia, notas: '',
        // Repuestos siempre arranca con un plan (Básica si no se eligió): los derechos salen de ahí.
        plan: PLANES.includes(req.body.plan) ? req.body.plan : (producto === 'repuestos' ? 'basico' : ''),
        medioPago: MEDIOS.includes(req.body.medioPago) ? req.body.medioPago : '',
        pagoHasta: fechaValida(req.body.pagoHasta) ? req.body.pagoHasta : null,
        email: String(req.body.email || '').trim(),
        origen: 'manual',
      });
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true, codigo });
    }

    if (accion === 'editar') {
      const l = lics.find(x => x.codigo === req.body.codigo);
      if (!l) return res.status(404).json({ error: 'No existe esa licencia.' });
      if (typeof req.body.taller === 'string') l.taller = req.body.taller.trim();
      if (typeof req.body.notas === 'string') l.notas = req.body.notas.trim();
      if (req.body.topeDia !== undefined && Number(req.body.topeDia) >= 0) l.topeDia = Number(req.body.topeDia);
      // Cambiar de producto sin cambiar el código (una repuestera que arrancó con un GNC-):
      // el código es la llave en Repuestos, el CRM y el facturador, así que no se toca.
      if (req.body.producto !== undefined && Object.keys(PRODUCTOS).includes(req.body.producto)) l.producto = req.body.producto;
      if (req.body.plan !== undefined) l.plan = PLANES.includes(req.body.plan) ? req.body.plan : '';
      if (req.body.medioPago !== undefined) l.medioPago = MEDIOS.includes(req.body.medioPago) ? req.body.medioPago : '';
      if (req.body.pagoHasta !== undefined) l.pagoHasta = fechaValida(req.body.pagoHasta) ? req.body.pagoHasta : null;
      if (typeof req.body.email === 'string') l.email = req.body.email.trim();
      // Repuestos: excepciones por función (true/false pisa el plan; null vuelve al plan) y topes.
      if (req.body.funciones && typeof req.body.funciones === 'object') {
        const f = { ...(l.funciones || {}) };
        for (const [k, v] of Object.entries(req.body.funciones)) {
          if (!(k in FUNCIONES_REPUESTOS)) continue;
          if (v === true || v === false) f[k] = v; else delete f[k];
        }
        l.funciones = f;
      }
      if (req.body.topes && typeof req.body.topes === 'object') {
        const t = { ...(l.topes || {}) };
        for (const k of ['usuarios', 'lecturasDia']) {
          if (!(k in req.body.topes)) continue;
          const v = req.body.topes[k];
          if (v === null || v === '' || v === undefined) delete t[k]; else if (Number(v) >= 0) t[k] = Number(v);
        }
        l.topes = t;
      }
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true, derechos: derechosDe(l) });
    }

    // Registrar un pago: extiende "pago al día hasta" un mes (desde hoy o desde
    // la fecha actual si es futura) y deja la licencia activa. Es lo que usás
    // cuando te pagan por transferencia (y lo que el webhook de MP hará solo).
    if (accion === 'registrar-pago') {
      const l = lics.find(x => x.codigo === req.body.codigo);
      if (!l) return res.status(404).json({ error: 'No existe esa licencia.' });
      const hoy = new Date().toISOString().slice(0, 10);
      const base = (l.pagoHasta && l.pagoHasta > hoy) ? l.pagoHasta : hoy;
      l.pagoHasta = sumarMesISO(base);
      l.estado = 'activo';
      l.prueba = false;
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true, pagoHasta: l.pagoHasta });
    }

    if (accion === 'estado') {
      const l = lics.find(x => x.codigo === req.body.codigo);
      if (!l) return res.status(404).json({ error: 'No existe esa licencia.' });
      l.estado = req.body.estado === 'activo' ? 'activo' : 'suspendido';
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'eliminar') {
      const antes = lics.length;
      lics = lics.filter(x => x.codigo !== req.body.codigo);
      if (lics.length === antes) return res.status(404).json({ error: 'No existe esa licencia.' });
      await guardarLicencias(lics);
      return res.status(200).json({ ok: true });
    }

    // --- Sugerencias enviadas por los talleres ---
    if (accion === 'sugerencias-listar') {
      const sugerencias = await leerSugerencias();
      return res.status(200).json({ ok: true, sugerencias });
    }

    if (accion === 'sugerencia-estado') {
      const lista = await leerSugerencias();
      const s = lista.find(x => x.id === req.body.id);
      if (!s) return res.status(404).json({ error: 'No existe esa sugerencia.' });
      s.estado = req.body.estado === 'leida' ? 'leida' : 'nueva';
      await guardarSugerencias(lista);
      return res.status(200).json({ ok: true });
    }

    if (accion === 'sugerencia-eliminar') {
      let lista = await leerSugerencias();
      const antes = lista.length;
      lista = lista.filter(x => x.id !== req.body.id);
      if (lista.length === antes) return res.status(404).json({ error: 'No existe esa sugerencia.' });
      await guardarSugerencias(lista);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error del servidor.' });
  }
}
