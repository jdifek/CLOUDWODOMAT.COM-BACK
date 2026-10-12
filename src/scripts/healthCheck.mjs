// src/scripts/healthCheck.mjs — полная проверка сбора статистики одной командой
// Запуск на сервере из /var/www/backend:
//   node src/scripts/healthCheck.mjs                 — всё, включая сверку с китайским API
//   node src/scripts/healthCheck.mjs --no-api        — только база и логи (быстро)
//   node src/scripts/healthCheck.mjs --days=1,7,30   — какие дни сверять с API (по умолчанию 1 и 7 дней назад)
//   node src/scripts/healthCheck.mjs --fix-daily     — пересчитать DailyStat из Transaction (безопасно)
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import prisma from '../utils/prisma.js';
import { getConsumeList } from '../services/chinaApi.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const args = process.argv.slice(2);
const NO_API = args.includes('--no-api');
const FIX_DAILY = args.includes('--fix-daily');
const daysArg = (args.find((a) => a.startsWith('--days=')) || '--days=1,7').split('=')[1];
const CHECK_DAYS = daysArg.split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0);

const TZ = process.env.STATS_TZ || 'Europe/Warsaw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
const toApi = (s) => dayjs.tz(s, 'YYYY-MM-DD HH:mm:ss', TZ).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');

const problems = []; // { level: 'error'|'warn', text }
const actions = [];
const bad = (text) => problems.push({ level: 'error', text });
const warn = (text) => problems.push({ level: 'warn', text });
const head = (t) => console.log(`\n━━ ${t} ━━`);

