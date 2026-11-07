const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

export function weeklyBuckets(entries = [], startDate, weeks = 4) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const count = Number.isInteger(weeks) && weeks > 0 ? weeks : 0;
  if (count === 0) {
    return [];
  }

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    throw new Error('weeklyBuckets requires a valid startDate');
  }

  const anchor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const buckets = Array.from({ length: count }, (_, index) => {
    const bucketStart = new Date(anchor.getTime() + (index * MS_PER_WEEK));
    const bucketEnd = new Date(anchor.getTime() + ((index + 1) * MS_PER_WEEK));

    return {
      index,
      label: `Week ${index + 1}`,
      start: bucketStart.toISOString(),
      end: bucketEnd.toISOString(),
      in: 0,
      out: 0,
    };
  });

  for (const entry of entries) {
    if (!entry || Number.isNaN(new Date(entry.occurred_at || entry.date || entry.when).getTime())) {
      continue;
    }

    const occurredAt = new Date(entry.occurred_at || entry.date || entry.when);
    const dayUtc = Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate());
    const anchorUtc = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
    const diffMs = dayUtc - anchorUtc;
    const weekIndex = Math.floor(diffMs / MS_PER_WEEK);

    if (weekIndex < 0 || weekIndex >= count) {
      continue;
    }

    const rawAmount = Number(entry.amount_cents ?? entry.amount ?? 0);
    const direction = String(entry.direction ?? entry.type ?? '').toLowerCase();
    const bucket = buckets[weekIndex];

    if (direction === 'in') {
      bucket.in += rawAmount;
      continue;
    }

    if (direction === 'out') {
      bucket.out += rawAmount;
      continue;
    }

    if (rawAmount >= 0) {
      bucket.in += rawAmount;
    } else {
      bucket.out += Math.abs(rawAmount);
    }
  }

  return buckets;
}

export function projectBalance(openingCents = 0, buckets = []) {
  let runningBalance = Number(openingCents) || 0;

  return buckets.map((bucket) => {
    const inAmount = Number(bucket.in ?? 0);
    const outAmount = Number(bucket.out ?? 0);
    const net = inAmount - outAmount;
    const previousBalance = runningBalance;
    runningBalance += net;

    return {
      ...bucket,
      openingCents: previousBalance,
      net,
      balance: runningBalance,
    };
  });
}

export function lowPoint(projection = []) {
  if (!Array.isArray(projection) || projection.length === 0) {
    return { weekIndex: 0, label: '', amount: 0 };
  }

  let lowest = {
    weekIndex: Number(projection[0].index ?? 0),
    label: String(projection[0].label || 'Week 1'),
    amount: Number(projection[0].balance ?? 0),
  };

  for (const bucket of projection) {
    const amount = Number(bucket.balance ?? 0);
    if (amount < lowest.amount) {
      lowest = {
        weekIndex: Number(bucket.index ?? 0),
        label: String(bucket.label || `Week ${Number(bucket.index ?? 0) + 1}`),
        amount,
      };
    }
  }

  return lowest;
}

export function limitAlarm(spentCents, limitCents) {
  const spent = Number(spentCents) || 0;
  const limit = Number(limitCents) || 0;

  if (limit <= 0) {
    return {
      level: spent > 0 ? 'over' : 'ok',
      percent: spent > 0 ? 100 : 0,
    };
  }

  const percent = (spent / limit) * 100;

  if (percent > 100) {
    return { level: 'over', percent: Number(percent.toFixed(2)) };
  }

  if (percent >= 80) {
    return { level: 'watch', percent: Number(percent.toFixed(2)) };
  }

  return { level: 'ok', percent: Number(percent.toFixed(2)) };
}
