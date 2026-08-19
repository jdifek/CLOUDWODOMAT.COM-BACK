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
    logger.error('[webhook] ❌ Signature verification failed', { message: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.info(`[webhook] ===== START ${event.type} (${event.id}) =====`);
  logger.info(`[webhook] raw event data`, JSON.stringify(event.data.object).slice(0, 2000));

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        const userId = session.metadata?.userId;
        const devicesCountRaw = session.metadata?.devicesCount;
        const monthsRaw = session.metadata?.months;

        logger.info('[webhook] step 1: parsed metadata', {
          sessionId: session.id,
          fullMetadata: session.metadata,
          userId,
          devicesCountRaw,
          monthsRaw,
          paymentIntent: session.payment_intent,
          paymentStatus: session.payment_status,
          mode: session.mode,
          amountTotal: session.amount_total,
        });

        if (!userId) {
          logger.error('[webhook] step 1 FAILED: userId отсутствует в metadata', { sessionId: session.id, metadata: session.metadata });
          throw new Error(`userId отсутствует в metadata (session ${session.id})`);
        }

        const devicesCount = parseInt(devicesCountRaw, 10) || 1;
        const months = parseInt(monthsRaw, 10) || 1;
        logger.info('[webhook] step 2: parsed numbers', { devicesCount, months });

        logger.info('[webhook] step 3: looking up existing subscription', { userId });
        const existing = await prisma.subscription.findUnique({ where: { userId } });
        logger.info('[webhook] step 3 result', { existing });

        const now = new Date();
        const base = existing?.currentPeriodEnd && existing.currentPeriodEnd > now
          ? existing.currentPeriodEnd
          : now;
        logger.info('[webhook] step 4: base date for period calc', { base, now, existingPeriodEnd: existing?.currentPeriodEnd });

        const currentPeriodEnd = new Date(base);
        currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + months);
        logger.info('[webhook] step 5: computed currentPeriodEnd', { currentPeriodEnd });

        logger.info('[webhook] step 6: upserting subscription', {
          where: { userId },
          update: { status: 'ACTIVE', devicesCount, currentPeriodEnd },
        });

        let savedSub;
        try {
          savedSub = await prisma.subscription.upsert({
            where: { userId },
            update: {
              status: 'ACTIVE',
              devicesCount,
              currentPeriodEnd,
            },
            create: {
              userId,
              status: 'ACTIVE',
              devicesCount,
              currentPeriodEnd,
              price: 0, // TODO: проверьте обязательность поля price в схеме
            },
          });
        } catch (dbErr) {
          logger.error('[webhook] step 6 FAILED: prisma.subscription.upsert threw', {
            message: dbErr.message,
            code: dbErr.code,       // код ошибки Prisma, например P2002 (unique constraint)
            meta: dbErr.meta,       // детали, какое именно поле/constraint
            stack: dbErr.stack,
          });
          throw dbErr;
        }

        logger.info(`[webhook] step 6 OK ✅ Subscription upserted`, {
          dbId: savedSub.id,
          userId: savedSub.userId,
          status: savedSub.status,
          periodEnd: savedSub.currentPeriodEnd,
        });

        const stripePaymentId = session.payment_intent || session.id;
        logger.info('[webhook] step 7: upserting payment', { stripePaymentId, amount: session.amount_total / 100 });

        try {
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
        } catch (dbErr) {
          logger.error('[webhook] step 7 FAILED: prisma.payment.upsert threw', {
            message: dbErr.message,
            code: dbErr.code,
            meta: dbErr.meta,
            stack: dbErr.stack,
          });
          throw dbErr;
        }

        logger.info(`[webhook] step 7 OK ✅ Payment upserted`, { stripePaymentId });

        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        logger.info('[webhook] customer.subscription.updated payload', {
          id: subscription.id,
          status: subscription.status,
          current_period_end: subscription.current_period_end,
        });

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
          logger.info(`[webhook] ✅ customer.subscription.updated OK — ${subscription.id} -> ${subscription.status}`, { affectedRows: result.count });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        logger.info('[webhook] customer.subscription.deleted payload', { id: subscription.id });

        const result = await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { status: 'CANCELED' },
        });

        if (result.count === 0) {
          logger.error(`[webhook] ⚠️ customer.subscription.deleted: подписка ${subscription.id} НЕ найдена в БД`);
        } else {
          logger.info(`[webhook] ✅ customer.subscription.deleted OK — ${subscription.id}`, { affectedRows: result.count });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        logger.error(`[webhook] ⚠️ invoice.payment_failed`, {
          customer: invoice.customer,
          subscription: invoice.subscription,
          amount: invoice.amount_due / 100,
        });

        if (invoice.subscription) {
          const result = await prisma.subscription.updateMany({
            where: { stripeSubscriptionId: invoice.subscription },
            data: { status: 'PAST_DUE' },
          });
          logger.info('[webhook] invoice.payment_failed -> PAST_DUE applied', { affectedRows: result.count });
        }
        break;
      }

      default:
        logger.info(`[webhook] (не обрабатывается) ${event.type}`);
    }

    logger.info(`[webhook] ===== SUCCESS ${event.type} (${event.id}) =====`);
    res.json({ received: true });

  } catch (error) {
    logger.error('🔴🔴🔴 WEBHOOK FAILED 🔴🔴🔴', {
      eventType: event.type,
      eventId: event.id,
      message: error.message,
      code: error.code,
      meta: error.meta,
      stack: error.stack,
    });
    logger.info(`[webhook] ===== FAILED ${event.type} (${event.id}) =====`);

    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;