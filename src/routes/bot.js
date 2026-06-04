// routes/bot.js
import express from 'express';
import prisma from '../utils/prisma.js';

const router = express.Router();

// GET /api/bot/check-subscription?saler=xxx&appid=yyy
// Открытый эндпоинт — бот сам знает свои saler/appid, секрет не нужен
router.get('/check-subscription', async (req, res) => {
  try {
    const { saler, appid } = req.query;

    if (!saler || !appid) {
      return res.status(400).json({ active: false, reason: 'saler and appid required' });
    }

    const user = await prisma.user.findFirst({
      where: { saler, appid },
      include: { subscription: true },
    });

    if (!user) return res.json({ active: false });

    const sub = user.subscription;
    if (!sub || sub.status !== 'ACTIVE') return res.json({ active: false });

    if (sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) < new Date()) {
      return res.json({ active: false });
    }

    return res.json({ active: true });
  } catch (error) {
    console.error('check-subscription error:', error);
    res.status(500).json({ active: false });
  }
});

export default router;