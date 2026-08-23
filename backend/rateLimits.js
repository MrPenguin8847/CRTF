'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function createRateLimiter({ windowMs, limit, name }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: req => req.auth?.user?.id
      ? `user:${req.auth.user.id}`
      : `ip:${ipKeyGenerator(req.ip)}`,
    handler: (req, res) => {
      const resetTime = req.rateLimit?.resetTime;
      if (resetTime) {
        const retryAfterSeconds = Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
      }
      res.status(429).json({
        error: `${name} rate limit exceeded. Please retry shortly.`,
        retryable: true,
      });
    },
  });
}

function createRateLimiters(config) {
  return {
    wallet: createRateLimiter({
      windowMs: config.walletRateLimitWindowMs,
      limit: config.walletRateLimitMax,
      name: 'Wallet analysis',
    }),
    assistant: createRateLimiter({
      windowMs: config.assistantRateLimitWindowMs,
      limit: config.assistantRateLimitMax,
      name: 'Assistant',
    }),
    invitations: createRateLimiter({
      windowMs: config.invitationRateLimitWindowMs,
      limit: config.invitationRateLimitMax,
      name: 'Invitation claim',
    }),
  };
}

module.exports = { createRateLimiters };
