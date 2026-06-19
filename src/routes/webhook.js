import express from 'express';
import Stripe from 'stripe';
import prisma from "../utils/prisma.js";
import { logger } from '../utils/logger.js';

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
    logger.error('Webhook signature verification failed', { message: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Отвечаем Stripe сразу. Дальше обрабатываем и в любом случае
  // громко логируем результат — успех или ошибку.
  res.json({ received: true });

  logger.info(`[webhook] >>> Received: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        const userId = session.metadata?.userId;
        const devicesCountRaw = session.metadata?.devicesCount;

        logger.info('[webhook] checkout.session.completed payload', {
          sessionId: session.id,
          userId,
          devicesCountRaw,
          subscriptionId: session.subscription,
          paymentStatus: session.payment_status,
          mode: session.mode,
        });

        if (!userId) {
          throw new Error(`userId отсутствует в metadata (session ${session.id})`);
        }
        if (!session.subscription) {
          throw new Error(`нет subscription id (session ${session.id}), mode=${session.mode}`);
        }

        const devicesCount = parseInt(devicesCountRaw, 10) || 1;
        const subscriptionId = session.subscription;

        const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);

        const priceItem = stripeSub.items?.data?.[0]?.price;
        if (!priceItem || typeof priceItem.unit_amount !== 'number') {
          throw new Error(`не удалось определить price.unit_amount для subscription ${subscriptionId}`);
        }

        const savedSub = await prisma.subscription.upsert({
          where: { userId },
          update: {
            stripeSubscriptionId: subscriptionId,
            status: 'ACTIVE',
            price: priceItem.unit_amount / 100,
            devicesCount,
            currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
          },
          create: {
            userId,
            stripeSubscriptionId: subscriptionId,
            status: 'ACTIVE',
            price: priceItem.unit_amount / 100,
            devicesCount,
            currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
          },
        });

        logger.info(`[webhook] ✅ Subscription upserted OK — userId=${userId}, dbId=${savedSub.id}, status=${savedSub.status}`);

        // payment_intent в checkout.session для mode: 'subscription' часто null —
        // реальный платёж лежит в invoice. Достаём его оттуда.
        let stripePaymentId = session.payment_intent;

        if (!stripePaymentId && session.invoice) {
          const invoice = await stripe.invoices.retrieve(session.invoice);
          stripePaymentId = invoice.payment_intent || invoice.id;
        }

        if (!stripePaymentId) {
          logger.error(`[webhook] ⚠️ Не удалось определить stripePaymentId для session ${session.id}, invoice=${session.invoice} — Payment НЕ создан`);
        } else {
          await prisma.payment.upsert({
            where: { stripePaymentId },
            update: {
              status: 'succeeded',
              amount: session.amount_total / 100,
            },
            create: {
              userId,
              stripePaymentId,
              amount: session.amount_total / 100,
              status: 'succeeded',
            },
          });
          logger.info(`[webhook] ✅ Payment upserted OK — stripePaymentId=${stripePaymentId}`);
        }

        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;

        const result = await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: {
            status: subscription.status.toUpperCase(),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
          },
        });

        if (result.count === 0) {
          logger.error(`[webhook] ⚠️ customer.subscription.updated: подписка ${subscription.id} НЕ найдена в БД`);
        } else {
          logger.info(`[webhook] ✅ customer.subscription.updated OK — ${subscription.id} -> ${subscription.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        const result = await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { status: 'CANCELED' },
        });

        if (result.count === 0) {
          logger.error(`[webhook] ⚠️ customer.subscription.deleted: подписка ${subscription.id} НЕ найдена в БД`);
        } else {
          logger.info(`[webhook] ✅ customer.subscription.deleted OK — ${subscription.id}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        logger.error(`[webhook] ⚠️ invoice.payment_failed — customer=${invoice.customer}, subscription=${invoice.subscription}, amount=${invoice.amount_due / 100}`);

        if (invoice.subscription) {
          await prisma.subscription.updateMany({
            where: { stripeSubscriptionId: invoice.subscription },
            data: { status: 'PAST_DUE' },
          });
        }
        break;
      }

      default:
        logger.info(`[webhook] (не обрабатывается) ${event.type}`);
    }
  } catch (error) {
    // Главное место: эта ошибка раньше "терялась". Теперь её видно
    // явным маркером — ищите в логах Railway по строке "WEBHOOK FAILED".
    logger.error('🔴🔴🔴 WEBHOOK FAILED 🔴🔴🔴', {
      eventType: event.type,
      eventId: event.id,
      message: error.message,
      stack: error.stack,
    });
  }
});

export default router;