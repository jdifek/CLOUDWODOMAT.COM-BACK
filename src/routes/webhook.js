import express from 'express';
import Stripe from 'stripe';
import prisma from "../utils/prisma.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const devicesCount = parseInt(session.metadata.devicesCount);
        const subscriptionId = session.subscription;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        await prisma.subscription.upsert({
          where: { userId },
          update: {
            stripeSubscriptionId: subscriptionId,
            status: 'ACTIVE',
            price: subscription.items.data[0].price.unit_amount / 100,
            devicesCount,
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
          },
          create: {
            userId,
            stripeSubscriptionId: subscriptionId,
            status: 'ACTIVE',
            price: subscription.items.data[0].price.unit_amount / 100,
            devicesCount,
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
          },
        });

        await prisma.payment.create({
          data: {
            userId,
            stripePaymentId: session.payment_intent,
            amount: session.amount_total / 100,
            status: 'succeeded',
          },
        });
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;

        await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: {
            status: subscription.status.toUpperCase(),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
          },
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { status: 'CANCELED' },
        });
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
export default router;
