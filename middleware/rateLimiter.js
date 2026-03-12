const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please try again later',
    retryAfter: '15 minutes'
  }
});

const analysisLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Analysis rate limit exceeded',
    retryAfter: '1 minute',
    note: 'LLM analysis is limited to prevent abuse. Please wait before analyzing more entries.'
  }
});

const journalCreationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Journal creation limit exceeded',
    retryAfter: '1 minute'
  }
});

module.exports = {
  apiLimiter,
  analysisLimiter,
  journalCreationLimiter
};