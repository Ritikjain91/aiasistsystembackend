const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// ═════════════════════════════════════════════════════════════
// CORS - Allow Vercel + Localhost
// ═════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://ai-assisted-journal-system-iota.vercel.app',
  // Add your Vercel URL after deployment
];

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// ═════════════════════════════════════════════════════════════
// DATABASE
// ═════════════════════════════════════════════════════════════
const dbPath = process.env.NODE_ENV === 'production' 
  ? '/tmp/journal.db'
  : path.join(__dirname, 'journal.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err);
  } else {
    console.log('✅ SQLite connected');
    initDatabase();
  }
});

function initDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      ambience TEXT NOT NULL,
      text TEXT NOT NULL,
      emotion TEXT,
      keywords TEXT,
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS analysis_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_hash TEXT UNIQUE NOT NULL,
      emotion TEXT NOT NULL,
      keywords TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ═════════════════════════════════════════════════════════════
// LLM INTEGRATION
// ═════════════════════════════════════════════════════════════
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;

async function analyzeWithLLM(text) {
  if (!OPENROUTER_API_KEY) {
    console.log('Using fallback analysis');
    return fallbackAnalysis(text);
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ai-assisted-journal-system-iota.vercel.app',
        'X-Title': 'AI Journal System'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat:free',
        messages: [{
          role: 'system',
          content: 'Analyze this journal entry. Return ONLY JSON: {"emotion": "single word", "keywords": ["3-5 words"], "summary": "one sentence"}'
        }, {
          role: 'user',
          content: text
        }],
        temperature: 0.3,
        max_tokens: 150
      })
    });

    if (!response.ok) throw new Error(`LLM API error: ${response.status}`);
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    try {
      const parsed = JSON.parse(content);
      return {
        emotion: parsed.emotion || 'neutral',
        keywords: parsed.keywords || ['journal', 'entry'],
        summary: parsed.summary || 'User wrote a journal entry'
      };
    } catch (e) {
      return extractFromText(content);
    }
  } catch (err) {
    console.error('LLM error:', err.message);
    return fallbackAnalysis(text);
  }
}

function fallbackAnalysis(text) {
  const lower = text.toLowerCase();
  const emotions = {
    calm: ['calm', 'peace', 'relax', 'quiet', 'still', 'breathe', 'meditation'],
    happy: ['happy', 'joy', 'good', 'great', 'wonderful', 'smile', 'love', 'excited'],
    sad: ['sad', 'down', 'cry', 'tears', 'depressed', 'lonely', 'upset'],
    anxious: ['anxious', 'worry', 'stress', 'nervous', 'tense', 'panic', 'fear'],
    angry: ['angry', 'mad', 'frustrated', 'annoyed', 'rage', 'hate', 'irritated'],
    focused: ['focus', 'concentrate', 'productive', 'work', 'study', 'clear', 'motivated']
  };
  
  let detectedEmotion = 'neutral';
  let maxMatches = 0;
  
  for (const [emotion, keywords] of Object.entries(emotions)) {
    const matches = keywords.filter(k => lower.includes(k)).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      detectedEmotion = emotion;
    }
  }
  
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const commonWords = ['felt', 'after', 'today', 'with', 'this', 'that', 'have', 'from', 'they', 'them'];
  const keywords = [...new Set(words.filter(w => !commonWords.includes(w)))].slice(0, 5);
  
  if (keywords.length === 0) keywords.push('journal', 'reflection', 'thoughts');
  
  return {
    emotion: detectedEmotion,
    keywords: keywords,
    summary: `User expressed ${detectedEmotion} feelings in their ${detectedEmotion === 'focused' ? 'productive' : 'reflective'} journal entry.`
  };
}

function extractFromText(text) {
  const emotionMatch = text.match(/"emotion":\s*"([^"]+)"/);
  const keywordsMatch = text.match(/"keywords":\s*\[([^\]]+)\]/);
  const summaryMatch = text.match(/"summary":\s*"([^"]+)"/);
  
  return {
    emotion: emotionMatch?.[1] || 'neutral',
    keywords: keywordsMatch 
      ? keywordsMatch[1].split(',').map(k => k.replace(/"/g, '').trim()).slice(0, 5)
      : ['journal', 'entry', 'reflection'],
    summary: summaryMatch?.[1] || 'User wrote a journal entry'
  };
}

// ═════════════════════════════════════════════════════════════
// API ROUTES
// ═════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    llm: OPENROUTER_API_KEY ? 'enabled' : 'fallback'
  });
});

app.post('/api/journal', async (req, res) => {
  const { userId, ambience, text } = req.body;
  
  if (!userId || !ambience || !text) {
    return res.status(400).json({ 
      success: false, 
      message: 'Missing required fields' 
    });
  }
  
  db.run(
    'INSERT INTO entries (userId, ambience, text) VALUES (?, ?, ?)',
    [userId, ambience, text],
    function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      
      res.json({
        success: true,
        data: {
          id: this.lastID,
          userId,
          ambience,
          text,
          created_at: new Date().toISOString()
        }
      });
    }
  );
});

