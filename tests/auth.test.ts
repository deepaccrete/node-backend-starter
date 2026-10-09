/**
 * Auth end to end through HTTP, with the two models replaced by an in-memory
 * stand-in (no database). Everything else is real: validation, bcrypt, token
 * signing, cookie handling, rotation, reuse detection and the middleware.
 */

import bcrypt from 'bcryptjs';
import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DatabaseModule from '../src/config/database.js';
import type { Role } from '../src/config/permissions.js';

// ─── In-memory stand-in for usermaster / authsession ──────────────────
interface FakeUser {
    id: number;
    username: string;
    fullname: string;
    rolecode: Role;
    passwordhash: string;
    failedlogins: number;
    lockeduntil: Date | null;
    isactive: number;
}
interface FakeSession {
    id: string;
    usermaster_id: number;
    refreshtokenhash: string;
    generation: number;
    expiresat: Date;
    revokedat: Date | null;
}

const store = vi.hoisted(() => ({
    users: new Map<string, FakeUser>(),
    sessions: new Map<string, FakeSession>(),
    nextSession: 1,
}));

vi.mock('../src/config/database.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DatabaseModule>();
    return { ...actual, withTransaction: (fn: (db: unknown) => Promise<unknown>) => fn(undefined) };
});

vi.mock('../src/models/auth/user.model.js', () => {
    const byId = (id: number) => [...store.users.values()].find((u) => u.id === id);
    return {
        UserModel: {
            findCredentialsByUsername: vi.fn((username: string) =>
                Promise.resolve(store.users.get(username) ?? null)
            ),
            findActiveById: vi.fn((id: number) => {
                const u = byId(id);
                return Promise.resolve(u?.isactive === 1 ? u : null);
            }),
            recordFailedLogin: vi.fn((id: number, max: number, lockMinutes: number) => {
                const u = byId(id);
                if (u) {
                    u.failedlogins += 1;
                    if (u.failedlogins >= max) {
                        u.failedlogins = 0;
                        u.lockeduntil = new Date(Date.now() + lockMinutes * 60_000);
                    }
                }
                return Promise.resolve();
            }),
            recordSuccessfulLogin: vi.fn(() => Promise.resolve()),
        },
    };
});

vi.mock('../src/models/auth/session.model.js', () => ({
    SessionModel: {
        create: vi.fn((userId: number, data: { expiresAt: Date }) => {
            const s: FakeSession = {
                id: `00000000-0000-4000-8000-${String(store.nextSession++).padStart(12, '0')}`,
                usermaster_id: userId,
                refreshtokenhash: '',
                generation: 0,
                expiresat: data.expiresAt,
                revokedat: null,
            };
            store.sessions.set(s.id, s);
            return Promise.resolve({ ...s });
        }),
        findById: vi.fn((id: string) => {
            const s = store.sessions.get(id);
            return Promise.resolve(s ? { ...s } : null);
        }),
        rotate: vi.fn((id: string, gen: number, hash: string, expiresAt: Date) => {
            const s = store.sessions.get(id);
            if (s?.generation !== gen || s.revokedat) return Promise.resolve(null);
            Object.assign(s, { generation: gen + 1, refreshtokenhash: hash, expiresat: expiresAt });
            return Promise.resolve({ ...s });
        }),
        revoke: vi.fn((id: string) => {
            const s = store.sessions.get(id);
            if (s) s.revokedat = new Date();
            return Promise.resolve();
        }),
        revokeAllForUser: vi.fn((userId: number) => {
            for (const s of store.sessions.values())
                if (s.usermaster_id === userId) s.revokedat = new Date();
            return Promise.resolve();
        }),
    },
}));

