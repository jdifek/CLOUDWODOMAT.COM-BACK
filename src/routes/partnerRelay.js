import express from 'express';
import { logger } from '../utils/logger.js';

const router = express.Router();
const TARGET = (process.env.HAPPY_TARGET || 'http://api.happy-ti.com:2028').replace(/\/+$/, '');

// Тело читаем как есть, без разбора, и отдаём дальше без изменений
router.use(express.raw({ type: '*/*', limit: '1mb' }));

router.use(async (req, res) => {
  const token = process.env.RELAY_TOKEN;
  const prefix = `/${token}/`;
  if (!token || !req.url.startsWith(prefix)) return res.sendStatus(404);

  const url = TARGET + req.url.slice(prefix.length - 1);
  const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;

  try {
    const r = await fetch(url, {
      method: req.method,
      headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
      body: hasBody ? req.body : undefined,
      signal: AbortSignal.timeout(15000), // без повторов: ошибку возвращаем как есть
    });
    const buf = Buffer.from(await r.arrayBuffer());
    // тело и query не логируем, чтобы не светить appid и платёжные данные
    logger.info(`partner-relay ${req.method} ${req.path.replace(token, '***')} -> ${r.status}`);
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(buf);
  } catch (err) {
    logger.error(`partner-relay ${req.method} failed: ${err.message}`);
    res.status(502).json({ error: 'upstream error' });
  }
});

export default router;