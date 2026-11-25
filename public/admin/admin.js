// Panel de administración: productos (con foto y stock), pedidos y configuración.
const $ = (s) => document.querySelector(s);
let currency = 'Gs.';
const money = (n) => `${currency} ${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// Aviso fijo cuando no hay conexión con la tienda (apagada o sin internet).
// Se oculta solo en cuanto vuelve a responder.
function setOffline(on) {
  $('#offlineBar').hidden = !on;
}

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch {
    setOffline(true);
    const err = new Error('No hay conexión con la tienda. Revisá que esté encendida y que tengas internet.');
    err.offline = true;
    throw err;
  }
  setOffline(false);
  $('#restartBar').hidden = res.headers.get('X-Restart-Needed') !== '1';
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && data.error === 'No encontrado.') {
    // El panel pidió algo que el servidor en funcionamiento no conoce: es una versión anterior
    $('#restartBar').hidden = false;
    throw new Error('Esta función es nueva y la tienda que está funcionando es una versión anterior. Reiniciá la tienda para usarla.');
  }
  if (res.status === 401 && !url.endsWith('/login')) {
    showLogin();
    throw new Error(data.error || 'Sesión vencida.');
  }
  if (!res.ok) throw new Error(data.error || 'Ocurrió un error.');
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

/* ---------------- sesión ---------------- */

function showLogin() {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
}

let me = null; // usuario con sesión iniciada

async function start() {
  try {
    me = await api('/api/admin/me');
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    $('#whoami').textContent = me.username;
    const s = await api('/api/admin/settings');
    currency = s.currency || '';
    $('#panelTitle').textContent = s.store_name;
    loadProducts();
    loadOrders();
  } catch {
    showLogin();
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: e.target.username.value.trim(), password: e.target.password.value }),
    });
    e.target.reset();
    start();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------------- pestañas ---------------- */

let currentTab = 'products';
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (!t) return;
  currentTab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${currentTab}`));
  if (currentTab === 'orders') loadOrders();
  if (currentTab === 'reports') loadReport();
  if (currentTab === 'settings') {
    loadSettings();
    loadDelivery();
    loadApiKey();
  }
});

/* ---------------- productos ---------------- */

let products = [];

async function loadProducts() {
  try {
    products = await api('/api/admin/products');
    renderProducts();
  } catch (err) {
    toast(err.message, true);
  }
}

const STOCK_FILTERS = {
  out: (p) => p.stock <= 0,
  low: (p) => p.stock > 0 && p.stock <= 3,
  hidden: (p) => !p.active,
  featured: (p) => p.featured,
};

function renderSummary() {
  const units = products.reduce((a, p) => a + p.stock, 0);
  const value = products.reduce((a, p) => a + p.stock * p.price, 0);
  const out = products.filter(STOCK_FILTERS.out).length;
  const low = products.filter(STOCK_FILTERS.low).length;
  $('#stockSummary').innerHTML = `
    <button data-filter=""><strong>${products.length}</strong><span>Productos · ${units} unidades</span></button>
    <button data-filter="" title="Stock × precio de venta"><strong style="font-size:1.15rem;padding:4px 0">${money(value)}</strong><span>Valor del stock</span></button>
    <button data-filter="low" class="${low ? 'warn' : ''}"><strong>${low}</strong><span>Con stock bajo</span></button>
    <button data-filter="out" class="${out ? 'bad' : ''}"><strong>${out}</strong><span>Sin stock</span></button>`;
}

$('#stockSummary').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  $('#stockFilter').value = b.dataset.filter;
  renderProducts();
});
$('#stockFilter').addEventListener('change', renderProducts);

