import type { RequestHandler } from 'express';

import { error } from '../utils/response.js';

/**
 * Reached only when no route matched. Answers in the same envelope as everything
 * else: an HTML 404 breaks clients that assume JSON.
 */
export const notFound: RequestHandler = (req, res) => {
    error(res, `Route not found: ${req.method} ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND');
};
