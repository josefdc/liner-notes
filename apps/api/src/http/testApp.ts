/**
 * Test helper: an Express app with the given routers mounted, for route tests with supertest.
 *
 *   const app = createTestApp(healthRouter);
 *   const res = await request(app).get("/api/health");
 */

import express, { type Router } from "express";

export function createTestApp(...routers: Router[]): express.Express {
  const app = express();
  app.use(express.json());
  for (const router of routers) app.use(router);
  return app;
}
