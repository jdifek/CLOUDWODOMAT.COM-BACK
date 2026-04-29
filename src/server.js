import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import subscriptionRoutes from './routes/subscription.js';
import webhookRoutes from './routes/webhook.js';
import settingsRoutes from './routes/settings.js';
import proxyRoutes from './routes/proxy.js';

import { startSubscriptionCron } from './utils/subscriptionCron.js';
import { logger } from './utils/logger.js';

dotenv.config();

const app = express();

app.use(cors());

app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });

  next();
});

app.use(express.json());

app.use((req, res, next) => {
  logger.debug('BODY:', req.body);
  next();
});

app.use('/webhook', webhookRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api-happy', proxyRoutes);

app.get('/health', (req, res) => {
  logger.info('HEALTH CHECK');
  res.json({ status: 'ok' });
});


app.use((err, req, res, next) => {
  logger.error('ERROR:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
  });

  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  startSubscriptionCron();
});

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection:', err);
});