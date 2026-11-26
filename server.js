const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { db, getSettings, setSetting, hashPassword, verifyPassword, validateNewUser, SETTING_KEYS } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
// En el servidor se usa HOST=127.0.0.1: sólo Nginx (en la misma máquina) puede llegar a la tienda.
const HOST = process.env.HOST || '0.0.0.0';
const UPLOADS = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
// Detrás de Nginx: tomar la IP real del visitante y saber si entró por HTTPS
// (sólo se confía en el proxy de la misma máquina).
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' })); // varias fotos por producto

// Si el código del servidor cambió después de iniciarlo, el panel avisa que hay que reiniciar
// (las pantallas se actualizan solas, pero las funciones nuevas del servidor no).
const CODE_FILES = ['server.js', 'db.js'].map((f) => path.join(__dirname, f));
const codeStamp = () => CODE_FILES.map((f) => fs.statSync(f).mtimeMs).join('|');
const startStamp = codeStamp();
let restartNeeded = false;
let lastStampCheck = 0;
app.use('/api', (req, res, next) => {
  if (!restartNeeded && Date.now() - lastStampCheck > 5000) {
    lastStampCheck = Date.now();
    try {
      restartNeeded = codeStamp() !== startStamp;
    } catch {
      /* archivo en uso: se revisa en la próxima */
    }
  }
  if (restartNeeded) res.setHeader('X-Restart-Needed', '1');
  next();
});
// Las pantallas (html, js, css) se revisan siempre: así, después de una actualización,
// el navegador no se queda con una versión vieja del panel o de la tienda.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, file) => {
      if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
app.use('/uploads', express.static(UPLOADS));

// Página de detalle de cada producto: /producto/5
app.get('/producto/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'producto.html')));

/* ----------------------------- utilidades ----------------------------- */

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const STATUSES = ['pendiente', 'confirmado', 'entregado', 'cancelado', 'rechazado'];
const HOLDS_STOCK = ['confirmado', 'entregado']; // en estos estados el stock del pedido está descontado

/* ------------------------------ stock y estados de pedidos ------------------------------ */
// Regla única (la usan el panel y la API):
//  - Pasa a Confirmado o Entregado y su stock NO estaba descontado -> se descuenta (una sola vez).
//  - Pasa a Pendiente, Cancelado o Rechazado y su stock SÍ estaba descontado -> se devuelve (una sola vez).
//  - En cualquier otro cambio el stock no se toca (ej: Cancelado -> Rechazado, Confirmado -> Entregado).
// La marca orders.stock_descontado se cambia con un UPDATE condicional dentro de la misma transacción,
// así aunque lleguen dos cambios al mismo tiempo el stock se mueve una sola vez.

// Anota y aplica un cambio de stock (dentro de una transacción ya abierta). Nunca deja stock negativo.
function moveStock(productId, change, source, { orderId = null, reason = '', username = '' } = {}) {
  const r =
    change < 0
      ? db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock + ? >= 0').run(change, productId, change)
      : db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(change, productId);
  if (!r.changes) return false;
  const p = db.prepare('SELECT name, stock FROM products WHERE id = ?').get(productId);
  db.prepare(
    `INSERT INTO stock_movements (product_id, product_name, change, stock_after, source, order_id, reason, username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(productId, p.name, change, p.stock, source, orderId, reason, username);
  return true;
}

// Fija el stock de un producto en un valor (panel o API) y lo anota en el historial
function setStock(productId, stock, source, { reason = '', username = '' } = {}) {
  if (!Number.isInteger(stock) || stock < 0) throw httpError(400, 'El stock debe ser un número entero mayor o igual a 0.');
  const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
  if (!p) throw httpError(404, 'Producto no encontrado.');
  const change = stock - p.stock;
  if (change) moveStock(productId, change, source, { reason, username });
  return change;
}

// Ejecuta fn dentro de una transacción: o se aplica todo, o nada
function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function changeOrderStatus(id, status, opts = {}) {
  if (!STATUSES.includes(status)) throw httpError(400, `Estado no válido. Usá uno de estos: ${STATUSES.join(', ')}.`);
  return inTransaction(() => applyStatus(id, status, opts));
}

// Modifica los productos de un pedido (lo usa la API). Debe llamarse dentro de una transacción.
// - Se guarda una sola vez lo que el cliente pidió originalmente (original_items).
// - Si el pedido YA tiene el stock descontado, se ajusta sólo la diferencia (ej: de 3 a 2 devuelve 1).
// - El total se recalcula; el delivery queda igual.
function applyItems(id, productos, { username = '', source = 'api' } = {}) {
  if (!Array.isArray(productos) || !productos.length) {
    throw httpError(400, '"productos" debe ser una lista con al menos un producto. Para anular el pedido, cambiá el estado a "cancelado".');
  }
  if (productos.length > 100) throw httpError(400, 'Demasiados productos en un pedido (máximo 100).');
  const wanted = new Map();
  productos.forEach((it, i) => {
    const pid = Number(it?.producto_id);
    const qty = Number(it?.cantidad);
    if (!Number.isInteger(pid) || pid < 1) throw httpError(400, `Producto ${i + 1}: "producto_id" no es válido.`);
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, `Producto ${i + 1}: "cantidad" debe ser un número entero mayor que 0.`);
    wanted.set(pid, (wanted.get(pid) || 0) + qty);
  });

  const order = db.prepare('SELECT id, status, stock_descontado, delivery_fee, original_items FROM orders WHERE id = ?').get(id);
  if (!order) throw httpError(404, 'Pedido no encontrado.');
  const current = db.prepare('SELECT product_id, product_name, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id').all(id);

  const next = [];
  for (const [pid, qty] of wanted) {
    const prev = current.find((c) => c.product_id === pid);
    const p = db.prepare('SELECT id, name, price, stock FROM products WHERE id = ?').get(pid);
    if (!p && !prev) throw httpError(400, `El producto ${pid} no existe.`);
    // Si el producto ya estaba en el pedido se respeta su precio; si es nuevo, va con el precio actual
    next.push({ product_id: pid, product_name: prev ? prev.product_name : p.name, quantity: qty, unit_price: prev ? prev.unit_price : p.price, exists: !!p });
  }

  const same =
    next.length === current.length && next.every((n) => current.some((c) => c.product_id === n.product_id && c.quantity === n.quantity));
  if (same) return { changed: false, stock: 'sin_cambios' };

  let stock = 'sin_cambios';
  if (order.stock_descontado) {
    // Diferencia por producto: positiva = hay que descontar más, negativa = hay que devolver
    const delta = new Map();
    for (const c of current) if (c.product_id) delta.set(c.product_id, (delta.get(c.product_id) || 0) - c.quantity);
    for (const n of next) delta.set(n.product_id, (delta.get(n.product_id) || 0) + n.quantity);
    const missing = [];
    for (const [pid, d] of delta) {
      if (d <= 0) continue;
      const p = db.prepare('SELECT name, stock FROM products WHERE id = ?').get(pid);
      if (p && p.stock < d) missing.push(`"${p.name}" (hay ${p.stock}, faltan ${d})`);
    }
    if (missing.length) throw httpError(409, `No hay stock suficiente de ${missing.join(', ')}. El pedido no se modificó.`);
    const info = { orderId: id, reason: `Pedido #${id} modificado`, username };
    for (const [pid, d] of delta) {
      if (!d || !db.prepare('SELECT 1 FROM products WHERE id = ?').get(pid)) continue;
      moveStock(pid, -d, source, info);
      stock = 'ajustado';
    }
  }

  if (!order.original_items) {
    const original = current.map((c) => ({ producto_id: c.product_id, nombre: c.product_name, cantidad: c.quantity, precio_unitario: c.unit_price }));
    db.prepare('UPDATE orders SET original_items = ? WHERE id = ?').run(JSON.stringify(original), id);
  }
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
  const ins = db.prepare('INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)');
  for (const n of next) ins.run(id, n.product_id, n.product_name, n.quantity, n.unit_price);
  const subtotal = next.reduce((s, n) => s + n.quantity * n.unit_price, 0);
  db.prepare('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?').run(subtotal, subtotal + (order.delivery_fee || 0), id);

  const desc = next.map((n) => `${n.quantity} x ${n.product_name}`).join(', ');
  db.prepare('INSERT INTO order_status_history (order_id, status, note, username) VALUES (?, ?, ?, ?)').run(
    id,
    order.status,
    `Productos modificados: ${desc}`.slice(0, 300),
    username
  );
  return { changed: true, stock };
}

// Cambia el estado y mueve el stock según la regla única. Debe llamarse dentro de una transacción.
function applyStatus(id, status, { note = '', username = '', source = 'panel' } = {}) {
  if (!STATUSES.includes(status)) throw httpError(400, `Estado no válido. Usá uno de estos: ${STATUSES.join(', ')}.`);
  {
    const order = db.prepare('SELECT id, status, stock_descontado FROM orders WHERE id = ?').get(id);
    if (!order) throw httpError(404, 'Pedido no encontrado.');
    if (order.status === status) return { changed: false, stock: 'sin_cambios' };

    const items = db
      .prepare(
        `SELECT i.product_id, i.product_name, i.quantity, p.stock AS current_stock
         FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ?`
      )
      .all(id)
      .filter((it) => it.current_stock !== null); // productos borrados del catálogo: no hay stock que mover
    const info = { orderId: id, reason: `Pedido #${id} → ${status}`, username };
    let stock = 'sin_cambios';

    if (HOLDS_STOCK.includes(status) && !order.stock_descontado) {
      const missing = items.filter((it) => it.current_stock < it.quantity);
      if (missing.length) {
        throw httpError(
          409,
          `No hay stock suficiente de ${missing.map((it) => `"${it.product_name}" (hay ${it.current_stock}, el pedido lleva ${it.quantity})`).join(', ')}. El pedido sigue ${order.status}.`
        );
      }
      if (db.prepare('UPDATE orders SET stock_descontado = 1 WHERE id = ? AND stock_descontado = 0').run(id).changes) {
        for (const it of items) moveStock(it.product_id, -it.quantity, source, info);
        stock = 'descontado';
      }
    } else if (!HOLDS_STOCK.includes(status) && order.stock_descontado) {
      if (db.prepare('UPDATE orders SET stock_descontado = 0 WHERE id = ? AND stock_descontado = 1').run(id).changes) {
        for (const it of items) moveStock(it.product_id, it.quantity, source, info);
        stock = 'devuelto';
      }
    }

    db.prepare(
      `UPDATE orders SET status = ?, status_changed_at = datetime('now','localtime'),
         reject_reason = CASE WHEN ? = 'rechazado' THEN ? ELSE reject_reason END,
         delivered_at = CASE WHEN ? = 'entregado' THEN datetime('now','localtime') ELSE NULL END
       WHERE id = ?`
    ).run(status, status, note, status, id);
    db.prepare('INSERT INTO order_status_history (order_id, status, note, username) VALUES (?, ?, ?, ?)').run(id, status, note, username);
    return { changed: true, stock };
  }
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const str = (v) => String(v ?? '').trim();
const money = (n, cur = getSettings().currency || '$') => `${cur} ${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(hhmm));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

// "09:00-13:00, 17:00-21:00" -> [[540, 780], [1020, 1260]]
function parseRanges(text) {
  return String(text || '')
    .split(',')
    .map((r) => r.split('-').map(toMinutes))
    .filter(([a, b]) => !isNaN(a) && !isNaN(b) && b > a);
}

function closedDays(s) {
  return String(s.closed_days || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number);
}

// Horarios de un día, marcando cuáles están llenos.
function slotsFor(dateStr, s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return [];
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  if (closedDays(s).includes(day.getDay())) return [];

  const step = Math.max(5, Number(s.slot_minutes) || 30);
  const earliest = Date.now() + (Number(s.lead_minutes) || 0) * 60000;
  const max = Number(s.max_per_slot) || 0; // 0 = sin límite

  const taken = {};
  const rows = db
    .prepare("SELECT slot_time, COUNT(*) AS c FROM orders WHERE slot_date = ? AND status NOT IN ('cancelado', 'rechazado') GROUP BY slot_time")
    .all(dateStr);
  for (const r of rows) taken[r.slot_time] = r.c;

  const out = [];
  for (const [from, to] of parseRanges(s.hours)) {
    for (let t = from; t < to; t += step) {
      const when = new Date(y, m - 1, d, Math.floor(t / 60), t % 60);
      if (when.getTime() < earliest) continue;
      const time = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      out.push({ time, available: max <= 0 || (taken[time] || 0) < max });
    }
  }
  return out;
}

// Próximos días que tienen al menos un horario libre.
function availableDays(s) {
  const n = Math.min(60, Math.max(1, Number(s.days_ahead) || 7));
  const today = new Date();
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const key = ymd(d);
    if (!slotsFor(key, s).some((x) => x.available)) continue;
    const name = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : DAY_NAMES[d.getDay()];
    out.push({ date: key, label: `${name} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}` });
  }
  return out;
}

function waLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}` + (text ? `?text=${encodeURIComponent(text)}` : '');
}

