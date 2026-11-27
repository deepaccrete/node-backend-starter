/**
 * Require a signed-in user. Reads ONLY the `Authorization: Bearer` header —
 * never a cookie: a token accepted from a cookie is one a cross-site request can
 * carry (CSRF). Sets `req.user`.
 *
 * Apply it once at the top of a route file, `router.use(authenticate)`, so a
 * route added later inherits it instead of being silently public.
 *
 * A user signed in with a temporary password is refused everywhere
 * (PASSWORD_CHANGE_REQUIRED) except the few routes that use
 * `authenticateAllowingPasswordChange`: change-password and /me.
 *
 * `authenticateApp` is the Android app's equivalent: it accepts only app tokens
 * and sets `req.contact`. Neither middleware accepts the other's tokens.
 */

import type { Request, RequestHandler } from 'express';

import { verifyAccessToken, verifyAppAccessToken } from '../services/token.service.js';
import { PasswordChangeRequiredError, UnauthorizedError } from '../utils/errors.js';

const bearer = (req: Request) => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    return scheme === 'Bearer' && token ? token : null;
};

const dashboard =
    (allowPasswordChange: boolean): RequestHandler =>
    (req, _res, next) => {
        const token = bearer(req);
        if (!token) {
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
                mustChangePassword: claims.pwc === true,
            };
            next(
                req.user.mustChangePassword && !allowPasswordChange
                    ? new PasswordChangeRequiredError()
                    : undefined
            );
        } catch (err) {
            next(err);
        }
    };

export const authenticate = dashboard(false);

/** For change-password and /me only: lets a user with a temporary password through. */
export const authenticateAllowingPasswordChange = dashboard(true);

export const authenticateApp: RequestHandler = (req, _res, next) => {
    const token = bearer(req);
    if (!token) {
        next(new UnauthorizedError());
        return;
    }
    try {
        const claims = verifyAppAccessToken(token);
        req.contact = {
            id: Number(claims.sub),
            distributorid: claims.distributorid,
            sid: claims.sid,
        };
        next();
    } catch (err) {
        next(err);
    }
};
