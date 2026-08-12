import express from 'express';
import fetch from 'node-fetch';
import http from 'http';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Отдельный агент без keep-alive — избегаем проблем с переиспользованием сокетов
const noKeepAliveAgent = new http.Agent({ keepAlive: false });

router.all('*', async (req, res) => {
  const queryString = req.originalUrl.split('?')[1] || '';
  const path = req.path;
  const targetUrl = `http://api.happy-ti.com:2028${path}${queryString ? '?' + queryString : ''}`;

  logger.info('→ Proxy to happy-ti:', { url: targetUrl, method: req.method });

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: req.method === 'POST'
        ? new URLSearchParams(req.body).toString()
        : undefined,
      agent: noKeepAliveAgent,
      timeout: 15000, // 15 сек, чтобы не висеть бесконечно
    });

    const rawText = await response.text(); // читаем ОДИН раз как текст

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      logger.error('Proxy: non-JSON response from happy-ti', { rawText });
      return res.status(502).json({ error: { code: '502', message: 'Invalid JSON from upstream', raw: rawText } });
    }

    logger.info('← happy-ti response:', { status: response.status, data });
    res.status(response.status).json(data);
  } catch (err) {
    logger.error('Proxy error:', { message: err.message, url: targetUrl });
    res.status(502).json({ error: { code: '502', message: err.message } });
  }
});

export default router;