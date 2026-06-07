const { createClient } = require('redis');

const redisClient = createClient({
  url: `redis://${process.env.REDIS_USER || 'default'}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`,
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err.message));
redisClient.on('connect', () => console.log('✅ Redis Connected'));
redisClient.on('reconnecting', () => console.log('🔄 Redis Reconnecting...'));

const connectRedis = async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('❌ Redis Connection Failed:', err.message);
    console.log('⚠️  App will continue without Redis caching');
  }
};

// ── Cache helpers ─────────────────────────────────────────────
const CACHE_TTL = {
  SHORT: 60,         // 1 min  – dashboard, profile
  MEDIUM: 300,       // 5 min  – KYC status, loan history
  LONG: 3600,        // 1 hour – admin stats
  SESSION: 86400,    // 24 hrs – user sessions
};

/**
 * Get cached value (returns parsed JSON or null)
 */
const getCache = async (key) => {
  try {
    if (!redisClient.isOpen) return null;
    const val = await redisClient.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    console.error('Redis GET error:', err.message);
    return null;
  }
};

/**
 * Set cache value with TTL (auto-serialises to JSON)
 */
const setCache = async (key, value, ttl = CACHE_TTL.SHORT) => {
  try {
    if (!redisClient.isOpen) return;
    await redisClient.setEx(key, ttl, JSON.stringify(value));
  } catch (err) {
    console.error('Redis SET error:', err.message);
  }
};

/**
 * Delete one or more cache keys (supports patterns with *)
 */
const delCache = async (...keys) => {
  try {
    if (!redisClient.isOpen) return;
    for (const key of keys) {
      if (key.includes('*')) {
        const matchingKeys = await redisClient.keys(key);
        if (matchingKeys.length) await redisClient.del(matchingKeys);
      } else {
        await redisClient.del(key);
      }
    }
  } catch (err) {
    console.error('Redis DEL error:', err.message);
  }
};

/**
 * Invalidate all caches for a specific user
 */
const invalidateUserCache = async (userId) => {
  await delCache(
    `user:${userId}:profile`,
    `user:${userId}:dashboard`,
    `user:${userId}:kyc`,
    `user:${userId}:loans`,
    `user:${userId}:notifications`,
  );
};

module.exports = {
  redisClient,
  connectRedis,
  getCache,
  setCache,
  delCache,
  invalidateUserCache,
  CACHE_TTL,
};
