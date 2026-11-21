// Código compartido por todas las páginas de la tienda:
// encabezado, pie, menú, carrito, elección de horario y envío del pedido por WhatsApp.
// Cada página (home.js, product.js) define `page` con sus funciones y llama a startShop().

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- íconos ---------------- */

const PATHS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  zoom: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
};
const WA_PATH =
  'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z';

function icon(name) {
  if (name === 'whatsapp') return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${WA_PATH}"/></svg>`;
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

/* ---------------- utilidades ---------------- */

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch {
    throw new Error('No pudimos conectarnos con la tienda. Revisá tu conexión a internet y probá de nuevo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ocurrió un error. Probá de nuevo.');
  return data;
}

const store = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
  },
};

let products = [];
let shop = { store_name: 'Todo Herramientas', currency: 'Gs.', delivery_enabled: true, pickup_enabled: true, days: [] };
let cart = store.read('cart', {}); // { idProducto: cantidad }
let view = null; // panel del carrito: 'cart' | 'checkout' | 'success' | null
let page = {};   // funciones propias de cada página

const money = (n) => `${shop.currency || ''} ${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`.trim();
const waUrl = (text) => `https://wa.me/${String(shop.whatsapp || '').replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
const discount = (p) => (p.compare_price > p.price ? Math.round((1 - p.price / p.compare_price) * 100) : 0);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Singular simple (igual que en el servidor): "taladros" -> "taladro", "motores" -> "motor"
function stem(w) {
  if (/^\d/.test(w)) return w;
  if (w.length > 4 && /[rlndzj]es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const words = (s) => norm(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);

// El producto coincide si contiene todas las palabras buscadas (en singular o plural,
// y también palabras a medio escribir: "tala" encuentra "taladro")
function matchesSearch(p, q) {
  const text = ' ' + words(`${p.name} ${p.category} ${p.description}`).map(stem).join(' ');
  return words(q).every((w) => text.includes(' ' + stem(w)));
}
const productUrl = (p) => `/producto/${p.id}`;
const photosOf = (p) => (p.images?.length ? p.images : p.image ? [p.image] : []);

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

/* ---------------- estructura común de la página ---------------- */

function renderLayout() {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div id="announce" class="announce" hidden></div>
    <header class="site-header">
      <div class="container header-main">
        <button id="menuBtn" class="icon-btn hamburger" aria-label="Ver categorías">${icon('menu')}</button>
        <a href="/" class="logo" aria-label="Inicio">
          <img class="logo-img" src="/img/logo.webp" alt="" width="58" height="58">
          <span class="logo-text"><span id="storeName"><b>Todo</b> Herramientas</span><small>Fuerza · Calidad · Confianza</small></span>
        </a>
        <form id="searchForm" class="search" role="search" action="/">
          <input id="searchInput" name="q" type="search" placeholder="Buscar productos..." aria-label="Buscar productos" autocomplete="off">
          <button aria-label="Buscar">${icon('search')}</button>
        </form>
        <button id="cartBtn" class="cart-btn" aria-label="Abrir carrito">
          ${icon('cart')}
          <span id="cartCount" class="cart-badge">0</span>
          <span class="cart-sum"><small>Carrito</small><strong id="cartSum"></strong></span>
        </button>
      </div>
      <nav class="catnav" aria-label="Categorías"><div class="container" id="catnav"></div></nav>
    </header>`
  );

  document.body.insertAdjacentHTML(
    'beforeend',
    `<footer class="site-footer">
      <div class="container footer-grid">
        <div>
          <div class="logo"><img class="logo-img" src="/img/logo.webp" alt="Logo de Todo Herramientas" width="96" height="96"><span class="logo-text"><span id="footerName"><b>Todo</b> Herramientas</span><small>Fuerza · Calidad · Confianza</small></span></div>
          <p id="footerText" style="margin-top:14px"></p>
        </div>
        <div>
          <h3>Contacto</h3>
          <p>${icon('chat')}<a id="footerWa" href="#" target="_blank" rel="noopener">WhatsApp</a></p>
          <p id="footerAddressRow" hidden>${icon('pin')}<span id="footerAddress"></span></p>
        </div>
        <div>
          <h3>Horarios de pedidos</h3>
          <p>${icon('clock')}<span id="footerHours"></span></p>
          <p id="footerClosedRow" hidden>${icon('x')}<span id="footerClosed"></span></p>
        </div>
      </div>
      <div class="footer-bottom"><div class="container">© <span id="year"></span> <span id="footerName2">Todo Herramientas</span></div></div>
    </footer>

    <a id="waFloat" class="wa-float" href="#" target="_blank" rel="noopener" aria-label="Escribinos por WhatsApp">${icon('whatsapp')}</a>
    <div id="overlay" class="overlay" hidden></div>

    <aside id="menuDrawer" class="drawer left" aria-label="Categorías">
      <div class="drawer-head"><h2>Categorías</h2><button class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button></div>
      <div class="drawer-body"><ul id="menuList" class="menu-list"></ul></div>
    </aside>

    <aside id="drawer" class="drawer" aria-labelledby="drawerTitle">
      <div class="drawer-head">
        <h2 id="drawerTitle">Tu carrito</h2>
        <button class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button>
      </div>
      <div id="drawerBody" class="drawer-body"></div>
      <div id="drawerFoot" class="drawer-foot"></div>
    </aside>

    <div id="toast" class="toast" role="status" hidden></div>`
  );
}

