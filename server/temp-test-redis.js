// temp-test-redis.js
import { redis } from './src/redis.js';
const pong = await redis.ping();
console.log('PING:', pong);
await redis.set('test:key', 'ok', 'EX', 60);
console.log('GET:', await redis.get('test:key'));
process.exit(0);
