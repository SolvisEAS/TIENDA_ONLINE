// Página de detalle de un producto: /producto/5
const productId = Number(location.pathname.split('/').filter(Boolean).pop());
let qty = 1;
let photoIndex = 0;
let rendered = false;

const current = () => products.find((p) => p.id === productId);

function renderNotFound() {
  document.title = `Producto no disponible · ${shop.store_name}`;
  $('#productPage').innerHTML = `<div class="not-found">
    <h1>Este producto no está disponible</h1>
    <p class="muted">Puede que se haya dejado de vender o que el enlace esté mal.</p>
    <a class="btn primary" href="/">Ver todos los productos</a>
  </div>`;
}

function renderProduct() {
  const p = current();
  if (!p) return renderNotFound();
  const photos = photosOf(p);
  photoIndex = Math.min(photoIndex, Math.max(0, photos.length - 1));
  document.title = `${p.name} · ${shop.store_name}`;
  renderNav(p.category || null);

  $('#productPage').innerHTML = `
    <nav class="breadcrumb" aria-label="Ubicación">
      <a href="/">Inicio</a><span>›</span>
      ${p.category ? `<a href="/?cat=${encodeURIComponent(p.category)}">${esc(p.category)}</a><span>›</span>` : ''}
      <span aria-current="page">${esc(p.name)}</span>
    </nav>

    <div class="product-layout">
      <section class="gallery" aria-label="Fotos del producto">
        <div class="gallery-main">
          ${
            photos.length
              ? `<div id="track" class="gallery-track">
                  ${photos.map((src, i) => `<button class="gallery-slide" data-zoom="${i}" aria-label="Ampliar foto ${i + 1}"><img src="${esc(src)}" alt="${esc(p.name)} - foto ${i + 1}" ${i ? 'loading="lazy"' : ''}></button>`).join('')}
                </div>
                ${photos.length > 1 ? `
                  <button class="g-arrow prev" data-photo-step="-1" aria-label="Foto anterior">${icon('left')}</button>
                  <button class="g-arrow next" data-photo-step="1" aria-label="Foto siguiente">${icon('right')}</button>
                  <span id="photoCount" class="g-count">1 / ${photos.length}</span>` : ''}
                <span class="g-zoom" aria-hidden="true">${icon('zoom')}</span>
                ${discount(p) ? `<span class="tag sale g-tag">${discount(p)}% OFF</span>` : ''}`
              : '<div class="gallery-empty">Sin foto</div>'
          }
        </div>
        ${
          photos.length > 1
            ? `<div class="thumbs">${photos.map((src, i) => `<button class="thumb ${i === photoIndex ? 'active' : ''}" data-thumb="${i}" aria-label="Ver foto ${i + 1}"><img src="${esc(src)}" alt=""></button>`).join('')}</div>`
            : ''
        }
      </section>

      <section class="buybox">
        ${p.category ? `<a class="pcard-cat" href="/?cat=${encodeURIComponent(p.category)}">${esc(p.category)}</a>` : ''}
        <h1>${esc(p.name)}</h1>
        <div id="priceBox"></div>
        <div id="buyBox"></div>
        <a class="consult" href="${esc(waUrl(`Hola! Quería consultar por: ${p.name}\n${location.origin}${productUrl(p)}`))}" target="_blank" rel="noopener">${icon('whatsapp')} Consultar por WhatsApp</a>
        <ul class="buy-perks">
          <li>${icon('cart')}<span><strong>Pedido online</strong> sumá productos al carrito y confirmá cuando quieras.</span></li>
          <li>${icon('clock')}<span><strong>Elegí día y horario</strong> para ${[shop.pickup_enabled && 'retirar', shop.delivery_enabled && 'recibir'].filter(Boolean).join(' o ')} tu pedido.</span></li>
          <li>${icon('chat')}<span><strong>Confirmación por WhatsApp</strong> con el detalle de tu compra.</span></li>
        </ul>
        <button class="share-btn" id="shareBtn">${icon('share')} Compartir producto</button>
      </section>
    </div>

    ${p.description ? `<section class="section description"><div class="section-head"><h2>Descripción</h2></div><div class="desc-text">${esc(p.description)}</div></section>` : ''}
  `;

  renderBuyBox();
  renderRelated();
  bindGallery();
  if (photoIndex) goPhoto(photoIndex, false);
}

// Parte que cambia con el stock y el carrito (se vuelve a dibujar sin tocar la galería)
function renderBuyBox() {
  const p = current();
  if (!p) return;
  const sale = p.compare_price > p.price;
  $('#priceBox').innerHTML = `
    <div class="price-row big">${sale ? `<del>${money(p.compare_price)}</del>` : ''}<strong class="${sale ? 'sale' : ''}">${money(p.price)}</strong></div>
    ${sale ? `<div class="saving">Ahorrás ${money(p.compare_price - p.price)}</div>` : ''}`;

  const inCart = cart[p.id] || 0;
  const left = p.stock - inCart;
  qty = Math.max(1, Math.min(qty, left));
  let html =
    p.stock > 0
      ? `<div class="stock-ok">✓ Disponible${p.stock <= 10 ? ` · quedan ${p.stock}` : ''}</div>`
      : '<div class="stock-out">Sin stock por el momento</div>';
  if (inCart) html += `<div class="in-cart-note">Ya tenés <strong>${inCart}</strong> en el carrito · <button class="link" id="viewCart">Ver carrito</button></div>`;
  if (left > 0) {
    html += `<div class="buy-row">
        <div class="qty">
          <button type="button" data-qty="-1" aria-label="Menos" ${qty <= 1 ? 'disabled' : ''}>−</button>
          <span>${qty}</span>
          <button type="button" data-qty="1" aria-label="Más" ${qty >= left ? 'disabled' : ''}>+</button>
        </div>
        <button class="btn-add" id="addBtn">Añadir al carrito</button>
      </div>
      <button class="btn-buy" id="buyNow">Comprar ahora</button>`;
  } else if (p.stock > 0) {
    html += '<div class="muted">Ya agregaste todo el stock disponible.</div>';
  }
  $('#buyBox').innerHTML = html;
}