function buildWhatsAppMessage(order, items, s) {
  const [y, m, d] = order.slot_date.split('-');
  const dayName = DAY_NAMES[new Date(+y, +m - 1, +d).getDay()];
  const lines = [
    `*Nuevo pedido #${order.id}* - ${s.store_name}`,
    '',
    `Cliente: ${order.customer_name}`,
    `Teléfono: ${order.phone}`,
    `Día y hora: ${dayName} ${d}/${m} a las ${order.slot_time} hs`,
    ...(order.delivery_type === 'envio'
      ? [`Ciudad: ${order.city}`, `Envío a: ${order.address}`]
      : ['Retira en el local']),
    `Factura: ${order.invoice ? `Sí - Ruc/CI: ${order.ruc}` : 'No'}`,
    '',
    '*Detalle:*',
    ...items.map((it) => `- ${it.quantity} x ${it.product_name}: ${money(it.unit_price * it.quantity, s.currency)}`),
    '',
    ...(order.delivery_type === 'envio'
      ? [`Subtotal: ${money(order.subtotal, s.currency)}`, `Delivery (${order.city}): ${order.delivery_fee ? money(order.delivery_fee, s.currency) : 'sin costo'}`]
      : []),
    `*Total: ${money(order.total, s.currency)}*`,
  ];
  if (order.notes) lines.push('', `Aclaraciones: ${order.notes}`);
  return lines.join('\n');
}

function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw httpError(400, 'La imagen no es válida.');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS, name), Buffer.from(m[2], 'base64'));
  return `/uploads/${name}`;
}

function deleteImage(url) {
  if (url && url.startsWith('/uploads/')) {
    fs.rm(path.join(UPLOADS, path.basename(url)), { force: true }, () => {});
  }
}

/* ------------------------------ fotos de productos ------------------------------ */

const MAX_IMAGES = 8;

