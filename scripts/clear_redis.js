const { createClient } = require('redis');
require('dotenv').config();

async function clear() {
  const url = `redis://${process.env.REDIS_USER || 'default'}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`;
  const client = createClient({ url });

  client.on('error', (err) => console.error('❌ Redis Client Error:', err.message));

  try {
    console.log("Connecting to Redis...");
    await client.connect();
    console.log("Connected! Flushing database...");
    await client.flushAll();
    console.log("Redis flushed successfully!");
    await client.quit();
    process.exit(0);
  } catch (err) {
    console.error("Failed to clear Redis:", err.message);
    process.exit(1);
  }
}

clear();
