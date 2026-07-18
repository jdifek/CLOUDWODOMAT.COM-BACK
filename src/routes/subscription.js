import express from 'express';
import Stripe from 'stripe';
import prisma from "../utils/prisma.js";
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Вспомогательная функция для получения настройки
async function getSetting(key, defaultValue) {
  try {
    const setting = await prisma.settings.findUnique({ where: { key } });
    return setting ? parseFloat(setting.value) : defaultValue;
  } catch (error) {
    console.error(`Failed to get setting ${key}:`, error);
    return defaultValue;
  }
}
router.post('/checkout', authenticate, async (req, res) => {
  try {
    const { devicesCount, period = 'month' } = req.body;

    if (!devicesCount || devicesCount < 1) {
      return res.status(400).json({ error: 'Invalid devices count' });
    }

    const basePrice = await getSetting('BASE_PRICE', 1);
    const monthlyPrice = basePrice * devicesCount;

    const periodConfig = {
      month:  { months: 1,  discount: 0,    label: '1 month' },
      month6: { months: 6,  discount: 0.10, label: '6 months' },
      year:   { months: 12, discount: 0.20, label: '12 months' },
    };

    const config = periodConfig[period] ?? periodConfig.month;
    const totalPrice = monthlyPrice * config.months * (1 - config.discount);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment', // было 'subscription'
      customer_email: req.user.email,
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: {
              name: `Подписка — ${devicesCount} устройств(о) / ${config.label}`,
              description: `${basePrice} PLN/устройство/месяц${config.discount > 0 ? ` · скидка ${config.discount * 100}%` : ''}`,
            },
            unit_amount: Math.round(totalPrice * 100),
            // recurring убрали — это уже не рекуррентный платёж
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/subscription?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/subscription`,
      metadata: {
        userId: req.user.id,
        devicesCount: devicesCount.toString(),
        basePrice: basePrice.toString(),
        period,
        months: config.months.toString(), // понадобится в вебхуке для расчёта periodEnd
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

export default router;