function renderShopInfo() {
  // Primera palabra del nombre resaltada, como en el logo ("TODO herramientas")
  const [first, ...rest] = String(shop.store_name).split(' ');
  for (const id of ['#storeName', '#footerName']) $(id).innerHTML = `<b>${esc(first)}</b> ${esc(rest.join(' '))}`;
  $('#footerName2').textContent = shop.store_name;
  renderMarquee(shop.announcements || []);
  $('#footerText').textContent = shop.footer_text || '';
  const wa = waUrl('Hola! Tengo una consulta.');
  $('#waFloat').href = wa;
  $('#footerWa').href = wa;
  $('#footerWa').textContent = `+${String(shop.whatsapp || '').replace(/\D/g, '')}`;
  $('#footerAddressRow').hidden = !shop.address;
  $('#footerAddress').textContent = shop.address || '';
  $('#footerHours').textContent = String(shop.hours || '').split(',').map((h) => h.trim()).join(' y ') + ' hs';
  $('#footerClosedRow').hidden = !shop.closed_days?.length;
  $('#footerClosed').textContent = shop.closed_days?.length ? `Cerrado: ${shop.closed_days.join(', ')}` : '';
  $('#year').textContent = new Date().getFullYear();
}

/* ---------------- cartel superior en movimiento ---------------- */

const MARQUEE_SPEED = 45; // píxeles por segundo (lento, para que se lea cómodo)
let marqueeKey = '';

function renderMarquee(messages) {
  const box = $('#announce');
  box.hidden = !messages.length;
  const key = messages.join('\n');
  if (!messages.length || key === marqueeKey) return; // no reiniciar la animación si no cambió
  marqueeKey = key;

  const one = messages.map((m) => `<span class="marquee-msg">${esc(m)}</span><span class="marquee-sep" aria-hidden="true">•</span>`).join('');
  box.innerHTML = `<p class="sr-only">${esc(messages.join('. '))}</p>
    <div class="marquee" aria-hidden="true"><div class="marquee-track"><div class="marquee-group">${one}</div></div></div>`;

  // Repetir los mensajes hasta cubrir el ancho de la pantalla, y duplicar el grupo
  // para que la vuelta sea continua (la animación mueve el carril la mitad de su ancho).
  const track = box.querySelector('.marquee-track');
  const group = track.firstElementChild;
  const base = group.innerHTML;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; // queda quieto, sin repetir
  while (group.scrollWidth < box.clientWidth && group.childElementCount < 200) group.insertAdjacentHTML('beforeend', base);
  track.appendChild(group.cloneNode(true));
  track.style.setProperty('--marquee-duration', `${Math.max(12, group.scrollWidth / MARQUEE_SPEED)}s`);

  // En el celular, se detiene mientras se mantiene apretado
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    box.addEventListener('touchstart', () => box.classList.add('paused'), { passive: true });
    box.addEventListener('touchend', () => box.classList.remove('paused'));
    box.addEventListener('touchcancel', () => box.classList.remove('paused'));
  }
}

