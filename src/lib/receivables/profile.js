import { toChicagoDateKey } from './status.js';

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function dayDifferenceInDays(startValue, endValue) {
  const startKey = toChicagoDateKey(startValue);
  const endKey = toChicagoDateKey(endValue);

  if (!startKey || !endKey) {
    return 0;
  }

  const [startYear, startMonth, startDay] = startKey.split('-').map(Number);
  const [endYear, endMonth, endDay] = endKey.split('-').map(Number);

  const startMs = Date.UTC(startYear, startMonth - 1, startDay);
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.max(0, Math.round((endMs - startMs) / 86400000));
}

function quotedMethod(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value).trim();
}

function getUsualMethod(payments) {
  const methodCounts = new Map();
  for (const payment of normalizeArray(payments)) {
    const method = quotedMethod(payment?.method ?? payment?.payment_method ?? payment?.channel ?? payment?.type ?? payment?.source);
    if (!method) {
      continue;
    }
    methodCounts.set(method, (methodCounts.get(method) || 0) + 1);
  }

  if (methodCounts.size === 0) {
    return null;
  }

  let winner = null;
  let bestCount = -1;
  for (const [method, count] of methodCounts.entries()) {
    if (count > bestCount) {
      winner = method;
      bestCount = count;
    }
  }

  return winner;
}

function formatAvgDaysLate(avg) {
  return avg % 1 === 0 ? avg : avg.toFixed(1);
}

function buildEvidence({ paidLateCount, paidCount, lateDaysTotal, unpaidPastDueCount, invoiceCount, enoughHistory }) {
  if (!enoughHistory) {
    return [`Not enough history yet. Based on ${invoiceCount} ${invoiceCount === 1 ? 'invoice' : 'invoices'}.`];
  }

  const avgDaysLate = paidLateCount > 0 ? Number((lateDaysTotal / paidLateCount).toFixed(1)) : 0;
  const lines = [];

  if (paidCount > 0 && paidLateCount > 0) {
    const verb = paidLateCount === 1 ? 'was' : 'were';
    lines.push(`${paidLateCount} of ${paidCount} paid invoices ${verb} paid late, ${formatAvgDaysLate(avgDaysLate)} days late on average.`);
  } else if (paidCount > 0 && paidLateCount === 0) {
    lines.push(`All ${paidCount} paid invoices were paid on time.`);
  }

  if (unpaidPastDueCount > 0) {
    lines.push(`${unpaidPastDueCount} more past due and unpaid.`);
  }

  lines.push(`Based on ${invoiceCount} ${invoiceCount === 1 ? 'invoice' : 'invoices'}.`);

  return lines;
}

function hasPastDueUnpaid(invoice, now) {
  const dueAt = invoice?.due_at;
  if (!dueAt) {
    return false;
  }

  const amountCents = Number(invoice?.amount_cents ?? 0);
  const paidCents = Number(invoice?.paid_cents ?? 0);
  if (paidCents >= amountCents) {
    return false;
  }

  const dueDate = toChicagoDateKey(dueAt);
  const todayKey = toChicagoDateKey(now ?? new Date().toISOString());
  if (!dueDate || !todayKey) {
    return false;
  }

  return dueDate < todayKey;
}

export function buildProfile({ invoices = [], promises = [], payments = [], now = new Date().toISOString() } = {}) {
  const invoiceList = normalizeArray(invoices);
  const promiseList = normalizeArray(promises);

  const invoiceCount = invoiceList.length;
  const totalInvoicedCents = invoiceList.reduce((sum, invoice) => sum + Number(invoice?.amount_cents ?? 0), 0);
  const totalPaidCents = invoiceList.reduce((sum, invoice) => sum + Number(invoice?.paid_cents ?? 0), 0);
  const outstandingCents = Math.max(totalInvoicedCents - totalPaidCents, 0);

  const lateInvoices = [];
  for (const invoice of invoiceList) {
    const amountCents = Number(invoice?.amount_cents ?? 0);
    const paidCents = Number(invoice?.paid_cents ?? 0);
    const paidAt = invoice?.paid_at;
    const dueAt = invoice?.due_at;

    if (amountCents <= 0 || paidCents < amountCents) {
      continue;
    }

    if (!paidAt || !dueAt) {
      continue;
    }

    const lateDays = dayDifferenceInDays(dueAt, paidAt);
    if (lateDays > 0) {
      lateInvoices.push(lateDays);
    }
  }

  const paidLateCount = lateInvoices.length;
  const lateDaysTotal = lateInvoices.reduce((sum, value) => sum + value, 0);
  const avgDaysLate = paidLateCount > 0 ? Number((lateDaysTotal / paidLateCount).toFixed(1)) : 0;

  const paidCount = invoiceList.filter((invoice) => {
    const amountCents = Number(invoice?.amount_cents ?? 0);
    const paidCents = Number(invoice?.paid_cents ?? 0);
    return amountCents > 0 && paidCents >= amountCents;
  }).length;

  const historyInvoices = invoiceList.filter((invoice) => {
    const amountCents = Number(invoice?.amount_cents ?? 0);
    const paidCents = Number(invoice?.paid_cents ?? 0);
    if (paidCents >= amountCents) {
      return true;
    }
    return hasPastDueUnpaid(invoice, now);
  });

  const unpaidPastDueCount = historyInvoices.filter((invoice) => {
    const amountCents = Number(invoice?.amount_cents ?? 0);
    const paidCents = Number(invoice?.paid_cents ?? 0);
    return paidCents < amountCents;
  }).length;

  const enoughHistory = historyInvoices.length >= 3;

  const promisesMade = promiseList.filter((promise) => promise && promise.status && promise.status !== 'unconfirmed').length;
  const promisesKept = promiseList.filter((promise) => promise && promise.status === 'kept').length;
  const promisesBroken = promiseList.filter((promise) => promise && promise.status === 'broken').length;

  const usualMethod = getUsualMethod(payments);
  let label = null;
  if (enoughHistory) {
    if (paidLateCount === 0) {
      label = 'Usually on time';
    } else if (paidLateCount >= Math.ceil(invoiceCount / 2) && invoiceCount > 0) {
      label = 'Usually late';
    } else {
      label = 'Mixed';
    }
  }

  const evidence = buildEvidence({
    paidLateCount,
    paidCount,
    lateDaysTotal,
    unpaidPastDueCount,
    invoiceCount: historyInvoices.length || invoiceCount,
    enoughHistory,
  });

  return {
    invoiceCount,
    totalInvoicedCents,
    totalPaidCents,
    outstandingCents,
    paidLateCount,
    avgDaysLate,
    promisesMade,
    promisesKept,
    promisesBroken,
    usualMethod,
    enoughHistory,
    label,
    evidence,
  };
}
