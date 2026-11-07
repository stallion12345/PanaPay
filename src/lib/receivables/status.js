const CHICAGO_TZ = 'America/Chicago';

function toChicagoDateKey(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  if (!map.year || !map.month || !map.day) {
    return null;
  }

  return `${map.year}-${map.month}-${map.day}`;
}

function compareDateKeysDescending(left, right) {
  const leftKey = toChicagoDateKey(left);
  const rightKey = toChicagoDateKey(right);

  if (!leftKey && !rightKey) {
    return 0;
  }
  if (!leftKey) {
    return -1;
  }
  if (!rightKey) {
    return 1;
  }
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey > rightKey ? 1 : -1;
}

function getLatestOpenPromise(promises = []) {
  const openPromises = (Array.isArray(promises) ? promises : []).filter((promise) => {
    if (!promise || promise.status !== 'open') {
      return false;
    }

    return Boolean(toChicagoDateKey(promise.promised_date));
  });

  if (openPromises.length === 0) {
    return null;
  }

  return openPromises.reduce((latest, current) => {
    if (!latest) {
      return current;
    }

    const comparison = compareDateKeysDescending(current.promised_date, latest.promised_date);
    if (comparison === 0) {
      const currentCreated = new Date(current.created_at ?? 0).getTime();
      const latestCreated = new Date(latest.created_at ?? 0).getTime();
      return currentCreated >= latestCreated ? current : latest;
    }

    return comparison > 0 ? current : latest;
  }, null);
}

export function getStatusReasonLabel(result) {
  if (!result || result.reason !== 'no_due_date') {
    return null;
  }

  return 'No due date';
}

export function derive({ invoice = {}, promises = [], now } = {}) {
  const amountCents = Number(invoice.amount_cents ?? 0);
  const paidCents = Number(invoice.paid_cents ?? 0);
  const dueKey = toChicagoDateKey(invoice.due_at);
  const todayKey = toChicagoDateKey(now);
  const paidAtKey = toChicagoDateKey(invoice.paid_at);

  const result = (status, reason = null) => ({ status, reason: reason === 'no_due_date' ? 'no_due_date' : null });

  if (paidCents >= amountCents) {
    if (paidAtKey && dueKey && paidAtKey > dueKey) {
      return result('paid_late');
    }
    return result('paid');
  }

  if (paidCents > 0 && paidCents < amountCents) {
    return result('partially_paid');
  }

  const latestOpenPromise = getLatestOpenPromise(promises);
  if (latestOpenPromise) {
    const promisedKey = toChicagoDateKey(latestOpenPromise.promised_date);
    if (promisedKey && promisedKey >= (todayKey ?? '')) {
      return result('promised');
    }
    return result('broken_promise');
  }

  if (!dueKey) {
    return result('issued', 'no_due_date');
  }

  if (todayKey && dueKey === todayKey) {
    return result('due_today');
  }

  if (todayKey && dueKey < todayKey) {
    return result('overdue');
  }

  return result('issued');
}
