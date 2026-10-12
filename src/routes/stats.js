// routes/stats.js — статистика для самого пользователя (его saler берётся из БД по токену)
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  parseRange,
  getAccountByUserId,
  buildOverview,
  buildDevice,
  buildHourly,
  buildTransactions,
  listDevices,
} from '../services/statsQuery.js';

const router = express.Router();

router.use(authenticate, async (req, res, next) => {
  try {
    const acc = await getAccountByUserId(req.user.id);
    if (!acc) return res.status(400).json({ error: 'appid/saler is not configured' });
    req.account = acc;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user' });
  }
});

const fail = (res, err) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Failed to load stats' });
};

// GET /api/stats/overview?from=&to=
router.get('/overview', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    res.json(await buildOverview(req.account.saler, from, to));
  } catch (err) { fail(res, err); }
});

// GET /api/stats/hourly?from=&to=[&deviceId=]
router.get('/hourly', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const deviceId = req.query.deviceId ? String(req.query.deviceId) : null;
    res.json(await buildHourly(req.account.saler, from, to, deviceId));
  } catch (err) { fail(res, err); }
});

// GET /api/stats/devices
router.get('/devices', async (req, res) => {
  try { res.json(await listDevices(req.account.saler)); } catch (err) { fail(res, err); }
});

// GET /api/stats/devices/:deviceId/transactions?cursor=&limit=
router.get('/devices/:deviceId/transactions', async (req, res) => {
  try {
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    res.json(await buildTransactions(req.account.saler, String(req.params.deviceId), cursor, req.query.limit));
  } catch (err) { fail(res, err); }
});

// GET /api/stats/devices/:deviceId?from=&to=
router.get('/devices/:deviceId', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    res.json(await buildDevice(req.account.saler, String(req.params.deviceId), from, to));
  } catch (err) { fail(res, err); }
});

export default router;