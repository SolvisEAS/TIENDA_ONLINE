// Página principal: banner de destacados, nuevos productos y catálogo con filtros.
const params = new URLSearchParams(location.search);
let category = params.get('cat') || 'Todas';
let query = params.get('q') || '';
let sort = 'new';
let heroReady = false;

function renderFilters() {
  const cats = categories();
  if (!cats.includes(category)) category = 'Todas';
  renderNav(query ? null : category);
  $('#chips').innerHTML =
    cats.length > 2
      ? cats.map((c) => `<button class="chip ${c === category ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')
      : '';
}

function renderGrid() {
  let list = products.filter((p) => category === 'Todas' || p.category === category);
  if (query) {
    const q = norm(query);
    list = list.filter((p) => norm(`${p.name} ${p.category} ${p.description}`).includes(q));
  }
  const by = {
    new: (a, b) => b.id - a.id,
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    name: (a, b) => a.name.localeCompare(b.name, 'es'),
  };
  list.sort(by[sort]);

  $('#catalogTitle').textContent = query ? `Resultados para "${query}"` : category === 'Todas' ? 'Todos los productos' : category;
  const info = $('#resultInfo');
  info.hidden = !query;
  info.innerHTML = query
    ? `${list.length} producto${list.length === 1 ? '' : 's'} encontrado${list.length === 1 ? '' : 's'} · <button class="link" id="clearSearch">Limpiar búsqueda</button>`
    : '';

  $('#grid').innerHTML = list.length
    ? list.map(card).join('')
    : `<p class="empty">${products.length ? 'No encontramos productos con esa búsqueda.' : 'Todavía no hay productos cargados.'}</p>`;
}

function renderNew() {
  const latest = [...products].sort((a, b) => b.id - a.id).slice(0, 8);
  $('#newSection').hidden = latest.length < 2;
  $('#newRail').innerHTML = latest.map(card).join('');
}

// Mantiene la dirección de la página igual a lo que se ve (para poder compartirla o volver atrás)
function syncUrl() {
  const p = new URLSearchParams();
  if (query) p.set('q', query);
  else if (category !== 'Todas') p.set('cat', category);
  history.replaceState(null, '', p.toString() ? `/?${p}` : '/');
}

/* ---------------- banner ---------------- */

let slideIndex = 0;
let slideTimer;

function renderHero() {
  let slides = products.filter((p) => p.featured && photosOf(p).length);
  if (!slides.length) slides = products.filter((p) => photosOf(p).length && p.stock > 0).slice(0, 3);
  const hero = $('#hero');
  clearInterval(slideTimer);

  if (!slides.length) {
    hero.innerHTML = `<div class="hero-track"><div class="slide hero-welcome active"><div>
      <img src="/img/logo.webp" alt="" style="width:120px;height:120px;border-radius:50%;margin:0 auto 14px">
      <h2>${esc(shop.store_name)}</h2>
      <p class="slide-price" style="font-weight:500">Herramientas para tu casa, taller u obra</p></div></div></div>`;
    return;
  }

  slideIndex = Math.min(slideIndex, slides.length - 1);
  hero.innerHTML = `<div class="hero-track">
      ${slides
        .map(
          (p, i) => `<div class="slide ${i === slideIndex ? 'active' : ''}" aria-hidden="${i !== slideIndex}">
          <div>
            <span class="slide-pill">${discount(p) ? `¡${discount(p)}% OFF!` : esc(p.category || 'Destacado')}</span>
            <h2>${esc(p.name)}</h2>
            <div class="slide-price">${p.compare_price > p.price ? `<del>${money(p.compare_price)}</del>` : ''}${money(p.price)}</div>
            <a class="btn" href="${productUrl(p)}">Ver producto</a>
          </div>
          <a class="slide-img" href="${productUrl(p)}" tabindex="-1"><img src="${esc(photosOf(p)[0])}" alt="${esc(p.name)}"></a>
        </div>`
        )
        .join('')}
      ${slides.length > 1 ? `<button class="hero-arrow prev" data-slide="-1" aria-label="Anterior">${icon('left')}</button><button class="hero-arrow next" data-slide="1" aria-label="Siguiente">${icon('right')}</button>` : ''}
    </div>
    ${slides.length > 1 ? `<div class="dots">${slides.map((_, i) => `<button data-dot="${i}" class="${i === slideIndex ? 'active' : ''}" aria-label="Ver destacado ${i + 1}"></button>`).join('')}</div>` : ''}`;

  if (slides.length > 1) slideTimer = setInterval(() => goSlide(slideIndex + 1), 5500);
}

function goSlide(i) {
  const slides = document.querySelectorAll('.slide');
  if (!slides.length) return;
  slideIndex = (i + slides.length) % slides.length;
  slides.forEach((s, k) => {
    s.classList.toggle('active', k === slideIndex);
    s.setAttribute('aria-hidden', k !== slideIndex);
  });
  document.querySelectorAll('[data-dot]').forEach((d, k) => d.classList.toggle('active', k === slideIndex));
}

/* ---------------- funciones de la página ---------------- */

page = {
  onData() {
    renderFilters();
    if (!heroReady) {
      renderHero();
      heroReady = true;
      if (query || category !== 'Todas') $('#catalogo').scrollIntoView();
    }
    renderNew();
    renderGrid();
  },
  onError(err) {
    $('#grid').innerHTML = `<p class="empty">No se pudo cargar la tienda: ${esc(err.message)}</p>`;
  },
  onCartChange() {
    renderGrid();
    renderNew();
  },
  onCategory(cat) {
    category = cat;
    query = '';
    $('#searchInput').value = '';
    renderFilters();
    renderGrid();
    syncUrl();
    $('#catalogo').scrollIntoView({ behavior: 'smooth' });
  },
  onSearch(q, scroll) {
    query = q;
    if (q) category = 'Todas';
    renderFilters();
    renderGrid();
    syncUrl();
    if (scroll) $('#catalogo').scrollIntoView({ behavior: 'smooth' });
  },
};

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.slide) goSlide(slideIndex + Number(t.dataset.slide));
  else if (t.dataset.dot) goSlide(Number(t.dataset.dot));
  else if (t.id === 'clearSearch') page.onSearch('', false);
});

$('#sort').addEventListener('change', (e) => {
  sort = e.target.value;
  renderGrid();
});

startShop();
$('#searchInput').value = query;
