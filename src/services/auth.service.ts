/**
 * Authentication — coordinates the user and session models and the tokens.
 *
 * A service, not a model, because each flow spans two collections plus token signing.
 * Reached only from the auth controller, never directly from a route.
 */

import bcrypt from 'bcryptjs';

import { env } from '../config/env.js';
import { permissionsFor, type Permission, type Role } from '../config/permissions.js';
import { SessionModel } from '../models/auth/session.model.js';
import { UserModel, type UserRow } from '../models/auth/user.model.js';
import {
    BadRequestError,
    LockedError,
    OtpCooldownError,
    OtpInvalidError,
    UnauthorizedError,
} from '../utils/errors.js';
import { OtpService } from './otp.service.js';
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
    /** True after an Admin set a temporary password: the client shows change-password first. */
    mustChangePassword: boolean;
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
    mustChangePassword: row.mustchangepassword === 1,
});

const refreshExpiry = () => new Date(Date.now() + env.auth.refreshTtlSeconds * 1000);

const accessTokenFor = (user: PublicUser, sid: string) =>
    signAccessToken({
        sub: String(user.id),
        sid,
        role: user.role,
        permissions: user.permissions,
        ...(user.mustChangePassword ? { pwc: true } : {}),
    });

/**
 * A new session for a user already checked. The token names the session, so its
 * key is taken first and the session is stored with the token's hash in one
 * write: no half-made session can exist.
 */
async function openSession(user: PublicUser, client: ClientInfo): Promise<IssuedSession> {
    const sid = await SessionModel.newId();
    const refreshToken = signRefreshToken({ sub: String(user.id), sid, gen: 1 });
    await SessionModel.create(sid, user.id, {
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiry(),
        ...client,
    });
    return { user, accessToken: accessTokenFor(user, sid), refreshToken };
}

const RESET_SENT =
    'If the username and mobile number match an account, a code has been sent to that mobile.';

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

        const session = await openSession(toPublicUser(user), client);
        // Separate write. If it fails the login fails too; the session just stored is
        // never handed out and simply expires.
        await UserModel.recordSuccessfulLogin(user.id);
        return session;
    },

    /**
     * Exchange a refresh token for a new pair. The old refresh token stops working.
     * Presenting an already-replaced token means it was copied: every session of
     * that user is revoked, so a thief and the real user both have to sign in again.
     */
    async refresh(token: string): Promise<IssuedSession> {
        const claims = verifyRefreshToken(token);
        const session = await SessionModel.findById(claims.sid);

        // `usermaster_id` is null on an app session: not one this endpoint can refresh.
        if (
            session?.usermaster_id == null ||
            session.revokedat ||
            session.expiresat.getTime() <= Date.now()
        ) {
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

    /**
     * Change the signed-in user's password. Every session of the user ends (a
     * stolen session should not outlive a password change) and a fresh one is
     * returned, so this device stays signed in.
     */
    async changePassword(
        userId: number,
        currentPassword: string,
        newPassword: string,
        client: ClientInfo
    ): Promise<IssuedSession> {
        const hash = await UserModel.findPasswordHashById(userId);
        if (!hash) throw new UnauthorizedError();
        if (!(await bcrypt.compare(currentPassword, hash))) {
            throw new BadRequestError('Your current password is not right.', 'VALIDATION_FAILED', [
                { field: 'currentPassword', message: 'Your current password is not right.' },
            ]);
        }
        if (await bcrypt.compare(newPassword, hash)) {
            throw new BadRequestError(
                'Choose a password different from the current one.',
                'VALIDATION_FAILED',
                [
                    {
                        field: 'newPassword',
                        message: 'Choose a password different from the current one.',
                    },
                ]
            );
        }
        await UserModel.setPassword(userId, await hashPassword(newPassword), 0, userId);
        await SessionModel.revokeAllForUser(userId);
        const user = await UserModel.findActiveById(userId);
        if (!user) throw new UnauthorizedError();
        return openSession(toPublicUser(user), client);
    },

    /**
     * Text a reset code to the user's registered mobile. The answer is the same
     * whether or not the details match, so this cannot be used to find accounts.
     */
    async forgotPassword(usernameInput: string, mobileno: string): Promise<string> {
        const userId = await UserModel.findIdForReset(normaliseUsername(usernameInput), mobileno);
        if (userId === null) return RESET_SENT;
        try {
            await OtpService.issue(
                { purpose: 'PASSWORD_RESET', mobileno },
                (code, minutes) =>
                    `${code} is your TPJP password reset code. It expires in ${minutes} minutes. Do not share it.`
            );
        } catch (err) {
            // Saying "wait" only for real accounts would reveal which ones exist.
            if (!(err instanceof OtpCooldownError)) throw err;
        }
        return RESET_SENT;
    },

    /** Set a new password with the texted code. Ends every session of the user. */
    async resetPassword(
        usernameInput: string,
        mobileno: string,
        code: string,
        newPassword: string
    ): Promise<void> {
        const userId = await UserModel.findIdForReset(normaliseUsername(usernameInput), mobileno);
        if (userId === null) throw new OtpInvalidError();
        await OtpService.verify({ purpose: 'PASSWORD_RESET', mobileno }, code);
        await UserModel.setPassword(userId, await hashPassword(newPassword), 0, userId);
        await SessionModel.revokeAllForUser(userId);
    },
};