function categories() {
  return ['Todas', ...[...new Set(products.map((p) => p.category).filter(Boolean))].sort()];
}

const catHref = (c) => (c === 'Todas' ? '/' : `/?cat=${encodeURIComponent(c)}`);

// active: categoría marcada (o null para no marcar ninguna)
function renderNav(active = null) {
  const cats = categories();
  $('#catnav').innerHTML = cats
    .map((c) => `<a href="${catHref(c)}" data-cat="${esc(c)}" class="${c === active ? 'active' : ''}">${c === 'Todas' ? 'Inicio' : esc(c)}</a>`)
    .join('');
  $('#menuList').innerHTML = cats
    .map((c) => `<li><a href="${catHref(c)}" data-cat="${esc(c)}" class="${c === active ? 'active' : ''}">${c === 'Todas' ? 'Todos los productos' : esc(c)}<span>›</span></a></li>`)
    .join('');
}

/* ---------------- tarjeta de producto ---------------- */

function priceRow(p) {
  const sale = p.compare_price > p.price;
  return `<div class="price-row">${sale ? `<del>${money(p.compare_price)}</del>` : ''}<strong class="${sale ? 'sale' : ''}">${money(p.price)}</strong></div>`;
}

function qtyControl(id, qty, max) {
  return `<div class="qty">
    <button type="button" data-dec="${id}" aria-label="Quitar uno">−</button>
    <span>${qty}</span>
    <button type="button" data-inc="${id}" ${qty >= max ? 'disabled' : ''} aria-label="Agregar uno">+</button>
  </div>`;
}

function card(p) {
  const inCart = cart[p.id] || 0;
  const out = p.stock <= 0;
  const off = discount(p);
  const [img1, img2] = photosOf(p);
  const action = out
    ? '<button class="btn-add" disabled>Sin stock</button>'
    : inCart
      ? `<div class="in-cart">${qtyControl(p.id, inCart, p.stock)}</div>`
      : `<button class="btn-add" data-add="${p.id}">Añadir al carrito</button>`;
  return `<article class="pcard">
    <a class="pcard-media" href="${productUrl(p)}" aria-label="Ver ${esc(p.name)}">
      <span class="pcard-badges">
        ${off ? `<span class="tag sale">${off}%</span>` : ''}
        ${out ? '<span class="tag out">Sin stock</span>' : ''}
      </span>
      ${img1 ? `<img src="${esc(img1)}" alt="${esc(p.name)}" loading="lazy">` : '<span class="noimg">Sin foto</span>'}
      ${img2 ? `<img class="alt" src="${esc(img2)}" alt="" loading="lazy">` : ''}
    </a>
    ${p.category ? `<div class="pcard-cat">${esc(p.category)}</div>` : ''}
    <h3 class="pcard-title"><a href="${productUrl(p)}">${esc(p.name)}</a></h3>
    ${priceRow(p)}
    ${action}
  </article>`;
}

/* ---------------- carrito ---------------- */

function cartLines() {
  return Object.entries(cart)
    .map(([id, qty]) => {
      const p = products.find((x) => x.id === Number(id));
      return p ? { p, qty: Math.min(qty, p.stock) } : null;
    })
    .filter((l) => l && l.qty > 0);
}

const cartTotal = () => cartLines().reduce((sum, l) => sum + l.p.price * l.qty, 0);

function saveCart() {
  store.write('cart', cart);
  $('#cartCount').textContent = Object.values(cart).reduce((a, b) => a + b, 0);
  $('#cartSum').textContent = money(cartTotal());
}

function syncCartWithStock() {
  for (const id of Object.keys(cart)) {
    const p = products.find((x) => x.id === Number(id));
    if (!p || p.stock <= 0) delete cart[id];
    else if (cart[id] > p.stock) cart[id] = p.stock;
  }
  saveCart();
}

