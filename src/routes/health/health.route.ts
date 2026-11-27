/**
 * Health endpoints. Unauthenticated by design — a probe has no credentials.
 *
 *   GET /health        LIVENESS — "is this process running?" Never touches the
 *                      database: a liveness probe that checks the DB turns a brief
 *                      database blip into every container restarting at once.
 *   GET /health/ready  READINESS — "should traffic be routed here?" Pings the
 *                      database; 503 (not 500) when it cannot be reached.
 */

import { Router } from 'express';
import { z } from 'zod';

import { query } from '../../config/database.js';
import { jsonContent, registry } from '../../openapi/registry.js';
import { APP_VERSION } from '../../utils/version.js';

const PATH = '/health';
const router = Router();
const startedAt = Date.now();

router.get('/', (_req, res) => {
    res.json({
        success: true,
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        version: APP_VERSION,
        timestamp: new Date().toISOString(),
    });
});

router.get('/ready', async (_req, res) => {
    try {
        await query('SELECT 1');
        res.json({ success: true, status: 'ready', database: 'up' });
    } catch {
        // The driver's message is logged by `query`; it is not sent to an unauthenticated caller.
        res.status(503).json({
            success: false,
            code: 'INTERNAL_ERROR',
            status: 'not-ready',
            database: 'down',
            message: 'Database unavailable',
        });
    }
});

registry.registerPath({
    method: 'get',
    path: PATH,
    tags: ['Health'],
    summary: 'Liveness: the process is running',
    responses: {
        200: {
            description: 'Running',
            content: jsonContent(
                z.object({
                    success: z.literal(true),
                    status: z.literal('ok'),
                    uptimeSeconds: z.number().int(),
                    version: z.string(),
                    timestamp: z.string(),
                })
            ),
        },
    },
});
registry.registerPath({
    method: 'get',
    path: `${PATH}/ready`,
    tags: ['Health'],
    summary: 'Readiness: the database answers',
    responses: {
        200: { description: 'Ready' },
        503: { description: 'Database unavailable' },
    },
});

export default { path: PATH, router };
