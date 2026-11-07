// Seed data for the UI. Single source of truth for the demo story.
// Every number on screen is derived from this file, so nothing contradicts anything else.
// Later: replace with data from your own API/database (same shape).
// Week = Mon-Sun. "Today" is Fri Oct 30, 2026.
window.SEED = {
  merchant: {
    name: "Ngozi's Fabrics",
    currency: "USD",
    // Limit on EVERYDAY spending only (shop running costs). Supplier payouts and rent are planned separately.
    weeklyLimit: 400,
    spentThisWeek: 340,
    today: "Friday, Oct 30",
  },

  // Cash position at the start of "This week"
  openingBalance: 1000,

  // Projected totals per week (all money in / out, including planned payouts)
  weeks: [
    { label: "This week",   in: 1450, out: 1550 },
    { label: "Next week",   in: 650,  out: 1300 }, // = Kola 240 + Mama Nkechi 410 + Rent 600 + 50 other
    { label: "Week of Nov 9",  in: 1950, out: 750 },
    { label: "Week of Nov 16", in: 1500, out: 950 },
  ],

  lowPoint: {
    dateLabel: "Thursday, Nov 5",
    note: "Lowest point: Thursday, Nov 5. Mama Nkechi's payout and shop rent land before more money comes in.",
  },

  // STATIC placeholder. This is where the LLM's explanation will go.
  aiSummary:
    "Next week you pay out $1,250 but only $540 is confirmed coming in. Moving shop rent to the week after would lift your lowest point from $250 to $850.",

  upcoming: [
    { date: "Mon, Nov 2", name: "Kola Enterprises", note: "Retrying after failed payout (Wed, Oct 28)", amount: -240 },
    { date: "Tue, Nov 3", name: "James A. (diaspora)", note: "Invoice payment confirmed", amount: 540 },
    { date: "Thu, Nov 5", name: "Mama Nkechi Stores", note: "Supplier payout, due Thursday", amount: -410 },
    { date: "Fri, Nov 6", name: "Shop rent (landlord)", note: "Scheduled payout", amount: -600 },
  ],

  ledger: [
    { date: "Oct 28", name: "Kola Enterprises", desc: "Supplier payout", category: "Supplies", amount: -240, status: "Failed", conf: 0.96 },
    { date: "Oct 28", name: "Adaeze Textiles", desc: "Invoice #1042", category: "Sales", amount: 780, status: "Completed", conf: 0.99 },
    { date: "Oct 27", name: "Power and data", desc: "Utilities top-up", category: "Utilities", amount: -85, status: "Completed", conf: 0.88 },
    { date: "Oct 27", name: "Chidi O.", desc: "Invoice #1041", category: "Sales", amount: 420, status: "Completed", conf: 0.99 },
    { date: "Oct 26", name: "Market stall fee", desc: "Weekly fee", category: "Other", amount: -60, status: "Completed", conf: 0.52 },
    { date: "Oct 26", name: "Transport", desc: "Delivery to Ibadan", category: "Delivery", amount: -195, status: "Pending", conf: 0.91 },
    { date: "Oct 25", name: "Funke B.", desc: "Invoice #1040", category: "Sales", amount: 250, status: "Refunded", conf: 0.97 },
  ],
};
