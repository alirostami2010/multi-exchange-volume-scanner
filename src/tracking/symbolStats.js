// File: src/tracking/symbolStats.js
// Per-symbol signal history. INFORMATIONAL ONLY.
// These statistics are NOT used in scoring, filtering or signal decisions.

const EPSILON = 0.000001;

function percent(count, total) {
  if (!(total > 0)) return '—';
  return (count / total * 100).toFixed(0) + '%';
}

function emptyStats(symbol) {
  return {
    symbol,
    issued: 0,
    wins: 0,
    losses: 0,
    flat: 0,
    ambiguous: 0,
    expired: 0,
    open: 0,
    deliveryUnknown: 0,
    closed: 0,
    sumNetPct: 0,
    longClosed: 0,
    longWins: 0,
    shortClosed: 0,
    shortWins: 0,
  };
}

function addSignal(stats, signal) {
  if (signal.status === 'DELIVERY_UNKNOWN') {
    stats.deliveryUnknown++;
    return;
  }

  if (!signal.sentAt) return;

  stats.issued++;

  if (signal.status === 'AMBIGUOUS') {
    stats.ambiguous++;
    return;
  }

  if (signal.status === 'EXPIRED_NO_ENTRY') {
    stats.expired++;
    return;
  }

  if (signal.status !== 'CLOSED') {
    stats.open++;
    return;
  }

  if (!Number.isFinite(signal.netPct)) return;

  stats.closed++;
  stats.sumNetPct += signal.netPct;

  const won = signal.netPct > EPSILON;

  if (won) {
    stats.wins++;
  } else if (signal.netPct < -EPSILON) {
    stats.losses++;
  } else {
    stats.flat++;
  }

  if (signal.side === 'LONG') {
    stats.longClosed++;
    if (won) stats.longWins++;
  }

  if (signal.side === 'SHORT') {
    stats.shortClosed++;
    if (won) stats.shortWins++;
  }
}

export function symbolStats(state, symbol, excludeId = null) {
  const stats = emptyStats(symbol);
  const signals = Object.values(state.signals);

  for (const signal of signals) {
    if (signal.symbol !== symbol) continue;
    if (excludeId != null && signal.id === excludeId) continue;

    addSignal(stats, signal);
  }

  return stats;
}

export function symbolHistoryLine(stats) {
  const lines = [];

  lines.push('📁 سابقه سیگنال‌های ' + stats.symbol + ' (فقط اطلاع‌رسانی):');

  if (stats.issued === 0) {
    lines.push('اولین سیگنال ثبت‌شده برای این ارز است.');
    return lines.join('\n');
  }

  lines.push(
    'ارسال‌شده: ' + stats.issued +
    ' | بسته‌شده: ' + stats.closed +
    ' | باز/منتظر: ' + stats.open
  );

  if (stats.closed > 0) {
    lines.push(
      '✅ موفق: ' + stats.wins + ' (' + percent(stats.wins, stats.closed) + ')' +
      ' | ❌ ناموفق: ' + stats.losses + ' (' + percent(stats.losses, stats.closed) + ')' +
      ' | ➖ سربه‌سر: ' + stats.flat
    );

    const average = stats.sumNetPct / stats.closed;
    const sign = average >= 0 ? '+' : '';

    lines.push('میانگین نتیجه خالص فرضی: ' + sign + average.toFixed(2) + '%');
  } else {
    lines.push('هنوز معامله فرضی بسته‌شده‌ای ندارد.');
  }

  lines.push(
    'مبهم: ' + stats.ambiguous +
    ' | بدون ورود: ' + stats.expired
  );

  if (stats.closed < 5) {
    lines.push('نمونه کم است؛ برای نتیجه‌گیری قابل اتکا نیست.');
  }

  lines.push('این آمار در امتیاز یا تصمیم ربات اثری ندارد.');

  return lines.join('\n');
}

export function symbolReportMessage(state, maxSymbols = 30) {
  const bySymbol = new Map();

  for (const signal of Object.values(state.signals)) {
    if (!bySymbol.has(signal.symbol)) {
      bySymbol.set(signal.symbol, emptyStats(signal.symbol));
    }

    addSignal(bySymbol.get(signal.symbol), signal);
  }

  const rows = [...bySymbol.values()]
    .filter(stats => stats.issued > 0)
    .sort((a, b) => {
      const issuedDifference = b.issued - a.issued;
      if (issuedDifference !== 0) return issuedDifference;
      return a.symbol.localeCompare(b.symbol);
    });

  const lines = [
    '📁 گزارش عملکرد به تفکیک ارز (فقط اطلاع‌رسانی)',
    'موفق/ناموفق فقط بین معاملات بسته‌شده و غیرمبهم محاسبه شده است.',
    '━━━━━━━━━━━━━━━━━━',
  ];

  if (rows.length === 0) {
    lines.push('هنوز سیگنال ارسال‌شده‌ای برای گزارش وجود ندارد.');
    return lines.join('\n');
  }

  for (const stats of rows.slice(0, maxSymbols)) {
    let line =
      stats.symbol +
      ' | ارسال ' + stats.issued +
      ' | بسته ' + stats.closed;

    if (stats.closed > 0) {
      line +=
        ' | ✅ ' + stats.wins + ' (' + percent(stats.wins, stats.closed) + ')' +
        ' | ❌ ' + stats.losses + ' (' + percent(stats.losses, stats.closed) + ')';
    }

    if (stats.longClosed > 0) {
      line += ' | L ' + percent(stats.longWins, stats.longClosed);
    }

    if (stats.shortClosed > 0) {
      line += ' | S ' + percent(stats.shortWins, stats.shortClosed);
    }

    if (stats.ambiguous > 0) {
      line += ' | مبهم ' + stats.ambiguous;
    }

    if (stats.expired > 0) {
      line += ' | بدون ورود ' + stats.expired;
    }

    lines.push(line);
  }

  if (rows.length > maxSymbols) {
    lines.push('… و ' + (rows.length - maxSymbols) + ' ارز دیگر');
  }

  lines.push(
    '━━━━━━━━━━━━━━━━━━',
    'L و S = درصد موفقیت لانگ و شورت در معاملات بسته‌شده.',
    'نمونه‌های کم قابل اتکا نیستند؛ این آمار در تصمیم ربات اثری ندارد.',
    'نتایج فرضی‌اند و بر اساس داده Gate؛ سود واقعی حساب LBank نیستند.'
  );

  return lines.join('\n');
}
