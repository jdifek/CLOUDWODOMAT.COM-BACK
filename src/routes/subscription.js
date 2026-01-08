import express from 'express';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post('/checkout', authenticate, async (req, res) => {
  try {
    const { devicesCount } = req.body;

    if (!devicesCount || devicesCount < 1) {
      return res.status(400).json({ error: 'Invalid devices count' });
    }

    const basePrice = parseFloat(process.env.BASE_PRICE);
    const price = basePrice * devicesCount;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: req.user.email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Subscription for ${devicesCount} device(s)`,
            },
            unit_amount: Math.round(price * 100),
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard`,
      metadata: {
        userId: req.user.id,
        devicesCount: devicesCount.toString(),
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

export default router;
