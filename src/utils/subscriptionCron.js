import cron from 'node-cron';
import prisma from './prisma.js';

export function startSubscriptionCron() {
  // Запускается каждый час
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await prisma.subscription.updateMany({
        where: {
          status: 'ACTIVE',
          currentPeriodEnd: { lt: new Date() },
        },
        data: { status: 'CANCELED' },
      });

      if (result.count > 0) {
        console.log(`[Cron] Deactivated ${result.count} expired subscription(s)`);
      }
    } catch (error) {
      console.error('[Cron] Failed to deactivate subscriptions:', error);
    }
  });

  console.log('[Cron] Subscription checker started');
}