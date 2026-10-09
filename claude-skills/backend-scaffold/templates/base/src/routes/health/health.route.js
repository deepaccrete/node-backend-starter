/**
 * Health endpoints. Unauthenticated by design — a probe has no credentials.
 *
 * Two endpoints, because liveness and readiness answer different questions and
 * conflating them causes outages:
 *
 *   GET /health        LIVENESS  — "is this process running?" Never touches the
 *                      database. If a liveness probe checks the DB, a brief
 *                      database blip restarts every healthy API container at
 *                      once and turns a blip into an outage.
 *
 *   GET /health/ready  READINESS — "should traffic be routed here?" Pings the
 *                      database, because an instance that cannot reach it will
 *                      fail every request and should be pulled from the pool.
 */

const { Router } = require('express');

const { query } = require('../../config/database');

const router = Router();

const startedAt = Date.now();

router.get('/', (req, res) => {
    res.json({
        success: true,
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        version: require('../../../package.json').version,
        timestamp: new Date().toISOString(),
    });
});

router.get('/ready', async (req, res) => {
    try {
        await query('SELECT 1');
        return res.json({ success: true, status: 'ready', database: 'up' });
    } catch (err) {
        // 503, not 500: this instance is not broken, it is not ready. Load
        // balancers treat the two differently.
        // The driver error is already logged by `query()`; don't return it to an
        // unauthenticated probe — it leaks connection and schema detail.
        return res.status(503).json({ success: false, status: 'not-ready', database: 'down' });
    }
});

module.exports = { path: '/health', router };
