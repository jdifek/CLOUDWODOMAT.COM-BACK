// services/statsSync.js  (ESM, для CRM-бэкенда)
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import prisma from '../utils/prisma.js';
import { logger } from '../utils/logger.js';
// Перенести getConsumeList(appid, saler, beginTime, endTime, page) из bot/src/services/apiClient.js
import { getConsumeList } from './chinaApi.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

// Часовой пояс, по которому режем "дни" в статистике. ВЫБЕРИТЕ ОДИН и не меняйте (для Польши — Europe/Warsaw, как на фронте).
const STATS_TZ = process.env.STATS_TZ || 'Europe/Warsaw';
const API_TZ = 'Asia/Shanghai'; // китайский API отдаёт/принимает время в UTC+8

const RETENTION_DAYS = 1000;        // сколько дней храним в базе (удаляем только записи старше)
const PAGE_SIZE = 20;               // API отдаёт по 20 записей на страницу
const MAX_PAGES = 500;              // защита от бесконечного цикла
const OVERLAP_MIN = 15;             // перекрытие окон; дубли отсекает unique(saler, payId)
const CHUNK_HOURS = 12;             // размер одного окна запроса
const FORWARD_CHUNKS_PER_RUN = 20;  // догон "вперёд" после простоя
const REQUEST_DELAY_MS = 500;       // пауза между страницами
const RUN_EVERY_MS = 5 * 60 * 1000;

// ── Устойчивость к сбоям китайского API ──
const RETRIES = 3;                          // повторы одного запроса (всего 4 попытки)
const RETRY_BASE_MS = 2000;                 // пауза между попытками: 2с, 4с, 8с
const COOLDOWN_STEPS_MIN = [5, 10, 20, 40, 60]; // пауза для аккаунта после подряд идущих сбоев
const GLOBAL_PAUSE_MIN = 10;                // если API не отвечает у нескольких аккаунтов подряд
const GLOBAL_FAIL_LIMIT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toApi = (d) => dayjs(d).tz(API_TZ).format('YYYY-MM-DD HH:mm:ss');
const fromApi = (s) => dayjs.tz(s, 'YYYY-MM-DD HH:mm:ss', API_TZ).toDate();
const dayOf = (d) => dayjs(d).tz(STATS_TZ).format('YYYY-MM-DD');
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// ── Здоровье аккаунта: после сбоя пауза растёт 5 → 10 → 20 → 40 → 60 мин ──
function makeHealth() {
  const m = new Map();
  return {
    can: (k) => {
      const h = m.get(k);
      return !h || Date.now() >= h.nextTryAt;
    },
    ok: (k) => m.delete(k),
    fail: (k) => {
      const h = m.get(k) || { fails: 0, nextTryAt: 0 };
      h.fails += 1;
      const mins = COOLDOWN_STEPS_MIN[Math.min(h.fails - 1, COOLDOWN_STEPS_MIN.length - 1)];
      h.nextTryAt = Date.now() + mins * 60_000;
      m.set(k, h);
      return mins;
    },
  };
}
const fwdHealth = makeHealth(); // догон новых данных

// ── Одна страница с повторами и нарастающей паузой ──
async function fetchPage(appid, saler, begin, end, page) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await getConsumeList(appid, saler, begin, end, page);

      // null = сеть / таймаут / HTTP-ошибка (в т.ч. 429, 5xx) → пробуем ещё раз
      if (res === null || res === undefined) throw new Error('request failed (network/timeout/HTTP)');

      // Код 022 ("数据不存在" = данных нет) — штатный ответ на период без записей
      if (String(res.code) === '022') return { empty: true, data: [] };

      // Любой другой не-0 код — ошибка API
      if (res.code !== 0 || !Array.isArray(res.data)) {
        throw new Error(`API error: ${JSON.stringify(res).slice(0, 200)}`);
      }
      return { empty: false, data: res.data };
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw new Error(`saler=${saler} page=${page} ${begin}→${end}: ${lastErr.message}`);
}

// ── Выгрузка диапазона [begin, end] (строки в часовом поясе API) со всеми страницами ──
async function fetchRange(appid, saler, begin, end) {
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    await sleep(REQUEST_DELAY_MS); // не заваливаем API запросами
    const r = await fetchPage(appid, saler, begin, end, page);
    if (r.empty) return all;
    all.push(...r.data);
    if (r.data.length < PAGE_SIZE) return all;
  }
  throw new Error(`window too large (>${MAX_PAGES} pages) saler=${saler} ${begin}→${end}`);
}

