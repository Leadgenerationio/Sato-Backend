import IORedis from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export const redis = env.REDIS_URL
  ? new IORedis.default(env.REDIS_URL, { maxRetriesPerRequest: null })
  : null;

if (redis) {
  redis.on('connect', () => logger.info('Redis connected'));
  redis.on('error', (err: Error) => logger.error({ err }, 'Redis error'));
}
