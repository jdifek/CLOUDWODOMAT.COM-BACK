// services/chinaApi.js — запросы к китайскому API (Shengtiqi)
import { logger } from '../utils/logger.js';

// Записи потребления (3.2.3), тот же эндпоинт record/getlist, что использует фронт.
// ВАЖНО: фронт всегда передаёт year (год из beginTime) — API хранит записи по годам,
// поэтому передаём его и здесь. Время beginTime/endTime — в часовом поясе API (UTC+8).
export async function getConsumeList(appid, saler, beginTime, endTime, page = 1) {
  const base = (process.env.CHINA_API_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    logger.error('CHINA_API_BASE_URL is not set');
    return null;
  }

  try {
    const qs = new URLSearchParams({
      appid: String(appid),
      saler: String(saler),
      beginTime,
      endTime,
      page: String(page),
      year: String(beginTime).slice(0, 4),
    });
    const resp = await fetch(`${base}/record/getlist?${qs}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    logger.error(`chinaApi getConsumeList: ${err.message}`);
    return null;
  }
}