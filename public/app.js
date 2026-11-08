const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

// One money helper: formats cents, and converts dollars to integer cents.
const formatMoney = (cents) => {
  const usd = Number(cents ?? 0) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(usd);
};
const toCents = (dollars) => Math.max(0, Math.round(Number(dollars) * 100));

const ICON_PATHS = {
  plane: `<path d="M14 2 2 7.5l4.5 2L8.5 14 14 2z"/><path d="M6.5 9.5 14 2"/>`,
  calendar: `<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>`,
  alert: `<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.5M8 12h.01"/>`,
  'calendar-check': `<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3M5.8 10.2l1.6 1.6 3-3"/>`,
  'circle-cross': `<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>`,
  'half-circle': `<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>`,
  'circle-check': `<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.8 1.8 3.4-3.6"/>`,
  'clock-check': `<circle cx="7" cy="7" r="5"/><path d="M7 4.2V7l1.8 1M9.5 11.5l1.5 1.5 3-3"/>`,
  clock: `<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2 1.2"/>`,
  circle: `<circle cx="8" cy="8" r="6"/>`,
  dot: `<circle cx="8" cy="8" r="1.5" fill="currentColor"/>`,
  x: `<path d="M3.5 3.5l9 9M3.5 12.5l9-9"/>`,
};
function icon(name) {
  return `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}
function tint(hex, alpha) {
  const c = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
const STATUS_ICONS = {
  issued: { label: 'Sent', icon: 'plane', color: '#5e6f6a' },
  due_today: { label: 'Due today', icon: 'calendar', color: '#c9972f' },
  overdue: { label: 'Overdue', icon: 'alert', color: '#b3322b' },
  promised: { label: 'Promised', icon: 'calendar-check', color: '#2f7f9f' },
  broken_promise: { label: 'Promise broken', icon: 'circle-cross', color: '#b3322b' },
  partially_paid: { label: 'Part paid', icon: 'half-circle', color: '#c9972f' },
  paid: { label: 'Paid', icon: 'circle-check', color: '#0d7a5f' },
  paid_late: { label: 'Paid late', icon: 'clock-check', color: '#8a9a2f' },
  open: { label: 'Open', icon: 'clock', color: '#5e6f6a' },
  kept: { label: 'Kept', icon: 'circle-check', color: '#0d7a5f' },
  broken: { label: 'Broken', icon: 'circle-cross', color: '#b3322b' },
  unconfirmed: { label: 'Unconfirmed', icon: 'clock', color: '#c9972f' },
};
function statusChip(status) {
  const info = STATUS_ICONS[String(status).toLowerCase()] || { label: String(status), icon: 'circle', color: '#5e6f6a' };
  return `<span class="status-chip" style="color:${info.color}; border-color:${tint(info.color, 0.2)}; background:${tint(info.color, 0.08)}">${icon(info.icon)}<span class="txt">${escapeHtml(info.label)}</span></span>`;
}

const app = document.getElementById('app');
let gridApi = null;
let pollTimer = null;
let currentRoute = 'receivables';
let initialLoad = true;
let selectedInvoiceId = null;

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
  return data;
}

function renderShell() {
  return `
    <div class="layout">
      <aside class="sidebar">
        <a class="brand" href="#/receivables" aria-label="PanaPay home">Pana<b>Pay</b></a>
        <nav aria-label="Main navigation">
          <a href="#/overview" data-route="overview" class="nav-link">Overview</a>
          <a href="#/receivables" data-route="receivables" class="nav-link">Receivables</a>
        </nav>
        <div class="foot">PanaPay &nbsp;·&nbsp; Merchant dashboard</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <h1 id="page-title">Receivables</h1>
          <div class="toolbar" id="toolbar"></div>
        </header>
        <div id="panel-root"></div>
        <div id="modal-root"></div>
        <div id="view"></div>
      </div>
    </div>
  `;
}

function setupNav() {
  document.querySelectorAll('.nav-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === currentRoute);
  });
}

function renderApp() {
  if (!app.innerHTML.trim()) {
    app.innerHTML = renderShell();
  }
  currentRoute = location.hash.replace(/^#\//, '') || 'receivables';
  setupNav();
  if (currentRoute === 'overview') {
    stopPolling();
    renderOverview();
  } else {
    renderReceivables();
  }
}

// ---------- Overview (placeholder) ----------
function renderOverview() {
  const title = document.getElementById('page-title');
  const toolbar = document.getElementById('toolbar');
  const view = document.getElementById('view');
  title.textContent = 'Overview';
  toolbar.innerHTML = '';
  view.innerHTML = `
    <div class="receivables">
      <h2>Overview</h2>
      <p class="empty-inline">Overview placeholder.</p>
      <p style="color:var(--muted);">Receivables is the default view.</p>
    </div>
  `;
}
// ---------- Receivables ----------
function formatDue(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function statusCellRenderer(params) {
  const { value: status } = params;
  return statusChip(status);
}
function invoiceIdRenderer(p) {
  const id = String(p.value ?? '');
  const short = id.length > 22 ? id.slice(0, 19) + '...' : id;
  return `<span class="invoice-id-cell" title="${escapeHtml(id)}">${escapeHtml(short)}</span>`;
}
const COLUMNS = [
  { headerName: 'Customer', field: 'customerName', minWidth: 170, sortable: true, flex: 1 },
  { headerName: 'Invoice', field: 'paypalInvoiceId', minWidth: 150, sortable: true, flex: 1, cellRenderer: invoiceIdRenderer },
  { headerName: 'Amount', field: 'amountCents', minWidth: 120, type: 'rightAligned',
    valueFormatter: (p) => formatMoney(p.value), cellClass: 'amt-cell', flex: 1 },
  { headerName: 'Due', field: 'dueAt', minWidth: 140, valueFormatter: (p) => formatDue(p.value), flex: 1 },
  { headerName: 'Days late', field: 'daysLate', minWidth: 110, type: 'rightAligned',
    valueFormatter: (p) => (p.value == null || p.value === 0) ? '—' : String(p.value),
    cellClass: (p) => (p.value != null && p.value > 0) ? 'days-late' : '', flex: 1 },
  { headerName: 'Status', field: 'status', minWidth: 170, cellRenderer: statusCellRenderer, flex: 1 },
  { headerName: 'Next action', field: 'nextAction', minWidth: 140, valueFormatter: () => '—', flex: 1 },
];
function initGrid() {
  gridApi = agGrid.createGrid(document.getElementById('aggrid'), {
    columnDefs: COLUMNS,
    rowData: [],
    rowSelection: 'single',
    getRowId: (p) => p.data.invoiceId,
    suppressClickEdit: true,
    animateRows: true,
  });
  gridApi.addEventListener('rowClicked', (event) => {
    if (event.data) {
      selectedInvoiceId = event.data.invoiceId;
      openSidePanel(event.data.customerId);
    }
  });
}
function syncGrid(invoices) {
  const byId = new Map(invoices.map((inv) => [Number(inv.invoiceId), inv]));
  const selectedId = gridApi.getSelectedRows()[0]?.invoiceId;
  gridApi.forEachNode((node) => {
    const id = Number(node.id);
    const newData = byId.get(id);
    if (newData && JSON.stringify(node.data) !== JSON.stringify(newData)) {
      node.setData(newData);
    }
  });
  const adds = invoices.filter((inv) => !gridApi.getRowNode(Number(inv.invoiceId)));
  if (adds.length) gridApi.applyTransaction({ add: adds });
  const removes = [];
  gridApi.forEachNode((node) => { if (!byId.has(Number(node.id))) removes.push(node); });
  if (removes.length) gridApi.applyTransaction({ remove: removes });
  if (selectedId) {
    const node = gridApi.getRowNode(selectedId);
    if (node) node.setSelected(true);
  }
}
function renderGridMarkup() {
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="receivables">
      <div id="grid-loading" class="loading-state" aria-live="polite">
        <div class="spinner" aria-hidden="true"></div><p>Loading invoices…</p>
      </div>
      <div id="grid-empty" class="empty-state" style="display:none">
        <div style="font-size:1.1rem; font-weight:800;">No invoices yet</div>
        <p style="color:var(--muted);">Create your first invoice to see receivables here.</p>
      </div>
      <div id="grid-error" style="display:none; background:rgba(179,50,43,0.09); border:1px solid rgba(179,50,43,0.22); color:var(--danger); padding:14px 16px; border-radius:12px; margin-bottom:12px; font-size:0.9rem;">
        <div id="grid-error-msg"></div>
        <button type="button" id="btn-retry" class="btn secondary" style="width:auto; margin-top:10px;">Retry</button>
      </div>
      <div id="grid-wrap" class="grid-wrap" style="display:none"><div id="aggrid" class="ag-theme-quartz" style="width:100%;"></div></div>
    </div>
  `;
  document.getElementById('btn-retry')?.addEventListener('click', loadReceivables);
}
async function loadReceivables() {
  const loading = document.getElementById('grid-loading');
  const error = document.getElementById('grid-error');
  const wrap = document.getElementById('grid-wrap');
  const empty = document.getElementById('grid-empty');
  const isInitial = initialLoad;
  initialLoad = false;
  if (isInitial) {
    loading.style.display = 'grid';
    error.style.display = 'none';
    wrap.style.display = 'none';
    empty.style.display = 'none';
  }
  try {
    const data = await getJson('/api/receivables');
    const invoices = Array.isArray(data.invoices) ? data.invoices : [];
    if (!gridApi) { initGrid(); gridApi.setGridOption('rowData', invoices); }
    else syncGrid(invoices);
    loading.style.display = 'none';
    if (invoices.length === 0) empty.style.display = 'grid';
    else wrap.style.display = 'block';
  } catch (err) {
    loading.style.display = 'none';
    error.style.display = 'block';
    document.getElementById('grid-error-msg').textContent = 'Unable to load invoices.';
    document.getElementById('grid-error-msg').innerHTML = 'Unable to load invoices. ' + escapeHtml(err.message);
    wrap.style.display = 'none';
  }
}
function startPolling() {
  stopPolling();
  if (currentRoute !== 'receivables') return;
  if (document.visibilityState !== 'visible') return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && currentRoute === 'receivables') loadReceivables();
  }, 5000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function renderReceivables() {
  const title = document.getElementById('page-title');
  const toolbar = document.getElementById('toolbar');
  title.textContent = 'Receivables';
  toolbar.innerHTML = `<button type="button" class="btn-new" id="btn-new-invoice" aria-label="Create a new invoice">+ New invoice</button>`;
  gridApi = null;
  initialLoad = true;
  renderGridMarkup();
  document.getElementById('btn-new-invoice').addEventListener('click', openNewInvoiceForm);
  startPolling();
  loadReceivables();
}

