// routes/bot.js
import express from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import prisma from '../utils/prisma.js';
import { buildOverview, parseRange, STATS_TZ } from '../services/statsQuery.js';
import { isRangeComplete } from '../services/coverage.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

// Подписка по связке appid + saler (та же логика, что была в check-subscription)
async function isSubscriptionActive(appid, saler) {
  const user = await prisma.user.findFirst({
    where: { saler, appid },
    include: { subscription: true },
  });
  if (!user) return false;

  const sub = user.subscription;
  if (!sub || sub.status !== 'ACTIVE') return false;
  if (sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) < new Date()) return false;
  return true;
}

// GET /api/bot/check-subscription?saler=xxx&appid=yyy
// Открытый эндпоинт — бот сам знает свои saler/appid, секрет не нужен
router.get('/check-subscription', async (req, res) => {
  try {
    const { saler, appid } = req.query;

    if (!saler || !appid) {
      return res.status(400).json({ active: false, reason: 'saler and appid required' });
    }

    return res.json({ active: await isSubscriptionActive(appid, saler) });
  } catch (error) {
    console.error('check-subscription error:', error);
    res.status(500).json({ active: false });
  }
});

// Секрет бота (заголовок x-bot-key): отчёты содержат данные о продажах
function botAuth(req, res, next) {
  const key = process.env.BOT_API_KEY;
  if (!key) return res.status(503).json({ error: 'BOT_API_KEY is not configured' });
  if (req.headers['x-bot-key'] !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/bot/report?appid=&saler=&from=YYYY-MM-DD&to=YYYY-MM-DD
// Продажи по автоматам за период из нашей БД (сутки по STATS_TZ), максимум 90 дней.
router.get('/report', botAuth, async (req, res) => {
  try {
    const { appid, saler } = req.query;
    if (!appid || !saler) return res.status(400).json({ error: 'appid and saler required' });

    if (!(await isSubscriptionActive(String(appid), String(saler)))) {
      return res.status(403).json({ active: false });
    }

    const { from, to } = parseRange(req.query);
    const data = await buildOverview(String(saler), from, to);

    const startMs = dayjs.tz(`${from} 00:00:00`, STATS_TZ).valueOf();
    const endMs = dayjs.tz(`${to} 23:59:59`, STATS_TZ).valueOf();

    res.json({
      range: data.range,
      complete: isRangeComplete(data.coverage, startMs, endMs),
      coverage: data.coverage,
      total: data.total,
      devices: data.byDevice.map((d) => ({
        deviceId: d.deviceId,
        location: d.location,
        liters: d.liters,
        amount: d.amount,
        txCount: d.txCount,
      })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('bot report error:', err);
    res.status(500).json({ error: 'Failed to build report' });
  }
});

export default router;