import express from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';

const router = express.Router();
const prisma = new PrismaClient();

router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        devices: true,
        subscription: true,
      },
    });

    const { passwordHash, ...userData } = user;
    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.put('/me', authenticate, async (req, res) => {
  try {
    const { name, surname, phone, company } = req.body;

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name, surname, phone, company },
    });

    const { passwordHash, ...userData } = user;
    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.put('/me/password',
  authenticate,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { currentPassword, newPassword } = req.body;

      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({
        where: { id: req.user.id },
        data: { passwordHash },
      });

      res.json({ message: 'Password updated' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update password' });
    }
  }
);

router.get('/devices', authenticate, async (req, res) => {
  try {
    const devices = await prisma.device.findMany({
      where: { userId: req.user.id },
    });
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

router.post('/devices', authenticate, async (req, res) => {
  try {
    const { name, code } = req.body;

    const device = await prisma.device.create({
      data: { userId: req.user.id, name, code },
    });

    res.json(device);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Device code already exists' });
    }
    res.status(500).json({ error: 'Failed to create device' });
  }
});

router.put('/devices/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code } = req.body;

    const device = await prisma.device.findUnique({ where: { id } });
    if (!device || device.userId !== req.user.id) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updated = await prisma.device.update({
      where: { id },
      data: { name, code },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update device' });
  }
});

router.delete('/devices/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const device = await prisma.device.findUnique({ where: { id } });
    if (!device || device.userId !== req.user.id) {
      return res.status(404).json({ error: 'Device not found' });
    }

    await prisma.device.delete({ where: { id } });
    res.json({ message: 'Device deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

export default router;
