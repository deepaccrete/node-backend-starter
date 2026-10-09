import crypto from 'node:crypto';

import type { RequestHandler } from 'express';

/**
 * Attach a correlation id to every request and echo it in `X-Request-Id`, so the
 * log lines of one failing request can be found together. An incoming id is
 * honoured (bounded in length — it ends up in log files).
 */
export const requestContext: RequestHandler = (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && incoming.length <= 64 ? incoming : crypto.randomUUID();
    req.startedAt = Date.now();
    req.validated = {};
    res.setHeader('X-Request-Id', req.id);
    next();
};