function cartChanged() {
  saveCart();
  if (view === 'cart') renderCart();
  page.onCartChange?.();
}

// Devuelve cuántas unidades se agregaron realmente (puede ser menos por el stock)
function addToCart(id, amount = 1) {
  const p = products.find((x) => x.id === id);
  if (!p || p.stock <= 0) return 0;
  const before = cart[id] || 0;
  cart[id] = Math.min(before + amount, p.stock);
  const added = cart[id] - before;
  if (!added) toast(`No hay más stock de "${p.name}"`, true);
  cartChanged();
  return added;
}

/* ---------------- paneles laterales ---------------- */

function showOverlay(on) {
  $('#overlay').hidden = !on;
  document.body.style.overflow = on ? 'hidden' : '';
}

function openDrawer(v) {
  closeMenu();
  view = v;
  showOverlay(true);
  $('#drawer').classList.add('open');
  if (v === 'cart') renderCart();
  else if (v === 'checkout') renderCheckout();
}

function closeDrawer() {
  view = null;
  $('#drawer').classList.remove('open');
  showOverlay(false);
}

function openMenu() {
  $('#menuDrawer').classList.add('open');
  showOverlay(true);
}

function closeMenu() {
  $('#menuDrawer').classList.remove('open');
  if (!view) showOverlay(false);
}

function renderCart() {
  const body = $('#drawerBody');
  const foot = $('#drawerFoot');
  $('#drawerTitle').textContent = 'Tu carrito';
  const lines = cartLines();
  if (!lines.length) {
    body.innerHTML = '<p class="empty">Tu carrito está vacío.</p>';
    foot.innerHTML = '<button class="btn block" data-close>Ver productos</button>';
    return;
  }
  body.innerHTML = lines
    .map(({ p, qty }) => {
      const img = photosOf(p)[0];
      return `<div class="line">
        <a href="${productUrl(p)}">${img ? `<img src="${esc(img)}" alt="">` : '<span class="line-noimg"></span>'}</a>
        <div class="line-info">
          <a class="line-name" href="${productUrl(p)}">${esc(p.name)}</a>
          <div class="muted">${money(p.price)} c/u</div>
          ${qtyControl(p.id, qty, p.stock)}
        </div>
        <div class="line-right">
          <strong>${money(p.price * qty)}</strong>
          <button class="link danger" data-remove="${p.id}">Quitar</button>
        </div>
      </div>`;
    })
    .join('');
  foot.innerHTML = `
    <div class="total"><span>Total</span><strong>${money(cartTotal())}</strong></div>
    <button id="toCheckout" class="btn primary block">Elegir horario y confirmar</button>`;
}

