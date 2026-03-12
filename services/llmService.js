const axios = require('axios');
const NodeCache = require('node-cache');

const analysisCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const FREE_MODELS = [
  'google/gemma-2-9b-it:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'microsoft/phi-3-mini-128k-instruct:free',
  'openrouter/free'
];

async function analyzeEmotion(text) {
  const cacheKey = `emotion_${Buffer.from(text).toString('base64').slice(0, 32)}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    console.log('🎯 Cache hit for emotion analysis');
    return { ...cached, cached: true };
  }

  if (!OPENROUTER_API_KEY) {
    console.warn('⚠️ No OPENROUTER_API_KEY found, using fallback analysis');
    return fallbackAnalysis(text);
  }

  const prompt = `Analyze the following journal entry for emotional content.
  
Journal Entry: "${text}"

Provide a JSON response with exactly this structure:
{
  "emotion": "primary emotion (one word: calm, anxious, happy, sad, excited, frustrated, peaceful, etc.)",
  "keywords": ["array of 3-5 relevant keywords"],
  "summary": "Brief 1-sentence summary of the emotional state"
}

Rules:
- Emotion must be a single lowercase word
- Keywords should be lowercase, no duplicates
- Summary should be empathetic and professional`;

  try {
    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: FREE_MODELS[0],
        messages: [
          {
            role: 'system',
            content: 'You are an empathetic emotional analysis assistant. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'ArvyaX Journal System'
        },
        timeout: 30000
      }
    );

    const content = response.data.choices[0].message.content;
    let result;
    
    try {
      result = JSON.parse(content);
    } catch (parseError) {
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || 
                       content.match(/{[\s\S]*?}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } else {
        throw new Error('Invalid JSON response from LLM');
      }
    }

    if (!result.emotion || !result.keywords || !result.summary) {
      throw new Error('Invalid response structure from LLM');
    }

    analysisCache.set(cacheKey, result);
    console.log(`✅ LLM analysis complete: ${result.emotion}`);
    
    return { ...result, cached: false, model: response.data.model };

  } catch (error) {
    console.error('❌ LLM Analysis Error:', error.message);
    
    if (error.response?.status === 429 || error.response?.status === 401) {
      console.log('🔄 Falling back to local analysis');
      return fallbackAnalysis(text);
    }
    
    throw new Error(`Emotion analysis failed: ${error.message}`);
  }
}

function fallbackAnalysis(text) {
  const lowerText = text.toLowerCase();
  
  const emotionMap = {
    calm: ['calm', 'peaceful', 'relaxed', 'serene', 'tranquil', 'quiet'],
    happy: ['happy', 'joy', 'excited', 'glad', 'cheerful', 'delighted'],
    sad: ['sad', 'unhappy', 'depressed', 'down', 'melancholy', 'gloomy'],
    anxious: ['anxious', 'worried', 'nervous', 'stressed', 'tense', 'uneasy'],
    frustrated: ['frustrated', 'angry', 'annoyed', 'irritated', 'upset'],
    focused: ['focused', 'concentrated', 'attentive', 'alert', 'mindful'],
    tired: ['tired', 'exhausted', 'sleepy', 'weary', 'drained']
  };

  let detectedEmotion = 'neutral';
  let maxMatches = 0;
  
  for (const [emotion, keywords] of Object.entries(emotionMap)) {
    const matches = keywords.filter(kw => lowerText.includes(kw)).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      detectedEmotion = emotion;
    }
  }

  const commonWords = text.toLowerCase()
    .replace(/[^a-zA-Z\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['felt', 'after', 'today', 'listening', 'this', 'that', 'with', 'from', 'during'].includes(w))
    .slice(0, 5);

  const keywords = commonWords.length > 0 ? commonWords : ['nature', 'experience', 'reflection'];

  const result = {
    emotion: detectedEmotion,
    keywords: keywords,
    summary: `User expressed ${detectedEmotion} feelings during the session`,
    cached: false,
    fallback: true
  };

  const cacheKey = `emotion_${Buffer.from(text).toString('base64').slice(0, 32)}`;
  analysisCache.set(cacheKey, result, 1800);

  return result;
}

async function analyzeEmotionStream(text, onChunk) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('Streaming requires OpenRouter API key');
  }

  const prompt = `Analyze emotions in this journal entry and respond in JSON format:
"${text}"

Format: {"emotion": "...", "keywords": [...], "summary": "..."}`;

  try {
    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: FREE_MODELS[0],
        messages: [
          { role: 'system', content: 'You are an emotional analysis assistant. Respond with JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        stream: true,
        max_tokens: 200
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'ArvyaX Journal System'
        },
        responseType: 'stream',
        timeout: 30000
      }
    );

    let fullContent = '';
    
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            fullContent += content;
            onChunk({ content, full: fullContent, done: false });
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    });

    response.data.on('end', () => {
      try {
        const result = JSON.parse(fullContent);
        onChunk({ content: fullContent, full: fullContent, done: true, result });
      } catch (e) {
        onChunk({ content: fullContent, full: fullContent, done: true, error: 'Failed to parse final result' });
      }
    });

  } catch (error) {
    console.error('Streaming error:', error.message);
    throw error;
  }
}

function getCacheStats() {
  return {
    keys: analysisCache.keys(),
    stats: analysisCache.getStats()
  };
}

function clearCache() {
  analysisCache.flushAll();
  return { cleared: true };
}

module.exports = {
  analyzeEmotion,
  analyzeEmotionStream,
  fallbackAnalysis,
  getCacheStats,
  clearCache,
  analysisCache
};