import { Router } from 'express';

const router = Router();
const TARGET = (process.env.CHINA_API_BASE_URL || 'http://api.happy-ti.com:2028').replace(/\/+$/, '');

// Адрес: /china-relay/<RELAY_TOKEN>/record/getlist?appid=...
router.use(async (req, res) => {
  const token = process.env.RELAY_TOKEN;
  const prefix = `/${token}/`;
  if (!token || req.method !== 'GET' || !req.url.startsWith(prefix)) {
    return res.sendStatus(404);
  }
  const path = req.url.slice(prefix.length - 1); // оставляем ведущий "/"
  try {
    const r = await fetch(TARGET + path, { signal: AbortSignal.timeout(15000) });
    const body = Buffer.from(await r.arrayBuffer());
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: 'upstream error' });
  }
});

export default router;