// ---------- Side panel ----------
async function openSidePanel(customerId) {
  const root = document.getElementById('panel-root');
  root.innerHTML = `
    <div class="panel" id="side-panel" aria-label="Customer details" role="region" aria-modal="true">
      <div class="panel-header-card">
        <div class="header-top">
          <div class="header-left">
            <h2 class="customer-name" id="panel-customer-name">Loading…</h2>
            <span class="demo-tag" id="panel-demo-tag">Demo data</span>
          </div>
          <button type="button" class="panel-close" id="btn-close-panel" aria-label="Close panel">${icon('x')}</button>
        </div>
        <div class="figures">
          <div class="figure"><div class="figure-value" id="panel-outstanding">—</div><div class="figure-label">Outstanding</div></div>
          <div class="figure"><div class="figure-value" id="panel-paid-late">—</div><div class="figure-label">Paid late</div></div>
          <div class="figure"><div class="figure-value" id="panel-promises-kept">—</div><div class="figure-label">Promises kept</div></div>
        </div>
      </div>
      <div class="panel-body" id="panel-body">
        <div class="loading-state"><div class="spinner" aria-hidden="true"></div><p>Loading customer…</p></div>
      </div>
    </div>
  `;
  document.getElementById('btn-close-panel').addEventListener('click', closeSidePanel);
  try {
    const data = await getJson(`/api/customers/${customerId}`);
    renderSidePanel(data);
    document.getElementById('panel-demo-tag').style.display = data.customer?.source === 'seeded' ? 'inline-block' : 'none';
    window.addEventListener('resize', positionPanel);
  } catch (err) {
    document.getElementById('panel-body').innerHTML = `<p style="color:var(--danger); padding:16px;">Unable to load customer: ${escapeHtml(err.message)}</p>`;
  }
}
function positionPanel() {
  const panel = document.getElementById('side-panel');
  if (!panel) return;
  const topbar = document.querySelector('.topbar');
  const top = topbar ? Math.round(topbar.getBoundingClientRect().bottom) : 0;
  const desktop = window.innerWidth >= 900;
  const gridWrap = document.getElementById('grid-wrap');
  if (desktop) {
    panel.style.position = 'fixed';
    panel.style.top = top + 'px';
    panel.style.right = '0';
    panel.style.width = '420px';
    panel.style.height = Math.max(0, window.innerHeight - top) + 'px';
    if (gridWrap) gridWrap.style.marginRight = '440px';
  } else {
    panel.style.position = 'fixed';
    panel.style.top = '0';
    panel.style.right = '0';
    panel.style.width = '100vw';
    panel.style.height = '100vh';
    panel.style.left = 'auto';
    if (gridWrap) gridWrap.style.marginRight = '';
  }
  gridApi?.sizeColumnsToFit();
}
function closeSidePanel() {
  document.getElementById('panel-root').innerHTML = '';
  gridApi?.deselectAll();
  selectedInvoiceId = null;
  window.removeEventListener('resize', positionPanel);
  const gridWrap = document.getElementById('grid-wrap');
  if (gridWrap) gridWrap.style.marginRight = '';
  gridApi?.sizeColumnsToFit();
}
function renderSidePanel(data) {
  const { customer, invoices = [], notes = [], promises = [], profile } = data || {};
  const body = document.getElementById('panel-body');
  const enough = Boolean(profile?.enoughHistory);
  const evidence = Array.isArray(profile?.evidence) ? profile.evidence : [];
  document.getElementById('panel-customer-name').textContent = customer?.name ?? 'Customer';
  document.getElementById('panel-demo-tag').style.display = customer?.source === 'seeded' ? 'inline-block' : 'none';
  document.getElementById('panel-outstanding').textContent = formatMoney(profile?.outstandingCents ?? 0);
  document.getElementById('panel-paid-late').textContent = String(profile?.paidLateCount ?? 0);
  document.getElementById('panel-promises-kept').textContent = `${profile?.promisesKept ?? 0} of ${profile?.promisesMade ?? 0}`;

  const whatWeKnow = enough
    ? `<ul class="evidence-list">${evidence.map((e) => `<li>${icon('dot')}${escapeHtml(e)}</li>`).join('')}</ul>
       <p class="sample-footnote">Sample size: ${profile?.invoiceCount ?? 0} invoice${profile?.invoiceCount === 1 ? '' : 's'}.</p>`
    : '<p class="empty-inline">Not enough history yet</p>';

  const invList = invoices.map((inv) => {
    const info = STATUS_ICONS[String(inv.status).toLowerCase()] || { label: String(inv.status), icon: 'circle', color: '#5e6f6a' };
    const days = inv.daysLate;
    return `<div class="invoice-row" data-id="${inv.id}">
      <div class="inv-id" title="${escapeHtml(inv.paypal_invoice_id || '')}">${escapeHtml(inv.paypal_invoice_id || 'Invoice')}</div>
      <div class="inv-amount">${formatMoney(inv.amount_cents)}</div>
      <div class="inv-due">${formatDue(inv.due_at)}</div>
      <div class="inv-status">${statusChip(inv.status)}</div>
      <div class="inv-days">${days > 0 ? `${days} days late` : ''}</div>
    </div>`;
  }).join('');

  const noteItems = (notes || []).map((n) => `<p style="margin:4px 0; font-size:0.88rem;">${escapeHtml(n.text || n.note || '')}</p>`).join('') || '<p class="empty-inline">No notes.</p>';

  const promiseItems = (promises || []).map((p) => {
    const confirmed = String(p.status || '').toLowerCase() !== 'unconfirmed';
    const info = STATUS_ICONS[String(p.status || 'unconfirmed').toLowerCase()] || { label: String(p.status), icon: 'circle', color: '#5e6f6a' };
    return `<div class="promise-row">
      <span class="status-chip" style="color:${info.color}; border-color:${tint(info.color, 0.2)}; background:${tint(info.color, 0.08)}">${icon(info.icon)}<span class="txt">${escapeHtml(info.label)}</span></span>
      <span class="promise-date">${formatDue(p.promised_date)}</span>
      <span class="promise-confidence">${Math.round(Number(p.confidence ?? 0) * 100)}%</span>
      <span class="promise-reason">${escapeHtml(p.reason || '')}</span>
      ${confirmed ? '' : '<span class="needs-confirm">Needs confirmation</span>'}
    </div>`;
  }).join('') || '<p class="empty-inline">No promises.</p>';

  body.innerHTML = `
    <div class="panel-section"><h3>What we know</h3><div class="evidence-list">${whatWeKnow}</div></div>
    <div class="panel-section"><h3>Invoices (${invoices.length})</h3><div class="invoice-list">${invList || '<p class="empty-inline">No invoices.</p>'}</div></div>
    <div class="panel-section"><h3>Notes and promises</h3><div class="notes-list">${noteItems}${promiseItems}</div></div>
    <div class="panel-section"><h3>Next action</h3><p style="margin:0; color:var(--muted); font-size:0.88rem;">Next action rules coming soon.</p></div>
  `;
}