// API хранит записи по годам (параметр year берётся из beginTime), поэтому окно,
// пересекающее границу года, запрашиваем двумя частями.
async function fetchWindow(appid, saler, from, to) {
  const begin = toApi(from);
  const end = toApi(to);
  const y1 = begin.slice(0, 4);
  const y2 = end.slice(0, 4);
  if (y1 === y2) return fetchRange(appid, saler, begin, end);

  const a = await fetchRange(appid, saler, begin, `${y1}-12-31 23:59:59`);
  const b = await fetchRange(appid, saler, `${y2}-01-01 00:00:00`, end);
  return [...a, ...b];
}

// Тип оплаты — та же логика, что classifyPath на фронте (card / cash / qr / terminal)
function classifyPay(rec) {
  if (String(rec.pay_id ?? '').endsWith('_pos')) return 'terminal';
  const path = String(rec.path || '').toLowerCase();
  const cardNum = rec.card_num;
  if (!path) return 'qr';
  if (path === 'shop' && cardNum && cardNum !== 'coin' && cardNum !== 'qrcode') return 'card';
  if (path.includes('card') || path.includes('卡')) return 'card';
  if (path === 'coin' || path.includes('cash') || path.includes('现金') || path.includes('投币')) return 'cash';
  return 'qr';
}

function normalize(saler, rec) {
  const payId = rec.pay_id || rec.key_id || rec.alipay_number || rec.id;
  const deviceId = rec.shop_num || rec.card_num;
  if (!payId || !deviceId || !rec.time) return null;

  const liters = num(rec.water1) + num(rec.water2);
  const amount = num(rec.cost_value || rec.value);
  const paidAt = fromApi(rec.time);

  return {
    saler,
    payId: String(payId),
    deviceId: String(deviceId),
    location: rec.location || null,
    paidAt,
    day: dayOf(paidAt),
    liters,
    amount,
    noDispense: amount > 0 && liters === 0,
    payType: classifyPay(rec),
    raw: rec, // исходная запись API целиком (для вкладки "Потребление")
  };
}

// ── Пересчёт агрегата из сырых данных (идемпотентно, двойного счёта нет) ──
async function rebuildDailyStats(saler, days) {
  if (!days.length) return;
  await prisma.$executeRaw`
    INSERT INTO "DailyStat"
      ("saler","deviceId","day","location","liters","amount","txCount","noDispenseCount",
       "cardCount","cashCount","qrCount","terminalCount","updatedAt")
    SELECT "saler","deviceId","day", MAX("location"),
           SUM("liters"), SUM("amount"), COUNT(*)::int,
           (COUNT(*) FILTER (WHERE "noDispense"))::int,
           (COUNT(*) FILTER (WHERE "payType" = 'card'))::int,
           (COUNT(*) FILTER (WHERE "payType" = 'cash'))::int,
           (COUNT(*) FILTER (WHERE "payType" = 'qr'))::int,
           (COUNT(*) FILTER (WHERE "payType" = 'terminal'))::int,
           NOW()
    FROM "Transaction"
    WHERE "saler" = ${saler} AND "day" = ANY(${days}::text[])
    GROUP BY "saler","deviceId","day"
    ON CONFLICT ("saler","deviceId","day") DO UPDATE SET
      "location" = EXCLUDED."location",
      "liters" = EXCLUDED."liters",
      "amount" = EXCLUDED."amount",
      "txCount" = EXCLUDED."txCount",
      "noDispenseCount" = EXCLUDED."noDispenseCount",
      "cardCount" = EXCLUDED."cardCount",
      "cashCount" = EXCLUDED."cashCount",
      "qrCount" = EXCLUDED."qrCount",
      "terminalCount" = EXCLUDED."terminalCount",
      "updatedAt" = NOW()
  `;
}

async function loadWindow(acc, from, to) {
  const raw = await fetchWindow(acc.appid, acc.saler, from, to);
  const rows = raw.map((r) => normalize(acc.saler, r)).filter(Boolean);
  if (raw.length !== rows.length) {
    logger.warn(`[stats ${acc.saler}] skipped ${raw.length - rows.length} records without payId/device/time`);
  }
  if (!rows.length) return 0;

  // 1) Новые записи добавляем, существующие пропускаем (дубли невозможны)
  await prisma.transaction.createMany({ data: rows, skipDuplicates: true });

  // 2) "Дозаполнение": у записей, собранных старой версией (raw пустой), проставляем
  //    исходную запись API и тип оплаты. Остальные (raw уже есть) не трогаем.
  const patch = rows.map((r) => ({ payId: r.payId, payType: r.payType, raw: r.raw }));
  await prisma.$executeRaw`
    UPDATE "Transaction" t
    SET "raw" = v."raw", "payType" = v."payType"
    FROM jsonb_to_recordset(${JSON.stringify(patch)}::jsonb) AS v("payId" text, "payType" text, "raw" jsonb)
    WHERE t."saler" = ${acc.saler} AND t."payId" = v."payId" AND t."raw" IS NULL
  `;

  // 3) Агрегат по дням пересчитываем из сырых записей (после дозаполнения)
  await rebuildDailyStats(acc.saler, [...new Set(rows.map((r) => r.day))]);
  return rows.length;
}

