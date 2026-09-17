// El estado del panel para el control diario (agente o persona): licencias
// por vencer, vencidas, suspendidas, consumo de IA del mes, ritmo y autonomía
// del saldo declarado. Sólo lectura, sin datos de personas más que el nombre
// del negocio. Header x-monitor-secret (env MONITOR_SECRET); sin la variable
// no contesta.
//
//   GET /api/monitor   header x-monitor-secret: <secreto>
import crypto from 'crypto';
import { leerLicenciasEstricto, leerActividad, leerConsumoMes, leerCredito, calcularRitmo, productoDe, GRACIA_DIAS } from './_licencias.js';

function secretoOk(req) {
  const recibido = String(req.headers['x-monitor-secret'] || (req.query && req.query.secreto) || '');
  const esperado = String(process.env.MONITOR_SECRET || '');
  if (!esperado || esperado.length < 16 || !recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function diasHasta(iso, hoy) {
  return Math.round((new Date(iso + 'T00:00:00') - new Date(hoy + 'T00:00:00')) / 86400000);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  if (!secretoOk(req)) {
    await new Promise(r => setTimeout(r, 400));
    return res.status(403).json({ error: 'no autorizado' });
  }
  const alertas = [];
  const avisos = [];
  let lics = [];
  let blobOk = true;
  try {
    lics = await leerLicenciasEstricto();
  } catch (e) {
    blobOk = false;
    alertas.push('No se pudo leer el almacenamiento de licencias (Vercel Blob).');
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const d = new Date();
  const mesAnterior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const [act, consumo, consumoAnt, credito] = await Promise.all([leerActividad(30), leerConsumoMes(), leerConsumoMes(mesAnterior), leerCredito()]);

  const porProducto = {};
  const porVencer = [], vencidas = [], suspendidas = [], pruebaVencida = [];
  let costoMes = 0, readsMes = 0;
  for (const l of lics) {
    const p = productoDe(l);
    const g = porProducto[p] || (porProducto[p] = { total: 0, activas: 0 });
    g.total++;
    if (l.estado === 'activo') g.activas++;
    const c = consumo[l.codigo] || {};
    costoMes += Number(c.costoUSD) || 0;
    readsMes += Number(c.reads) || 0;
    const ficha = { codigo: l.codigo, negocio: l.taller || '', producto: p, pagoHasta: l.pagoHasta || null };
    if (l.estado !== 'activo') { suspendidas.push(ficha); continue; }
    if (l.pagoHasta) {
      const dias = diasHasta(l.pagoHasta, hoy);
      if (l.prueba && dias < 0) pruebaVencida.push({ ...ficha, dias });
      else if (dias < -GRACIA_DIAS) vencidas.push({ ...ficha, dias });
      else if (dias <= 7) porVencer.push({ ...ficha, dias });
    }
  }
  const costoMesAnterior = Object.values(consumoAnt || {}).reduce((s, c) => s + (Number(c.costoUSD) || 0), 0);
  const ritmo = calcularRitmo(costoMes, readsMes, costoMesAnterior, credito);

  for (const v of vencidas) alertas.push(`Licencia ${v.codigo} (${v.negocio || 'sin nombre'}) vencida hace ${-v.dias} días: la app ya se cortó.`);
  for (const v of porVencer) avisos.push(`Licencia ${v.codigo} (${v.negocio || 'sin nombre'}) ${v.dias <= 0 ? 'vence hoy' : `vence en ${v.dias} días`}.`);
  for (const v of pruebaVencida) avisos.push(`Prueba de ${v.codigo} (${v.negocio || 'sin nombre'}) terminó hace ${-v.dias} días sin pago.`);
  // Hito comercial: al vender la cuarta licencia de Repuestos hay que revisar el
  // disco y las fotos del servidor (Runbook seccion 12). Avisa mientras sean 4 activas.
  if ((porProducto.repuestos || {}).activas === 4) {
    avisos.push('Ya hay 4 licencias activas de Estelita Repuestos: revisar el disco de fotos del servidor (Runbook seccion 12) antes de sumar mas.');
  }
  if (ritmo.autonomia && ritmo.autonomia.dias != null) {
    if (ritmo.autonomia.dias < 7) alertas.push(`Al ritmo actual, el saldo de Anthropic alcanza para ${ritmo.autonomia.dias} día(s).`);
    else if (ritmo.autonomia.dias < 14) avisos.push(`El saldo de Anthropic alcanza para ${ritmo.autonomia.dias} días.`);
  } else if (!credito) {
    avisos.push('No hay saldo de Anthropic declarado en el panel: no se puede estimar la autonomía.');
  } else if (credito && (Date.now() - new Date(credito.fecha)) > 30 * 86400000) {
    avisos.push('El saldo de Anthropic declarado tiene más de 30 días: actualizalo en el panel.');
  }
  const usaronHoy = Object.values(act).filter(a => a.hoy > 0).length;

  return res.status(200).json({
    ok: alertas.length === 0,
    app: 'panel-estelita',
    ahora: new Date().toISOString(),
    almacenamiento: blobOk,
    alertas, avisos,
    licencias: { total: lics.length, porProducto, porVencer, vencidas, suspendidas: suspendidas.length, pruebaVencida },
    ia: {
      costoMesUSD: Math.round(costoMes * 100) / 100,
      lecturasMes: readsMes,
      ritmoUSDdia: Math.round(ritmo.ritmoUSDdia * 100) / 100,
      proyeccionMesUSD: Math.round(ritmo.proyeccionMesUSD * 100) / 100,
      saldoDeclaradoUSD: credito ? credito.usd : null,
      saldoDeclaradoEn: credito ? credito.fecha : null,
      saldoEstimadoUSD: ritmo.autonomia ? Math.round(ritmo.autonomia.saldoEstimadoUSD * 100) / 100 : null,
      diasDeAutonomia: ritmo.autonomia ? ritmo.autonomia.dias : null,
      licenciasQueUsaronHoy: usaronHoy,
    },
  });
}
