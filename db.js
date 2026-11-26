// Base de datos SQLite (incluida en Node, no requiere instalar nada extra).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tienda.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    price       REAL    NOT NULL DEFAULT 0,
    stock       INTEGER NOT NULL DEFAULT 0,
    category    TEXT    NOT NULL DEFAULT '',
    image       TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT    NOT NULL,
    phone         TEXT    NOT NULL,
    delivery_type TEXT    NOT NULL,           -- 'envio' | 'retiro'
    address       TEXT    NOT NULL DEFAULT '',
    notes         TEXT    NOT NULL DEFAULT '',
    slot_date     TEXT    NOT NULL,           -- AAAA-MM-DD
    slot_time     TEXT    NOT NULL,           -- HH:MM
    total         REAL    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pendiente',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id   INTEGER,
    product_name TEXT    NOT NULL,
    quantity     INTEGER NOT NULL,
    unit_price   REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Columnas agregadas después de la primera versión
const productCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productCols.includes('compare_price')) {
  db.exec('ALTER TABLE products ADD COLUMN compare_price REAL NOT NULL DEFAULT 0'); // precio anterior (oferta)
}
if (!productCols.includes('featured')) {
  db.exec('ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0'); // aparece en el banner
}

// Varias fotos por producto (la primera es la principal y también queda en products.image)
db.exec(`
  CREATE TABLE IF NOT EXISTS product_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    url        TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_product_images ON product_images(product_id, position);
`);
// Pasar la foto única de la versión anterior a la tabla nueva
db.exec(`
  INSERT INTO product_images (product_id, url, position)
  SELECT id, image, 0 FROM products
  WHERE image != '' AND id NOT IN (SELECT product_id FROM product_images);
`);

// Pedidos: motivo de rechazo, fecha de entrega e historial de cada cambio de estado
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderCols.includes('reject_reason')) db.exec("ALTER TABLE orders ADD COLUMN reject_reason TEXT NOT NULL DEFAULT ''");
if (!orderCols.includes('delivered_at')) db.exec('ALTER TABLE orders ADD COLUMN delivered_at TEXT'); // cuenta como venta ese día
if (!orderCols.includes('status_changed_at')) db.exec('ALTER TABLE orders ADD COLUMN status_changed_at TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS order_status_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status     TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    username   TEXT    NOT NULL DEFAULT '',  -- quién hizo el cambio ('' = el cliente al crear el pedido)
    changed_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_status_history ON order_status_history(order_id);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_delivered ON orders(delivered_at);
`);
// Ciudades con precio de delivery (las carga la tienda en Configuración)
db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_cities (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    price    REAL    NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0
  );
`);
// Pedidos: ciudad, costo de delivery, subtotal de productos y datos de factura
for (const [col, def] of [
  ['city', "TEXT NOT NULL DEFAULT ''"],
  ['city_other', 'INTEGER NOT NULL DEFAULT 0'], // 1 = el cliente eligió "Otros" y la escribió a mano
  ['delivery_fee', 'REAL NOT NULL DEFAULT 0'],
  ['subtotal', 'REAL'],
  ['invoice', 'INTEGER NOT NULL DEFAULT 0'],
  ['ruc', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${def}`);
}
db.exec('UPDATE orders SET subtotal = total WHERE subtotal IS NULL'); // pedidos anteriores: no tenían delivery

// Marca por pedido: 1 = el stock de este pedido está descontado.
// Con ella el stock se descuenta y se devuelve UNA sola vez, pase el pedido por los estados que pase.
if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'stock_descontado')) {
  db.exec('ALTER TABLE orders ADD COLUMN stock_descontado INTEGER NOT NULL DEFAULT 0');
  // Antes, el stock se descontaba al crear el pedido y se devolvía al cancelar o rechazar:
  // los pedidos que no están cancelados ni rechazados ya tienen su stock descontado.
  // (No se cambia ningún número de stock: sólo se anota cómo está cada pedido.)
  db.exec("UPDATE orders SET stock_descontado = 1 WHERE status NOT IN ('cancelado', 'rechazado')");
}

// Lo que el cliente pidió originalmente en la web (JSON), guardado la primera vez que la API modifica el pedido
if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'original_items')) {
  db.exec('ALTER TABLE orders ADD COLUMN original_items TEXT');
}

// Historial de cada cambio de stock: por pedidos, por la API o desde el panel
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_movements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NOT NULL,
    product_name TEXT    NOT NULL DEFAULT '',
    change       INTEGER NOT NULL,          -- negativo = salió stock, positivo = entró
    stock_after  INTEGER NOT NULL,
    source       TEXT    NOT NULL,          -- 'pedido' | 'api' | 'panel'
    order_id     INTEGER,
    reason       TEXT    NOT NULL DEFAULT '',
    username     TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, id);
`);

// Pedidos entregados antes de existir la fecha de entrega: se toma la del último cambio o la del pedido
db.exec(`UPDATE orders SET delivered_at = COALESCE(status_changed_at, created_at)
         WHERE status = 'entregado' AND delivered_at IS NULL`);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), salt, 64);
  const buf = Buffer.from(hash, 'hex');
  return buf.length === calc.length && crypto.timingSafeEqual(buf, calc);
}

