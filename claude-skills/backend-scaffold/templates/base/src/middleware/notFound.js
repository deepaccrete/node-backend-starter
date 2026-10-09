const { error } = require('../utils/response');

/**
 * Reached only when no route matched. Mounted after the route loader and before
 * the error handler.
 *
 * It answers in the same envelope as everything else — a 404 that returns
 * Express's default HTML page breaks clients that assume JSON, and it is
 * indistinguishable from a proxy misconfiguration.
 */
const notFound = (req, res) =>
    error(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);

module.exports = notFound;