function renderCheckout() {
  const body = $('#drawerBody');
  const foot = $('#drawerFoot');
  $('#drawerTitle').textContent = 'Datos del pedido';
  if (!cartLines().length) return openDrawer('cart');

  if (!shop.days.length) {
    body.innerHTML = '<p class="empty">Por ahora no hay horarios disponibles para tomar pedidos. Probá más tarde.</p>';
    foot.innerHTML = '<button class="link" id="backToCart">← Volver al carrito</button>';
    return;
  }

  const saved = store.read('customer', {});
  const options = [];
  if (shop.delivery_enabled) options.push(['envio', 'Envío a domicilio']);
  if (shop.pickup_enabled) options.push(['retiro', 'Retiro en el local']);
  const chosen = options.some(([v]) => v === saved.delivery_type) ? saved.delivery_type : options[0]?.[0];

  body.innerHTML = `<form id="checkoutForm" class="form" novalidate>
    <label>Nombre y apellido
      <input name="customer_name" required autocomplete="name" value="${esc(saved.customer_name)}">
    </label>
    <label>Teléfono
      <input name="phone" type="tel" required autocomplete="tel" value="${esc(saved.phone)}">
    </label>
    <fieldset class="seg">
      ${options.map(([v, l]) => `<label><input type="radio" name="delivery_type" value="${v}" ${v === chosen ? 'checked' : ''}> ${l}</label>`).join('')}
    </fieldset>
    <div id="envioFields" class="form-group">
      <div class="label">Ciudad
        <div class="combo">
          <input id="cityInput" type="text" autocomplete="off" spellcheck="false" placeholder="Escribí tu ciudad…"
            role="combobox" aria-expanded="false" aria-controls="cityList" aria-autocomplete="list">
          <ul id="cityList" class="combo-list" role="listbox" hidden></ul>
        </div>
        <span class="hint" id="cityHint"></span>
      </div>
      <input type="hidden" name="city_id">
      <label id="cityOtherWrap" hidden>Nombre de tu ciudad
        <input name="city_name" maxlength="80" autocomplete="address-level2" value="${esc(saved.city_name)}">
      </label>
      <label>Dirección de entrega
        <input name="address" autocomplete="street-address" value="${esc(saved.address)}" placeholder="Calle, número, barrio">
      </label>
    </div>
    <label>Día
      <select name="slot_date">
        ${shop.days.map((d) => `<option value="${d.date}">${esc(d.label)}</option>`).join('')}
      </select>
    </label>
    <div class="label">Horario
      <div id="slots" class="slots"><span class="muted">Cargando…</span></div>
    </div>
    <label class="check invoice-check"><input type="checkbox" name="invoice" ${saved.invoice ? 'checked' : ''}> Necesito factura</label>
    <label id="rucWrap" hidden>Ruc/CI:
      <input name="ruc" maxlength="15" inputmode="text" placeholder="Ej: 1234567 o 80012345-6" value="${esc(saved.ruc)}">
    </label>
    <label>Aclaraciones <span class="hint">(opcional)</span>
      <textarea name="notes" rows="2" maxlength="500" placeholder="Ej: forma de pago, referencias de la dirección…"></textarea>
    </label>
  </form>`;

  foot.innerHTML = `
    <div class="sum-row"><span>Productos</span><span id="sumSub"></span></div>
    <div class="sum-row" id="sumDelRow"><span id="sumDelLabel">Delivery</span><span id="sumDel"></span></div>
    <div class="total"><span>Total</span><strong id="sumTotal"></strong></div>
    <button type="submit" form="checkoutForm" id="submitBtn" class="btn whatsapp block">Enviar pedido por WhatsApp</button>
    <button class="link" id="backToCart">← Volver al carrito</button>`;

  const form = $('#checkoutForm');
  const toggleFields = () => {
    $('#envioFields').hidden = form.delivery_type.value !== 'envio';
    $('#rucWrap').hidden = !form.invoice.checked;
    updateTotals();
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'delivery_type' || e.target.name === 'invoice') toggleFields();
    if (e.target.name === 'invoice' && e.target.checked) form.ruc.focus();
    if (e.target.name === 'slot_date') loadSlots(e.target.value);
  });
  form.addEventListener('submit', submitOrder);
  setupCityCombo(saved.city_id);
  toggleFields();
  loadSlots(form.slot_date.value);
}

/* ---------------- ciudad y costo del delivery ---------------- */

let selectedCity = null; // { id, name, price } — id 'otros' si la escribe el cliente

function cityOptions() {
  return [
    ...(shop.delivery_cities || []).map((c) => ({ id: String(c.id), name: c.name, price: c.price })),
    { id: 'otros', name: 'Otros', price: shop.delivery_other_price || 0, other: true },
  ];
}

const feeText = (price) => (price ? money(price) : 'Sin costo');

function deliveryFee() {
  const form = $('#checkoutForm');
  return form?.delivery_type.value === 'envio' && selectedCity ? selectedCity.price : 0;
}

function updateTotals() {
  const form = $('#checkoutForm');
  if (!form || !$('#sumTotal')) return;
  const sub = cartTotal();
  const envio = form.delivery_type.value === 'envio';
  $('#sumSub').textContent = money(sub);
  $('#sumDelRow').hidden = !envio;
  $('#sumDelLabel').textContent = selectedCity && !selectedCity.other ? `Delivery a ${selectedCity.name}` : 'Delivery';
  $('#sumDel').textContent = selectedCity ? feeText(selectedCity.price) : 'Elegí tu ciudad';
  $('#sumTotal').textContent = money(sub + deliveryFee());
}