function imagesOf(productId) {
  return db
    .prepare('SELECT url FROM product_images WHERE product_id = ? ORDER BY position, id')
    .all(productId)
    .map((r) => r.url);
}

// Agrega a cada producto la lista "images" con todas sus fotos en orden
function withImages(rows) {
  const byProduct = {};
  for (const r of db.prepare('SELECT product_id, url FROM product_images ORDER BY position, id').all()) {
    (byProduct[r.product_id] ||= []).push(r.url);
  }
  return rows.map((p) => ({ ...p, images: byProduct[p.id] || [] }));
}

const IMAGE_DATA_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

// Revisa la lista antes de tocar la base de datos, para no dejar un producto a medio guardar
function checkImageList(list) {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw httpError(400, 'Lista de fotos no válida.');
  if (list.length > MAX_IMAGES) throw httpError(400, `Se pueden cargar hasta ${MAX_IMAGES} fotos por producto.`);
  for (const item of list) {
    if (item?.data && !IMAGE_DATA_RE.test(item.data)) throw httpError(400, 'Una de las fotos no es una imagen válida.');
  }
}

// list: [{ url } (foto que ya tenía) | { data } (foto nueva en base64)], en el orden deseado
function saveProductImages(productId, list) {
  if (!Array.isArray(list)) return;
  const current = imagesOf(productId);
  const final = [];
  for (const item of list) {
    if (item?.data) final.push(saveImage(item.data));
    else if (item?.url && current.includes(item.url) && !final.includes(item.url)) final.push(item.url);
  }
  for (const url of current) if (!final.includes(url)) deleteImage(url);

  db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId);
  const ins = db.prepare('INSERT INTO product_images (product_id, url, position) VALUES (?, ?, ?)');
  final.forEach((url, i) => ins.run(productId, url, i));
  db.prepare('UPDATE products SET image = ? WHERE id = ?').run(final[0] || '', productId);
}

/* ------------------------------ productos relacionados ------------------------------ */
// Sin IA: se combinan dos señales.
//  1) Palabras del nombre: productos que comparten palabras importantes ("taladro", la marca...)
//     pesan más cuanto más rara es la palabra en el catálogo. El voltaje (12V, 20V) suma si coincide
//     y resta si es distinto (una batería de 20V no sirve para un taladro de 12V).
//  2) Pedidos: productos que los clientes compraron juntos.

const STOPWORDS = new Set(
  (
    'de del la el los las para con sin y o a en un una unos unas x por al su sus que es se le lo ' +
    'kit juego set pack tipo modelo mas cm mm pieza piezas unidad unidades ' +
    // palabras de descripción que no dicen qué producto es
    'incluye incluido incluida ideal alta calidad nuevo nueva original uso profesional color ' +
    'potencia accesorio accesorios repuesto regulable sistema marca linea ' +
    // características que comparten herramientas distintas (no las hacen "relacionadas")
    'inalambrica inalambrico electrica electrico industrial'
  ).split(' ')
);

