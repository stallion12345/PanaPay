const state = { summary: null, ledger: [], forecast: null, loading: true };
const app = document.getElementById('app');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

function formatMoney(valueCents) {
  const cents = Number(valueCents ?? 0);
  const usd = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usd);
}

function badgeClass(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('completed') || value.includes('success')) return 'success';
  if (value.includes('pending') || value.includes('created')) return 'pending';
  if (value.includes('failed') || value.includes('refunded')) return 'failed';
  return 'pending';
}

function renderShell() {
  return `
    <header class="topbar">
      <a class="brand" href="#/home"><span>Pana<b>Pay</b></span></a>
      <a class="icon-btn" href="#/settings" data-route="settings" aria-label="Settings">⚙️</a>
    </header>
    <nav class="tabs" aria-label="Main navigation">
      <a href="#/home" data-route="home">🏠 Home</a>
      <a href="#/ledger" data-route="ledger">📒 Ledger</a>
      <a href="#/pay" data-route="pay">💸 Pay supplier</a>
      <a href="#/assistant" data-route="assistant">🤖 Assistant</a>
    </nav>
  `;
}

function renderLoading(message = 'Loading your cash flow…') {
  app.innerHTML = `
    ${renderShell()}
    <section class="card loading-state" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <p>${escapeHtml(message)}</p>
    </section>
  `;
}

function renderHome() {
  const summary = state.summary || { weekly_limit: 0, spent_this_week: 0, safe_to_spend: 0, percent_used: 0 };
  const seedData = window.SEED || {};
  const lowPoint = seedData.lowPoint || {};
  const upcoming = Array.isArray(seedData.upcoming) ? seedData.upcoming : [];
  const weeks = Array.isArray(seedData.weeks) ? seedData.weeks : [];
  const aiSummary = seedData.aiSummary || 'No AI summary available yet.';
  const safe = Number(summary.safe_to_spend ?? 0);
  const spent = Number(summary.spent_this_week ?? 0);
  const limit = Number(summary.weekly_limit ?? 0);
  const percent = limit > 0 ? Math.min(Math.round((spent / limit) * 100), 100) : 0;

  app.innerHTML = `
    ${renderShell()}
    <div class="date">${escapeHtml(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }))}</div>
    <h1 class="page-title">Your money this week</h1>
    <div class="home-grid">
      <div>
        <section class="hero">
          <div>
            <div class="label">Safe to spend this week</div>
            <div class="big">${escapeHtml(formatMoney(safe))}</div>
            <div class="sub">${escapeHtml(formatMoney(spent))} spent of your ${escapeHtml(formatMoney(limit))} weekly limit</div>
          </div>
          <div class="ring" aria-label="${percent}% of weekly limit used">
            <svg viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" fill="none" stroke="#dcefe3" stroke-width="12"></circle>
              <circle cx="60" cy="60" r="52" fill="none" stroke="#c9972f" stroke-width="12" stroke-linecap="round" stroke-dasharray="${Math.min((percent / 100) * 326.72, 326.72)} 326.72"></circle>
            </svg>
            <div class="pct">${percent}%</div>
          </div>
        </section>

        <section class="alert">
          <div class="ic">⚠️</div>
          <div>
            <h3>Heads up about this week</h3>
            <p>You have used ${percent}% of your weekly limit. You may run short on ${escapeHtml(lowPoint.dateLabel || 'this week')}.</p>
          </div>
          <a class="btn" href="#/ledger">Check the ledger</a>
        </section>

        <section class="card" style="margin-top:20px;">
          <h2>Coming up</h2>
          <ul class="list">
            ${upcoming.map((item) => `
              <li>
                <div class="dot">${Number(item.amount || 0) > 0 ? '↘' : '↗'}</div>
                <div class="meta">
                  <div class="name">${escapeHtml(item.name || 'Upcoming item')}</div>
                  <div class="note">${escapeHtml(item.note || '')} · ${escapeHtml(item.date || '')}</div>
                </div>
                <div class="amt ${Number(item.amount || 0) > 0 ? 'in' : ''}">${Number(item.amount || 0) > 0 ? '+' : ''}${escapeHtml(formatMoney(Number(item.amount || 0) * 100))}</div>
              </li>
            `).join('') || '<li class="empty-inline">No upcoming items.</li>'}
          </ul>
        </section>
      </div>

      <div>
        <section class="card chart">
          <h2>Next 4 weeks</h2>
          <svg viewBox="0 0 640 300" role="img" aria-label="Cash forecast chart">
            <line x1="52" x2="624" y1="250" y2="250" stroke="#dfe5df" />
            ${[0, 500, 1000, 1500, 2000].map((value) => `
              <g>
                <line x1="52" x2="624" y1="${250 - (value / 2000) * 200}" y2="${250 - (value / 2000) * 200}" stroke="#e8e0cd" stroke-dasharray="3 4" />
                <text x="44" y="${254 - (value / 2000) * 200}" text-anchor="end" font-size="12" fill="#5e6f6a">$${(value / 1000).toFixed(0)}k</text>
              </g>
            `).join('')}
            ${weeks.map((week, idx) => {
              const x = 52 + idx * 150 + 25;
              const inBar = Number(week.in || 0);
              const outBar = Number(week.out || 0);
              return `
                <g>
                  <rect x="${x - 26}" y="${250 - (inBar / 2000) * 200}" width="18" height="${(inBar / 2000) * 200}" fill="#1b6e4f" rx="3"></rect>
                  <rect x="${x + 10}" y="${250 - (outBar / 2000) * 200}" width="18" height="${(outBar / 2000) * 200}" fill="#d1a84f" rx="3"></rect>
                  <text x="${x + 6}" y="290" text-anchor="middle" font-size="12" fill="#5e6f6a">${escapeHtml(String(week.label || '').split(' ')[0])}</text>
                </g>
              `;
            }).join('')}
          </svg>
          <div class="legend">
            <span><i style="background:#1b6e4f"></i>Money in</span>
            <span><i style="background:#d1a84f"></i>Money out</span>
            <span><i style="background:#2f7f9f"></i>Left over</span>
          </div>
          <div class="note-bar">⚠️ ${escapeHtml(lowPoint.note || 'No forecast warning.')}</div>
          <div class="ai"><span class="tag">AI</span><span>${escapeHtml(aiSummary)}</span></div>
        </section>
      </div>
    </div>
  `;
}

