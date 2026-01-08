import express from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticate, requireAdmin);

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

router.put('/users/:id', async (req, res) => {
  try {
    const { name, surname, phone, company, role } = req.body;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { name, surname, phone, company, role },
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

    const token = jwt.sign(
      { userId: user.id, role: user.role, impersonatedBy: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ token });
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