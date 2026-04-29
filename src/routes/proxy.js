// routes/proxy.js
import express from 'express';
import fetch from 'node-fetch';
import { logger } from '../utils/logger.js'; // добавь .js
const router = express.Router();

router.all('*', async (req, res) => {
  try {
    // Берём сырую query строку из запроса — она уже правильно закодирована
    const queryString = req.originalUrl.split('?')[1] || '';
    const path = req.path;
    const targetUrl = `http://api.happy-ti.com:2028${path}${queryString ? '?' + queryString : ''}`;

    logger.info('→ Proxy to happy-ti:', { url: targetUrl, method: req.method });

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: req.method === 'POST'
        ? new URLSearchParams(req.body).toString()
        : undefined,
    });

    const data = await response.json();
    logger.info('← happy-ti response:', { status: response.status, data });

    res.status(response.status).json(data);
  } catch (err) {
    logger.error('Proxy error:', err);
    res.status(502).json({ error: { code: '502', message: err.message } });
  }
});

export default router;