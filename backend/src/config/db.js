import mongoose from 'mongoose';
import { env } from './env.js';
import { Asset } from '../models/Asset.js';

/** Connect to MongoDB and create indexes before accepting requests. */
export async function connectDb() {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
  await Asset.init();
}

/** Close MongoDB during graceful shutdown. */
export async function disconnectDb() {
  await mongoose.disconnect();
}
