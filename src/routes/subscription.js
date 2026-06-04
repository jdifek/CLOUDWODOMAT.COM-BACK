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

    // Скидки и интервалы
    const periodConfig = {
      month:  { interval: 'month', intervalCount: 1,  discount: 0,    label: '1 month' },
      month6: { interval: 'month', intervalCount: 6,  discount: 0.10, label: '6 months' },
      year:   { interval: 'year',  intervalCount: 1,  discount: 0.20, label: '12 months' },
    };

    const config = periodConfig[period] ?? periodConfig.month;
    const totalMonths = config.interval === 'year' ? 12 : config.intervalCount;
    const totalPrice = monthlyPrice * totalMonths * (1 - config.discount);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: req.user.email,
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: {
              name: `Subscription — ${devicesCount} device(s) / ${config.label}`,
              description: `${basePrice} PLN/device/month${config.discount > 0 ? ` · ${config.discount * 100}% discount` : ''}`,
            },
            unit_amount: Math.round(totalPrice * 100),
            recurring: {
              interval: config.interval,
              interval_count: config.intervalCount,
            },
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
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

export default router;