function selectCity(opt, focusOther = true) {
  const form = $('#checkoutForm');
  selectedCity = opt;
  form.city_id.value = opt ? opt.id : '';
  $('#cityInput').value = opt ? opt.name : '';
  $('#cityOtherWrap').hidden = !opt?.other;
  $('#cityHint').textContent = opt ? `Costo del delivery: ${feeText(opt.price)}` : '';
  if (opt?.other && focusOther) form.city_name.focus();
  updateTotals();
}

function setupCityCombo(savedId) {
  const input = $('#cityInput');
  const list = $('#cityList');
  let active = -1;
  let shown = [];

  selectedCity = null;
  const saved = cityOptions().find((o) => o.id === String(savedId || ''));
  if (saved) selectCity(saved, false);

  const render = () => {
    const q = norm(input.value.trim());
    const all = cityOptions();
    const isSelectedText = selectedCity && input.value === selectedCity.name;
    shown = all.filter((o) => o.other || !q || isSelectedText || norm(o.name).includes(q));
    const cities = shown.filter((o) => !o.other);
    active = Math.min(active, shown.length - 1);
    list.innerHTML =
      (q && !isSelectedText && !cities.length ? '<li class="combo-empty">No encontramos esa ciudad: elegí "Otros" y escribila.</li>' : '') +
      shown
        .map(
          (o, i) => `<li role="option" id="city-opt-${i}" data-i="${i}" class="${i === active ? 'active' : ''} ${o.other ? 'other' : ''}" aria-selected="${selectedCity?.id === o.id}">
            <span>${o.other ? 'Otros <small>(escribí tu ciudad)</small>' : esc(o.name)}</span><span class="combo-price">${feeText(o.price)}</span>
          </li>`
        )
        .join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `city-opt-${active}` : '');
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  input.addEventListener('focus', () => {
    input.select();
    render();
  });
  input.addEventListener('input', () => {
    if (selectedCity && input.value !== selectedCity.name) {
      selectedCity = null;
      $('#checkoutForm').city_id.value = '';
      $('#cityOtherWrap').hidden = true;
      $('#cityHint').textContent = '';
      updateTotals();
    }
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return render();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (e.key === 'Enter' && !list.hidden && shown[active]) {
      e.preventDefault();
      selectCity(shown[active]);
      close();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  // mousedown (antes del blur) para que el clic en la lista no se pierda
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-i]');
    if (!li) return;
    e.preventDefault();
    selectCity(shown[Number(li.dataset.i)]);
    close();
  });
  input.addEventListener('blur', () => {
    // Si escribió exactamente el nombre de una ciudad, se toma aunque no la haya tocado en la lista
    if (!selectedCity && input.value.trim()) {
      const exact = cityOptions().find((o) => !o.other && norm(o.name) === norm(input.value.trim()));
      if (exact) selectCity(exact);
    }
    close();
  });
}

async function loadSlots(date) {
  const box = $('#slots');
  box.innerHTML = '<span class="muted">Cargando…</span>';
  try {
    const slots = await api(`/api/slots?date=${encodeURIComponent(date)}`);
    box.innerHTML = slots.length
      ? slots
          .map(
            (s) => `<label class="slot ${s.available ? '' : 'full'}" title="${s.available ? '' : 'Completo'}">
              <input type="radio" name="slot_time" value="${s.time}" ${s.available ? '' : 'disabled'}>
              <span>${s.time}</span>
            </label>`
          )
          .join('')
      : '<span class="muted">No hay horarios para este día.</span>';
  } catch (err) {
    box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

async function submitOrder(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));

  if (!data.customer_name?.trim()) return toast('Completá tu nombre.', true);
  if (!data.phone?.trim()) return toast('Completá tu teléfono.', true);
  if (data.delivery_type === 'envio') {
    if (!data.city_id) {
      $('#cityInput').focus();
      return toast('Elegí tu ciudad de la lista. Si no está, elegí "Otros".', true);
    }
    if (data.city_id === 'otros' && !data.city_name?.trim()) return toast('Escribí el nombre de tu ciudad.', true);
    if (!data.address?.trim()) return toast('Indicá la dirección de entrega.', true);
  }
  if (!data.slot_time) return toast('Elegí un horario.', true);
  data.invoice = !!data.invoice;
  if (data.invoice && !data.ruc?.trim()) {
    form.ruc.focus();
    return toast('Escribí tu Ruc/CI para la factura.', true);
  }

  const btn = $('#submitBtn');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ ...data, items: cartLines().map((l) => ({ product_id: l.p.id, quantity: l.qty })) }),
    });
    store.write('customer', {
      customer_name: data.customer_name,
      phone: data.phone,
      address: data.address,
      delivery_type: data.delivery_type,
      city_id: data.city_id,
      city_name: data.city_name,
      invoice: data.invoice,
      ruc: data.ruc,
    });
    cart = {};
    saveCart();
    renderSuccess(res);
    const win = window.open(res.whatsapp_url, '_blank');
    if (!win) window.location.href = res.whatsapp_url;
    loadData();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = 'Enviar pedido por WhatsApp';
    await loadData(); // refresca stock y horarios
    if (view === 'checkout') loadSlots(form.slot_date.value);
  }
}