const { createApp } = await import('../src/app.js');
const { SessionModel } = await import('../src/models/auth/session.model.js');
const { UserModel } = await import('../src/models/auth/user.model.js');
const { authenticate } = await import('../src/middleware/authenticate.js');
const { requirePermission } = await import('../src/middleware/requirePermission.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { requestContext } = await import('../src/middleware/requestContext.js');
const { signAccessToken } = await import('../src/services/token.service.js');

const PASSWORD = 'correct horse battery';
let app: Express;

function addUser(id: number, username: string, rolecode: Role, extra: Partial<FakeUser> = {}) {
    store.users.set(username, {
        id,
        username,
        fullname: `${username} name`,
        rolecode,
        passwordhash: bcrypt.hashSync(PASSWORD, 4), // low cost keeps tests fast
        failedlogins: 0,
        lockeduntil: null,
        isactive: 1,
        ...extra,
    });
}

/** The value of the tpjp_rt cookie from a response, or undefined. */
function refreshCookie(res: request.Response): string | undefined {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const line = raw?.find((c) => c.startsWith('tpjp_rt='));
    const value = line?.split(';')[0]?.slice('tpjp_rt='.length);
    return value === '' ? undefined : value;
}

const login = (username: string, password = PASSWORD) =>
    request(app).post('/api/v1/auth/login').send({ username, password });

beforeAll(async () => {
    app = await createApp();
});

beforeEach(() => {
    store.users.clear();
    store.sessions.clear();
    addUser(1, 'admin', 'ADMIN');
    addUser(2, 'asm', 'ASM');
});

describe('POST /auth/login', () => {
    it('signs in, returns the user with permissions and sets a hardened refresh cookie', async () => {
        const res = await login('  Admin  ');
        expect(res.status).toBe(200);
        const body = res.body as {
            data: { user: { role: string; permissions: string[] }; accessToken: string };
        };
        expect(body.data.user.role).toBe('ADMIN');
        expect(body.data.user.permissions).toContain('plans:upload');
        expect(body.data.accessToken).toEqual(expect.any(String));

        const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
            c.startsWith('tpjp_rt=')
        );
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/SameSite=Strict/);
        expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    });

    it('gives the same answer for a wrong password and an unknown user', async () => {
        const wrong = await login('admin', 'nope');
        const unknown = await login('ghost', 'nope');
        for (const res of [wrong, unknown]) {
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({
                code: 'INVALID_CREDENTIALS',
                message: 'Incorrect username or password.',
            });
        }
        expect(vi.mocked(UserModel.recordFailedLogin)).toHaveBeenCalledTimes(1);
    });

    it('locks the account after 5 failures (423 ACCOUNT_LOCKED), even for the right password', async () => {
        for (let i = 0; i < 5; i++) await login('admin', 'nope');
        const res = await login('admin');
        expect(res.status).toBe(423);
        expect(res.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    });

    it('refuses a deactivated user like an unknown one', async () => {
        addUser(3, 'gone', 'RM', { isactive: 0 });
        expect((await login('gone')).body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });
});

describe('access token', () => {
    it('opens /auth/me', async () => {
        const token = ((await login('asm')).body as { data: { accessToken: string } }).data
            .accessToken;
        const me = await request(app)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${token}`);
        expect(me.status).toBe(200);
        expect(me.body).toMatchObject({ data: { username: 'asm', role: 'ASM' } });
    });

    it('is rejected when expired (TOKEN_EXPIRED) and when it is really a refresh token', async () => {
        const expired = jwt.sign(
            {
                sub: '1',
                sid: 's',
                role: 'ADMIN',
                permissions: [],
                typ: 'access',
                exp: Math.floor(Date.now() / 1000) - 10,
            },
            process.env.JWT_ACCESS_SECRET ?? ''
        );
        const res = await request(app)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${expired}`);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: 'TOKEN_EXPIRED' });

        const refresh = refreshCookie(await login('admin')) ?? '';
        const asAccess = await request(app)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${refresh}`);
        expect(asAccess.status).toBe(401);
    });

    it('is rejected when its typ is not "access", even if signed with the access secret', async () => {
        const wrongType = jwt.sign(
            { sub: '1', sid: 's', role: 'ADMIN', permissions: ['plans:upload'], typ: 'refresh' },
            process.env.JWT_ACCESS_SECRET ?? ''
        );
        const res = await request(app)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${wrongType}`);
        expect(res.status).toBe(401);
    });

    it('is never read from a cookie', async () => {
        const token = ((await login('asm')).body as { data: { accessToken: string } }).data
            .accessToken;
        const res = await request(app).get('/api/v1/auth/me').set('Cookie', `access=${token}`);
        expect(res.status).toBe(401);
    });
});

describe('POST /auth/refresh', () => {
    it('rotates the refresh token and returns a new access token', async () => {
        const first = refreshCookie(await login('admin'));
        const res = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `tpjp_rt=${first ?? ''}`);
        expect(res.status).toBe(200);
        const second = refreshCookie(res);
        expect(second).toBeDefined();
        expect(second).not.toBe(first);
    });

    it('treats a replayed old token as theft: REFRESH_REUSED and every session revoked', async () => {
        const first = refreshCookie(await login('admin')) ?? '';
        const other = refreshCookie(await login('admin')) ?? ''; // a second device
        await request(app).post('/api/v1/auth/refresh').set('Cookie', `tpjp_rt=${first}`);

        const replay = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `tpjp_rt=${first}`);
        expect(replay.status).toBe(401);
        expect(replay.body).toMatchObject({ code: 'REFRESH_REUSED' });
        expect(vi.mocked(SessionModel.revokeAllForUser)).toHaveBeenCalledWith(1);

        const otherDevice = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `tpjp_rt=${other}`);
        expect(otherDevice.status).toBe(401);
    });

    it('answers SESSION_EXPIRED without a cookie', async () => {
        const res = await request(app).post('/api/v1/auth/refresh');
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: 'SESSION_EXPIRED' });
    });
});

describe('POST /auth/logout', () => {
    it('revokes the session and clears the cookie', async () => {
        const token = refreshCookie(await login('admin')) ?? '';
        const res = await request(app)
            .post('/api/v1/auth/logout')
            .set('Cookie', `tpjp_rt=${token}`);
        expect(res.status).toBe(204);
        expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/tpjp_rt=;/);

        const after = await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `tpjp_rt=${token}`);
        expect(after.status).toBe(401);
    });
});

describe('requirePermission', () => {
    const guarded = express()
        .use(requestContext)
        .get('/upload', authenticate, requirePermission('plans:upload'), (_req, res) => {
            res.json({ ok: true });
        })
        .use(errorHandler);

    const tokenFor = (role: Role, permissions: string[]) =>
        signAccessToken({ sub: '9', sid: 's', role, permissions: permissions as never });

    it('answers 403 FORBIDDEN without the permission and lets it through with it', async () => {
        const denied = await request(guarded)
            .get('/upload')
            .set('Authorization', `Bearer ${tokenFor('ASM', ['dashboard:view'])}`);
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({ code: 'FORBIDDEN' });

        const allowed = await request(guarded)
            .get('/upload')
            .set('Authorization', `Bearer ${tokenFor('ADMIN', ['plans:upload'])}`);
        expect(allowed.status).toBe(200);
    });

    it('answers 401 without a token', async () => {
        expect((await request(guarded).get('/upload')).status).toBe(401);
    });
});
