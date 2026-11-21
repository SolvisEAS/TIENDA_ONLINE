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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS));

// Página de detalle de cada producto: /producto/5
app.get('/producto/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'producto.html')));

/* ----------------------------- utilidades ----------------------------- */

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const STATUSES = ['pendiente', 'confirmado', 'entregado', 'cancelado', 'rechazado'];
const CLOSED = ['cancelado', 'rechazado']; // no se concretaron: devuelven el stock y no se pueden reactivar

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
  const found = session && session.exp > Date.now() && db.prepare('SELECT id, username, session_version FROM users WHERE id = ?').get(session.userId);
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
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, id);
      items.push({ product_id: id, product_name: p.name, quantity: qty, unit_price: p.price });
      subtotal += p.price * qty;
    }
    const total = subtotal + delivery_fee;

    const r = db
      .prepare(
        `INSERT INTO orders (customer_name, phone, delivery_type, address, notes, slot_date, slot_time,
                             subtotal, delivery_fee, total, city, city_other, invoice, ruc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  const user = username && db.prepare('SELECT id, password_hash, session_version FROM users WHERE username = ?').get(username);
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
  db.prepare('UPDATE products SET name = ?, description = ?, price = ?, compare_price = ?, stock = ?, category = ?, featured = ?, active = ? WHERE id = ?')
    .run(p.name, p.description, p.price, p.compare_price, p.stock, p.category, p.featured, p.active, id);
  saveProductImages(id, req.body?.images); // si no se manda "images", las fotos quedan como estaban
  res.json(adminProduct(id));
});

app.patch('/api/admin/products/:id/stock', (req, res) => {
  const id = Number(req.params.id);
  const stock = Number(req.body?.stock);
  if (!Number.isInteger(stock) || stock < 0) throw httpError(400, 'El stock debe ser un número entero mayor o igual a 0.');
  const r = db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stock, id);
  if (!r.changes) throw httpError(404, 'Producto no encontrado.');
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
  if (!STATUSES.includes(status)) throw httpError(400, 'Estado no válido.');
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
  if (!order) throw httpError(404, 'Pedido no encontrado.');
  if (order.status === status) return res.json({ ok: true });
  if (CLOSED.includes(order.status)) throw httpError(409, `Un pedido ${order.status} no se puede reactivar.`);

  db.exec('BEGIN');
  try {
    if (CLOSED.includes(status)) {
      // Devolver el stock de los productos que todavía existen
      const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(id);
      const restore = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
      for (const it of items) if (it.product_id) restore.run(it.quantity, it.product_id);
    }
    db.prepare(
      `UPDATE orders SET status = ?, status_changed_at = datetime('now','localtime'),
         reject_reason = CASE WHEN ? = 'rechazado' THEN ? ELSE reject_reason END,
         delivered_at = CASE WHEN ? = 'entregado' THEN datetime('now','localtime') ELSE NULL END
       WHERE id = ?`
    ).run(status, status, note, status, id);
    db.prepare('INSERT INTO order_status_history (order_id, status, note, username) VALUES (?, ?, ?, ?)').run(
      id,
      status,
      note,
      req.user.username
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
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

/* ------------------------------ errores ------------------------------ */

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message =
    err.type === 'entity.too.large' ? 'La imagen es demasiado grande.' : status >= 500 ? 'Error interno del servidor.' : err.message;
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
