import { env } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { recoverVideoJobs } from './services/video-jobs.service.js';

try {
  await connectDb();
  await recoverVideoJobs();
  const server = createApp().listen(env.port, () => console.log(`Media Asset CMS listening on http://localhost:${env.port}`));
  server.on('error', (error) => { console.error('HTTP server failed:', error.message); process.exitCode = 1; void disconnectDb(); });
  const shutdown = () => {
    const timeout = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await disconnectDb();
      clearTimeout(timeout);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Server startup failed:', error.message);
  process.exitCode = 1;
  await disconnectDb();
}