// Valores iniciales de configuración (sólo se cargan la primera vez).
const DEFAULTS = {
  store_name: 'Todo Herramientas',
  whatsapp: '595983139610',
  currency: 'Gs.',
  // Mensajes del cartel superior: uno por línea
  announcement: [
    'Herramientas de calidad para profesionales y particulares',
    'Hacé tu pedido online y elegí día y horario',
    'Confirmación inmediata por WhatsApp',
    'Retiro en el local o envío a domicilio',
  ].join('\n'),
  delivery_other_price: '0', // precio del delivery cuando el cliente elige "Otros"
  footer_text: 'Equipamos tu taller, obra y hogar con herramientas de calidad y una atención pensada para profesionales y particulares.',
  address: '',
  hours: '09:00-13:00, 17:00-21:00',
  slot_minutes: '30',
  lead_minutes: '60',
  days_ahead: '7',
  max_per_slot: '3',
  closed_days: '0',
  delivery_enabled: '1',
  pickup_enabled: '1',
};

const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULTS)) insertDefault.run(k, v);
// Usuarios del panel de administración
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
// La contraseña única de la primera versión ya no se usa
db.prepare("DELETE FROM settings WHERE key = 'admin_password'").run();

// La recuperación de contraseña por correo se quitó: se borran sus datos si quedaron de antes.
// (La contraseña se resetea desde la terminal con: npm run resetear-clave)
db.exec('DROP TABLE IF EXISTS password_resets');
db.prepare("DELETE FROM settings WHERE key LIKE 'smtp_%'").run();

// Cada vez que se resetea la contraseña desde la terminal sube este número,
// y el servidor cierra las sesiones abiertas de ese usuario.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('session_version')) db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');

// Tipo de usuario: 'panel' (entra a /admin) o 'api' (sólo puede usar la API con token)
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'panel'");
}

// Tokens de la API: se obtienen con usuario y contraseña y duran 24 horas.
// Se guarda sólo el "hash" del token, nunca el token.
db.exec(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    token_hash      TEXT    PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_version INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,          -- milisegundos (Date.now())
    created_at      INTEGER NOT NULL
  );
`);
// La clave de API generada en el panel ya no se usa (ahora es usuario + contraseña -> token)
db.prepare("DELETE FROM settings WHERE key IN ('api_key_hash', 'api_key_hint', 'api_key_created')").run();

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;

function validateNewUser(username, password) {
  if (!USERNAME_RE.test(username)) {
    return 'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios).';
  }
  if (String(password).length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  return null;
}

function createUser(username, password, role = 'panel') {
  const error = validateNewUser(username, password);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw Object.assign(new Error(`Ya existe el usuario "${username}".`), { status: 409 });
  }
  const r = db
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), role === 'api' ? 'api' : 'panel');
  return Number(r.lastInsertRowid);
}

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

module.exports = {
  db,
  getSettings,
  setSetting,
  hashPassword,
  verifyPassword,
  createUser,
  validateNewUser,
  SETTING_KEYS: Object.keys(DEFAULTS),
};
