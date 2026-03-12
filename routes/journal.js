const express = require('express');
const router = express.Router();
const { dbAsync } = require('../database');
const { analyzeEmotion, analyzeEmotionStream, getCacheStats, clearCache } = require('../services/llmService');
const { apiLimiter, analysisLimiter, journalCreationLimiter } = require('../middleware/rateLimiter');

router.post('/', journalCreationLimiter, async (req, res) => {
  try {
    const { userId, ambience, text } = req.body;

    if (!userId || !ambience || !text) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['userId', 'ambience', 'text'],
        received: Object.keys(req.body)
      });
    }

    if (text.length > 5000) {
      return res.status(400).json({
        error: 'Text too long',
        maxLength: 5000,
        received: text.length
      });
    }

    const validAmbiences = ['forest', 'ocean', 'mountain', 'rain', 'desert', 'meadow'];
    if (!validAmbiences.includes(ambience.toLowerCase())) {
      return res.status(400).json({
        error: 'Invalid ambience',
        validValues: validAmbiences,
        received: ambience
      });
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
      message: 'Journal entry created successfully',
      data: {
        id: entry.id,
        userId: entry.userId,
        ambience: entry.ambience,
        text: entry.text,
        created_at: entry.created_at
      }
    });

  } catch (error) {
    console.error('Error creating journal entry:', error);
    res.status(500).json({
      error: 'Failed to create journal entry',
      message: error.message
    });
  }
});

router.get('/:userId', apiLimiter, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const entries = await dbAsync.all(
      `SELECT 
        id, userId, ambience, text, 
        emotion, keywords, summary,
        created_at
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
    console.error('Error fetching journal entries:', error);
    res.status(500).json({
      error: 'Failed to fetch journal entries',
      message: error.message
    });
  }
});

router.post('/analyze', analysisLimiter, async (req, res) => {
  try {
    const { text, entryId, stream = false } = req.body;

    if (!text) {
      return res.status(400).json({
        error: 'Text is required for analysis'
      });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        await analyzeEmotionStream(text, (chunk) => {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          
          if (chunk.done && chunk.result && entryId) {
            updateEntryAnalysis(entryId, chunk.result);
          }
        });
        
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (streamError) {
        res.write(`data: ${JSON.stringify({ error: streamError.message })}\n\n`);
        res.end();
      }
      return;
    }

    const analysis = await analyzeEmotion(text);

    if (entryId) {
      await updateEntryAnalysis(entryId, analysis);
    }

    res.json({
      success: true,
      data: analysis
    });

  } catch (error) {
    console.error('Error analyzing text:', error);
    res.status(500).json({
      error: 'Failed to analyze text',
      message: error.message
    });
  }
});

router.get('/insights/:userId', apiLimiter, async (req, res) => {
  try {
    const { userId } = req.params;

    const countResult = await dbAsync.get(
      `SELECT COUNT(*) as total FROM journal_entries WHERE userId = ?`,
      [userId]
    );

    const emotionResult = await dbAsync.get(
      `SELECT emotion, COUNT(*) as count 
       FROM journal_entries 
       WHERE userId = ? AND emotion IS NOT NULL 
       GROUP BY emotion 
       ORDER BY count DESC 
       LIMIT 1`,
      [userId]
    );

    const ambienceResult = await dbAsync.get(
      `SELECT ambience, COUNT(*) as count 
       FROM journal_entries 
       WHERE userId = ? 
       GROUP BY ambience 
       ORDER BY count DESC 
       LIMIT 1`,
      [userId]
    );

    const recentEntries = await dbAsync.all(
      `SELECT keywords 
       FROM journal_entries 
       WHERE userId = ? AND keywords IS NOT NULL 
       ORDER BY created_at DESC 
       LIMIT 5`,
      [userId]
    );

    const keywordFreq = {};
    recentEntries.forEach(entry => {
      try {
        const keywords = JSON.parse(entry.keywords);
        keywords.forEach(kw => {
          keywordFreq[kw] = (keywordFreq[kw] || 0) + 1;
        });
      } catch (e) {}
    });

    const recentKeywords = Object.entries(keywordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([kw]) => kw);

    const emotionDistribution = await dbAsync.all(
      `SELECT emotion, COUNT(*) as count 
       FROM journal_entries 
       WHERE userId = ? AND emotion IS NOT NULL 
       GROUP BY emotion`,
      [userId]
    );

    const weeklyTrend = await dbAsync.all(
      `SELECT 
        strftime('%Y-W%W', created_at) as week,
        COUNT(*) as entries,
        emotion
       FROM journal_entries 
       WHERE userId = ? AND created_at >= date('now', '-12 weeks')
       GROUP BY week, emotion
       ORDER BY week`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        totalEntries: countResult.total,
        topEmotion: emotionResult?.emotion || 'unknown',
        emotionCount: emotionResult?.count || 0,
        mostUsedAmbience: ambienceResult?.ambience || 'unknown',
        ambienceCount: ambienceResult?.count || 0,
        recentKeywords: recentKeywords.length > 0 ? recentKeywords : ['no data'],
        emotionDistribution,
        weeklyTrend: formatWeeklyTrend(weeklyTrend),
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error generating insights:', error);
    res.status(500).json({
      error: 'Failed to generate insights',
      message: error.message
    });
  }
});

router.post('/:id/analyze', analysisLimiter, async (req, res) => {
  try {
    const { id } = req.params;

    const entry = await dbAsync.get(
      `SELECT * FROM journal_entries WHERE id = ?`,
      [id]
    );

    if (!entry) {
      return res.status(404).json({ error: 'Journal entry not found' });
    }

    const analysis = await analyzeEmotion(entry.text);
    await updateEntryAnalysis(id, analysis);

    res.json({
      success: true,
      message: 'Entry analyzed successfully',
      data: {
        entryId: id,
        analysis
      }
    });

  } catch (error) {
    console.error('Error analyzing entry:', error);
    res.status(500).json({
      error: 'Failed to analyze entry',
      message: error.message
    });
  }
});

router.get('/cache/stats', async (req, res) => {
  try {
    const stats = getCacheStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/cache/clear', async (req, res) => {
  try {
    const result = clearCache();
    res.json({ success: true, message: 'Cache cleared successfully', data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function updateEntryAnalysis(entryId, analysis) {
  try {
    await dbAsync.run(
      `UPDATE journal_entries 
       SET emotion = ?, keywords = ?, summary = ? 
       WHERE id = ?`,
      [
        analysis.emotion,
        JSON.stringify(analysis.keywords),
        analysis.summary,
        entryId
      ]
    );
    console.log(`✅ Updated entry ${entryId} with analysis`);
  } catch (error) {
    console.error(`❌ Failed to update entry ${entryId}:`, error);
  }
}

function formatWeeklyTrend(rawData) {
  const weeks = {};
  
  rawData.forEach(row => {
    if (!weeks[row.week]) {
      weeks[row.week] = { week: row.week, entries: 0, emotions: {} };
    }
    weeks[row.week].entries += row.entries;
    weeks[row.week].emotions[row.emotion] = row.entries;
  });

  return Object.values(weeks).slice(-8);
}

module.exports = router;