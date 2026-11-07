function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function chicagoDayKey(dateLike, fallback = null) {
  const date = parseDate(dateLike) ?? parseDate(fallback);
  if (!date) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  if (!values.year || !values.month || !values.day) {
    return null;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function dayDifferenceInDays(startValue, endValue) {
  const startKey = chicagoDayKey(startValue);
  const endKey = chicagoDayKey(endValue);

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

function buildEvidence({ paidLateCount, lateDaysTotal, invoiceCount, enoughHistory, legacyCount }) {
  const sampleCount = enoughHistory ? Math.max(legacyCount, invoiceCount) : invoiceCount;

  if (sampleCount === 0) {
    return ['No invoice history yet. Based on 0 invoices.'];
  }

  const avgDaysLate = sampleCount > 0 && paidLateCount > 0
    ? Number((lateDaysTotal / paidLateCount).toFixed(1))
    : 0;

  const daysLabel = avgDaysLate === 0 ? '0 days' : `${avgDaysLate % 1 === 0 ? avgDaysLate : avgDaysLate.toFixed(1)} days`;

  if (paidLateCount === 0) {
    return [`Paid 0 of ${sampleCount} invoices late, ${daysLabel} late on average. Based on ${sampleCount} invoices.`];
  }

  return [`Paid ${paidLateCount} of ${sampleCount} invoices late, ${daysLabel} late on average. Based on ${sampleCount} invoices.`];
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

  const dueDate = chicagoDayKey(dueAt);
  const todayKey = chicagoDayKey(now ?? new Date().toISOString());
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

  const historyInvoices = invoiceList.filter((invoice) => {
    const amountCents = Number(invoice?.amount_cents ?? 0);
    const paidCents = Number(invoice?.paid_cents ?? 0);
    if (paidCents >= amountCents) {
      return true;
    }
    return hasPastDueUnpaid(invoice, now);
  });

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
    lateDaysTotal,
    invoiceCount: historyInvoices.length || invoiceCount,
    enoughHistory,
    legacyCount: historyInvoices.length || 0,
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