// ---------- New invoice form ----------
async function openNewInvoiceForm() {
  let data;
  try { data = await getJson('/api/customers'); } catch (err) {
    alert('Unable to load customers: ' + err.message);
    return;
  }
  const invoiceable = Array.isArray(data.customers) ? data.customers.filter((c) => c.canInvoice) : [];
  const options = invoiceable.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('') || '<option value="">No invoicable customers</option>';
  const modal = document.getElementById('modal-root');
  modal.innerHTML = `
    <div class="modal" id="invoice-modal" aria-label="New invoice" role="dialog" aria-modal="true">
      <div class="panel" style="position:relative; height:auto; max-height:90vh; overflow-y:auto; border:none; box-shadow:var(--shadow);">
        <div class="head">
          <h2>New invoice</h2>
          <button type="button" class="close" id="btn-close-form" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="body" style="padding:24px; overflow-y:auto; max-height:65vh;">
          <form id="invoice-form">
            <div class="form-row">
              <label for="form-customer">Customer</label>
              <select id="form-customer" required>${options}</select>
            </div>
            <div class="form-row">
              <label for="form-amount">Amount (USD)</label>
              <input type="number" id="form-amount" step="0.01" min="0" placeholder="0.00" required>
            </div>
            <div class="form-row">
              <label for="form-due">Due date</label>
              <input type="date" id="form-due" required>
            </div>
            <div class="form-row">
              <label for="form-desc">Description</label>
              <textarea id="form-desc" rows="3" placeholder="e.g. Fabric order"></textarea>
            </div>
            <div id="form-error" class="error-box" style="display:none"></div>
            <div style="display:flex; gap:10px; margin-top:18px;">
              <button type="button" id="btn-cancel-form" class="btn secondary" style="width:auto;">Cancel</button>
              <button type="submit" id="btn-submit-form" class="btn-new" style="width:auto;">Create invoice</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
  document.getElementById('btn-close-form').addEventListener('click', closeNewInvoiceForm);
  document.getElementById('btn-cancel-form').addEventListener('click', closeNewInvoiceForm);
  document.getElementById('invoice-form').addEventListener('submit', handleNewInvoiceSubmit);
  document.getElementById('form-due').value = new Date().toISOString().slice(0, 10);
}
function closeNewInvoiceForm() {
  document.getElementById('modal-root').innerHTML = '';
}
async function handleNewInvoiceSubmit(e) {
  e.preventDefault();
  const amountCents = toCents(document.getElementById('form-amount').value);
  const body = {
    customerId: Number(document.getElementById('form-customer').value),
    amountCents,
    dueDate: document.getElementById('form-due').value,
    description: document.getElementById('form-desc').value.trim(),
  };
  const errorEl = document.getElementById('form-error');
  const submitBtn = document.getElementById('btn-submit-form');
  errorEl.style.display = 'none';
  errorEl.textContent = '';
  submitBtn.disabled = true;
  try {
    const data = await postJson('/api/invoices', body);
    const payerLink = data.payer_link;
    document.getElementById('invoice-form').innerHTML = `
      <div class="success-box">Invoice created successfully.</div>
      ${payerLink ? `<a href="${escapeHtml(payerLink)}" target="_blank" rel="noopener" class="payer-link-btn">Open payer link</a>` : ''}
      <p style="margin-top:10px; font-size:0.85rem; color:var(--muted);">Refreshing the grid…</p>
    `;
    setTimeout(() => { closeNewInvoiceForm(); loadReceivables(); }, 1200);
  } catch (err) {
    errorEl.style.display = 'block';
    errorEl.innerHTML = 'Unable to create invoice. ' + escapeHtml(err.message);
    submitBtn.disabled = false;
  }
}

// ---------- Keyboard + nav ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSidePanel(); closeNewInvoiceForm(); }
});
window.addEventListener('load', renderApp);
window.addEventListener('hashchange', renderApp);
window.addEventListener('resize', positionPanel);

