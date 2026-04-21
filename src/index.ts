import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { generalLimiter } from './middleware/rate-limit.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';
import { router } from './routes/index.js';
import { seedDefaultUsers } from './data/users.js';
import { registerSchedules } from './jobs/schedules.js';

const app: Express = express();

// Security
app.use(cors({
  origin: env.NODE_ENV === 'development' ? true : env.FRONTEND_URL,
  credentials: true,
}));
app.use(helmet());

// Body parsing
app.use(express.json({ limit: '10mb' }));

// Rate limiting
app.use(generalLimiter);

// Request logging
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'incoming request');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1', router);

// Error handling
app.use(errorHandler);

// Start server
async function start() {
  await seedDefaultUsers();
  try {
    await registerSchedules();
  } catch (err) {
    logger.error({ err }, 'Failed to register scheduled jobs');
  }
  app.listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT}`);
  });
}

start();

export default app;
