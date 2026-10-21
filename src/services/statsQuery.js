// services/statsQuery.js — общие запросы статистики (используют и /api/stats, и /api/admin/stats)
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import prisma from '../utils/prisma.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const STATS_TZ = process.env.STATS_TZ || 'Europe/Warsaw';
const MAX_RANGE_DAYS = 1000; // максимальный период запроса (= срок хранения в statsSync.js)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = [
  'liters', 'amount', 'txCount', 'noDispenseCount',
  'cardCount', 'cashCount', 'qrCount', 'terminalCount',
];
const SUM = Object.fromEntries(KEYS.map((k) => [k, true]));
const flat = (s = {}) => Object.fromEntries(KEYS.map((k) => [k, s[k] || 0]));
const sumTotal = (rows) =>
  rows.reduce((a, r) => {
    for (const k of KEYS) a[k] += r[k];
    return a;
  }, flat());

export function parseRange(q) {
  const today = dayjs().tz(STATS_TZ).format('YYYY-MM-DD');
  const to = DATE_RE.test(q.to) ? q.to : today;
  const from = DATE_RE.test(q.from) ? q.from : dayjs(to).subtract(29, 'day').format('YYYY-MM-DD');
  if (dayjs(to).diff(dayjs(from), 'day') > MAX_RANGE_DAYS) {
    throw Object.assign(new Error(`Max range is ${MAX_RANGE_DAYS} days`), { status: 400 });
  }
  return { from, to };
}

// Заполняем дни без продаж нулями — удобно для графиков
function fillDays(from, to, rows) {
  const map = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let d = dayjs(from); !d.isAfter(dayjs(to)); d = d.add(1, 'day')) {
    const key = d.format('YYYY-MM-DD');
    out.push(map.get(key) || { day: key, ...flat() });
  }
  return out;
}

export async function getCoverage(saler) {
  const s = await prisma.syncState.findUnique({ where: { saler } });
  return {
    loadedFrom: s?.backfilledFrom ?? null,
    loadedTo: s?.syncedTo ?? null,
    lastRunAt: s?.lastRunAt ?? null,
    lastError: s?.lastError ?? null,
  };
}

export async function getAccountByUserId(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, appid: true, saler: true },
  });
  if (!u || !u.appid || !u.saler) return null;
  return { userId: u.id, appid: u.appid, saler: u.saler };
}

// Вкладка "Все автоматы"
export async function buildOverview(saler, from, to) {
  const where = { saler, day: { gte: from, lte: to } };

  const [byDay, byDevice, coverage] = await Promise.all([
    prisma.dailyStat.groupBy({ by: ['day'], where, _sum: SUM, orderBy: { day: 'asc' } }),
    prisma.dailyStat.groupBy({ by: ['deviceId'], where, _sum: SUM, _max: { location: true } }),
    getCoverage(saler),
  ]);

  const days = byDay.map((r) => ({ day: r.day, ...flat(r._sum) }));
  const devices = byDevice
    .map((r) => ({ deviceId: r.deviceId, location: r._max.location, ...flat(r._sum) }))
    .sort((a, b) => b.amount - a.amount);

  return {
    range: { from, to },
    coverage,
    total: sumTotal(days),
    byDay: fillDays(from, to, days),
    byDevice: devices,
  };
}

// Вкладка "Один автомат"
export async function buildDevice(saler, deviceId, from, to) {
  const where = { saler, deviceId, day: { gte: from, lte: to } };

  const [byDay, recent, last, coverage, ports] = await Promise.all([
    prisma.dailyStat.groupBy({ by: ['day'], where, _sum: SUM, orderBy: { day: 'asc' } }),
    prisma.transaction.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take: 50,
      select: { payId: true, paidAt: true, liters: true, amount: true, noDispense: true },
    }),
    prisma.dailyStat.findFirst({
      where: { saler, deviceId },
      orderBy: { day: 'desc' },
      select: { location: true },
    }),
    getCoverage(saler),
    // Разбивка воды по портам берём из исходных записей (raw)
    prisma.$queryRaw`
      SELECT COALESCE(SUM(NULLIF("raw"->>'water1', '')::float), 0)::float AS "water1",
             COALESCE(SUM(NULLIF("raw"->>'water2', '')::float), 0)::float AS "water2"
      FROM "Transaction"
      WHERE "saler" = ${saler} AND "deviceId" = ${deviceId}
        AND "day" >= ${from} AND "day" <= ${to}
    `,
  ]);

  const days = byDay.map((r) => ({ day: r.day, ...flat(r._sum) }));

  return {
    range: { from, to },
    coverage,
    device: { deviceId, location: last?.location ?? null },
    ports: ports[0] ?? { water1: 0, water2: 0 },
    total: sumTotal(days),
    byDay: fillDays(from, to, days),
    recent,
  };
}

// Список автоматов, по которым есть данные (для выпадающего списка)
export async function listDevices(saler) {
  const rows = await prisma.dailyStat.groupBy({
    by: ['deviceId'],
    where: { saler },
    _max: { location: true, day: true },
  });
  return rows
    .map((r) => ({ deviceId: r.deviceId, location: r._max.location, lastActiveDay: r._max.day }))
    .sort((a, b) => String(a.location || a.deviceId).localeCompare(String(b.location || b.deviceId)));
}

// Почасовая разбивка (для графика "по часам"); deviceId необязателен
export async function buildHourly(saler, from, to, deviceId = null) {
  return prisma.$queryRaw`
    SELECT "day",
           EXTRACT(HOUR FROM (("paidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${STATS_TZ}))::int AS "hour",
           COUNT(*)::int AS "sales",
           COALESCE(SUM("amount"), 0)::float AS "revenue",
           COALESCE(SUM("liters"), 0)::float AS "liters"
    FROM "Transaction"
    WHERE "saler" = ${saler}
      AND "day" >= ${from} AND "day" <= ${to}
      AND (${deviceId}::text IS NULL OR "deviceId" = ${deviceId})
    GROUP BY "day", 2
    ORDER BY "day", 2
  `;
}

// Список транзакций одного автомата (новые сверху), постранично по курсору "paidAt|id"
export async function buildTransactions(saler, deviceId, cursor = null, limit = 30) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);

  let cursorWhere = {};
  if (cursor) {
    const [iso, id] = String(cursor).split('|');
    const t = new Date(iso);
    if (!Number.isNaN(t.getTime()) && id) {
      cursorWhere = { OR: [{ paidAt: { lt: t } }, { paidAt: t, id: { lt: id } }] };
    }
  }

  const rows = await prisma.transaction.findMany({
    where: { saler, deviceId, ...cursorWhere },
    orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    select: { id: true, paidAt: true, raw: true },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((r) => r.raw).filter(Boolean),
    nextCursor: hasMore && last ? `${last.paidAt.toISOString()}|${last.id}` : null,
    coverage: await getCoverage(saler),
  };
}