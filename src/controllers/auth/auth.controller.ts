/**
 * Auth controller — thin: read the request, call one service function, set or
 * clear the refresh cookie, and pick a response helper.
 *
 * The refresh token travels ONLY in an httpOnly cookie scoped to the auth path,
 * so page scripts cannot read it and other endpoints never receive it. The access
 * token goes in the response body and is held in memory by the frontend.
 */

import type { CookieOptions, Request, Response } from 'express';

import { env } from '../../config/env.js';
import { AuthService, type IssuedSession } from '../../services/auth.service.js';
import { UnauthorizedError } from '../../utils/errors.js';
import { success } from '../../utils/response.js';
import type { LoginBody } from '../../routes/auth/auth.route.js';

export const REFRESH_COOKIE = 'tpjp_rt';

const cookieOptions = (): CookieOptions => ({
    httpOnly: true,
    // Browsers drop Secure cookies on plain http://localhost, so it is on outside development.
    secure: env.NODE_ENV !== 'development',
    sameSite: 'strict',
    path: `${env.API_PREFIX}/auth`,
});

const readRefreshCookie = (req: Request): string | undefined => {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value ? value : undefined;
};

function sendSession(res: Response, session: IssuedSession, message: string) {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
        ...cookieOptions(),
        maxAge: env.auth.refreshTtlSeconds * 1000,
    });
    return success(res, { user: session.user, accessToken: session.accessToken }, message);
}

export const AuthController = {
    login: async (req: Request, res: Response) => {
        const { username, password } = req.body as LoginBody;
        const session = await AuthService.login(username, password, {
            userAgent: req.get('user-agent') ?? null,
            ipAddress: req.ip ?? null,
        });
        return sendSession(res, session, 'Signed in');
    },

    refresh: async (req: Request, res: Response) => {
        const token = readRefreshCookie(req);
        if (!token) throw new UnauthorizedError('Please sign in.', 'SESSION_EXPIRED');
        try {
            return sendSession(res, await AuthService.refresh(token), 'Session refreshed');
        } catch (err) {
            // A refresh that fails ends the session in this browser too.
            res.clearCookie(REFRESH_COOKIE, cookieOptions());
            throw err;
        }
    },

    logout: async (req: Request, res: Response) => {
        await AuthService.logout(readRefreshCookie(req));
        res.clearCookie(REFRESH_COOKIE, cookieOptions());
        return res.status(204).end();
    },

    me: async (req: Request, res: Response) => {
        if (!req.user) throw new UnauthorizedError();
        return success(res, await AuthService.currentUser(req.user.id), 'Signed-in user');
    },
};
