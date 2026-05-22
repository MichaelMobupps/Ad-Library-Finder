import { Router } from 'express';

export const healthRouter: Router = Router();

// Captured at module load — advances on each deploy (process restart).
// Used by the autonomous deploy-detect poller via /version.
const BUILT_AT = new Date().toISOString();

healthRouter.get('/', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Separate version endpoint (mounted at /version by index.ts).
export const versionRouter: Router = Router();
versionRouter.get('/', (_req, res) => {
  res.json({ builtAt: BUILT_AT });
});