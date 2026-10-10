import { Router } from 'express';
import { env } from '../config/env.js';

export const bucketsRouter = Router();
bucketsRouter.get('/', (_req, res) => {
  res.json({ buckets: env.buckets.map((name) => ({ name, publicUrl: env.bucketPublicUrls[name] })) });
});
