/**
 * Require a signed-in user. Reads ONLY the `Authorization: Bearer` header —
 * never a cookie: a token accepted from a cookie is one a cross-site request can
 * carry (CSRF). Sets `req.user`.
 *
 * Apply it once at the top of a route file, `router.use(authenticate)`, so a
 * route added later inherits it instead of being silently public.
 */

import type { RequestHandler } from 'express';

import { verifyAccessToken } from '../services/token.service.js';
import { UnauthorizedError } from '../utils/errors.js';

export const authenticate: RequestHandler = (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
        next(new UnauthorizedError());
        return;
    }
    try {
        const claims = verifyAccessToken(token);
        req.user = {
            id: Number(claims.sub),
            role: claims.role,
            permissions: claims.permissions,
            sid: claims.sid,
        };
        next();
    } catch (err) {
        next(err);
    }
};