function renderProducts() {
  renderSummary();
  const q = $('#productSearch').value.trim().toLowerCase();
  const f = STOCK_FILTERS[$('#stockFilter').value];
  const list = products.filter((p) => (!q || `${p.name} ${p.category}`.toLowerCase().includes(q)) && (!f || f(p)));
  $('#categoryList').innerHTML = [...new Set(products.map((p) => p.category).filter(Boolean))]
    .map((c) => `<option value="${esc(c)}">`)
    .join('');

  if (!list.length) {
    $('#productList').innerHTML = products.length
      ? '<p class="empty">No hay productos que coincidan con la búsqueda.</p>'
      : '<p class="empty">Todavía no cargaste productos. Tocá <strong>+ Nuevo producto</strong> para empezar.</p>';
    return;
  }

  $('#productList').innerHTML = list
    .map(
      (p) => `<div class="prow ${p.active ? '' : 'inactive'}">
        ${p.image ? `<img src="${esc(p.image)}" alt="">` : '<div class="thumb-empty"></div>'}
        <div class="info">
          <div class="name">${esc(p.name)}${p.active ? '' : ' <span class="muted">(oculto)</span>'}${p.featured ? '<span class="pill feat">Destacado</span>' : ''}${p.compare_price > p.price ? '<span class="pill sale">Oferta</span>' : ''}</div>
          <div class="meta">${p.compare_price > p.price ? `<del>${money(p.compare_price)}</del> ` : ''}${money(p.price)}${p.category ? ' · ' + esc(p.category) : ''}</div>
          <div class="meta">${p.images.length ? `${p.images.length} foto${p.images.length === 1 ? '' : 's'}` : 'Sin fotos'} · <a href="/producto/${p.id}" target="_blank" rel="noopener">Ver página</a></div>
        </div>
        <label class="stock-edit">Stock
          <input type="number" min="0" step="1" value="${p.stock}" data-stock="${p.id}" class="${p.stock <= 0 ? 'zero' : ''}">
        </label>
        <div class="actions">
          <button class="btn small" data-edit="${p.id}">Editar</button>
          <button class="btn small danger" data-delete="${p.id}">Borrar</button>
        </div>
      </div>`
    )
    .join('');
}

$('#productSearch').addEventListener('input', renderProducts);