// ── Один аккаунт: только догон вперёд (историю назад не докачиваем) ──
const inFlight = new Set(); // защита от двойного запуска (планировщик + кнопка в админке)

const setError = (saler, msg) =>
  prisma.syncState
    .update({ where: { saler }, data: { lastRunAt: new Date(), lastError: String(msg).slice(0, 500) } })
    .catch(() => {});

// true = догон прошёл, false = ошибка догона, undefined = уже выполняется
export async function syncAccount(acc) {
  if (inFlight.has(acc.saler)) return undefined;
  inFlight.add(acc.saler);
  try {
    return await syncAccountInner(acc);
  } finally {
    inFlight.delete(acc.saler);
  }
}

async function syncAccountInner(acc) {
  const { saler } = acc;
  const now = dayjs();

  let st = await prisma.syncState.upsert({
    where: { saler },
    create: { saler, appid: acc.appid },
    update: { appid: acc.appid },
  });

  // Вперёд. Курсор двигается только после успешной загрузки окна —
  // при сбое следующая попытка продолжит с того же места, данные не теряются.
  // backfilledFrom задаётся один раз при первом запуске и дальше не меняется
  // (нужен для getCoverage — "загружено с").
  try {
    if (!st.syncedTo) {
      const from = now.subtract(1, 'hour');
      await loadWindow(acc, from, now);
      st = await prisma.syncState.update({
        where: { saler },
        data: { syncedTo: now.toDate(), backfilledFrom: from.toDate() },
      });
    }

    let cursor = dayjs(st.syncedTo).subtract(OVERLAP_MIN, 'minute');
    for (let i = 0; i < FORWARD_CHUNKS_PER_RUN && cursor.isBefore(now); i++) {
      const next = cursor.add(CHUNK_HOURS, 'hour');
      const to = next.isAfter(now) ? now : next;
      await loadWindow(acc, cursor, to);
      await prisma.syncState.update({ where: { saler }, data: { syncedTo: to.toDate() } });
      cursor = to;
    }

    await prisma.syncState.update({ where: { saler }, data: { lastRunAt: new Date(), lastError: null } });
  } catch (err) {
    logger.error(`[stats ${saler}] forward sync error: ${err.message}`);
    await setError(saler, err.message);
    return false;
  }

  return true;
}

// Удаляем только то, что старше RETENTION_DAYS (1000 дней)
async function prune() {
  const cutoff = dayjs().tz(STATS_TZ).subtract(RETENTION_DAYS, 'day').format('YYYY-MM-DD');
  const a = await prisma.transaction.deleteMany({ where: { day: { lt: cutoff } } });
  const b = await prisma.dailyStat.deleteMany({ where: { day: { lt: cutoff } } });
  logger.info(`[stats] prune < ${cutoff}: tx=${a.count}, daily=${b.count}`);
}

// ── Планировщик (по одному аккаунту за раз — китайский API не перегружаем) ──
let running = false;
let lastPrune = 0;
let pausedUntil = 0;

export async function runStatsSync() {
  if (running) return; // не допускаем наложения прогонов
  if (Date.now() < pausedUntil) return; // общая пауза: API не отвечает
  running = true;
  try {
    const accounts = await prisma.user.findMany({
      where: {
        appid: { not: null },
        saler: { not: null },
        subscription: {
          is: {
            status: 'ACTIVE',
            OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }],
          },
        },
      },
      select: { appid: true, saler: true },
      distinct: ['saler'],
    });

    let consecutiveFails = 0;
    for (const acc of accounts) {
      if (!fwdHealth.can(acc.saler)) continue; // аккаунт "отдыхает" после сбоев

      const ok = await syncAccount(acc);
      if (ok === true) {
        fwdHealth.ok(acc.saler);
        consecutiveFails = 0;
      } else if (ok === false) {
        const mins = fwdHealth.fail(acc.saler);
        logger.warn(`[stats ${acc.saler}] sync failed, next attempt in ${mins} min`);
        if (++consecutiveFails >= GLOBAL_FAIL_LIMIT) {
          pausedUntil = Date.now() + GLOBAL_PAUSE_MIN * 60_000;
          logger.warn(`[stats] китайский API не отвечает у ${consecutiveFails} аккаунтов подряд — пауза ${GLOBAL_PAUSE_MIN} мин`);
          break;
        }
      }
    }

    if (Date.now() - lastPrune > 24 * 3600 * 1000) {
      await prune();
      lastPrune = Date.now();
    }
  } catch (err) {
    logger.error(`[stats] runStatsSync error: ${err.message}`);
  } finally {
    running = false;
  }
}

export function startStatsSync() {
  setTimeout(runStatsSync, 10_000);
  setInterval(runStatsSync, RUN_EVERY_MS);
}