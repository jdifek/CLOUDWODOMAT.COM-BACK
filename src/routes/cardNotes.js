// routes/cardNotes.js
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.js'; // adjust path

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/card-notes
 * Returns all card notes for the current user as a map { cardNumber: note }
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const notes = await prisma.cardNote.findMany({
      where: { userId: req.user.id },
    });

    // Return as a map for O(1) lookup on the frontend
    const map = {};
    for (const note of notes) {
      map[note.cardNumber] = {
        phone: note.phone ?? '',
        name:  note.name  ?? '',
        notes: note.notes ?? '',
      };
    }

    res.json({ notes: map });
  } catch (err) {
    console.error('GET /api/card-notes error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/card-notes/:cardNumber
 * Upsert phone/name/notes for a single card.
 * Body: { phone?, name?, notes? }
 */
router.put('/:cardNumber', authenticate, async (req, res) => {
  const { cardNumber } = req.params;
  const { phone = '', name = '', notes = '' } = req.body;

  try {
    const note = await prisma.cardNote.upsert({
      where: {
        userId_cardNumber: {
          userId: req.user.id,
          cardNumber,
        },
      },
      update:  { phone, name, notes },
      create:  { userId: req.user.id, cardNumber, phone, name, notes },
    });

    res.json({ note });
  } catch (err) {
    console.error('PUT /api/card-notes error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/card-notes/sync
 * Frontend sends the full list of card numbers it received from HappyTi.
 * We return notes only for those cards (and can create empty stubs if desired).
 * Body: { cardNumbers: string[] }
 */
router.post('/sync', authenticate, async (req, res) => {
  const { cardNumbers = [] } = req.body;

  if (!Array.isArray(cardNumbers) || cardNumbers.length === 0) {
    return res.json({ notes: {} });
  }

  try {
    const notes = await prisma.cardNote.findMany({
      where: {
        userId: req.user.id,
        cardNumber: { in: cardNumbers },
      },
    });

    const map = {};
    for (const note of notes) {
      map[note.cardNumber] = {
        phone: note.phone ?? '',
        name:  note.name  ?? '',
        notes: note.notes ?? '',
      };
    }

    res.json({ notes: map });
  } catch (err) {
    console.error('POST /api/card-notes/sync error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;