function renderSuccess(res) {
  view = 'success';
  $('#drawerTitle').textContent = '¡Pedido registrado!';
  $('#drawerBody').innerHTML = `<div class="success">
    <div class="check-icon">✓</div>
    <h3>Pedido #${res.id}</h3>
    <p class="muted">Se abrió WhatsApp con el detalle de tu pedido.<br><strong>Tocá "Enviar" en WhatsApp</strong> para que lo recibamos.</p>
    <a class="btn whatsapp block" href="${esc(res.whatsapp_url)}" target="_blank" rel="noopener">Abrir WhatsApp de nuevo</a>
  </div>`;
  $('#drawerFoot').innerHTML = '<button class="btn block" data-close>Seguir comprando</button>';
}

/* ---------------- eventos comunes ---------------- */

function bindCommonEvents() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a[data-cat], #overlay');
    if (!t) return;
    const d = t.dataset;

    if (d.cat !== undefined && page.onCategory) {
      e.preventDefault(); // en la página principal se filtra sin recargar
      closeMenu();
      page.onCategory(d.cat);
    } else if (d.add) {
      const p = products.find((x) => x.id === Number(d.add));
      if (p && addToCart(p.id)) toast(`"${p.name}" agregado al carrito`);
    } else if (d.inc) {
      addToCart(Number(d.inc));
    } else if (d.dec) {
      const id = Number(d.dec);
      cart[id] = (cart[id] || 0) - 1;
      if (cart[id] <= 0) delete cart[id];
      cartChanged();
    } else if (d.remove) {
      delete cart[d.remove];
      cartChanged();
    } else if (t.id === 'cartBtn') {
      openDrawer('cart');
    } else if (t.id === 'menuBtn') {
      openMenu();
    } else if (t.id === 'toCheckout') {
      openDrawer('checkout');
    } else if (t.id === 'backToCart') {
      openDrawer('cart');
    } else if ('close' in d || t.id === 'overlay') {
      closeDrawer();
      closeMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      closeMenu();
    }
  });

  // Buscar: la página principal filtra en el momento; las demás van a la principal con ?q=
  $('#searchForm').addEventListener('submit', (e) => {
    const q = $('#searchInput').value.trim();
    if (page.onSearch) {
      e.preventDefault();
      page.onSearch(q, true);
    } else if (!q) {
      e.preventDefault();
    }
  });
  let searchTimer;
  $('#searchInput').addEventListener('input', () => {
    if (!page.onSearch) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => page.onSearch($('#searchInput').value.trim(), false), 250);
  });
}

/* ---------------- carga de datos ---------------- */

async function loadData() {
  try {
    [products, shop] = await Promise.all([api('/api/products'), api('/api/store')]);
    renderShopInfo();
    syncCartWithStock();
    if (view === 'cart') renderCart();
    page.onData?.();
  } catch (err) {
    page.onError?.(err);
  }
}

function startShop() {
  renderLayout();
  bindCommonEvents();
  saveCart();
  loadData();
}
