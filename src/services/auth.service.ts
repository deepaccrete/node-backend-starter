/**
 * Authentication — coordinates the user and session models and the tokens.
 *
 * A service, not a model, because each flow spans two tables plus token signing.
 * Reached only from the auth controller, never directly from a route.
 */

import bcrypt from 'bcryptjs';

import { withTransaction } from '../config/database.js';
import { env } from '../config/env.js';
import { permissionsFor, type Permission, type Role } from '../config/permissions.js';
import { SessionModel } from '../models/auth/session.model.js';
import { UserModel, type UserRow } from '../models/auth/user.model.js';
import { LockedError, UnauthorizedError } from '../utils/errors.js';
import {
    hashToken,
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
} from './token.service.js';

export const BCRYPT_ROUNDS = 12;

/** The user as the client sees it. `permissions` come from the backend's role table. */
export interface PublicUser {
    id: number;
    username: string;
    name: string;
    role: Role;
    permissions: Permission[];
}

export interface IssuedSession {
    user: PublicUser;
    accessToken: string;
    refreshToken: string;
}

export interface ClientInfo {
    userAgent: string | null;
    ipAddress: string | null;
}

const INVALID_CREDENTIALS = 'Incorrect username or password.';

// Compared against when the username does not exist, so "no such user" takes as
// long as "wrong password" and response timing does not reveal valid usernames.
let dummyHash: Promise<string> | undefined;
const timingDummy = () => (dummyHash ??= bcrypt.hash('timing-equaliser', BCRYPT_ROUNDS));

export const normaliseUsername = (username: string) => username.trim().toLowerCase();

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);

const toPublicUser = (row: UserRow): PublicUser => ({
    id: row.id,
    username: row.username,
    name: row.fullname,
    role: row.rolecode,
    permissions: permissionsFor(row.rolecode),
});

const refreshExpiry = () => new Date(Date.now() + env.auth.refreshTtlSeconds * 1000);

const accessTokenFor = (user: PublicUser, sid: string) =>
    signAccessToken({ sub: String(user.id), sid, role: user.role, permissions: user.permissions });

export const AuthService = {
    async login(
        usernameInput: string,
        password: string,
        client: ClientInfo
    ): Promise<IssuedSession> {
        const user = await UserModel.findCredentialsByUsername(normaliseUsername(usernameInput));

        if (user?.isactive !== 1) {
            await bcrypt.compare(password, await timingDummy());
            throw new UnauthorizedError(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
        }

        if (user.lockeduntil && user.lockeduntil.getTime() > Date.now()) {
            const minutes = Math.ceil((user.lockeduntil.getTime() - Date.now()) / 60_000);
            throw new LockedError(
                `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
            );
        }

        if (!(await bcrypt.compare(password, user.passwordhash))) {
            await UserModel.recordFailedLogin(user.id, env.auth.maxFailures, env.auth.lockMinutes);
            throw new UnauthorizedError(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
        }

        const publicUser = toPublicUser(user);

        // Two tables change together: the new session row and the user's login counters.
        const refreshToken = await withTransaction(async (db) => {
            const session = await SessionModel.create(
                user.id,
                { expiresAt: refreshExpiry(), ...client },
                db
            );
            const token = signRefreshToken({ sub: String(user.id), sid: session.id, gen: 1 });
            await SessionModel.rotate(session.id, 0, hashToken(token), refreshExpiry(), db);
            await UserModel.recordSuccessfulLogin(user.id, db);
            return { token, sid: session.id };
        });

        return {
            user: publicUser,
            accessToken: accessTokenFor(publicUser, refreshToken.sid),
            refreshToken: refreshToken.token,
        };
    },

    /**
     * Exchange a refresh token for a new pair. The old refresh token stops working.
     * Presenting an already-replaced token means it was copied: every session of
     * that user is revoked, so a thief and the real user both have to sign in again.
     */
    async refresh(token: string): Promise<IssuedSession> {
        const claims = verifyRefreshToken(token);
        const session = await SessionModel.findById(claims.sid);

        if (!session || session.revokedat || session.expiresat.getTime() <= Date.now()) {
            throw new UnauthorizedError(
                'Your session has expired. Please sign in again.',
                'SESSION_EXPIRED'
            );
        }

        if (claims.gen !== session.generation || hashToken(token) !== session.refreshtokenhash) {
            await SessionModel.revokeAllForUser(session.usermaster_id);
            throw new UnauthorizedError(
                'Your session was ended for security reasons. Please sign in again.',
                'REFRESH_REUSED'
            );
        }

        const user = await UserModel.findActiveById(session.usermaster_id);
        if (!user) {
            await SessionModel.revoke(session.id);
            throw new UnauthorizedError(
                'Your session has expired. Please sign in again.',
                'SESSION_EXPIRED'
            );
        }

        const next = signRefreshToken({
            sub: String(user.id),
            sid: session.id,
            gen: session.generation + 1,
        });
        const rotated = await SessionModel.rotate(
            session.id,
            session.generation,
            hashToken(next),
            refreshExpiry()
        );
        if (!rotated) {
            // Another request rotated this session a moment earlier.
            throw new UnauthorizedError(
                'Your session has expired. Please sign in again.',
                'SESSION_EXPIRED'
            );
        }

        const publicUser = toPublicUser(user);
        return {
            user: publicUser,
            accessToken: accessTokenFor(publicUser, session.id),
            refreshToken: next,
        };
    },

    /** Revoke the session named by the refresh token. A missing or invalid token is not an error. */
    async logout(token: string | undefined): Promise<void> {
        if (!token) return;
        try {
            const { sid } = verifyRefreshToken(token);
            await SessionModel.revoke(sid);
        } catch (err) {
            if (!(err instanceof UnauthorizedError)) throw err;
        }
    },

    async currentUser(userId: number): Promise<PublicUser> {
        const user = await UserModel.findActiveById(userId);
        if (!user) throw new UnauthorizedError();
        return toPublicUser(user);
    },
};