app.get('/api/journal/:userId', (req, res) => {
  const { userId } = req.params;
  const { limit = 50, offset = 0 } = req.query;
  
  db.all(
    'SELECT * FROM entries WHERE userId = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [userId, parseInt(limit), parseInt(offset)],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      
      const entries = rows.map(row => ({
        ...row,
        keywords: row.keywords ? JSON.parse(row.keywords) : undefined
      }));
      
      res.json({ success: true, data: entries });
    }
  );
});

app.post('/api/journal/analyze', async (req, res) => {
  const { text, entryId } = req.body;
  
  if (!text) {
    return res.status(400).json({ success: false, message: 'Text required' });
  }
  
  const textHash = crypto.createHash('md5').update(text).digest('hex');
  
  db.get('SELECT * FROM analysis_cache WHERE text_hash = ?', [textHash], async (err, cached) => {
    if (err) console.error('Cache check error:', err);
    
    if (cached) {
      return res.json({
        success: true,
        data: {
          emotion: cached.emotion,
          keywords: JSON.parse(cached.keywords),
          summary: cached.summary,
          cached: true
        }
      });
    }
    
    const analysis = await analyzeWithLLM(text);
    
    db.run(
      'INSERT OR REPLACE INTO analysis_cache (text_hash, emotion, keywords, summary) VALUES (?, ?, ?, ?)',
      [textHash, analysis.emotion, JSON.stringify(analysis.keywords), analysis.summary]
    );
    
    if (entryId) {
      db.run(
        'UPDATE entries SET emotion = ?, keywords = ?, summary = ? WHERE id = ?',
        [analysis.emotion, JSON.stringify(analysis.keywords), analysis.summary, entryId]
      );
    }
    
    res.json({
      success: true,
      data: { ...analysis, cached: false }
    });
  });
});

app.post('/api/journal/:id/analyze', async (req, res) => {
  const { id } = req.params;
  
  db.get('SELECT * FROM entries WHERE id = ?', [id], async (err, entry) => {
    if (err || !entry) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }
    
    const analysis = await analyzeWithLLM(entry.text);
    
    db.run(
      'UPDATE entries SET emotion = ?, keywords = ?, summary = ? WHERE id = ?',
      [analysis.emotion, JSON.stringify(analysis.keywords), analysis.summary, id],
      (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: err.message });
        }
        
        res.json({
          success: true,
          data: { entryId: parseInt(id), analysis }
        });
      }
    );
  });
});

app.get('/api/journal/insights/:userId', (req, res) => {
  const { userId } = req.params;
  
  db.all('SELECT * FROM entries WHERE userId = ?', [userId], (err, entries) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    
    if (entries.length === 0) {
      return res.json({
        success: true,
        data: {
          totalEntries: 0,
          topEmotion: null,
          emotionCount: 0,
          mostUsedAmbience: null,
          ambienceCount: 0,
          recentKeywords: [],
          emotionDistribution: [],
          weeklyTrend: [],
          generatedAt: new Date().toISOString()
        }
      });
    }
    
    const emotions = {};
    const ambiences = {};
    const allKeywords = [];
    
    entries.forEach(entry => {
      emotions[entry.emotion || 'unknown'] = (emotions[entry.emotion || 'unknown'] || 0) + 1;
      ambiences[entry.ambience] = (ambiences[entry.ambience] || 0) + 1;
      if (entry.keywords) {
        try {
          const kws = JSON.parse(entry.keywords);
          allKeywords.push(...kws);
        } catch (e) {}
      }
    });
    
    const topEmotion = Object.entries(emotions).sort((a, b) => b[1] - a[1])[0][0];
    const mostUsedAmbience = Object.entries(ambiences).sort((a, b) => b[1] - a[1])[0][0];
    const recentKeywords = [...new Set(allKeywords.slice(0, 10))];
    
    const emotionDistribution = Object.entries(emotions).map(([emotion, count]) => ({ emotion, count }));
    
    const weekMap = {};
    entries.forEach(entry => {
      const week = entry.created_at.substring(0, 10);
      if (!weekMap[week]) {
        weekMap[week] = { entries: 0, emotions: {} };
      }
      weekMap[week].entries++;
      const emo = entry.emotion || 'unknown';
      weekMap[week].emotions[emo] = (weekMap[week].emotions[emo] || 0) + 1;
    });
    
    const weeklyTrend = Object.entries(weekMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-7)
      .map(([week, data]) => ({ week, ...data }));
    
    res.json({
      success: true,
      data: {
        totalEntries: entries.length,
        topEmotion,
        emotionCount: emotions[topEmotion],
        mostUsedAmbience,
        ambienceCount: ambiences[mostUsedAmbience],
        recentKeywords,
        emotionDistribution,
        weeklyTrend,
        generatedAt: new Date().toISOString()
      }
    });
  });
});

app.get('/api/journal/cache/stats', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM analysis_cache', (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: { keys: [], stats: { keys: row.count } } });
  });
});

app.post('/api/journal/cache/clear', (req, res) => {
  db.run('DELETE FROM analysis_cache', (err) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: { cleared: true } });
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Journal API on port ${PORT}`);
  console.log(`🤖 LLM: ${OPENROUTER_API_KEY ? 'OpenRouter' : 'Fallback'}`);
});

module.exports = app;