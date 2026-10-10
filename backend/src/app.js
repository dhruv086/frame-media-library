import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { assetsRouter } from './routes/assets.routes.js';
import { bucketsRouter } from './routes/buckets.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { AppError } from './utils/AppError.js';

/** Build the Express application independently of the HTTP listener. */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: env.clientOrigin }));
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health', (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable', database: connected ? 'connected' : 'disconnected' });
  });
  app.use('/assets', assetsRouter);
  app.use('/buckets', bucketsRouter);
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use(errorHandler);
  return app;
}
