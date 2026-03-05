import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import prisma from "../utils/prisma.js";

const router = express.Router();

router.use(authenticate, requireAdmin);


// Удаление пользователя
router.delete('/users/:id', async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ message: 'User deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Создание подписки
router.post('/subscriptions', async (req, res) => {
  try {
    const { userId, status, price, devicesCount, currentPeriodEnd } = req.body;

    const subscription = await prisma.subscription.create({
      data: {
        userId,
        status,
        price,
        devicesCount,
        currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd) : null
      },
    });

    res.json(subscription);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'User already has a subscription' });
    }
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Обновление подписки
router.put('/subscriptions/:id', async (req, res) => {
  try {
    const { status, price, devicesCount, currentPeriodEnd } = req.body;

    const subscription = await prisma.subscription.update({
      where: { id: req.params.id },
      data: {
        status,
        price,
        devicesCount,
        currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd) : null
      },
    });

    res.json(subscription);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// Удаление подписки
router.delete('/subscriptions/:id', async (req, res) => {
  try {
    await prisma.subscription.delete({ where: { id: req.params.id } });
    res.json({ message: 'Subscription deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete subscription' });
  }
});

// Добавление устройства конкретному пользователю
router.post('/users/:userId/devices', async (req, res) => {
  try {
    const { name, code } = req.body;
    const device = await prisma.device.create({
      data: { userId: req.params.userId, name, code },
    });
    res.json(device);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Device code already exists' });
    }
    res.status(500).json({ error: 'Failed to create device' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        devices: true,
        subscription: true,
        _count: { select: { devices: true } },
      },
    });

    const usersData = users.map(({ passwordHash, ...user }) => user);
    res.json(usersData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        devices: true,
        subscription: true,
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { passwordHash, ...userData } = user;
    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});
// Создание нового пользователя
router.post('/users', async (req, res) => {
  try {
    const { email, password, name, surname, phone, company, role, appid, saler } = req.body;

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { email, passwordHash, name, surname, phone, company, role: role || 'USER', appid, saler },
    });

    const { passwordHash: _, ...userData } = user;
    res.json(userData);
  } catch (error) {
    console.log(error, 'error');
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Обновление пользователя
router.put('/users/:id', async (req, res) => {
  try {
    const { name, surname, phone, company, role, appid, saler } = req.body;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { name, surname, phone, company, role, appid, saler },
    });

    const { passwordHash, ...userData } = user;
    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});
router.post('/users/:id/impersonate', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Создаем токен для impersonation
    const impersonationToken = jwt.sign(
      { userId: user.id, role: user.role, impersonatedBy: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }
    );

    // Возвращаем оба токена
    res.json({
      token: impersonationToken,
      adminToken: req.headers.authorization?.split(' ')[1] // Оригинальный токен админа
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to impersonate user' });
  }
});

router.get('/subscriptions', async (req, res) => {
  try {
    const subscriptions = await prisma.subscription.findMany({
      include: { user: true },
    });
    res.json(subscriptions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
});

router.get('/devices', async (req, res) => {
  try {
    const devices = await prisma.device.findMany({
      include: { user: true },
    });
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

router.post('/devices', async (req, res) => {
  try {
    const { userId, name, code } = req.body;

    const device = await prisma.device.create({
      data: { userId, name, code },
    });

    res.json(device);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Device code already exists' });
    }
    res.status(500).json({ error: 'Failed to create device' });
  }
});

router.put('/devices/:id', async (req, res) => {
  try {
    const { name, code } = req.body;

    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { name, code },
    });

    res.json(device);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update device' });
  }
});

router.delete('/devices/:id', async (req, res) => {
  try {
    await prisma.device.delete({ where: { id: req.params.id } });
    res.json({ message: 'Device deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

export default router;