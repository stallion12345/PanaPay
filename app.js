// PanaPay front-end reference. No build step, no dependencies.
// Renders from window.SEED (data.js). Swap SEED for real API calls later.
// SECURITY: this file runs in the browser. Never put PayPal secrets or API calls that need them here.
(function () {
  const S = window.SEED;
  const money = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const ICONS = {
    home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    ledger: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    pay: '<path d="M3 12h4l3 3 6-6 5 5"/><path d="M3 18h18"/>',
    assistant: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    up: '<path d="M7 17L17 7M9 7h8v8"/>',
    down: '<path d="M17 7L7 17M15 17H7V9"/>',
    invoice: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
  };
  const svg = (name, size = 22) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  // Real PanaPay mark (converted from the Lovable LogoMark component).
  const LOGO = `<svg width="36" height="36" viewBox="0 0 48 48" role="img" aria-label="PanaPay">
    <defs>
      <linearGradient id="panapay-emerald" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0d7a5f"/>
        <stop offset="100%" stop-color="#064e3b"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="12" fill="url(#panapay-emerald)"/>
    <circle cx="30" cy="18" r="9" fill="#c9a84c"/>
    <circle cx="30" cy="18" r="5.5" fill="none" stroke="#f5f0e0" stroke-width="1.8"/>
    <path d="M15 38V16.5c0-2 1.4-3.5 3.4-3.5h5.8c3.6 0 6.3 2.7 6.3 6.2 0 3.6-2.7 6.3-6.3 6.3H19.5" fill="none" stroke="#f5f0e0" stroke-width="3.6" stroke-linecap="round"/>
  </svg>`;

  // ---------- Shell ----------
  const TABS = [
    ["home", "Home", "home"],
    ["ledger", "Ledger", "ledger"],
    ["pay", "Pay supplier", "pay"],
    ["assistant", "Assistant", "assistant"],
  ];
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<header class="topbar">
       <a class="brand" href="#/home">${LOGO}<span>Pana<b>Pay</b></span></a>
       <a class="icon-btn" href="#/settings" aria-label="Settings">${svg("gear")}</a>
     </header>
     <nav class="tabs" aria-label="Main">
       ${TABS.map(([r, label, icon]) => `<a href="#/${r}" data-route="${r}">${svg(icon)}<span>${label}</span></a>`).join("")}
     </nav>`
  );

  // ---------- Pieces ----------
  function ring(pct) {
    const r = 52, c = 2 * Math.PI * r, dash = (Math.min(pct, 100) / 100) * c;
    return `<div class="ring" role="img" aria-label="${pct}% of weekly limit used">
      <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="${r}" fill="none" stroke="#dcefe3" stroke-width="12"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="#c9972f" stroke-width="12" stroke-linecap="round" stroke-dasharray="${dash} ${c}"/></svg>
      <div class="pct">${pct}%</div></div>`;
  }

  function chart() {
    const W = 640, H = 300, pad = { l: 52, r: 16, t: 16, b: 38 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, max = 2000;
    const y = (v) => pad.t + ih - (v / max) * ih;
    let bal = S.openingBalance;
    const bals = S.weeks.map((w) => (bal += w.in - w.out));
    const gw = iw / S.weeks.length, bw = gw * 0.24;
    const lowIdx = bals.indexOf(Math.min(...bals));
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money in, money out and money left over for the next four weeks">`;
    for (let v = 0; v <= max; v += 500) {
      out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e8e0cd" stroke-dasharray="3 4"/>
              <text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="#5e6f6a">${v === 0 ? "$0" : "$" + (v / 1000) + "k"}</text>`;
    }
    S.weeks.forEach((w, i) => {
      const cx = pad.l + gw * i + gw / 2;
      out += `<rect x="${cx - bw - 2}" y="${y(w.in)}" width="${bw}" height="${y(0) - y(w.in)}" rx="3" fill="#1b6e4f"/>
              <rect x="${cx + 2}" y="${y(w.out)}" width="${bw}" height="${y(0) - y(w.out)}" rx="3" fill="#d1a84f"/>
              <text x="${cx}" y="${H - 14}" text-anchor="middle" font-size="12" fill="#5e6f6a">${esc(w.label)}</text>`;
    });
    const pts = bals.map((b, i) => [pad.l + gw * i + gw / 2, y(b)]);
    out += `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="#2f7f9f" stroke-width="2.5"/>`;
    pts.forEach((p, i) => {
      out += `<circle cx="${p[0]}" cy="${p[1]}" r="${i === lowIdx ? 6 : 4}" fill="${i === lowIdx ? "#b3322b" : "#2f7f9f"}"/>`;
    });
    return out + "</svg>";
  }

  // ---------- Views ----------
  function homeView() {
    const { weeklyLimit, spentThisWeek } = S.merchant;
    const safe = weeklyLimit - spentThisWeek;
    const pct = Math.round((spentThisWeek / weeklyLimit) * 100);
    const alert =
      pct >= 80
        ? `<section class="alert" role="status">
             <div class="ic">${svg("warn")}</div>
             <div><h3>Heads up about this week</h3>
             <p>You've used ${pct}% of this week's limit. You may run short on ${esc(S.lowPoint.dateLabel)}.</p></div>
             <a class="btn" href="#/ledger">Check the ledger</a>
           </section>`
        : "";
    return `
      <div class="date">${esc(S.merchant.today)}</div>
      <h1 class="page-title">Your money this week</h1>
      <div class="home-grid">
        <div class="col">
          <section class="card hero">
            <div>
              <div class="label">Safe to spend this week</div>
              <div class="big">${money(safe)}</div>
              <div class="sub">${money(spentThisWeek)} spent of your ${money(weeklyLimit)} weekly limit</div>
            </div>
            ${ring(pct)}
          </section>
          ${alert}
          <section class="card">
            <h2>Coming up</h2>
            <ul class="list">
              ${S.upcoming
                .map(
                  (u) => `<li>
                    <div class="dot">${svg(u.amount > 0 ? "down" : "up", 20)}</div>
                    <div class="meta"><div class="name">${esc(u.name)}</div><div class="note">${esc(u.note)} · ${esc(u.date)}</div></div>
                    <div class="amt ${u.amount > 0 ? "in" : ""}">${u.amount > 0 ? "+" : ""}${money(u.amount)}</div>
                  </li>`
                )
                .join("")}
            </ul>
          </section>
        </div>
        <div class="col">
          <section class="card chart">
            <h2>Next 4 weeks</h2>
            ${chart()}
            <div class="legend">
              <span><i style="background:#1b6e4f"></i>Money in</span>
              <span><i style="background:#d1a84f"></i>Money out</span>
              <span><i style="background:#2f7f9f"></i>Left over</span>
            </div>
            <div class="note-bar">${svg("warn", 18)}<span>${esc(S.lowPoint.note)}</span></div>
            <div class="ai"><span class="tag">AI</span><span>${esc(S.aiSummary)}</span></div>
          </section>
          <section class="card">
            <h2>Quick actions</h2>
            <div class="actions">
              <a class="action" href="#/invoices">${svg("invoice")}Create invoice</a>
              <a class="action" href="#/pay">${svg("pay")}Pay supplier</a>
              <a class="action" href="#/assistant">${svg("assistant")}Ask assistant</a>
            </div>
          </section>
        </div>
      </div>`;
  }

  function ledgerView() {
    const inn = S.ledger.filter((e) => e.amount > 0 && e.status !== "Refunded").reduce((a, e) => a + e.amount, 0);
    const outt = S.ledger.filter((e) => e.amount < 0 && e.status !== "Failed").reduce((a, e) => a + e.amount, 0);
    return `
      <h1 class="page-title">Ledger</h1>
      <div class="summary-strip">
        <div class="card"><div class="k">Money in</div><div class="v">${money(inn)}</div></div>
        <div class="card"><div class="k">Money out</div><div class="v">${money(outt)}</div></div>
        <div class="card"><div class="k">Net</div><div class="v">${money(inn + outt)}</div></div>
      </div>
      <section class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Name</th><th>Category</th><th class="num">Amount</th><th>Status</th></tr></thead>
          <tbody>
          ${S.ledger
            .map(
              (e) => `<tr>
                <td>${esc(e.date)}</td>
                <td><strong>${esc(e.name)}</strong><div class="note" style="color:#5e6f6a;font-size:13px">${esc(e.desc)}</div></td>
                <td>${esc(e.category)}${e.conf < 0.7 ? '<span class="review" title="AI is not sure about this category">Needs review</span>' : ""}</td>
                <td class="num amt ${e.amount > 0 ? "in" : ""}">${e.amount > 0 ? "+" : ""}${money(e.amount)}</td>
                <td><span class="chip ${esc(e.status)}">${esc(e.status)}</span></td>
              </tr>`
            )
            .join("")}
          </tbody></table></div>
        <p style="color:#5e6f6a;font-size:13px;margin:12px 0 0">Placeholder table. The real ledger will use AG Grid fed by the database.</p>
      </section>`;
  }

  const stub = (title, lines) => () => `
    <h1 class="page-title">${title}</h1>
    <section class="card stub">${lines.map((l) => `<p>${l}</p>`).join("")}</section>`;

  const ROUTES = {
    home: homeView,
    ledger: ledgerView,
    pay: stub("Pay supplier", [
      "Not built yet. Form: supplier, amount, note, confirm.",
      "Will call your own server route <code>POST /api/payouts</code>, which calls PayPal Payouts from server-side code only.",
    ]),
    assistant: stub("Assistant", [
      "Not built yet. Chat plus data cards, with an escalation banner.",
      "Will call <code>POST /api/assistant</code> (LLM with tools reading your database).",
    ]),
    invoices: stub("Invoices", ["Not built yet. List and create form (PayPal Invoicing)."]),
    settings: stub("Settings", [`Weekly spending limit: ${money(S.merchant.weeklyLimit)} (from data.js).`]),
  };

  function render() {
    const route = location.hash.replace(/^#\//, "") || "home";
    const view = ROUTES[route] || ROUTES.home;
    document.getElementById("app").innerHTML = view();
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", render);
  render();
})();
