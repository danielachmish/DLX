import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { createPool, type Pool } from './db.js';
import { errorHandler } from './errors.js';
import { createProviders, type Providers } from './services/providers.js';
import { authRoutes } from './routes/auth.js';
import { settingsRoutes } from './routes/settings.js';
import { catalogRoutes } from './routes/catalog.js';
import { purchasingRoutes } from './routes/purchasing.js';
import { stockRoutes } from './routes/stock.js';
import { customerRoutes } from './routes/customers.js';
import { cashRoutes } from './routes/cash.js';
import { salesRoutes } from './routes/sales.js';
import { returnRoutes } from './routes/returns.js';
import { documentRoutes } from './routes/documents.js';
import { reportRoutes } from './routes/reports.js';
import { exportRoutes } from './routes/exports.js';

declare module 'fastify' {
  interface FastifyInstance { pool: Pool; config: Config; providers: Providers }
}

export async function buildApp(config: Config, deps: { pool?: Pool; providers?: Providers } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logger ? { level: 'info', redact: ['req.headers.authorization', 'body.password', 'body.pin'] } : false,
    genReqId: (req) => (req.headers['x-correlation-id'] as string) || randomUUID(),
    bodyLimit: 5 * 1024 * 1024,
  });
  app.decorate('pool', deps.pool ?? createPool(config.databaseUrl));
  app.decorate('config', config);
  app.decorate('providers', deps.providers ?? createProviders());
  app.decorateRequest('auth', null as any);

  await app.register(cors, { origin: true, exposedHeaders: ['x-correlation-id'] });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '12h' } });
  await app.register(rateLimit, { global: false });
  app.addHook('onSend', async (req, reply) => { reply.header('x-correlation-id', req.id); });
  app.setErrorHandler(errorHandler);

  app.get('/health', async () => {
    await app.pool.query('SELECT 1');
    return { ok: true, service: 'dlx-api', time: new Date().toISOString() };
  });

  await app.register(async (v1) => {
    await authRoutes(v1);
    await settingsRoutes(v1);
    await catalogRoutes(v1);
    await purchasingRoutes(v1);
    await stockRoutes(v1);
    await customerRoutes(v1);
    await cashRoutes(v1);
    await salesRoutes(v1);
    await returnRoutes(v1);
    await documentRoutes(v1);
    await reportRoutes(v1);
    await exportRoutes(v1);
  }, { prefix: '/v1' });

  app.addHook('onClose', async () => { if (!deps.pool) await app.pool.end(); });
  return app;
}