// Singular simple: "taladros" -> "taladro", "motores" -> "motor", "mechas" -> "mecha"
function stem(w) {
  if (/^\d/.test(w)) return w;
  if (w.length > 4 && /[rlndzj]es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return [
    ...new Set(
      String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
        .map(stem)
    ),
  ];
}

const isVolt = (t) => /^\d+v$/.test(t);
const RELATED_MIN_SCORE = 1.5;

function computeRelated(baseIds, limit = 8) {
  const items = db.prepare('SELECT id, name, description FROM products WHERE active = 1 AND stock > 0').all();
  const all = db.prepare('SELECT id, name, description FROM products WHERE active = 1').all();
  const info = new Map(
    all.map((p) => [p.id, { name: new Set(tokenize(p.name)), desc: new Set(tokenize(p.description)) }])
  );
  // Qué tan común es cada palabra en el catálogo (las comunes pesan poco)
  const df = new Map();
  for (const { name, desc } of info.values()) for (const t of new Set([...name, ...desc])) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(all.length, 2);
  const idf = (t) => Math.log(N / (df.get(t) || 1));

  // Veces que dos productos aparecen en el mismo pedido (sin contar cancelados ni rechazados)
  const together = new Map();
  for (const r of db
    .prepare(
      `SELECT a.product_id AS x, b.product_id AS y, COUNT(DISTINCT a.order_id) AS c
       FROM order_items a
       JOIN order_items b ON a.order_id = b.order_id AND a.product_id <> b.product_id
       JOIN orders o ON o.id = a.order_id
       WHERE o.status NOT IN ('cancelado', 'rechazado') AND a.product_id IS NOT NULL AND b.product_id IS NOT NULL
       GROUP BY a.product_id, b.product_id`
    )
    .all()) {
    together.set(`${r.x}-${r.y}`, r.c);
  }

  // Palabra "distintiva": aparece en pocos productos (no cuenta la marca si está en medio catálogo)
  const distinctive = (t) => (df.get(t) || 0) / N <= 0.34;

  const bases = baseIds.filter((id) => info.has(id));
  const scores = new Map();
  for (const c of items) {
    if (bases.includes(c.id)) continue;
    const ci = info.get(c.id);
    let total = 0;
    for (const b of bases) {
      const bi = info.get(b);
      let score = 0;
      let core = false; // comparten al menos una palabra distintiva (no sólo marca o voltaje)
      let shared = 0;
      const add = (t, weight) => {
        score += weight * idf(t);
        shared++;
        if (distinctive(t)) core = true;
      };
      for (const t of bi.name) {
        if (isVolt(t)) continue;
        if (ci.name.has(t)) add(t, 2);
        else if (ci.desc.has(t)) add(t, 1.5); // ej: las mechas dicen "para taladro" en su descripción
      }
      for (const t of bi.desc) {
        // y al revés: desde las mechas se llega al taladro
        if (!bi.name.has(t) && !isVolt(t) && ci.name.has(t)) add(t, 1.5);
      }
      const bought = Math.min(together.get(`${b}-${c.id}`) || 0, 5);
      const bv = [...bi.name].filter(isVolt);
      const cv = [...ci.name].filter(isVolt);
      const sameVolt = bv.length && cv.length && bv.some((v) => cv.includes(v));
      // Mismo voltaje + al menos dos palabras en común (ej: "batería" y la marca) = compatibles
      if (sameVolt && shared >= 2) core = true;
      if (!core && !bought) continue; // sólo marca o sólo voltaje no alcanza para ser "relacionado"
      if (bv.length && cv.length) score += sameVolt ? 1.5 : -2;
      total += score + 4 * bought; // comprar juntos pesa bastante: es la señal más confiable
    }
    if (total >= RELATED_MIN_SCORE) scores.set(c.id, total);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

function productInput(b) {
  const name = str(b.name);
  if (!name) throw httpError(400, 'El nombre es obligatorio.');
  const price = Number(b.price);
  if (!Number.isFinite(price) || price < 0) throw httpError(400, 'El precio no es válido.');
  const stock = Number(b.stock);
  if (!Number.isInteger(stock) || stock < 0) throw httpError(400, 'El stock debe ser un número entero mayor o igual a 0.');
  return {
    name,
    description: str(b.description),
    price,
    stock,
    category: str(b.category),
    compare_price: Number(b.compare_price) > price ? Number(b.compare_price) : 0,
    featured: b.featured === true || b.featured === 1 || b.featured === '1' ? 1 : 0,
    active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
  };
}

/* ------------------------------ sesión admin ------------------------------ */

const sessions = new Map(); // token -> { userId, exp }
const SESSION_MS = 12 * 60 * 60 * 1000;

// Freno a intentos de ingreso repetidos: 5 fallos seguidos bloquean esa conexión por 10 minutos
const failedLogins = new Map(); // ip -> { count, until }
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

function dropUserSessions(userId, exceptToken) {
  for (const [t, s] of sessions) if (s.userId === userId && t !== exceptToken) sessions.delete(t);
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function requireAdmin(req, res, next) {
  const token = getCookie(req, 'admin_token');
  const session = token && sessions.get(token);
  const found = session && session.exp > Date.now() && db.prepare("SELECT id, username, session_version FROM users WHERE id = ? AND role = 'panel'").get(session.userId);
  // Si la contraseña se reseteó desde la terminal, las sesiones anteriores dejan de servir
  const user = found && found.session_version === session.version ? found : null;
  if (!user) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

/* ------------------------------ API pública ------------------------------ */

app.get('/api/store', (req, res) => {
  const s = getSettings();
  res.json({
    store_name: s.store_name,
    currency: s.currency,
    announcements: String(s.announcement || '').split('\n').map((l) => l.trim()).filter(Boolean),
    footer_text: s.footer_text,
    address: s.address,
    whatsapp: s.whatsapp,
    hours: s.hours,
    closed_days: closedDays(s).map((d) => DAY_NAMES[d]),
    delivery_enabled: s.delivery_enabled === '1',
    pickup_enabled: s.pickup_enabled === '1',
    days: availableDays(s),
    delivery_cities: db.prepare('SELECT id, name, price FROM delivery_cities ORDER BY position, name').all(),
    delivery_other_price: Number(s.delivery_other_price) || 0,
  });
});

app.get('/api/products', (req, res) => {
  res.json(
    withImages(
      db.prepare('SELECT id, name, description, price, compare_price, stock, category, image, featured, created_at FROM products WHERE active = 1 ORDER BY id DESC').all()
    )
  );
});

// Relacionados de un producto (página del producto)
app.get('/api/products/:id/related', (req, res) => {
  res.json(computeRelated([Number(req.params.id)]));
});

// Relacionados de varios productos juntos (resultados del buscador): ?ids=3,5,8
app.get('/api/related', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(Number)
    .filter(Number.isInteger)
    .slice(0, 20);
  res.json(ids.length ? computeRelated(ids) : []);
});

app.get('/api/products/:id', (req, res) => {
  const p = db
    .prepare('SELECT id, name, description, price, compare_price, stock, category, image, featured, created_at FROM products WHERE id = ? AND active = 1')
    .get(Number(req.params.id));
  if (!p) throw httpError(404, 'Este producto no existe o ya no está disponible.');
  res.json({ ...p, images: imagesOf(p.id) });
});

app.get('/api/slots', (req, res) => {
  res.json(slotsFor(str(req.query.date), getSettings()));
});

app.post('/api/orders', (req, res) => {
  const s = getSettings();
  const b = req.body || {};

  const customer_name = str(b.customer_name);
  const phone = str(b.phone);
  const delivery_type = b.delivery_type === 'envio' ? 'envio' : 'retiro';
  const address = str(b.address);
  const notes = str(b.notes).slice(0, 500);
  const slot_date = str(b.slot_date);
  const slot_time = str(b.slot_time);

  if (!customer_name || !phone) throw httpError(400, 'Completá tu nombre y teléfono.');
  if (delivery_type === 'envio' && s.delivery_enabled !== '1') throw httpError(400, 'El envío a domicilio no está disponible.');
  if (delivery_type === 'retiro' && s.pickup_enabled !== '1') throw httpError(400, 'El retiro en el local no está disponible.');
  if (delivery_type === 'envio' && !address) throw httpError(400, 'Indicá la dirección de entrega.');

  // Ciudad y costo del delivery: el precio lo pone siempre el servidor, nunca el navegador
  let city = '';
  let city_other = 0;
  let delivery_fee = 0;
  if (delivery_type === 'envio') {
    if (b.city_id === 'otros') {
      city = str(b.city_name).slice(0, 80);
      if (!city) throw httpError(400, 'Escribí el nombre de tu ciudad.');
      city_other = 1;
      delivery_fee = Number(s.delivery_other_price) || 0;
    } else {
      const c = db.prepare('SELECT name, price FROM delivery_cities WHERE id = ?').get(Number(b.city_id));
      if (!c) throw httpError(400, 'Elegí tu ciudad de la lista.');
      city = c.name;
      delivery_fee = c.price;
    }
  }

  // Factura
  const invoice = b.invoice === true || b.invoice === 'on' || b.invoice === '1' ? 1 : 0;
  const ruc = invoice ? str(b.ruc).replace(/[\s.]/g, '').toUpperCase() : '';
  if (invoice && !/^\d{3,12}(-[0-9K])?$/.test(ruc)) {
    throw httpError(400, 'Escribí un Ruc/CI válido: sólo números, y si es RUC con su dígito verificador (ej: 80012345-6).');
  }

  // Agrupar cantidades por producto
  const wanted = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const id = Number(it.product_id);
    const qty = Number(it.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) continue;
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  if (!wanted.size) throw httpError(400, 'El carrito está vacío.');

  db.exec('BEGIN IMMEDIATE');
  try {
    const slot = slotsFor(slot_date, s).find((x) => x.time === slot_time);
    if (!slot || !slot.available) throw httpError(409, 'El horario elegido ya no está disponible. Elegí otro.');

    const items = [];
    let subtotal = 0;
    for (const [id, qty] of wanted) {
      const p = db.prepare('SELECT id, name, price, stock FROM products WHERE id = ? AND active = 1').get(id);
      if (!p) throw httpError(409, 'Un producto de tu carrito ya no está disponible.');
      if (p.stock < qty) {
        throw httpError(409, p.stock > 0 ? `Sólo quedan ${p.stock} unidades de "${p.name}".` : `"${p.name}" se quedó sin stock.`);
      }
      // El stock NO se descuenta acá: se descuenta cuando el pedido pasa a Confirmado o Entregado
      items.push({ product_id: id, product_name: p.name, quantity: qty, unit_price: p.price });
      subtotal += p.price * qty;
    }
    const total = subtotal + delivery_fee;

    const r = db
      .prepare(
        `INSERT INTO orders (customer_name, phone, delivery_type, address, notes, slot_date, slot_time,
                             subtotal, delivery_fee, total, city, city_other, invoice, ruc, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web')`
      )
      .run(
        customer_name, phone, delivery_type, delivery_type === 'envio' ? address : '', notes, slot_date, slot_time,
        subtotal, delivery_fee, total, city, city_other, invoice, ruc
      );
    const id = Number(r.lastInsertRowid);

    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)'
    );
    for (const it of items) insItem.run(id, it.product_id, it.product_name, it.quantity, it.unit_price);
    db.prepare("UPDATE orders SET status_changed_at = created_at WHERE id = ?").run(id);
    db.prepare("INSERT INTO order_status_history (order_id, status) VALUES (?, 'pendiente')").run(id);

    db.exec('COMMIT');

    const order = { id, customer_name, phone, delivery_type, address, notes, slot_date, slot_time, subtotal, delivery_fee, total, city, invoice, ruc };
    const message = buildWhatsAppMessage(order, items, s);
    res.status(201).json({ id, total, message, whatsapp_url: waLink(s.whatsapp, message) });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

/* ------------------------------ API admin ------------------------------ */

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  const fails = failedLogins.get(ip);
  if (fails && fails.until > Date.now()) {
    const min = Math.ceil((fails.until - Date.now()) / 60000);
    throw httpError(429, `Demasiados intentos fallidos. Probá de nuevo en ${min} minuto${min === 1 ? '' : 's'}.`);
  }
  const username = str(req.body?.username);
  // Sólo los usuarios del panel (el usuario de la API no puede entrar a /admin)
  const user = username && db.prepare("SELECT id, password_hash, session_version FROM users WHERE username = ? AND role = 'panel'").get(username);
  if (!user || !verifyPassword(String(req.body?.password ?? ''), user.password_hash)) {
    const prev = fails && fails.until === 0 ? fails.count : 0; // si ya cumplió el bloqueo, empieza de cero
    const count = prev + 1;
    failedLogins.set(ip, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    throw httpError(401, 'Usuario o contraseña incorrectos.');
  }
  failedLogins.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, version: user.session_version, exp: Date.now() + SESSION_MS });
  // secure: con HTTPS la cookie de sesión nunca viaja sin cifrar
  res.cookie('admin_token', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = getCookie(req, 'admin_token');
  if (token) sessions.delete(token);
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

app.use('/api/admin', requireAdmin);

app.get('/api/admin/me', (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

// Productos
app.get('/api/admin/products', (req, res) => {
  res.json(withImages(db.prepare('SELECT * FROM products ORDER BY category, name').all()));
});

const adminProduct = (id) => ({ ...db.prepare('SELECT * FROM products WHERE id = ?').get(id), images: imagesOf(id) });

app.post('/api/admin/products', (req, res) => {
  const p = productInput(req.body || {});
  checkImageList(req.body?.images);
  const r = db
    .prepare('INSERT INTO products (name, description, price, compare_price, stock, category, featured, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.name, p.description, p.price, p.compare_price, p.stock, p.category, p.featured, p.active);
  const id = Number(r.lastInsertRowid);
  saveProductImages(id, req.body?.images || []);
  res.status(201).json(adminProduct(id));
});

app.put('/api/admin/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw httpError(404, 'Producto no encontrado.');
  const p = productInput(req.body || {});
  checkImageList(req.body?.images);
  db.exec('BEGIN IMMEDIATE');
  try {
    // El stock pasa por setStock para que el cambio quede en el historial de movimientos
    setStock(id, p.stock, 'panel', { reason: 'Edición del producto en el panel', username: req.user.username });
    db.prepare('UPDATE products SET name = ?, description = ?, price = ?, compare_price = ?, category = ?, featured = ?, active = ? WHERE id = ?')
      .run(p.name, p.description, p.price, p.compare_price, p.category, p.featured, p.active, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  saveProductImages(id, req.body?.images); // si no se manda "images", las fotos quedan como estaban
  res.json(adminProduct(id));
});

app.patch('/api/admin/products/:id/stock', (req, res) => {
  const id = Number(req.params.id);
  const stock = Number(req.body?.stock);
  db.exec('BEGIN IMMEDIATE');
  try {
    setStock(id, stock, 'panel', { reason: 'Cambio manual en el panel', username: req.user.username });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true, stock });
});

app.delete('/api/admin/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw httpError(404, 'Producto no encontrado.');
  const urls = imagesOf(id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id); // las filas de fotos se borran en cascada
  urls.forEach(deleteImage);
  res.json({ ok: true });
});

// Pedidos
app.get('/api/admin/orders', (req, res) => {
  const status = str(req.query.status);
  const orders = STATUSES.includes(status)
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY slot_date DESC, slot_time DESC LIMIT 300').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY slot_date DESC, slot_time DESC LIMIT 300').all();
  const itemsStmt = db.prepare('SELECT product_name, quantity, unit_price FROM order_items WHERE order_id = ?');
  const historyStmt = db.prepare('SELECT status, note, username, changed_at FROM order_status_history WHERE order_id = ? ORDER BY id');
  res.json(
    orders.map((o) => ({ ...o, items: itemsStmt.all(o.id), history: historyStmt.all(o.id), customer_whatsapp: waLink(o.phone) }))
  );
});

app.put('/api/admin/orders/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = str(req.body?.status);
  const note = str(req.body?.reason).slice(0, 300);
  const result = changeOrderStatus(id, status, { note, username: req.user.username, source: 'panel' });
  res.json({ ok: true, ...result });
});

/* ------------------------------ precios de delivery ------------------------------ */

app.get('/api/admin/delivery', (req, res) => {
  res.json({
    cities: db.prepare('SELECT id, name, price FROM delivery_cities ORDER BY position, name').all(),
    other_price: Number(getSettings().delivery_other_price) || 0,
  });
});

// Reemplaza la lista completa (los pedidos guardan el nombre de la ciudad, así que no se pierde nada)
app.put('/api/admin/delivery', (req, res) => {
  const list = Array.isArray(req.body?.cities) ? req.body.cities : [];
  if (list.length > 500) throw httpError(400, 'Demasiadas ciudades.');
  const seen = new Set();
  const cities = list.map((c, i) => {
    const name = str(c?.name).slice(0, 80);
    const price = Number(c?.price);
    if (!name) throw httpError(400, `Falta el nombre de la ciudad en la fila ${i + 1}.`);
    if (/^otros?$/i.test(name)) throw httpError(400, '"Otros" ya existe aparte: su precio se carga en el campo de abajo.');
    if (!Number.isFinite(price) || price < 0) throw httpError(400, `El precio de "${name}" no es válido.`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw httpError(400, `"${name}" está repetida.`);
    seen.add(key);
    return { name, price };
  });
  const other = Number(req.body?.other_price);
  if (!Number.isFinite(other) || other < 0) throw httpError(400, 'El precio de "Otros" no es válido.');

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM delivery_cities').run();
    const ins = db.prepare('INSERT INTO delivery_cities (name, price, position) VALUES (?, ?, ?)');
    cities.forEach((c, i) => ins.run(c.name, c.price, i));
    setSetting('delivery_other_price', other);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

/* ------------------------------ reportes ------------------------------ */
// Una venta cuenta sólo cuando el pedido se marca como ENTREGADO, en la fecha de entrega.
// Los conteos por estado usan la fecha en que el cliente hizo el pedido.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function reportRange(q) {
  const today = new Date();
  let from = str(q.from);
  let to = str(q.to);
  if (!DATE_RE.test(from)) from = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
  if (!DATE_RE.test(to)) to = ymd(today);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function buildReport(from, to) {
  const inDelivered = "status = 'entregado' AND date(delivered_at) BETWEEN ? AND ?";
  const inCreated = 'date(created_at) BETWEEN ? AND ?';

  const sales = db
    .prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS amount, COALESCE(SUM(delivery_fee), 0) AS delivery FROM orders WHERE ${inDelivered}`)
    .get(from, to);
  const units = db
    .prepare(
      `SELECT COALESCE(SUM(i.quantity), 0) AS u FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.status = 'entregado' AND date(o.delivered_at) BETWEEN ? AND ?`
    )
    .get(from, to).u;

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, amount: 0 }]));
  for (const r of db.prepare(`SELECT status, COUNT(*) AS c, SUM(total) AS t FROM orders WHERE ${inCreated} GROUP BY status`).all(from, to)) {
    byStatus[r.status] = { count: r.c, amount: r.t };
  }

  // Serie de ventas: por día, o por mes si el período es largo
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const monthly = days > 62;
  const bucket = monthly ? "strftime('%Y-%m', delivered_at)" : 'date(delivered_at)';
  const raw = Object.fromEntries(
    db
      .prepare(`SELECT ${bucket} AS k, SUM(total) AS amount, COUNT(*) AS orders FROM orders WHERE ${inDelivered} GROUP BY k`)
      .all(from, to)
      .map((r) => [r.k, r])
  );
  const series = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  if (monthly) {
    for (let d = new Date(fy, fm - 1, 1); ymd(d).slice(0, 7) <= to.slice(0, 7); d.setMonth(d.getMonth() + 1)) {
      const k = ymd(d).slice(0, 7);
      series.push({ key: k, amount: raw[k]?.amount || 0, orders: raw[k]?.orders || 0 });
    }
  } else {
    for (let d = new Date(fy, fm - 1, fd); ymd(d) <= to; d.setDate(d.getDate() + 1)) {
      const k = ymd(d);
      series.push({ key: k, amount: raw[k]?.amount || 0, orders: raw[k]?.orders || 0 });
    }
  }

  const soldRows = db
    .prepare(
      `SELECT i.product_id, i.product_name, COALESCE(p.category, '') AS category,
              SUM(i.quantity) AS units, SUM(i.quantity * i.unit_price) AS amount
       FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN products p ON p.id = i.product_id
       WHERE o.status = 'entregado' AND date(o.delivered_at) BETWEEN ? AND ?
       GROUP BY COALESCE(i.product_id, i.product_name) ORDER BY units DESC, amount DESC`
    )
    .all(from, to);

  const categories = {};
  for (const r of soldRows) {
    const c = r.category || 'Sin categoría';
    categories[c] ||= { category: c, units: 0, amount: 0 };
    categories[c].units += r.units;
    categories[c].amount += r.amount;
  }

  const itemsStmt = db.prepare('SELECT product_name, quantity, unit_price FROM order_items WHERE order_id = ?');
  const orders = db
    .prepare(`SELECT * FROM orders WHERE ${inCreated} ORDER BY id DESC`)
    .all(from, to)
    .map((o) => ({ ...o, items: itemsStmt.all(o.id) }));

  const soldById = Object.fromEntries(soldRows.filter((r) => r.product_id).map((r) => [r.product_id, r.units]));
  const stock = db
    .prepare('SELECT id, name, category, price, stock, active FROM products ORDER BY category, name')
    .all()
    .map((p) => ({ ...p, value: p.stock * p.price, sold: soldById[p.id] || 0, state: p.stock <= 0 ? 'Sin stock' : p.stock <= 3 ? 'Stock bajo' : 'OK' }));

  return {
    from,
    to,
    monthly,
    summary: {
      sales_amount: sales.amount,
      delivery_amount: sales.delivery, // parte del total vendido que es delivery
      delivered_orders: sales.orders,
      avg_ticket: sales.orders ? sales.amount / sales.orders : 0,
      units_sold: units,
      pending_delivery_amount: byStatus.confirmado.amount || 0,
    },
    by_status: byStatus,
    series,
    top_products: soldRows,
    categories: Object.values(categories).sort((a, b) => b.amount - a.amount),
    orders,
    stock,
  };
}

app.get('/api/admin/reports', (req, res) => {
  const { from, to } = reportRange(req.query);
  res.json(buildReport(from, to));
});

app.get('/api/admin/reports/excel', async (req, res) => {
  const ExcelJS = require('exceljs');
  const { from, to } = reportRange(req.query);
  const r = buildReport(from, to);
  const s = getSettings();
  const cur = `"${String(s.currency || '').replace(/"/g, '')} "#,##0`;
  const dmy = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') + (d.length > 10 ? d.slice(10, 16) : '') : '');

  const wb = new ExcelJS.Workbook();
  wb.creator = s.store_name;
  wb.created = new Date();

  function sheet(name, columns, rows) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16, style: c.money ? { numFmt: cur } : {} }));
    ws.addRows(rows);
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D2749' } };
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  }

  const res1 = wb.addWorksheet('Resumen');
  res1.columns = [{ width: 34 }, { width: 22 }];
  res1.addRow([`Reporte de ${s.store_name}`]).font = { bold: true, size: 14 };
  res1.addRow([`Período: ${dmy(from)} al ${dmy(to)}`]);
  res1.addRow(['Las ventas cuentan los pedidos entregados, en la fecha de entrega.']).font = { italic: true, color: { argb: 'FF64708A' } };
  res1.addRow([]);
  const rows = [
    ['Total vendido', r.summary.sales_amount, true],
    ['  de eso, delivery', r.summary.delivery_amount, true],
    ['Pedidos entregados', r.summary.delivered_orders],
    ['Ticket promedio', r.summary.avg_ticket, true],
    ['Unidades vendidas', r.summary.units_sold],
    ['Pendiente de entrega (confirmados)', r.summary.pending_delivery_amount, true],
  ];
  for (const [label, val, isMoney] of rows) {
    const row = res1.addRow([label, val]);
    row.getCell(1).font = { bold: true };
    if (isMoney) row.getCell(2).numFmt = cur;
  }
  res1.addRow([]);
  res1.addRow(['Pedidos recibidos en el período, por estado']).font = { bold: true };
  for (const st of STATUSES) {
    const row = res1.addRow([st[0].toUpperCase() + st.slice(1), r.by_status[st].count, r.by_status[st].amount || 0]);
    row.getCell(3).numFmt = cur;
  }
  res1.getColumn(3).width = 20;

  sheet(
    'Pedidos',
    [
      { header: 'N°', key: 'id', width: 8 },
      { header: 'Fuente', key: 'source', width: 12 },
      { header: 'Recibido', key: 'created', width: 18 },
      { header: 'Cliente', key: 'customer_name', width: 26 },
      { header: 'Teléfono', key: 'phone', width: 16 },
      { header: 'Entrega', key: 'type', width: 12 },
      { header: 'Día y hora elegidos', key: 'slot', width: 20 },
      { header: 'Ciudad', key: 'city', width: 20 },
      { header: 'Dirección', key: 'address', width: 30 },
      { header: 'Productos', key: 'products', width: 50 },
      { header: 'Subtotal', key: 'subtotal', width: 16, money: true },
      { header: 'Delivery', key: 'delivery_fee', width: 14, money: true },
      { header: 'Total', key: 'total', width: 16, money: true },
      { header: 'Factura', key: 'factura', width: 9 },
      { header: 'Ruc/CI', key: 'ruc', width: 14 },
      { header: 'Estado', key: 'status', width: 13 },
      { header: 'Entregado el', key: 'delivered', width: 18 },
      { header: 'Motivo de rechazo', key: 'reject_reason', width: 30 },
    ],
    r.orders.map((o) => ({
      ...o,
      created: dmy(o.created_at),
      type: o.delivery_type === 'envio' ? 'Envío' : 'Retiro',
      slot: `${dmy(o.slot_date)} ${o.slot_time}`,
      products: o.items.map((i) => `${i.quantity} x ${i.product_name}`).join(', '),
      city: o.city ? `${o.city}${o.city_other ? ' (Otros)' : ''}` : '',
      factura: o.invoice ? 'Sí' : 'No',
      delivered: dmy(o.delivered_at),
    }))
  );

  sheet(
    'Productos vendidos',
    [
      { header: 'Producto', key: 'product_name', width: 46 },
      { header: 'Categoría', key: 'category', width: 26 },
      { header: 'Unidades', key: 'units', width: 12 },
      { header: 'Monto', key: 'amount', width: 18, money: true },
    ],
    r.top_products
  );

  sheet(
    'Stock',
    [
      { header: 'Producto', key: 'name', width: 46 },
      { header: 'Categoría', key: 'category', width: 26 },
      { header: 'Precio', key: 'price', width: 16, money: true },
      { header: 'Stock', key: 'stock', width: 10 },
      { header: 'Valor del stock', key: 'value', width: 18, money: true },
      { header: 'Vendidos en el período', key: 'sold', width: 22 },
      { header: 'Estado', key: 'state', width: 12 },
      { header: 'Visible en la tienda', key: 'visible', width: 18 },
    ],
    r.stock.map((p) => ({ ...p, visible: p.active ? 'Sí' : 'No' }))
  );

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reporte-${from}-al-${to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// Configuración
app.get('/api/admin/settings', (req, res) => {
  const s = getSettings();
  const out = {};
  for (const k of SETTING_KEYS) out[k] = s[k];
  res.json(out);
});

app.put('/api/admin/settings', (req, res) => {
  const b = req.body || {};
  const next = {};
  next.store_name = str(b.store_name) || 'Todo Herramientas';
  next.currency = str(b.currency).slice(0, 6) || 'Gs.';
  next.announcement = String(b.announcement ?? '')
    .split('\n')
    .map((l) => l.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 10)
    .join('\n');
  next.footer_text = str(b.footer_text).slice(0, 400);
  next.address = str(b.address).slice(0, 200);
  next.whatsapp = str(b.whatsapp).replace(/\D/g, '');
  if (next.whatsapp.length < 8) throw httpError(400, 'El número de WhatsApp debe incluir código de país y área (ej: 595981123456).');
  next.hours = str(b.hours);
  if (!parseRanges(next.hours).length) throw httpError(400, 'Los horarios deben tener el formato 09:00-13:00, 17:00-21:00');
  for (const [k, min, max] of [['slot_minutes', 5, 240], ['lead_minutes', 0, 10080], ['days_ahead', 1, 60], ['max_per_slot', 0, 1000]]) {
    const v = Number(b[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw httpError(400, `Valor no válido en "${k}".`);
    next[k] = String(v);
  }
  next.closed_days = (Array.isArray(b.closed_days) ? b.closed_days : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    .join(',');
  next.delivery_enabled = b.delivery_enabled ? '1' : '0';
  next.pickup_enabled = b.pickup_enabled ? '1' : '0';
  if (next.delivery_enabled === '0' && next.pickup_enabled === '0') {
    throw httpError(400, 'Activá al menos una forma de entrega (envío o retiro).');
  }
  for (const [k, v] of Object.entries(next)) setSetting(k, v);
  res.json({ ok: true });
});

// Cambiar la contraseña propia
app.put('/api/admin/password', (req, res) => {
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, user.password_hash)) throw httpError(400, 'La contraseña actual no es correcta.');
  const error = validateNewUser(req.user.username, next);
  if (error) throw httpError(400, error);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  dropUserSessions(req.user.id, req.sessionToken); // cierra la sesión en otros dispositivos
  res.json({ ok: true });
});

/* ------------------------------ API v1 (para sistemas externos) ------------------------------ */
// Paso 1: POST /api/v1/login con el usuario de la API -> devuelve un token que dura 24 horas.
// Paso 2: cada llamada lleva la cabecera  Authorization: Bearer <token>
// El usuario de la API se crea en la terminal: npm run usuario-api -- <usuario>
// Documentación: deploy/API.md

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const TOKEN_MS = 24 * 60 * 60 * 1000;
const apiCalls = new Map(); // ip -> [momentos]  (límite: 120 llamadas por minuto)

function apiRateLimit(req, res, next) {
  const ip = req.ip || '';
  const now = Date.now();
  const recent = (apiCalls.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 120) return res.status(429).json({ error: 'Demasiadas llamadas: máximo 120 por minuto.' });
  apiCalls.set(ip, [...recent, now]);
  next();
}

app.use('/api/v1', apiRateLimit);

// Iniciar sesión: { "usuario": "...", "contrasena": "..." }  ->  { "token": "...", "vence": "..." }
app.post('/api/v1/login', (req, res) => {
  const ip = req.ip || '';
  const fails = failedLogins.get(ip);
  if (fails && fails.until > Date.now()) {
    const min = Math.ceil((fails.until - Date.now()) / 60000);
    throw httpError(429, `Demasiados intentos fallidos. Probá de nuevo en ${min} minuto${min === 1 ? '' : 's'}.`);
  }
  const b = req.body || {};
  const usuario = str(b.usuario);
  const contrasena = String(b.contrasena ?? b['contraseña'] ?? '');
  if (!usuario || !contrasena) throw httpError(400, 'Mandá "usuario" y "contrasena".');
  const user = db.prepare("SELECT id, password_hash, session_version FROM users WHERE username = ? AND role = 'api'").get(usuario);
  if (!user || !verifyPassword(contrasena, user.password_hash)) {
    const prev = fails && fails.until === 0 ? fails.count : 0;
    const count = prev + 1;
    failedLogins.set(ip, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    throw httpError(401, 'Usuario o contraseña incorrectos.');
  }
  failedLogins.delete(ip);
  const now = Date.now();
  db.prepare('DELETE FROM api_tokens WHERE expires_at < ?').run(now); // limpiar tokens vencidos
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO api_tokens (token_hash, user_id, session_version, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    user.id,
    user.session_version,
    now + TOKEN_MS,
    now
  );
  const vence = new Date(now + TOKEN_MS);
  res.json({ token, vence: `${ymd(vence)} ${pad(vence.getHours())}:${pad(vence.getMinutes())}`, dura_horas: 24 });
});

// Todas las demás rutas de la API necesitan un token válido
app.use('/api/v1', (req, res, next) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Falta el token. Primero iniciá sesión en POST /api/v1/login.' });
  const row = db
    .prepare(
      `SELECT t.expires_at, t.session_version AS tv, u.session_version AS uv
       FROM api_tokens t JOIN users u ON u.id = t.user_id AND u.role = 'api' WHERE t.token_hash = ?`
    )
    .get(sha256(token));
  // Si se cambió la contraseña del usuario de la API, sus tokens dejan de servir
  if (!row || row.tv !== row.uv) return res.status(401).json({ error: 'Token inválido. Iniciá sesión de nuevo en POST /api/v1/login.' });
  if (row.expires_at < Date.now()) return res.status(401).json({ error: 'El token venció. Iniciá sesión de nuevo en POST /api/v1/login.' });
  next();
});


function apiOrder(o) {
  const items = db.prepare('SELECT product_id, product_name, quantity, unit_price FROM order_items WHERE order_id = ?').all(o.id);
  const history = db.prepare('SELECT status, note, username, changed_at FROM order_status_history WHERE order_id = ? ORDER BY id').all(o.id);
  return {
    id: o.id,
    fuente: o.source || 'web',
    estado: o.status,
    stock_descontado: !!o.stock_descontado,
    creado: o.created_at,
    cliente: { nombre: o.customer_name, telefono: o.phone },
    entrega: {
      tipo: o.delivery_type === 'envio' ? 'envio' : 'retiro',
      ciudad: o.city || null,
      direccion: o.address || null,
      dia: o.slot_date,
      hora: o.slot_time,
    },
    factura: { necesita: !!o.invoice, ruc: o.ruc || null },
    productos: items.map((i) => ({
      producto_id: i.product_id,
      nombre: i.product_name,
      cantidad: i.quantity,
      precio_unitario: i.unit_price,
      subtotal: i.quantity * i.unit_price,
    })),
    subtotal: o.subtotal ?? o.total - (o.delivery_fee || 0),
    delivery: o.delivery_fee || 0,
    total: o.total,
    notas: o.notes || null,
    motivo_rechazo: o.reject_reason || null,
    entregado_el: o.delivered_at || null,
    modificado: !!o.original_items,
    productos_originales: o.original_items ? JSON.parse(o.original_items) : null, // lo que pidió el cliente en la web
    historial: history.map((h) => ({ estado: h.status, fecha: h.changed_at, por: h.username || 'cliente', nota: h.note || null })),
  };
}

function apiProduct(p) {
  return { id: p.id, nombre: p.name, categoria: p.category || null, precio: p.price, stock: p.stock, visible: !!p.active };
}

const apiLimit = (v, def, max) => Math.min(Math.max(Number(v) || def, 1), max);

// Pedidos
app.get('/api/v1/pedidos', (req, res) => {
  const where = [];
  const args = [];
  const estado = str(req.query.estado);
  if (estado) {
    if (!STATUSES.includes(estado)) throw httpError(400, `Estado no válido. Usá uno de estos: ${STATUSES.join(', ')}.`);
    where.push('status = ?');
    args.push(estado);
  }
  const fuente = str(req.query.fuente);
  if (fuente) {
    where.push('source = ? COLLATE NOCASE');
    args.push(fuente);
  }
  if (DATE_RE.test(str(req.query.desde))) {
    where.push('date(created_at) >= ?');
    args.push(str(req.query.desde));
  }
  if (DATE_RE.test(str(req.query.hasta))) {
    where.push('date(created_at) <= ?');
    args.push(str(req.query.hasta));
  }
  const rows = db
    .prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, apiLimit(req.query.limite, 50, 500));
  res.json(rows.map(apiOrder));
});

app.get('/api/v1/pedidos/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!o) throw httpError(404, 'Pedido no encontrado.');
  res.json(apiOrder(o));
});

// Modificar un pedido: productos reales, estado nuevo, o las dos cosas en la misma llamada.
// Primero se aplican los productos y después el estado, todo junto (o nada).
app.patch('/api/v1/pedidos/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const estado = str(b.estado);
  const hasItems = b.productos !== undefined;
  const hasFuente = b.fuente !== undefined;
  const fuente = str(b.fuente).slice(0, 60);
  if (!hasItems && !estado && !hasFuente) throw httpError(400, 'Mandá "productos", "estado" o "fuente".');
  if (hasFuente && !fuente) throw httpError(400, '"fuente" no puede estar vacía (ej: "web", "whatsapp", "local").');
  if (estado && !STATUSES.includes(estado)) throw httpError(400, `Estado no válido. Usá uno de estos: ${STATUSES.join(', ')}.`);
  const opts = { note: str(b.motivo).slice(0, 300), username: 'API', source: 'api' };

  const result = inTransaction(() => {
    if (!db.prepare('SELECT 1 FROM orders WHERE id = ?').get(id)) throw httpError(404, 'Pedido no encontrado.');
    if (hasFuente) db.prepare('UPDATE orders SET source = ? WHERE id = ?').run(fuente, id);
    const items = hasItems ? applyItems(id, b.productos, opts) : { changed: false, stock: 'sin_cambios' };
    const status = estado ? applyStatus(id, estado, opts) : { changed: false, stock: 'sin_cambios' };
    return { items, status };
  });

  res.json({
    ok: true,
    productos_modificados: result.items.changed,
    cambio_estado: result.status.changed,
    // qué pasó con el stock: 'descontado' | 'devuelto' | 'ajustado' | 'sin_cambios'
    stock: result.status.stock !== 'sin_cambios' ? result.status.stock : result.items.stock,
    pedido: apiOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)),
  });
});

