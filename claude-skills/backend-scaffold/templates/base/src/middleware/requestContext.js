/**
 * Attach a correlation id to every request.
 *
 * Without one, a production log is a flat stream in which the lines belonging to
 * a single failing request cannot be identified. The id is echoed back in the
 * `X-Request-Id` response header, so a user reporting a problem can hand you the
 * exact key to grep for.
 *
 * An incoming `X-Request-Id` is honoured, which is what lets a trace span the
 * gateway, this API, and anything it calls downstream.
 */

const crypto = require('crypto');

const requestContext = (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    // Bound the length: an attacker-supplied header ends up in log files.
    req.id = typeof incoming === 'string' && incoming.length <= 64 ? incoming : crypto.randomUUID();
    req.startedAt = Date.now();
    res.setHeader('X-Request-Id', req.id);
    next();
};

module.exports = requestContext;
