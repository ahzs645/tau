import type { Express, RequestHandler } from 'express';
import express from 'express';
import process from 'node:process';

import { createRequestHandler } from '@react-router/express';
import { coiMiddleware } from '@taucad/runtime/cross-origin-isolation/express';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

export async function createApp(): Promise<Express> {
  // The SSR build is produced by `react-router build` into ./build/server/index.js
  // and is intentionally excluded from typecheck (it does not exist before `nx build ui`).
  // @ts-expect-error -- runtime-only import; declared by react-router build output
  const build = (await import('./build/server/index.js')) as Parameters<typeof createRequestHandler>[0]['build'];
  const app = express();
  app.disable('x-powered-by');
  app.use(coiMiddleware() as RequestHandler);
  app.use('/assets', express.static('build/client/assets', { immutable: true, maxAge: '1y' }));
  app.use(express.static('build/client', { maxAge: '1h' }));
  app.all('*splat', createRequestHandler({ build }));
  return app;
}

if (process.env['NODE_ENV'] !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  app.listen(port, () => {
    // oxlint-disable-next-line no-console -- server boot log
    console.log(`[tau-serve] http://localhost:${port}`);
  });
}