// Stock
app.get('/api/v1/productos', (req, res) => {
  const soloVisibles = req.query.visibles === '1' || req.query.visibles === 'true';
  res.json(db.prepare(`SELECT * FROM products ${soloVisibles ? 'WHERE active = 1' : ''} ORDER BY id`).all().map(apiProduct));
});

app.get('/api/v1/productos/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!p) throw httpError(404, 'Producto no encontrado.');
  res.json(apiProduct(p));
});

// Modificar el stock directamente (opcional, para inventario, ingresos de mercadería, roturas, etc.).
// Para las ventas de los pedidos NO hace falta: la web descuenta sola al confirmar el pedido.
function apiStockChange(req, res, fn) {
  const id = Number(req.params.id);
  inTransaction(() => {
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw httpError(404, 'Producto no encontrado.');
    fn(id);
  });
  res.json({ ok: true, producto: apiProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
}

// Fijar el stock en un valor: { "stock": 10, "motivo": "Inventario" }
app.put('/api/v1/productos/:id/stock', (req, res) => {
  if (req.body?.stock === undefined) throw httpError(400, 'Falta "stock".');
  apiStockChange(req, res, (id) =>
    setStock(id, Number(req.body.stock), 'api', { reason: str(req.body?.motivo).slice(0, 200) || 'Stock fijado por la API', username: 'API' })
  );
});

// Sumar o restar: { "cantidad": -2, "motivo": "Rotura" }
app.post('/api/v1/productos/:id/stock/ajuste', (req, res) => {
  const cantidad = Number(req.body?.cantidad);
  if (!Number.isInteger(cantidad) || cantidad === 0) {
    throw httpError(400, '"cantidad" debe ser un número entero distinto de 0 (positivo para sumar, negativo para restar).');
  }
  apiStockChange(req, res, (id) => {
    const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(id);
    const done = moveStock(id, cantidad, 'api', { reason: str(req.body?.motivo).slice(0, 200) || 'Ajuste por la API', username: 'API' });
    if (!done) throw httpError(409, `No se puede restar ${-cantidad}: el producto tiene ${p.stock} en stock. El stock no cambió.`);
  });
});


// Historial de movimientos de stock: ?producto=36&limite=100
app.get('/api/v1/stock/movimientos', (req, res) => {
  const pid = Number(req.query.producto);
  const rows = Number.isInteger(pid) && pid > 0
    ? db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT ?').all(pid, apiLimit(req.query.limite, 100, 1000))
    : db.prepare('SELECT * FROM stock_movements ORDER BY id DESC LIMIT ?').all(apiLimit(req.query.limite, 100, 1000));
  res.json(
    rows.map((m) => ({
      id: m.id,
      fecha: m.created_at,
      producto_id: m.product_id,
      producto: m.product_name,
      cambio: m.change,
      stock_resultante: m.stock_after,
      origen: m.source,
      pedido_id: m.order_id,
      motivo: m.reason || null,
      por: m.username || null,
    }))
  );
});

/* ------------------------------ errores ------------------------------ */

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message =
    err.type === 'entity.too.large'
      ? 'La imagen es demasiado grande.'
      : err.type === 'entity.parse.failed'
        ? 'El contenido enviado no es un JSON válido.'
        : status >= 500
          ? 'Error interno del servidor.'
          : err.message;
  res.status(status).json({ error: message });
});

app.listen(PORT, HOST, () => {
  console.log(`\nTienda funcionando:`);
  console.log(`  Tienda:  http://localhost:${PORT}`);
  console.log(`  Panel:   http://localhost:${PORT}/admin`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`  Desde el celular (misma red WiFi): http://${net.address}:${PORT}`);
      }
    }
  }
  if (!db.prepare('SELECT 1 FROM users').get()) {
    console.log('\n  Todavía no hay usuarios para el panel. Creá uno con:');
    console.log('    npm run resetear-clave -- <usuario> <contraseña>');
  }
  console.log('');
});