// ───────────────────────── 1. Логи ─────────────────────────
function readTail(file, bytes = 6 * 1024 * 1024) {
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

head('1. Логи сервера (последние ~6 МБ)');
{
  const dir = path.join(os.homedir(), '.pm2', 'logs');
  const text = [readTail(path.join(dir, 'backend-out.log')), readTail(path.join(dir, 'backend-error.log'))]
    .filter(Boolean)
    .join('\n');
  if (!text) {
    console.log('Логи pm2 не найдены (имя процесса не "backend"?) — шаг пропущен');
  } else {
    const lines = text.split('\n').filter((l) => l.includes('[stats'));
    const silent = lines.filter((l) => l.includes('treated as no data') && !l.includes('"code":"022"'));
    const cnt = (s) => lines.filter((l) => l.includes(s)).length;
    console.log(`Строк про сбор:                          ${lines.length}`);
    console.log(`Ошибки догона (forward sync error):      ${cnt('forward sync error')}`);
    console.log(`Ошибки докачки (backfill error):         ${cnt('backfill')}`);
    console.log(`Пропущены записи без id (skipped):       ${cnt('skipped')}`);
    console.log(`Паузы из-за недоступности API:           ${cnt('пауза')}`);
    console.log(`Ответы API "как пусто", но код НЕ 022:   ${silent.length}`);
    if (silent.length) {
      bad(`Старая версия кода молча приняла за "нет данных" ${silent.length} ответов API с другим кодом (не 022) — в эти окна данные могли не попасть`);
      silent.slice(-3).forEach((l) => console.log('   пример:', l.slice(0, 220)));
    }
    if (cnt('skipped')) warn('Часть записей API пропущена (нет pay_id/автомата/времени)');
  }
}

// ───────────────────────── 2. Курсоры ─────────────────────────
head('2. Состояние сбора по аккаунтам');
const states = await prisma.syncState.findMany({ orderBy: { saler: 'asc' } });
const stateBy = new Map(states.map((s) => [s.saler, s]));
if (!states.length) bad('Таблица SyncState пуста — сбор ни разу не запускался');
for (const s of states) {
  const lagMin = s.syncedTo ? Math.round((Date.now() - new Date(s.syncedTo).getTime()) / 60000) : null;
  const backDays = s.backfilledFrom ? Math.round((Date.now() - new Date(s.backfilledFrom).getTime()) / 86400000) : 0;
  const flags = [];
  if (lagMin === null || lagMin > 30) { flags.push('⚠ отстаёт'); warn(`${s.saler}: данные отстают на ${lagMin ?? '—'} мин`); }
  if (s.lastError) { flags.push('⚠ ошибка'); warn(`${s.saler}: lastError = ${String(s.lastError).slice(0, 120)}`); }
  console.log(
    `${s.saler.padEnd(14)} догон: ${lagMin === null ? '—' : lagMin + ' мин назад'}, история: ${backDays}/90 дн. ${flags.join(' ')}${
      s.lastError ? '\n               ' + String(s.lastError).slice(0, 140) : ''
    }`
  );
}

// ───────────────────────── 3. Данные ─────────────────────────
head('3. Что лежит в базе');
let stats = [];
try {
  stats = await prisma.$queryRaw`
    SELECT "saler", MIN("day") AS first_day, MAX("day") AS last_day, COUNT(*)::int AS tx,
           COUNT(DISTINCT "day")::int AS days,
           COUNT(*) FILTER (WHERE "raw" IS NULL)::int AS raw_null,
           COUNT(*) FILTER (WHERE "payType" = 'qr')::int AS qr,
           COUNT(*) FILTER (WHERE "payType" = 'card')::int AS card,
           COUNT(*) FILTER (WHERE "payType" = 'cash')::int AS cash,
           COUNT(*) FILTER (WHERE "payType" = 'terminal')::int AS terminal,
           MAX("paidAt") AS last_tx
    FROM "Transaction" GROUP BY "saler" ORDER BY "saler"`;
} catch (e) {
  bad('В таблице Transaction нет колонок payType/raw — миграции не применены (npx prisma migrate deploy)');
  console.log('Ошибка запроса:', e.message.split('\n').pop());
}
for (const r of stats) {
  console.log(`${r.saler.padEnd(14)} ${r.first_day} … ${r.last_day}  записей: ${r.tx}, дней с продажами: ${r.days}`);
  console.log(`               оплаты: карта ${r.card}, наличные ${r.cash}, QR ${r.qr}, терминал ${r.terminal}; без raw: ${r.raw_null}`);
  if (r.raw_null > 0) bad(`${r.saler}: ${r.raw_null} записей без raw (собраны старой версией) — вкладка "Потребление" и разбивка воды по портам неполные`);
  if (r.tx > 50 && r.card + r.cash + r.terminal === 0) bad(`${r.saler}: все оплаты помечены как QR — тип оплаты не определяется (собрано до обновления)`);
}
if (stats.some((r) => r.raw_null > 0 || (r.tx > 50 && r.card + r.cash + r.terminal === 0))) {
  actions.push(`ПЕРЕКАЧКА (данные собраны до обновления структуры):
   sudo -u postgres psql wodomat -c 'TRUNCATE "Transaction", "DailyStat", "SyncState";' && pm2 restart backend --update-env`);
}

// Дни без транзакций
if (stats.length) {
  const gaps = await prisma.$queryRaw`
    SELECT s."saler", to_char(d, 'YYYY-MM-DD') AS day
    FROM (SELECT "saler", MIN("day")::date a, MAX("day")::date b FROM "Transaction" GROUP BY "saler") s,
         generate_series(s.a, s.b, interval '1 day') d
    WHERE NOT EXISTS (SELECT 1 FROM "Transaction" t WHERE t."saler" = s."saler" AND t."day" = to_char(d, 'YYYY-MM-DD'))
    ORDER BY 1, 2`;
  const by = new Map();
  gaps.forEach((g) => by.set(g.saler, [...(by.get(g.saler) || []), g.day]));
  if (!by.size) console.log('Дни без единой транзакции: нет');
  for (const [saler, days] of by) {
    console.log(`Дни без транзакций ${saler}: ${days.length} (${days.slice(0, 8).join(', ')}${days.length > 8 ? ', …' : ''})`);
    if (days.length >= 3) warn(`${saler}: ${days.length} дней без единой транзакции — проверьте, были ли продажи (сверка с API ниже)`);
  }
}

// Согласованность агрегата
head('4. Агрегат DailyStat против сырых Transaction');
try {
  const run = async () =>
    prisma.$queryRaw`
      SELECT t."saler", t.c::int AS tx, d.c::int AS daily, ROUND((t.a - d.a)::numeric, 2)::float AS diff
      FROM (SELECT "saler", COUNT(*) c, SUM("amount") a FROM "Transaction" GROUP BY "saler") t
      JOIN (SELECT "saler", SUM("txCount") c, SUM("amount") a FROM "DailyStat" GROUP BY "saler") d USING ("saler")
      WHERE t.c <> d.c OR ABS(t.a - d.a) > 0.01`;
  if (FIX_DAILY) {
    await prisma.$executeRaw`
      INSERT INTO "DailyStat" ("saler","deviceId","day","location","liters","amount","txCount","noDispenseCount",
                               "cardCount","cashCount","qrCount","terminalCount","updatedAt")
      SELECT "saler","deviceId","day", MAX("location"), SUM("liters"), SUM("amount"), COUNT(*)::int,
             (COUNT(*) FILTER (WHERE "noDispense"))::int, (COUNT(*) FILTER (WHERE "payType" = 'card'))::int,
             (COUNT(*) FILTER (WHERE "payType" = 'cash'))::int, (COUNT(*) FILTER (WHERE "payType" = 'qr'))::int,
             (COUNT(*) FILTER (WHERE "payType" = 'terminal'))::int, NOW()
      FROM "Transaction" GROUP BY "saler","deviceId","day"
      ON CONFLICT ("saler","deviceId","day") DO UPDATE SET
        "location" = EXCLUDED."location", "liters" = EXCLUDED."liters", "amount" = EXCLUDED."amount",
        "txCount" = EXCLUDED."txCount", "noDispenseCount" = EXCLUDED."noDispenseCount",
        "cardCount" = EXCLUDED."cardCount", "cashCount" = EXCLUDED."cashCount",
        "qrCount" = EXCLUDED."qrCount", "terminalCount" = EXCLUDED."terminalCount", "updatedAt" = NOW()`;
    await prisma.$executeRaw`
      DELETE FROM "DailyStat" d WHERE NOT EXISTS
        (SELECT 1 FROM "Transaction" t WHERE t."saler" = d."saler" AND t."deviceId" = d."deviceId" AND t."day" = d."day")`;
    console.log('Выполнен пересчёт DailyStat (--fix-daily)');
  }
  const mism = await run();
  if (!mism.length) console.log('Расхождений нет ✅');
  for (const m of mism) {
    console.log(`${m.saler}: транзакций ${m.tx}, в агрегате ${m.daily}, разница по сумме ${m.diff} zł`);
    bad(`${m.saler}: агрегат DailyStat не совпадает с Transaction`);
  }
  if (mism.length) actions.push('Пересчитать агрегат: node src/scripts/healthCheck.mjs --no-api --fix-daily');
} catch (e) {
  bad('Не удалось сверить агрегат: ' + e.message.split('\n').pop());
}

// ───────────────────────── 5. Сверка с API ─────────────────────────
async function fetchDay(appid, saler, day) {
  const begin = toApi(`${day} 00:00:00`);
  const end = toApi(`${day} 23:59:59`);
  const all = [];
  for (let page = 1; page <= 500; page++) {
    let res = null;
    for (let a = 0; a < 3 && res === null; a++) {
      res = await getConsumeList(appid, saler, begin, end, page);
      if (res === null) await sleep(2000);
    }
    if (res === null) throw new Error('API не отвечает');
    if (String(res.code) === '022') break;
    if (res.code !== 0 || !Array.isArray(res.data)) throw new Error('API: ' + JSON.stringify(res).slice(0, 120));
    all.push(...res.data);
    if (res.data.length < 20) break;
    await sleep(400);
  }
  return all;
}

head('5. Сверка с китайским API вживую');
if (NO_API) {
  console.log('Пропущено (--no-api)');
} else if (!stats.length) {
  console.log('В базе нет данных — сверять нечего');
} else {
  const users = await prisma.user.findMany({
    where: { saler: { in: stats.map((s) => s.saler) } },
    select: { saler: true, appid: true },
  });
  const appidBy = new Map(users.map((u) => [u.saler, u.appid]));
  const mismatched = [];

  for (const r of stats) {
    const appid = appidBy.get(r.saler);
    if (!appid) { console.log(`${r.saler}: нет appid — пропуск`); continue; }
    const st = stateBy.get(r.saler);

    for (const back of CHECK_DAYS) {
      const day = dayjs().tz(TZ).subtract(back, 'day').format('YYYY-MM-DD');
      const dayStart = dayjs.tz(`${day} 00:00:00`, TZ);
      if (day < r.first_day && (!st?.backfilledFrom || dayjs(st.backfilledFrom).isAfter(dayStart))) {
        console.log(`${r.saler} ${day}: история до этого дня ещё докачивается — пропуск`);
        continue;
      }
      try {
        const api = await fetchDay(appid, r.saler, day);
        const usable = api.filter((x) => (x.pay_id || x.key_id || x.alipay_number || x.id) && (x.shop_num || x.card_num) && x.time);
        const ids = new Set(usable.map((x) => String(x.pay_id || x.key_id || x.alipay_number || x.id)));
        const apiAmount = usable.reduce((s, x) => s + num(x.cost_value || x.value), 0);
        const apiLiters = usable.reduce((s, x) => s + num(x.water1) + num(x.water2), 0);
        const db = await prisma.transaction.aggregate({ where: { saler: r.saler, day }, _count: true, _sum: { amount: true, liters: true } });
        const dbAmount = db._sum.amount || 0;
        const dbLiters = db._sum.liters || 0;

        const okCount = ids.size === db._count;
        const okAmount = Math.abs(apiAmount - dbAmount) <= 0.01;
        const okLiters = Math.abs(apiLiters - dbLiters) <= 0.1;
        const mark = okCount && okAmount && okLiters ? '✅' : '❌';
        console.log(
          `${mark} ${r.saler} ${day}: API ${ids.size} шт / ${apiAmount.toFixed(2)} zł / ${apiLiters.toFixed(1)} л   БД ${db._count} шт / ${dbAmount.toFixed(2)} zł / ${dbLiters.toFixed(1)} л`
        );
        if (api.length !== usable.length) warn(`${r.saler} ${day}: ${api.length - usable.length} записей API без id/автомата/времени`);
        if (usable.length !== ids.size) warn(`${r.saler} ${day}: ${usable.length - ids.size} записей с повторяющимся id схлопнулись в одну`);
        if (mark === '❌') {
          bad(`${r.saler} ${day}: БД не совпадает с API (шт ${db._count} vs ${ids.size}, сумма ${dbAmount.toFixed(2)} vs ${apiAmount.toFixed(2)})`);
          mismatched.push(r.saler);
        }
      } catch (e) {
        console.log(`⚠ ${r.saler} ${day}: сверка не удалась — ${e.message}`);
      }
    }
  }
  const needFullReload = actions.some((a) => a.startsWith('ПЕРЕКАЧКА'));
  if (mismatched.length && !needFullReload) {
    const list = [...new Set(mismatched)].map((s) => `'${s}'`).join(', ');
    actions.push(`ДОКАЧКА для аккаунтов с расхождением (повторно загрузит историю, существующее не дублируется):
   sudo -u postgres psql wodomat -c "update \\"SyncState\\" set \\"backfilledFrom\\" = \\"syncedTo\\" where saler in (${list});"
   Через несколько часов повторите: node src/scripts/healthCheck.mjs`);
  }
}

// ───────────────────────── Итог ─────────────────────────
head('ИТОГ');
const errors = problems.filter((p) => p.level === 'error');
const warns = problems.filter((p) => p.level === 'warn');
if (!errors.length && !warns.length) {
  console.log('✅ Всё в порядке: сбор идёт, данные совпадают с API, перекачивать ничего не нужно.');
} else {
  if (errors.length) {
    console.log('❌ Нужны действия:');
    errors.forEach((p) => console.log('  •', p.text));
  }
  if (warns.length) {
    console.log('⚠ Обратите внимание:');
    warns.forEach((p) => console.log('  •', p.text));
  }
  if (actions.length) {
    console.log('\nЧто сделать:');
    actions.forEach((a, i) => console.log(`${i + 1}) ${a}`));
  }
}
if (!errors.length && warns.length) console.log('\nКритичных проблем нет: перекачка не требуется.');

await prisma.$disconnect();
process.exit(errors.length ? 1 : 0);