// Cambio rápido de stock
$('#productList').addEventListener('change', async (e) => {
  const id = e.target.dataset.stock;
  if (!id) return;
  const stock = Number(e.target.value);
  if (!Number.isInteger(stock) || stock < 0) return toast('El stock debe ser un número entero, 0 o mayor.', true);
  try {
    await api(`/api/admin/products/${id}/stock`, { method: 'PATCH', body: JSON.stringify({ stock }) });
    const p = products.find((x) => x.id === Number(id));
    if (p) p.stock = stock;
    e.target.classList.toggle('zero', stock <= 0);
    toast('Stock actualizado');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#productList').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-delete]');
  if (edit) openProductDialog(products.find((p) => p.id === Number(edit.dataset.edit)));
  if (del) {
    const p = products.find((x) => x.id === Number(del.dataset.delete));
    if (!p || !confirm(`¿Borrar "${p.name}"? Esta acción no se puede deshacer.\n\nSi sólo querés ocultarlo, editalo y destildá "Visible en la tienda".`)) return;
    try {
      await api(`/api/admin/products/${p.id}`, { method: 'DELETE' });
      toast('Producto borrado');
      loadProducts();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

/* ---------------- formulario de producto ---------------- */

const dialog = $('#productDialog');
const pform = $('#productForm');
const MAX_PHOTOS = 8;
let editing = null; // producto que se edita (o null si es nuevo)
let photos = [];    // [{ url } foto ya guardada | { data } foto nueva], en orden

function renderPhotos() {
  const tiles = photos
    .map(
      (ph, i) => `<div class="photo-tile">
        <img src="${esc(ph.url || ph.data)}" alt="Foto ${i + 1}">
        ${i === 0 ? '<span class="photo-main">Principal</span>' : ''}
        <div class="photo-tools">
          <button type="button" data-photo-move="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Mover a la izquierda">‹</button>
          <button type="button" data-photo-del data-i="${i}" aria-label="Quitar foto" class="del">✕</button>
          <button type="button" data-photo-move="1" data-i="${i}" ${i === photos.length - 1 ? 'disabled' : ''} aria-label="Mover a la derecha">›</button>
        </div>
      </div>`
    )
    .join('');
  const add =
    photos.length < MAX_PHOTOS
      ? `<label class="photo-add"><span>+</span>Agregar fotos<input type="file" id="photoInput" accept="image/*" multiple hidden></label>`
      : '';
  $('#photoGrid').innerHTML = tiles + add;
}

$('#photoGrid').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = Number(b.dataset.i);
  if ('photoDel' in b.dataset) photos.splice(i, 1);
  if (b.dataset.photoMove) {
    const j = i + Number(b.dataset.photoMove);
    [photos[i], photos[j]] = [photos[j], photos[i]];
  }
  renderPhotos();
});

$('#photoGrid').addEventListener('change', async (e) => {
  if (e.target.id !== 'photoInput') return;
  const files = [...e.target.files];
  const room = MAX_PHOTOS - photos.length;
  if (files.length > room) toast(`Sólo se agregaron ${room} foto${room === 1 ? '' : 's'}: el máximo es ${MAX_PHOTOS}.`, true);
  for (const file of files.slice(0, room)) {
    try {
      photos.push({ data: await resizeImage(file) });
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
  renderPhotos();
});

function openProductDialog(p = null) {
  editing = p;
  photos = (p?.images || []).map((url) => ({ url }));
  renderPhotos();
  pform.reset();
  $('#productDialogTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  pform.name.value = p?.name ?? '';
  pform.description.value = p?.description ?? '';
  pform.category.value = p?.category ?? '';
  pform.price.value = p?.price ?? '';
  pform.compare_price.value = p?.compare_price ? p.compare_price : '';
  pform.stock.value = p?.stock ?? '';
  pform.active.checked = p ? !!p.active : true;
  pform.featured.checked = !!p?.featured;
  dialog.showModal();
}

$('#newProductBtn').addEventListener('click', () => openProductDialog());
dialog.addEventListener('click', (e) => {
  if (e.target.closest('[data-dialog-close]')) dialog.close();
});

// Achica la foto en el navegador antes de subirla (máx. 1200 px, JPG)
function resizeImage(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * k);
      const h = Math.round(img.height * k);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen.'));
    };
    img.src = url;
  });
}

pform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: pform.name.value,
    description: pform.description.value,
    category: pform.category.value,
    price: Number(pform.price.value),
    compare_price: Number(pform.compare_price.value) || 0,
    stock: Number(pform.stock.value),
    active: pform.active.checked,
    featured: pform.featured.checked,
  };
  if (payload.compare_price && payload.compare_price <= payload.price) {
    return toast('El precio anterior tiene que ser mayor al precio de venta (o dejalo vacío).', true);
  }
  payload.images = photos.map((ph) => (ph.url ? { url: ph.url } : { data: ph.data }));

  const btn = $('#saveProductBtn');
  btn.disabled = true;
  try {
    await api(editing ? `/api/admin/products/${editing.id}` : '/api/admin/products', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    dialog.close();
    toast(editing ? 'Producto actualizado' : 'Producto creado');
    loadProducts();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- pedidos ---------------- */

// silent: la revisión automática no muestra avisos (si se cortó la conexión ya lo indica la barra roja)
async function loadOrders(silent = false) {
  try {
    const status = $('#orderFilter').value;
    const [orders, pending] = await Promise.all([
      api(`/api/admin/orders${status ? `?status=${status}` : ''}`),
      status === 'pendiente' ? null : api('/api/admin/orders?status=pendiente'),
    ]);
    const pendingCount = (pending ?? orders).length;
    $('#pendingBadge').hidden = !pendingCount;
    $('#pendingBadge').textContent = pendingCount;
    renderOrders(orders);
  } catch (err) {
    if (!silent && !err.offline) toast(err.message, true);
  }
}

function formatSlot(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  return `${DAYS[new Date(y, m - 1, d).getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')} · ${time} hs`;
}

const ORDER_STATUSES = ['pendiente', 'confirmado', 'entregado', 'cancelado', 'rechazado'];
const HOLDS_STOCK = ['confirmado', 'entregado']; // en estos estados el stock del pedido está descontado
const statusLabel = (s) => s[0].toUpperCase() + s.slice(1);

function renderOrders(orders) {
  if (!orders.length) {
    $('#orderList').innerHTML = '<p class="empty">No hay pedidos en esta lista.</p>';
    return;
  }
  $('#orderList').innerHTML = orders
    .map(
      (o) => `<article class="order">
        <div class="order-head">
          <h3>Pedido #${o.id} · ${esc(o.customer_name)}</h3>
          <span class="when">${formatSlot(o.slot_date, o.slot_time)}</span>
        </div>
        <div class="order-grid">
          <div>Teléfono: <a href="${esc(o.customer_whatsapp)}" target="_blank" rel="noopener">${esc(o.phone)}</a></div>
          <div>${o.delivery_type === 'envio' ? `Envío a: <strong>${esc(o.address)}</strong>${o.city ? ` · ${esc(o.city)}${o.city_other ? ' <span class="muted">(Otros)</span>' : ''}` : ''}` : 'Retira en el local'}</div>
          <div>Factura: ${o.invoice ? `<strong>Sí</strong> · Ruc/CI: <strong>${esc(o.ruc)}</strong>` : 'No'}</div>
          ${o.notes ? `<div>Aclaraciones: ${esc(o.notes)}</div>` : ''}
          <div class="muted">Recibido: ${esc(o.created_at)}</div>
          <div>${o.stock_descontado ? '<span class="stock-flag on">Stock descontado</span>' : '<span class="stock-flag">Stock sin descontar</span>'}</div>
        </div>
        ${o.original_items ? '<div class="sold-label">Vendido (modificado por la API):</div>' : ''}
        <ul>${o.items.map((it) => `<li>${it.quantity} × ${esc(it.product_name)} — ${money(it.unit_price * it.quantity)}</li>`).join('')}</ul>
        ${
          o.original_items
            ? `<details class="history"><summary>Pedido original del cliente</summary><ul>${JSON.parse(o.original_items)
                .map((it) => `<li>${it.cantidad} × ${esc(it.nombre)} — ${money(it.precio_unitario * it.cantidad)}</li>`)
                .join('')}</ul></details>`
            : ''
        }
        ${o.status === 'rechazado' && o.reject_reason ? `<div class="reject-note">Motivo del rechazo: ${esc(o.reject_reason)}</div>` : ''}
        ${
          o.history?.length > 1
            ? `<details class="history"><summary>Historial de estados</summary><ul>${o.history
                .map((h) => `<li><span class="muted">${esc(h.changed_at)}</span> · ${statusLabel(h.status)}${h.username ? ` · por ${esc(h.username)}` : ''}${h.note ? ` · "${esc(h.note)}"` : ''}</li>`)
                .join('')}</ul></details>`
            : ''
        }
        <div class="order-foot">
          <div>
            ${o.delivery_fee ? `<div class="muted">Productos ${money(o.subtotal ?? o.total - o.delivery_fee)} + delivery ${money(o.delivery_fee)}</div>` : ''}
            <strong>Total: ${money(o.total)}</strong>
          </div>
          <select class="status ${o.status}" data-order="${o.id}" data-held="${o.stock_descontado ? 1 : 0}" aria-label="Estado del pedido">
            ${ORDER_STATUSES.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
          </select>
        </div>
      </article>`
    )
    .join('');
}

$('#orderFilter').addEventListener('change', loadOrders);
$('#refreshOrders').addEventListener('click', loadOrders);

$('#orderList').addEventListener('change', async (e) => {
  const id = e.target.dataset.order;
  if (!id) return;
  const status = e.target.value;
  const held = e.target.dataset.held === '1';
  // Qué va a pasar con el stock (se mueve una sola vez, según la marca del pedido)
  const stockNote = HOLDS_STOCK.includes(status)
    ? held ? 'El stock ya estaba descontado: no cambia.' : 'Se va a DESCONTAR el stock de sus productos.'
    : held ? 'Se va a DEVOLVER el stock de sus productos.' : 'El stock no estaba descontado: no cambia.';
  let reason = '';
  if (status === 'rechazado') {
    reason = prompt(`¿Rechazar este pedido?\n\n${stockNote}\nSi querés, escribí el motivo (por ejemplo: "fuera de zona de envío"):`, '');
    if (reason === null) return loadOrders(); // tocó Cancelar
  } else if (!confirm(`¿Pasar el pedido a "${statusLabel(status)}"?\n\n${stockNote}`)) {
    return loadOrders();
  }
  try {
    const r = await api(`/api/admin/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status, reason }) });
    toast(r.stock === 'descontado' ? 'Pedido actualizado: stock descontado' : r.stock === 'devuelto' ? 'Pedido actualizado: stock devuelto' : 'Pedido actualizado');
    loadOrders();
    if (r.stock !== 'sin_cambios') loadProducts();
  } catch (err) {
    toast(err.message, true);
    loadOrders();
  }
});

// Revisa pedidos nuevos cada 30 segundos
// (cada 10 segundos mientras no haya conexión, para que el aviso desaparezca rápido al volver)
let lastCheck = 0;
setInterval(() => {
  if ($('#appView').hidden) return;
  const offline = !$('#offlineBar').hidden;
  if (Date.now() - lastCheck < (offline ? 10000 : 30000)) return;
  lastCheck = Date.now();
  loadOrders(true);
}, 5000);

/* ---------------- configuración ---------------- */

const sform = $('#settingsForm');

async function loadSettings() {
  try {
    const s = await api('/api/admin/settings');
    for (const k of ['store_name', 'currency', 'address', 'announcement', 'footer_text', 'whatsapp', 'hours', 'slot_minutes', 'lead_minutes', 'days_ahead', 'max_per_slot']) {
      sform[k].value = s[k] ?? '';
    }
    sform.delivery_enabled.checked = s.delivery_enabled === '1';
    sform.pickup_enabled.checked = s.pickup_enabled === '1';
    const closed = String(s.closed_days || '').split(',').filter(Boolean).map(Number);
    $('#closedDays').innerHTML = DAYS.map(
      (d, i) => `<label><input type="checkbox" name="closed_days" value="${i}" ${closed.includes(i) ? 'checked' : ''}> ${d}</label>`
    ).join('');
  } catch (err) {
    toast(err.message, true);
  }
}

sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(sform);
  const payload = Object.fromEntries(fd);
  payload.closed_days = fd.getAll('closed_days');
  payload.delivery_enabled = sform.delivery_enabled.checked;
  payload.pickup_enabled = sform.pickup_enabled.checked;
  for (const k of ['slot_minutes', 'lead_minutes', 'days_ahead', 'max_per_slot']) payload[k] = Number(payload[k]);
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    currency = payload.currency;
    $('#panelTitle').textContent = payload.store_name;
    renderProducts();
    toast('Configuración guardada');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.next.value !== f.repeat.value) return toast('Las dos contraseñas nuevas no coinciden.', true);
  try {
    await api('/api/admin/password', {
      method: 'PUT',
      body: JSON.stringify({ current: f.current.value, next: f.next.value }),
    });
    f.reset();
    toast('Contraseña cambiada');
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- clave de la API ---------------- */

async function loadApiKey() {
  $('#apiBase').textContent = `${location.origin}/api/v1`;
  try {
    const k = await api('/api/admin/api-key');
    $('#apiStatus').innerHTML = k.active
      ? `<span class="ok">✓ API activa</span> · clave terminada en <code>…${esc(k.hint)}</code> · creada el ${esc(k.created_at)}`
      : '<span class="warn">API desactivada: generá una clave para usarla.</span>';
    $('#genApiKey').textContent = k.active ? 'Generar clave nueva' : 'Generar clave';
    $('#delApiKey').hidden = !k.active;
  } catch (err) {
    if (!err.offline) toast(err.message, true);
  }
}

$('#genApiKey').addEventListener('click', async () => {
  const active = $('#genApiKey').textContent.includes('nueva');
  if (active && !confirm('¿Generar una clave nueva?\n\nLa clave actual deja de funcionar en el momento: el sistema que la use va a necesitar la nueva.')) return;
  try {
    const { key } = await api('/api/admin/api-key', { method: 'POST' });
    $('#apiKeyValue').textContent = key;
    $('#apiKeyBox').hidden = false;
    loadApiKey();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#copyApiKey').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#apiKeyValue').textContent);
    toast('Clave copiada');
  } catch {
    toast('No se pudo copiar: seleccioná la clave y copiala a mano.', true);
  }
});

$('#delApiKey').addEventListener('click', async () => {
  if (!confirm('¿Desactivar la API?\n\nLa clave actual deja de funcionar y ningún sistema externo va a poder usar la API hasta que generes una nueva.')) return;
  try {
    await api('/api/admin/api-key', { method: 'DELETE' });
    $('#apiKeyBox').hidden = true;
    toast('API desactivada');
    loadApiKey();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- precios de delivery ---------------- */

const dform = $('#deliveryForm');

function cityRow(c = { name: '', price: '' }) {
  return `<div class="dl-row">
    <input name="city" maxlength="80" placeholder="Ej: Coronel Oviedo" value="${esc(c.name)}" aria-label="Ciudad">
    <input name="price" type="number" min="0" step="any" placeholder="0" value="${esc(c.price)}" aria-label="Precio del delivery">
    <button type="button" class="icon-btn danger" data-del-city aria-label="Quitar ciudad">✕</button>
  </div>`;
}

async function loadDelivery() {
  try {
    const d = await api('/api/admin/delivery');
    $('#deliveryRows').innerHTML = d.cities.length ? d.cities.map(cityRow).join('') : cityRow();
    dform.other_price.value = d.other_price;
  } catch (err) {
    if (!err.offline) toast(err.message, true);
  }
}

$('#addCity').addEventListener('click', () => {
  $('#deliveryRows').insertAdjacentHTML('beforeend', cityRow());
  $('#deliveryRows').lastElementChild.querySelector('input').focus();
});

$('#deliveryRows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-city]');
  if (b) b.closest('.dl-row').remove();
});

dform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cities = [...$('#deliveryRows').querySelectorAll('.dl-row')]
    .map((row) => ({ name: row.querySelector('[name=city]').value.trim(), price: row.querySelector('[name=price]').value }))
    .filter((c) => c.name || c.price !== ''); // las filas vacías se ignoran
  for (const c of cities) {
    if (!c.name) return toast('Hay una fila con precio pero sin nombre de ciudad.', true);
    if (c.price === '') return toast(`Falta el precio de "${c.name}".`, true);
  }
  if (dform.other_price.value === '') return toast('Falta el precio de "Otros".', true);
  try {
    await api('/api/admin/delivery', {
      method: 'PUT',
      body: JSON.stringify({ cities: cities.map((c) => ({ ...c, price: Number(c.price) })), other_price: Number(dform.other_price.value) }),
    });
    toast('Precios de delivery guardados');
    loadDelivery();
  } catch (err) {
    toast(err.message, true);
  }
});

start();
