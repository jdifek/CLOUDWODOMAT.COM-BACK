import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

// Публичный эндпоинт для получения настроек (доступен всем авторизованным)
router.get('/', authenticate, async (req, res) => {
  try {
    const settings = await prisma.settings.findMany();
    
    // Преобразуем в объект key-value
    const settingsObj = settings.reduce((acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    }, {});
    
    res.json(settingsObj);
  } catch (error) {
    console.error('Failed to fetch settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Получить конкретную настройку
router.get('/:key', authenticate, async (req, res) => {
  try {
    const setting = await prisma.settings.findUnique({
      where: { key: req.params.key }
    });
    
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    
    res.json({ key: setting.key, value: setting.value });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

// Обновить настройку (только админ)
router.put('/:key', authenticate, requireAdmin, async (req, res) => {
  try {
    const { value } = req.body;
    
    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'Value is required' });
    }
    
    const setting = await prisma.settings.upsert({
      where: { key: req.params.key },
      update: { value: value.toString() },
      create: { key: req.params.key, value: value.toString() }
    });
    
    res.json(setting);
  } catch (error) {
    console.error('Failed to update setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Создать или обновить несколько настроек (только админ)
router.post('/bulk', authenticate, requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object is required' });
    }
    
    const updates = await Promise.all(
      Object.entries(settings).map(([key, value]) =>
        prisma.settings.upsert({
          where: { key },
          update: { value: value.toString() },
          create: { key, value: value.toString() }
        })
      )
    );
    
    res.json(updates);
  } catch (error) {
    console.error('Failed to update settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;