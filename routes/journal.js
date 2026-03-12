const express = require('express');
const router = express.Router();
const { dbAsync } = require('../database');
const { analyzeEmotion } = require('../services/llmService');
const { apiLimiter, analysisLimiter, journalCreationLimiter } = require('../middleware/rateLimiter');

// Debug: Log when routes are loaded
console.log('✅ Loading journal routes...');

// Test route
router.get('/test', (req, res) => {
  res.json({ message: 'Journal API is working' });
});

// GET /api/journal/:userId
router.get('/:userId', apiLimiter, async (req, res) => {
  console.log('GET /api/journal/:userId called with:', req.params.userId);
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const entries = await dbAsync.all(
      `SELECT id, userId, ambience, text, emotion, keywords, summary, created_at
       FROM journal_entries 
       WHERE userId = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    const formattedEntries = entries.map(entry => ({
      ...entry,
      keywords: entry.keywords ? JSON.parse(entry.keywords) : null
    }));

    res.json({
      success: true,
      count: entries.length,
      data: formattedEntries
    });

  } catch (error) {
    console.error('Error fetching entries:', error);
    res.status(500).json({ error: 'Failed to fetch journal entries', message: error.message });
  }
});

// POST /api/journal (create entry)
router.post('/', journalCreationLimiter, async (req, res) => {
  console.log('POST /api/journal called');
  try {
    const { userId, ambience, text } = req.body;

    if (!userId || !ambience || !text) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await dbAsync.run(
      `INSERT INTO journal_entries (userId, ambience, text) VALUES (?, ?, ?)`,
      [userId, ambience.toLowerCase(), text]
    );

    const entry = await dbAsync.get(
      `SELECT * FROM journal_entries WHERE id = ?`,
      [result.id]
    );

    res.status(201).json({
      success: true,
      data: entry
    });

  } catch (error) {
    console.error('Error creating entry:', error);
    res.status(500).json({ error: 'Failed to create entry', message: error.message });
  }
});

// POST /api/journal/analyze
router.post('/analyze', analysisLimiter, async (req, res) => {
  console.log('POST /api/journal/analyze called');
  try {
    const { text, entryId } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const analysis = await analyzeEmotion(text);

    if (entryId) {
      await dbAsync.run(
        `UPDATE journal_entries SET emotion = ?, keywords = ?, summary = ? WHERE id = ?`,
        [analysis.emotion, JSON.stringify(analysis.keywords), analysis.summary, entryId]
      );
    }

    res.json({ success: true, data: analysis });

  } catch (error) {
    console.error('Error analyzing:', error);
    res.status(500).json({ error: 'Analysis failed', message: error.message });
  }
});

// GET /api/journal/insights/:userId
router.get('/insights/:userId', apiLimiter, async (req, res) => {
  console.log('GET /api/journal/insights/:userId called');
  try {
    const { userId } = req.params;

    const countResult = await dbAsync.get(
      `SELECT COUNT(*) as total FROM journal_entries WHERE userId = ?`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        totalEntries: countResult?.total || 0,
        topEmotion: 'unknown',
        recentKeywords: []
      }
    });

  } catch (error) {
    console.error('Error getting insights:', error);
    res.status(500).json({ error: 'Failed to get insights', message: error.message });
  }
});

// POST /api/journal/:id/analyze
router.post('/:id/analyze', analysisLimiter, async (req, res) => {
  console.log('POST /api/journal/:id/analyze called');
  try {
    const { id } = req.params;
    
    const entry = await dbAsync.get(
      `SELECT * FROM journal_entries WHERE id = ?`,
      [id]
    );

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    const analysis = await analyzeEmotion(entry.text);
    
    await dbAsync.run(
      `UPDATE journal_entries SET emotion = ?, keywords = ?, summary = ? WHERE id = ?`,
      [analysis.emotion, JSON.stringify(analysis.keywords), analysis.summary, id]
    );

    res.json({ success: true, data: { entryId: id, analysis } });

  } catch (error) {
    console.error('Error analyzing entry:', error);
    res.status(500).json({ error: 'Failed to analyze entry', message: error.message });
  }
});

// Debug: Log all registered routes
console.log('📋 Journal routes registered:');
router.stack.forEach(r => {
  if (r.route) {
    console.log(`   ${Object.keys(r.route.methods).join(',').toUpperCase()} ${r.route.path}`);
  }
});

module.exports = router;