// /metrics endpoint. Prometheus scraper hits this on a fixed interval; the
// gauges are kept up-to-date by the sampler in observability/sampler.ts.

import type { Express, Request, Response } from 'express';
import { registry } from './metrics.js';

export function registerMetricsRoute(app: Express): void {
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'metrics render failed';
      res.status(500).end(message);
    }
  });
}
