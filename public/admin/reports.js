// Reportes de ventas, pedidos y stock (pestaña "Reportes" del panel).
// Usa las funciones de admin.js: $, api, esc, money, toast, statusLabel, ORDER_STATUSES.

const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dmy = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '');
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

let report = null;

function setRange(kind) {
  const t = new Date();
  let from = t;
  let to = t;
  if (kind === '7d') from = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6);
  if (kind === 'month') from = new Date(t.getFullYear(), t.getMonth(), 1);
  if (kind === 'prev') {
    from = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    to = new Date(t.getFullYear(), t.getMonth(), 0);
  }
  if (kind === 'year') from = new Date(t.getFullYear(), 0, 1);
  $('#rFrom').value = isoDay(from);
  $('#rTo').value = isoDay(to);
  document.querySelectorAll('#rangeChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.range === kind));
}

async function loadReport() {
  if (!$('#rFrom').value) setRange('month');
  const qs = `from=${$('#rFrom').value}&to=${$('#rTo').value}`;
  $('#excelBtn').href = `/api/admin/reports/excel?${qs}`;
  try {
    report = await api(`/api/admin/reports?${qs}`);
    renderReport();
  } catch (err) {
    // Mostrar el problema en la pantalla, no sólo en un aviso que desaparece
    report = null;
    const hint =
      err.message === 'No encontrado.'
        ? 'El servidor que está funcionando es una versión anterior. Detené la tienda y volvé a iniciarla para usar los reportes.'
        : err.message;
    $('#kpis').innerHTML = `<div class="report-error"><strong>No se pudo cargar el reporte.</strong> ${esc(hint)}</div>`;
    for (const id of ['#salesChart', '#statusList', '#categoryBars', '#topProducts', '#reportOrders', '#reportStock']) $(id).innerHTML = '';
  }
}

$('#rangeChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  setRange(b.dataset.range);
  loadReport();
});
for (const id of ['#rFrom', '#rTo']) {
  $(id).addEventListener('change', () => {
    document.querySelectorAll('#rangeChips .chip').forEach((c) => c.classList.remove('active'));
    if ($('#rFrom').value && $('#rTo').value) loadReport();
  });
}
$('#rStatus').addEventListener('change', () => renderReportOrders());
$('#rSearch').addEventListener('input', () => renderReportOrders());
$('#rStock').addEventListener('change', () => renderReportStock());

/* ---------------- dibujo ---------------- */