function renderLedger() {
  const shell = renderShell();

  if (state.loading) {
    app.innerHTML = `${shell}<section class="card loading-state"><div class="spinner" aria-hidden="true"></div><p>Loading your ledger…</p></section>`;
    return;
  }

  if (!state.ledger.length) {
    app.innerHTML = `${shell}<section class="card empty-state"><h2>Ledger</h2><p>No entries yet. As soon as money moves in or out, it will appear here.</p></section>`;
    return;
  }

  app.innerHTML = `${shell}<section class="card"><h2>Ledger</h2><div id="ledgerGrid" class="ag-theme-alpine" style="height:420px;width:100%;"></div></section>`;

  if (typeof agGrid === 'undefined') {
    app.innerHTML = `${shell}<section class="card"><h2>Ledger</h2><table><thead><tr><th>Date</th><th>Name</th><th>Description</th><th>Category</th><th>Amount</th><th>Status</th></tr></thead><tbody>${state.ledger.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.occurred_at ? new Date(entry.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')}</td>
        <td>${escapeHtml(entry.name || 'General expense')}</td>
        <td>${escapeHtml(entry.description || entry.category || '—')}</td>
        <td>${escapeHtml(entry.category || 'General')}</td>
        <td>${escapeHtml(formatMoney(entry.amount_cents ?? entry.amount ?? 0))}</td>
        <td><span class="status-chip ${badgeClass(entry.status)}">${escapeHtml(String(entry.status || 'pending'))}</span></td>
      </tr>
    `).join('')}</tbody></table></section>`;
    return;
  }

  const gridOptions = {
    rowData: state.ledger.map((entry) => ({
      date: entry.occurred_at ? new Date(entry.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
      name: entry.name || 'General expense',
      description: entry.description || entry.category || '—',
      category: entry.category || 'General',
      category_reason: entry.category_reason || '',
      category_confidence: Number(entry.category_confidence ?? 1),
      amount: Number(entry.amount_cents ?? entry.amount ?? 0),
      status: entry.status || 'pending',
    })),
    defaultColDef: {
      resizable: true,
      sortable: true,
      filter: false,
    },
    columnDefs: [
      { headerName: 'Date', field: 'date', minWidth: 120 },
      { headerName: 'Name', field: 'name', minWidth: 180 },
      { headerName: 'Description', field: 'description', minWidth: 220 },
      {
        headerName: 'Category',
        field: 'category',
        minWidth: 180,
        cellRenderer: (params) => {
          const category = String(params.value || 'General');
          const reason = String(params.data?.category_reason || '').trim();
          const needsReview = Number(params.data?.category_confidence ?? 1) < 0.7 || reason.toLowerCase().includes('needs review');
          const reasonLine = reason ? `<div class="category-reason">${escapeHtml(reason.slice(0, 80))}</div>` : '';
          const reviewChip = needsReview ? '<span class="review-chip">Needs review</span>' : '';
          return `<div class="category-cell"><div>${escapeHtml(category)}</div>${reasonLine}${reviewChip}</div>`;
        },
      },
      {
        headerName: 'Amount',
        field: 'amount',
        minWidth: 120,
        valueFormatter: (params) => `${params.value >= 0 ? '+' : '-'}${formatMoney(Math.abs(Number(params.value) || 0))}`,
        cellStyle: (params) => ({ color: Number(params.value) >= 0 ? '#0d7a5f' : '#1c2a2a', fontWeight: 800 }),
      },
      {
        headerName: 'Status',
        field: 'status',
        minWidth: 140,
        cellRenderer: (params) => `<span class="status-chip ${badgeClass(params.value)}">${escapeHtml(params.value || 'pending')}</span>`,
      },
    ],
    domLayout: 'normal',
    suppressCellFocus: true,
    rowSelection: 'none',
    animateRows: true,
    pagination: false,
  };

  const gridApi = new agGrid.Grid(document.getElementById('ledgerGrid'), gridOptions);
  gridApi.sizeColumnsToFit();
}

function renderPay() {
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/home"><span>Pana<b>Pay</b></span></a>
      <a class="icon-btn" href="#/settings" aria-label="Settings">⚙️</a>
    </header>
    <nav class="tabs" aria-label="Main navigation">
      <a href="#/home" data-route="home">🏠 Home</a>
      <a href="#/ledger" data-route="ledger">📒 Ledger</a>
      <a class="active" href="#/pay" data-route="pay">💸 Pay supplier</a>
      <a href="#/assistant" data-route="assistant">🤖 Assistant</a>
    </nav>

    <section class="grid-2">
      <div class="form-shell">
        <h2>Send a payout</h2>
        <form id="payoutForm" novalidate>
          <label>Supplier
            <select id="payoutSupplier" name="supplier" required>
              <option value="">Loading suppliers…</option>
            </select>
          </label>
          <label>Amount (USD)
            <input id="payoutAmount" name="amount" type="number" min="0.01" step="0.01" placeholder="250.00" required />
          </label>
          <label>Note
            <textarea id="payoutNote" name="note" rows="3" placeholder="Weekly supply order"></textarea>
          </label>
          <button id="submitPayout" type="submit">Review payout</button>
        </form>

        <section id="payoutConfirmView" class="answers" hidden>
          <h3>Confirm payout</h3>
          <div id="payoutConfirmSummary"></div>
          <div style="display:flex; gap:12px; margin-top:16px;">
            <button id="cancelPayout" type="button" class="secondary">Cancel</button>
            <button id="confirmPayout" type="button">Confirm</button>
          </div>
        </section>

        <div id="payoutFormNotice" class="status" hidden></div>
        <section id="payoutResultView" class="answers" hidden>
          <h3 id="payoutResultTitle">Payment status</h3>
          <p id="payoutResultMessage"></p>
          <p id="payoutResultStatus" class="status-chip pending">Status: pending</p>
        </section>
      </div>

      <div class="card">
        <h2>Sandbox guidance</h2>
        <p>Use a PayPal sandbox Business account for the merchant and a sandbox Personal account for the recipient. This is a PayPal sandbox payment, so no real money is sent.</p>
        <ul class="list">
          <li><div class="dot">1</div><div><div class="name">Choose a supplier</div><div class="note">Only active supplier contacts can receive payouts.</div></div></li>
          <li><div class="dot">2</div><div><div class="name">Review the total</div><div class="note">The confirmation step shows who, how much, and the note.</div></div></li>
          <li><div class="dot">3</div><div><div class="name">Watch the status</div><div class="note">Status updates every 3 seconds for up to 60 seconds.</div></div></li>
        </ul>
      </div>
    </section>
  `;

  const form = document.getElementById('payoutForm');
  const supplierSelect = document.getElementById('payoutSupplier');
  const amountInput = document.getElementById('payoutAmount');
  const noteInput = document.getElementById('payoutNote');
  const confirmView = document.getElementById('payoutConfirmView');
  const confirmSummary = document.getElementById('payoutConfirmSummary');
  const confirmButton = document.getElementById('confirmPayout');
  const cancelButton = document.getElementById('cancelPayout');
  const formNotice = document.getElementById('payoutFormNotice');
  const resultView = document.getElementById('payoutResultView');
  const resultMessage = document.getElementById('payoutResultMessage');
  const resultStatus = document.getElementById('payoutResultStatus');

  const state = {
    suppliers: [],
    draft: null,
    requestInFlight: false,
  };

  const setNotice = (messages, kind = 'error') => {
    const list = Array.isArray(messages) ? messages : [messages];
    const content = list.filter(Boolean).map((message) => `<li>${escapeHtml(String(message))}</li>`).join('');
    formNotice.hidden = false;
    formNotice.innerHTML = content ? `<ul>${content}</ul>` : '';
    formNotice.classList.remove('pending', 'success');
    if (kind === 'success') {
      formNotice.classList.add('success');
    }
  };

  const convertDollarsToCents = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
    const [whole, fraction = ''] = raw.split('.');
    const wholeCents = Number.parseInt(whole, 10) * 100;
    const fractionCents = Number.parseInt((fraction + '00').slice(0, 2), 10);
    const total = wholeCents + fractionCents;
    return total > 0 ? total : null;
  };

  const showForm = () => {
    confirmView.hidden = true;
    resultView.hidden = true;
    form.hidden = false;
    formNotice.hidden = true;
  };

  const showConfirmation = (draft) => {
    form.hidden = true;
    formNotice.hidden = true;
    confirmView.hidden = false;
    resultView.hidden = true;
    confirmSummary.innerHTML = `
      <p><strong>Supplier:</strong> ${escapeHtml(draft.supplierName)}</p>
      <p><strong>Amount:</strong> ${escapeHtml(formatMoney(draft.amountCents))}</p>
      <p><strong>Note:</strong> ${escapeHtml(draft.note || 'No note supplied')}</p>
      <p><em>This is a PayPal sandbox payment. No real money will be sent.</em></p>
    `;
  };

  const showResult = (title, message, status = 'pending') => {
    form.hidden = true;
    confirmView.hidden = true;
    resultView.hidden = false;
    const titleNode = document.getElementById('payoutResultTitle');
    titleNode.textContent = title;
    resultMessage.innerHTML = message;
    resultStatus.textContent = `Status: ${status}`;
    resultStatus.className = `status-chip ${badgeClass(status)}`;
  };

  const collectErrorMessages = (payload) => {
    if (!payload) return ['The payout could not be submitted right now.'];
    if (Array.isArray(payload.errors)) return payload.errors.filter(Boolean);
    if (Array.isArray(payload.error)) return payload.error.filter(Boolean);
    if (typeof payload.error === 'string' && payload.error.trim()) return [payload.error];
    if (typeof payload.message === 'string' && payload.message.trim()) return [payload.message];
    return ['The payout could not be submitted right now.'];
  };

  async function fetchSuppliers() {
    try {
      const response = await fetch('/api/parties?type=supplier');
      const data = await response.json();
      const suppliers = Array.isArray(data?.parties) ? data.parties : [];
      state.suppliers = suppliers;
      supplierSelect.innerHTML = '<option value="">Select a supplier</option>' + suppliers.map((supplier) => `<option value="${escapeHtml(String(supplier.id))}">${escapeHtml(String(supplier.name || 'Supplier'))}</option>`).join('');
      if (!suppliers.length) {
        supplierSelect.innerHTML = '<option value="">No suppliers available</option>';
      }
    } catch (error) {
      supplierSelect.innerHTML = '<option value="">Unable to load suppliers</option>';
      setNotice('We could not load suppliers right now. Please refresh and try again.');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const supplierId = supplierSelect.value;
    const amountCents = convertDollarsToCents(amountInput.value);
    const note = noteInput.value.trim();

    if (!supplierId) {
      setNotice('Please choose a supplier before continuing.');
      return;
    }

    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      setNotice('Enter an amount greater than $0.00 before continuing.');
      return;
    }

    const supplier = state.suppliers.find((item) => String(item.id) === String(supplierId));
    state.draft = {
      supplierId,
      supplierName: supplier?.name || 'Supplier',
      amountCents,
      note,
    };

    formNotice.hidden = true;
    showConfirmation(state.draft);
  });

  cancelButton.addEventListener('click', () => {
    state.draft = null;
    showForm();
  });

  confirmButton.addEventListener('click', async () => {
    if (!state.draft || state.requestInFlight) return;

    state.requestInFlight = true;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    resultStatus.textContent = 'Status: sending';
    resultStatus.className = 'status-chip pending';

    try {
      const response = await fetch('/api/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partyId: String(state.draft.supplierId),
          amountCents: Number(state.draft.amountCents),
          note: state.draft.note,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        const messages = collectErrorMessages(payload);
        formNotice.hidden = false;
        formNotice.innerHTML = `<ul>${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
        form.hidden = false;
        confirmView.hidden = true;
        resultView.hidden = true;
        confirmButton.disabled = false;
        cancelButton.disabled = false;
        state.requestInFlight = false;
        return;
      }

      const payout = payload?.payout || {};
      const payoutId = payout.id || null;
      const finalStatus = String(payout.status || 'pending').toLowerCase();
      showResult('Payment submitted', `A payout is on its way to <strong>${escapeHtml(String(state.draft.supplierName))}</strong> for <strong>${escapeHtml(formatMoney(Number(state.draft.amountCents)))}</strong>. This is a PayPal sandbox payment.`, finalStatus);

      if (!payoutId) {
        state.requestInFlight = false;
        confirmButton.disabled = false;
        cancelButton.disabled = false;
        return;
      }

      const startedAt = Date.now();
      const deadline = startedAt + 60000;
      let currentStatus = finalStatus;

      while (Date.now() < deadline) {
        try {
          const statusResponse = await fetch(`/api/payouts/${encodeURIComponent(payoutId)}`);
          const statusPayload = statusResponse.ok ? await statusResponse.json() : null;
          currentStatus = String(statusPayload?.payout?.status || currentStatus || 'pending').toLowerCase();
          resultStatus.textContent = `Status: ${currentStatus}`;
          resultStatus.className = `status-chip ${badgeClass(currentStatus)}`;
          if (currentStatus === 'completed' || currentStatus === 'failed') {
            break;
          }
        } catch (error) {
          // Ignore transient polling errors and keep retrying.
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      resultStatus.textContent = `Status: ${currentStatus}`;
      resultStatus.className = `status-chip ${badgeClass(currentStatus)}`;
      state.requestInFlight = false;
      confirmButton.disabled = false;
      cancelButton.disabled = false;
    } catch (error) {
      state.requestInFlight = false;
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      formNotice.hidden = false;
      formNotice.innerHTML = `<ul><li>${escapeHtml(error?.message || 'The payout could not be submitted right now.')}</li></ul>`;
      form.hidden = false;
      confirmView.hidden = true;
      resultView.hidden = true;
    }
  });

  fetchSuppliers();
  showForm();
}

function renderAssistant() {
  app.innerHTML = `
    ${renderShell()}
    <section class="assistant-layout">
      <div class="card chat-card">
        <div class="assistant-header">
          <div>
            <h2>Support assistant</h2>
            <p>Ask about recent payments, payouts, or your forecast.</p>
          </div>
          <a class="btn small" href="#/escalations">Escalation queue</a>
        </div>
        <div class="escalation-banner" id="assistantEscalationBanner" hidden>
          <strong>Escalated</strong>
          <span id="assistantEscalationReason">This issue has been handed to a human.</span>
        </div>
        <div class="suggestions" id="suggestionChips">
          <button type="button" class="suggestion-chip">Where is my recent payment?</button>
          <button type="button" class="suggestion-chip">Did the supplier payout go through?</button>
          <button type="button" class="suggestion-chip">How much can I spend this week?</button>
        </div>
        <div id="assistantChat" class="assistant-chat" aria-live="polite"></div>
        <form id="assistantForm" class="assistant-form">
          <input id="assistantInput" type="text" placeholder="Ask a question about your ledger or payouts" aria-label="Ask the support assistant" />
          <button type="submit">Send</button>
        </form>
      </div>
      <aside class="card assistant-side">
        <h3>Recent data</h3>
        <ul class="list">
          <li><div class="dot">📌</div><div><div class="name">Live ledger</div><div class="note">Uses the merchant ledger and payout rows.</div></div></li>
          <li><div class="dot">🧠</div><div><div class="name">AI answers</div><div class="note">Only from tool results or a human escalation.</div></div></li>
          <li><div class="dot">🚨</div><div><div class="name">Escalations</div><div class="note">Triggered by refund, fraud, amount over $500, or repeated unresolved issues.</div></div></li>
        </ul>
      </aside>
    </section>
  `;

  const chat = document.getElementById('assistantChat');
  const form = document.getElementById('assistantForm');
  const input = document.getElementById('assistantInput');
  const banner = document.getElementById('assistantEscalationBanner');
  const bannerReason = document.getElementById('assistantEscalationReason');

  const threadState = { id: null };

  const appendBubble = (role, content) => {
    const row = document.createElement('div');
    row.className = `chat-bubble ${role}`;
    row.textContent = content;
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  };

  appendBubble('assistant', 'I can check the merchant ledger, recent payouts, and the forecast.');

  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      input.value = chip.textContent.trim();
      input.focus();
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    appendBubble('user', message);
    input.value = '';

    const response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: threadState.id, message }),
    });

    const data = await response.json();
    if (!response.ok) {
      appendBubble('assistant', data.error || 'I could not answer that request.');
      return;
    }

    threadState.id = data.threadId || threadState.id;
    if (data.escalated) {
      banner.hidden = false;
      bannerReason.textContent = `${data.escalation?.severity || 'medium'}: ${data.escalation?.reason || 'Escalated to a human.'}`;
    } else {
      banner.hidden = true;
    }

    appendBubble('assistant', data.reply || 'I do not have enough data yet.');
  });
}

function renderEscalations() {
  app.innerHTML = `${renderShell()}<section class="card"><h2>Escalation queue</h2><div id="escalationList" class="stack-list"></div></section>`;

  fetch('/api/escalations')
    .then((response) => response.json())
    .then((data) => {
      const list = document.getElementById('escalationList');
      const escalations = Array.isArray(data.escalations) ? data.escalations : [];

      if (!escalations.length) {
        list.innerHTML = '<p class="empty-inline">No escalated threads right now.</p>';
        return;
      }

      list.innerHTML = escalations.map((item) => `
        <div class="escalation-item">
          <div class="escalation-topline">
            <strong>${escapeHtml(String(item.id || 'Thread'))}</strong>
            <span class="status-chip ${badgeClass(item.severity || 'pending')}">${escapeHtml(String(item.severity || 'medium'))}</span>
          </div>
          <p>${escapeHtml(String(item.escalation_reason || 'Escalated for review.'))}</p>
          <small>${escapeHtml(new Date(item.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</small>
        </div>
      `).join('');
    })
    .catch(() => {
      document.getElementById('escalationList').innerHTML = '<p class="empty-inline">Unable to load escalations right now.</p>';
    });
}

function renderSettings() {
  const summary = state.summary || { weekly_limit: 0 };
  app.innerHTML = `${renderShell()}<section class="card stub"><h2>Settings</h2><p>Weekly spending limit: ${escapeHtml(formatMoney(summary.weekly_limit || 0))}.</p></section>`;
}

const ROUTES = {
  home: renderHome,
  ledger: renderLedger,
  pay: renderPay,
  assistant: renderAssistant,
  escalations: renderEscalations,
  settings: renderSettings,
};

function renderCurrentRoute() {
  const route = location.hash.replace(/^#\//, '') || 'home';
  const renderer = ROUTES[route] || renderHome;
  renderer();

  const tabs = document.querySelectorAll('.tabs a');
  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.route === route);
  });

  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

async function fetchDashboardData() {
  const [summaryRes, ledgerRes] = await Promise.all([
    fetch('/api/summary'),
    fetch('/api/ledger'),
  ]);

  if (!summaryRes.ok || !ledgerRes.ok) {
    throw new Error('Unable to load the dashboard data.');
  }

  const ledger = await ledgerRes.json();

  state.summary = await summaryRes.json();
  state.ledger = Array.isArray(ledger) ? ledger : [];
}

async function initApp() {
  state.loading = true;
  renderLoading();

  try {
    await fetchDashboardData();
  } catch (error) {
    state.summary = { weekly_limit: 0, spent_this_week: 0, safe_to_spend: 0, percent_used: 0 };
    state.ledger = [];
  } finally {
    state.loading = false;
    renderCurrentRoute();
  }
}

window.addEventListener('hashchange', renderCurrentRoute);
initApp();
