// GET /whatsapp?p=gnc|repuestos|general — el botón "Consultar por WhatsApp" de
// las páginas de venta. Reparte las consultas entre los vendedores: elige uno de
// los números de VENTAS_WHATSAPP (variable de Vercel, separados por coma) y
// manda a wa.me con el mensaje ya escrito según de qué producto viene.
//
// Los números viven en Vercel y no en las páginas: se agregan o se cambian sin
// tocar el código ni republicar, y no quedan a la vista de los robots.
// Sin números cargados, cae al correo para que el botón nunca quede muerto.

const MENSAJES = {
  gnc: 'Hola! Vi la página de Estelita y quiero saber más para mi taller de GNC.',
  repuestos: 'Hola! Vi Estelita Repuestos y quiero saber más para mi casa de repuestos.',
  general: 'Hola! Vi la página de Estelita y quiero saber más.',
};

function numeros() {
  return String(process.env.VENTAS_WHATSAPP || '')
    .split(',')
    .map(s => s.replace(/\D/g, ''))
    .filter(n => n.length >= 10);
}

export default function handler(req, res) {
  const p = Object.prototype.hasOwnProperty.call(MENSAJES, req.query.p) ? req.query.p : 'general';
  const texto = MENSAJES[p];
  // Cada visita elige de nuevo: sin esto, un cache le mandaría todo al mismo vendedor.
  res.setHeader('Cache-Control', 'no-store');
  const lista = numeros();
  const destino = lista.length
    ? `https://wa.me/${lista[Math.floor(Math.random() * lista.length)]}?text=${encodeURIComponent(texto)}`
    : `mailto:estelitagnc@gmail.com?subject=${encodeURIComponent('Consulta por Estelita')}&body=${encodeURIComponent(texto)}`;
  res.statusCode = 302;
  res.setHeader('Location', destino);
  res.end();
}
