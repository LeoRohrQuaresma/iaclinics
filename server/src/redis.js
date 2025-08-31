// redis.js
import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL);
// Dica: se quiser ver erros de conexão
redis.on('error', (e) => console.error('[redis] error:', e.message));