// Relacionados calculados por el servidor (nombre, marca, voltaje y comprados juntos).
// Si no hay suficientes, se completa con la misma categoría y el resto del catálogo.
let relatedIds = null;

async function loadRelated() {
  try {
    relatedIds = await api(`/api/products/${productId}/related`);
  } catch {
    relatedIds = [];
  }
  renderRelated();
}

function renderRelated() {
  const p = current();
  if (!p) return;
  const smart = (relatedIds || []).map((id) => products.find((x) => x.id === id)).filter(Boolean);
  const same = products.filter((x) => x.id !== p.id && p.category && x.category === p.category && !smart.includes(x));
  const others = products.filter((x) => x.id !== p.id && !smart.includes(x) && !same.includes(x));
  const list = [...smart, ...same, ...others].slice(0, 8);
  $('#relatedSection').hidden = !list.length;
  $('#relatedRail').innerHTML = list.map(card).join('');
  $('#relatedMore').href = p.category ? `/?cat=${encodeURIComponent(p.category)}` : '/';
}

/* ---------------- galería ---------------- */

function goPhoto(i, smooth = true) {
  const track = $('#track');
  if (!track) return;
  const n = track.children.length;
  photoIndex = (i + n) % n;
  track.scrollTo({ left: photoIndex * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  markPhoto();
}

function markPhoto() {
  document.querySelectorAll('.thumb').forEach((t, k) => t.classList.toggle('active', k === photoIndex));
  const count = $('#photoCount');
  if (count) count.textContent = `${photoIndex + 1} / ${$('#track').children.length}`;
  document.querySelector('.thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function bindGallery() {
  const track = $('#track');
  if (!track) return;
  // Al deslizar con el dedo, actualizar la miniatura marcada
  let t;
  track.addEventListener('scroll', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      if (i !== photoIndex) {
        photoIndex = i;
        markPhoto();
      }
    }, 60);
  });
}

/* ---------------- foto ampliada ---------------- */

const lightbox = $('#lightbox');

function openLightbox(i) {
  photoIndex = i;
  showLightboxPhoto();
  lightbox.showModal();
}

function showLightboxPhoto() {
  const photos = photosOf(current());
  photoIndex = (photoIndex + photos.length) % photos.length;
  $('#lbImg').src = photos[photoIndex];
  $('#lbCount').textContent = photos.length > 1 ? `${photoIndex + 1} / ${photos.length}` : '';
  lightbox.querySelectorAll('.lb-arrow').forEach((b) => (b.hidden = photos.length < 2));
}

lightbox.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.lb) {
    photoIndex += Number(b.dataset.lb);
    showLightboxPhoto();
  } else if (b?.hasAttribute('data-lb-close') || e.target === lightbox) {
    lightbox.close();
  }
});
lightbox.addEventListener('close', () => goPhoto(photoIndex, false));
lightbox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { photoIndex--; showLightboxPhoto(); }
  if (e.key === 'ArrowRight') { photoIndex++; showLightboxPhoto(); }
});

/* ---------------- eventos de la página ---------------- */

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || !$('#productPage').contains(b)) return;
  const p = current();

  if (b.dataset.thumb) goPhoto(Number(b.dataset.thumb));
  else if (b.dataset.photoStep) goPhoto(photoIndex + Number(b.dataset.photoStep));
  else if (b.dataset.zoom) openLightbox(Number(b.dataset.zoom));
  else if (b.dataset.qty) {
    qty += Number(b.dataset.qty);
    renderBuyBox();
  } else if (b.id === 'addBtn' || b.id === 'buyNow') {
    const added = addToCart(p.id, qty);
    if (added) {
      qty = 1;
      renderBuyBox();
      if (b.id === 'buyNow') openDrawer('cart');
      else toast(`${added > 1 ? `${added} unidades de ` : ''}"${p.name}" agregado al carrito`);
    }
  } else if (b.id === 'viewCart') {
    openDrawer('cart');
  } else if (b.id === 'shareBtn') {
    const url = location.origin + productUrl(p);
    try {
      if (navigator.share) await navigator.share({ title: p.name, text: `${p.name} - ${money(p.price)}`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Enlace copiado');
      }
    } catch {
      /* el cliente canceló */
    }
  }
});

page = {
  onData() {
    if (!rendered) {
      rendered = true;
      renderProduct();
      loadRelated();
    } else {
      renderBuyBox();
      renderRelated();
    }
  },
  onError(err) {
    $('#productPage').innerHTML = `<p class="empty">No se pudo cargar el producto: ${esc(err.message)}</p>`;
  },
  onCartChange() {
    renderBuyBox();
    renderRelated();
  },
};

startShop();