function renderReport() {
  const r = report;
  const s = r.summary;
  const pendingCount = r.by_status.pendiente.count;
  $('#kpis').innerHTML = `
    <div class="kpi main"><span>Total vendido</span><strong>${money(s.sales_amount)}</strong><small>${s.delivered_orders} pedido${s.delivered_orders === 1 ? '' : 's'} entregado${s.delivered_orders === 1 ? '' : 's'}${s.delivery_amount ? ` · incluye ${money(s.delivery_amount)} de delivery` : ''}</small></div>
    <div class="kpi"><span>Ticket promedio</span><strong>${money(Math.round(s.avg_ticket))}</strong><small>por pedido entregado</small></div>
    <div class="kpi"><span>Unidades vendidas</span><strong>${s.units_sold.toLocaleString('es-AR')}</strong><small>en pedidos entregados</small></div>
    <div class="kpi"><span>Pendiente de entrega</span><strong>${money(s.pending_delivery_amount)}</strong><small>${r.by_status.confirmado.count} confirmado${r.by_status.confirmado.count === 1 ? '' : 's'}${pendingCount ? ` · ${pendingCount} sin confirmar` : ''}</small></div>`;

  renderChart();

  const maxStatus = Math.max(1, ...ORDER_STATUSES.map((st) => r.by_status[st].count));
  $('#statusList').innerHTML = ORDER_STATUSES.map((st) => {
    const v = r.by_status[st];
    return `<div class="srow">
      <span class="dot ${st}"></span><span class="slabel">${statusLabel(st)}</span>
      <span class="sbar"><span class="${st}" style="width:${(v.count / maxStatus) * 100}%"></span></span>
      <strong>${v.count}</strong><span class="muted samount">${money(v.amount || 0)}</span>
    </div>`;
  }).join('');

  const maxCat = Math.max(1, ...r.categories.map((c) => c.amount));
  $('#categoryBars').innerHTML = r.categories.length
    ? r.categories
        .map(
          (c) => `<div class="hbar"><div class="hbar-top"><span>${esc(c.category)}</span><strong>${money(c.amount)}</strong></div>
            <div class="hbar-track"><span style="width:${(c.amount / maxCat) * 100}%"></span></div>
            <small class="muted">${c.units} unidad${c.units === 1 ? '' : 'es'}</small></div>`
        )
        .join('')
    : '<p class="muted">Todavía no hay ventas entregadas en este período.</p>';

  $('#topProducts').innerHTML = r.top_products.length
    ? `<table class="rtable"><thead><tr><th>#</th><th>Producto</th><th>Categoría</th><th class="num">Unidades</th><th class="num">Monto</th></tr></thead><tbody>
        ${r.top_products
          .slice(0, 10)
          .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.product_name)}</td><td>${esc(p.category || '—')}</td><td class="num">${p.units}</td><td class="num">${money(p.amount)}</td></tr>`)
          .join('')}
      </tbody></table>`
    : '<p class="muted">Todavía no hay ventas entregadas en este período.</p>';

  renderReportOrders();
  renderReportStock();
}

function renderChart() {
  const r = report;
  $('#chartTitle').textContent = r.monthly ? 'Ventas por mes' : 'Ventas por día';
  const data = r.series;
  const max = Math.max(...data.map((d) => d.amount));
  if (!max) {
    $('#salesChart').innerHTML = '<p class="muted chart-empty">No hay ventas entregadas en este período.</p>';
    return;
  }
  // Escala "redonda" para las líneas guía
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  const label = (k) => {
    if (r.monthly) {
      const [y, m] = k.split('-');
      return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
    }
    const [, m, d] = k.split('-');
    return `${d}/${m}`;
  };
  const every = Math.ceil(data.length / 12); // no amontonar las fechas del eje

  $('#salesChart').innerHTML = `
    <div class="chart-plot">
      <div class="chart-grid">${ticks
        .map((v) => `<div class="gline" style="bottom:${(v / top) * 100}%"><span>${shortMoney(v)}</span></div>`)
        .join('')}</div>
      <div class="chart-bars">${data
        .map(
          (d, i) => `<div class="bar-slot" data-i="${i}" tabindex="0" aria-label="${label(d.key)}: ${money(d.amount)}">
            <span class="bar" style="height:${(d.amount / top) * 100}%"></span>
            <span class="xlabel">${i % every === 0 ? label(d.key) : ''}</span>
          </div>`
        )
        .join('')}</div>
    </div>
    <div class="chart-tip" id="chartTip" hidden></div>`;

  const tip = $('#chartTip');
  const show = (slot) => {
    const d = data[Number(slot.dataset.i)];
    const key = r.monthly ? label(d.key) : dmy(d.key);
    tip.innerHTML = `<strong>${key}</strong><div>${money(d.amount)}</div><div class="muted">${d.orders} pedido${d.orders === 1 ? '' : 's'}</div>`;
    tip.hidden = false;
    const box = $('#salesChart').getBoundingClientRect();
    const sb = slot.getBoundingClientRect();
    const x = Math.min(Math.max(sb.left - box.left + sb.width / 2, 70), box.width - 70);
    tip.style.left = `${x}px`;
    slot.classList.add('hover');
  };
  const hide = (slot) => {
    tip.hidden = true;
    slot.classList.remove('hover');
  };
  $('#salesChart').querySelectorAll('.bar-slot').forEach((slot) => {
    slot.addEventListener('mouseenter', () => show(slot));
    slot.addEventListener('focus', () => show(slot));
    slot.addEventListener('mouseleave', () => hide(slot));
    slot.addEventListener('blur', () => hide(slot));
  });
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function shortMoney(v) {
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}MM`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(0)}k`;
  return String(v);
}

function renderReportOrders() {
  if (!report) return;
  const st = $('#rStatus').value;
  const q = $('#rSearch').value.trim().toLowerCase();
  const list = report.orders.filter((o) => (!st || o.status === st) && (!q || `${o.customer_name} ${o.phone}`.toLowerCase().includes(q)));
  $('#reportOrders').innerHTML = list.length
    ? `<table class="rtable"><thead><tr><th>N°</th><th>Recibido</th><th>Cliente</th><th>Productos</th><th class="num">Total</th><th>Estado</th></tr></thead><tbody>
        ${list
          .map(
            (o) => `<tr>
              <td>${o.id}</td>
              <td>${dmy(o.created_at)}</td>
              <td>${esc(o.customer_name)}<div class="muted">${esc(o.phone)}</div>${o.city ? `<div class="muted">${esc(o.city)}</div>` : ''}${o.invoice ? `<div class="muted">Factura · Ruc/CI ${esc(o.ruc)}</div>` : ''}</td>
              <td>${o.items.map((i) => `${i.quantity} × ${esc(i.product_name)}`).join('<br>')}</td>
              <td class="num">${money(o.total)}</td>
              <td><span class="spill ${o.status}">${statusLabel(o.status)}</span>${o.delivered_at ? `<div class="muted">el ${dmy(o.delivered_at)}</div>` : ''}${o.reject_reason ? `<div class="muted">${esc(o.reject_reason)}</div>` : ''}</td>
            </tr>`
          )
          .join('')}
      </tbody></table>`
    : '<p class="muted">No hay pedidos con ese filtro.</p>';
}

function renderReportStock() {
  if (!report) return;
  const f = $('#rStock').value;
  const list = report.stock.filter((p) => !f || p.state === f);
  $('#reportStock').innerHTML = list.length
    ? `<table class="rtable"><thead><tr><th>Producto</th><th>Categoría</th><th class="num">Precio</th><th class="num">Stock</th><th class="num">Valor del stock</th><th class="num">Vendidos</th><th>Estado</th></tr></thead><tbody>
        ${list
          .map(
            (p) => `<tr class="${p.active ? '' : 'inactive-row'}">
              <td>${esc(p.name)}${p.active ? '' : ' <span class="muted">(oculto)</span>'}</td>
              <td>${esc(p.category || '—')}</td>
              <td class="num">${money(p.price)}</td>
              <td class="num">${p.stock}</td>
              <td class="num">${money(p.value)}</td>
              <td class="num">${p.sold}</td>
              <td><span class="stock-state ${p.state === 'OK' ? 'ok' : p.state === 'Sin stock' ? 'out' : 'low'}">${p.state}</span></td>
            </tr>`
          )
          .join('')}
      </tbody></table>`
    : '<p class="muted">No hay productos con ese filtro.</p>';
}
