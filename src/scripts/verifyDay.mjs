// src/scripts/verifyDay.mjs — сверка одного дня: китайское API (живьём) против нашей БД
// Запуск на сервере из /var/www/backend:
//   node src/scripts/verifyDay.mjs wodomat2026 2026-10-09
// Берите ПРОШЕДШИЙ день (сегодняшний ещё меняется).
import 'dotenv/config';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import prisma from '../utils/prisma.js';
import { getConsumeList } from '../services/chinaApi.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const [saler, day] = process.argv.slice(2);
if (!saler || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) {
  console.log('Использование: node src/scripts/verifyDay.mjs <saler> <YYYY-MM-DD>');
  process.exit(1);
}

const TZ = process.env.STATS_TZ || 'Europe/Warsaw';
const toApi = (s) => dayjs.tz(s, 'YYYY-MM-DD HH:mm:ss', TZ).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
const num = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user = await prisma.user.findFirst({ where: { saler }, select: { appid: true } });
if (!user?.appid) {
  console.log(`Не найден пользователь с saler=${saler}`);
  process.exit(1);
}

const begin = toApi(`${day} 00:00:00`);
const end = toApi(`${day} 23:59:59`);
console.log(`saler=${saler}, день ${day} (${TZ}) → окно API ${begin} … ${end}\n`);

// 1) Всё, что отдаёт API за этот день
const api = [];
for (let page = 1; page <= 500; page++) {
  const res = await getConsumeList(user.appid, saler, begin, end, page);
  if (res === null) { console.log(`Запрос не удался (стр. ${page}) — повторите позже`); process.exit(1); }
  if (String(res.code) === '022') break;
  if (res.code !== 0 || !Array.isArray(res.data)) { console.log('Ошибка API:', JSON.stringify(res).slice(0, 200)); process.exit(1); }
  api.push(...res.data);
  if (res.data.length < 20) break;
  await sleep(500);
}

const idOf = (r) => r.pay_id || r.key_id || r.alipay_number || r.id;
const devOf = (r) => r.shop_num || r.card_num;
const usable = api.filter((r) => idOf(r) && devOf(r) && r.time);
const uniqueIds = new Set(usable.map((r) => String(idOf(r))));

const apiAmount = usable.reduce((s, r) => s + num(r.cost_value || r.value), 0);
const apiLiters = usable.reduce((s, r) => s + num(r.water1) + num(r.water2), 0);

// 2) Что лежит у нас
const db = await prisma.transaction.aggregate({
  where: { saler, day },
  _count: true,
  _sum: { amount: true, liters: true },
});
const dbAmount = db._sum.amount || 0;
const dbLiters = db._sum.liters || 0;

const row = (name, a, b) => {
  const diff = typeof a === 'number' ? +(b - a).toFixed(2) : '';
  console.log(`${name.padEnd(28)} API: ${String(a).padStart(10)}   БД: ${String(b).padStart(10)}   ${diff === 0 ? 'OK' : 'разница ' + diff}`);
};
console.log(`Записей от API всего:        ${api.length}`);
console.log(`  из них пригодных (id/авто/время): ${usable.length}`);
console.log(`  уникальных id:             ${uniqueIds.size}\n`);
row('Количество транзакций', uniqueIds.size, db._count);
row('Сумма, zł', +apiAmount.toFixed(2), +dbAmount.toFixed(2));
row('Литры', +apiLiters.toFixed(1), +dbLiters.toFixed(1));

if (api.length !== usable.length) console.log(`\n⚠ ${api.length - usable.length} записей API без id/автомата/времени — мы их пропускаем`);
if (usable.length !== uniqueIds.size) console.log(`\n⚠ ${usable.length - uniqueIds.size} записей с повторяющимся id — в БД они схлопываются в одну`);

// 3) По автоматам — где расхождение
const apiByDev = new Map();
for (const r of usable) {
  const k = String(devOf(r));
  const v = apiByDev.get(k) || { n: 0, amount: 0 };
  v.n += 1; v.amount += num(r.cost_value || r.value);
  apiByDev.set(k, v);
}
const dbByDev = await prisma.transaction.groupBy({ by: ['deviceId'], where: { saler, day }, _count: true, _sum: { amount: true } });
const dbMap = new Map(dbByDev.map((r) => [r.deviceId, { n: r._count, amount: r._sum.amount || 0 }]));
const bad = [];
for (const k of new Set([...apiByDev.keys(), ...dbMap.keys()])) {
  const a = apiByDev.get(k) || { n: 0, amount: 0 };
  const b = dbMap.get(k) || { n: 0, amount: 0 };
  if (a.n !== b.n || Math.abs(a.amount - b.amount) > 0.01) bad.push(`${k}: API ${a.n} шт / ${a.amount.toFixed(2)} zł, БД ${b.n} шт / ${b.amount.toFixed(2)} zł`);
}
console.log(bad.length ? `\nРасхождения по автоматам:\n  ${bad.join('\n  ')}` : '\nПо каждому автомату всё совпало ✅');

await prisma.$disconnect();