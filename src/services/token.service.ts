/**
 * Signing and verifying the two token types.
 *
 *   access   short-lived, sent as `Authorization: Bearer …`, carries role + permissions.
 *   refresh  long-lived, only in an httpOnly cookie, names a session row (`sid`) and
 *            its generation (`gen`) so a replayed old token can be detected.
 *
 * The Android app has its own pair (`app-access`, `app-refresh`) naming a
 * telecaller number instead of a dashboard user; the app keeps its refresh token
 * in the device's secure storage, as cookies do not suit a native app.
 *
 * Separate secrets per type, and a `typ` claim checked BEFORE anything else, so
 * one kind can never be accepted as the other.
 */

import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { isRole, PERMISSIONS, type Permission, type Role } from '../config/permissions.js';
import { UnauthorizedError } from '../utils/errors.js';

const ALGORITHM = 'HS256';

export interface AccessClaims {
    sub: string;
    sid: string;
    role: Role;
    permissions: Permission[];
    /** Signed in with a temporary password: only changing it is allowed. */
    pwc?: boolean;
}

/** App access token: `sub` is the `distributorcontactid`. */
export interface AppAccessClaims {
    sub: string;
    sid: string;
    distributorid: number;
}

export interface RefreshClaims {
    sub: string;
    sid: string;
    gen: number;
}

export function signAccessToken(claims: AccessClaims): string {
    return jwt.sign({ ...claims, typ: 'access' }, env.auth.accessSecret, {
        algorithm: ALGORITHM,
        expiresIn: env.auth.accessTtlSeconds,
    });
}

export function signRefreshToken(claims: RefreshClaims): string {
    return jwt.sign({ ...claims, typ: 'refresh' }, env.auth.refreshSecret, {
        algorithm: ALGORITHM,
        expiresIn: env.auth.refreshTtlSeconds,
    });
}

export function signAppAccessToken(claims: AppAccessClaims): string {
    return jwt.sign({ ...claims, typ: 'app-access' }, env.auth.accessSecret, {
        algorithm: ALGORITHM,
        expiresIn: env.auth.accessTtlSeconds,
    });
}

export function signAppRefreshToken(claims: RefreshClaims): string {
    return jwt.sign({ ...claims, typ: 'app-refresh' }, env.auth.refreshSecret, {
        algorithm: ALGORITHM,
        expiresIn: env.auth.refreshTtlSeconds,
    });
}

function decode(token: string, secret: string, expiredCode: 'TOKEN_EXPIRED' | 'SESSION_EXPIRED') {
    try {
        const payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
        if (typeof payload === 'string') throw new UnauthorizedError('Invalid token');
        return payload;
    } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
            throw new UnauthorizedError(
                'Your session has expired. Please sign in again.',
                expiredCode
            );
        }
        throw new UnauthorizedError('Invalid token');
    }
}

const isPermission = (value: unknown): value is Permission => PERMISSIONS.some((p) => p === value);

export function verifyAccessToken(token: string): AccessClaims {
    const p = decode(token, env.auth.accessSecret, 'TOKEN_EXPIRED');
    if (p.typ !== 'access') throw new UnauthorizedError('Invalid token');
    if (
        typeof p.sub !== 'string' ||
        typeof p.sid !== 'string' ||
        !isRole(p.role) ||
        !Array.isArray(p.permissions)
    ) {
        throw new UnauthorizedError('Invalid token');
    }
    return {
        sub: p.sub,
        sid: p.sid,
        role: p.role,
        permissions: p.permissions.filter(isPermission),
        ...(p.pwc === true ? { pwc: true } : {}),
    };
}

export function verifyAppAccessToken(token: string): AppAccessClaims {
    const p = decode(token, env.auth.accessSecret, 'TOKEN_EXPIRED');
    if (p.typ !== 'app-access') throw new UnauthorizedError('Invalid token');
    if (
        typeof p.sub !== 'string' ||
        typeof p.sid !== 'string' ||
        typeof p.distributorid !== 'number'
    ) {
        throw new UnauthorizedError('Invalid token');
    }
    return { sub: p.sub, sid: p.sid, distributorid: p.distributorid };
}

export function verifyRefreshToken(
    token: string,
    typ: 'refresh' | 'app-refresh' = 'refresh'
): RefreshClaims {
    const p = decode(token, env.auth.refreshSecret, 'SESSION_EXPIRED');
    if (p.typ !== typ) throw new UnauthorizedError('Invalid token', 'SESSION_EXPIRED');
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.gen !== 'number') {
        throw new UnauthorizedError('Invalid token', 'SESSION_EXPIRED');
    }
    return { sub: p.sub, sid: p.sid, gen: p.gen };
}

/** Refresh tokens are stored hashed, so a database leak does not hand out live sessions. */
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
