/**
 * Auth routes. Mounted automatically at ${API_PREFIX}/auth by the route loader —
 * the `{ path, router }` export at the bottom IS the registration.
 *
 * login / refresh / logout are public by nature (they create or end a session).
 * /me requires a signed-in user. app.ts gives /auth its own, stricter rate limit.
 */

import { Router } from 'express';
import { z } from 'zod';

import { AuthController, REFRESH_COOKIE } from '../../controllers/auth/auth.controller.js';
import { PERMISSIONS, ROLES } from '../../config/permissions.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
    envelope,
    errorResponses,
    jsonContent,
    registry,
    requiresAuth,
} from '../../openapi/registry.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// ─── Field rules ──────────────────────────────────────────────────────
// Used for validation AND the OpenAPI contract. Lengths mirror the columns
// (usermaster.username is varchar(64)).

export const LoginBodySchema = z
    .object({
        username: z
            .string({ error: 'Enter your username' })
            .trim()
            .min(1, 'Enter your username')
            .max(64, 'Username is too long'),
        password: z
            .string({ error: 'Enter your password' })
            .min(1, 'Enter your password')
            .max(128, 'Password is too long'),
    })
    .meta({ id: 'LoginRequest' });

export type LoginBody = z.infer<typeof LoginBodySchema>;

export const PublicUserSchema = z
    .object({
        id: z.number().int(),
        username: z.string(),
        name: z.string(),
        role: z.enum(ROLES),
        permissions: z.array(z.enum(PERMISSIONS)),
    })
    .meta({ id: 'User' });

export const SessionSchema = z
    .object({
        user: PublicUserSchema,
        accessToken: z
            .string()
            .meta({ description: 'Short-lived bearer token. Keep in memory only.' }),
    })
    .meta({ id: 'Session' });

// ─── Endpoints ────────────────────────────────────────────────────────

const PATH = '/auth';
const router = Router();

const COOKIE_NOTE = `Sets the refresh token as an httpOnly cookie (${REFRESH_COOKIE}, SameSite=Strict, path /api/v1/auth).`;

router.post('/login', validate({ body: LoginBodySchema }), asyncHandler(AuthController.login));
registry.registerPath({
    method: 'post',
    path: `${PATH}/login`,
    tags: ['Auth'],
    summary: 'Sign in with username and password',
    description: `${COOKIE_NOTE} The same message is returned for an unknown username and a wrong password.`,
    request: { body: { content: jsonContent(LoginBodySchema) } },
    responses: {
        200: { description: 'Signed in', content: jsonContent(envelope(SessionSchema)) },
        ...errorResponses(400, 401, 423, 429),
    },
});

router.post('/refresh', asyncHandler(AuthController.refresh));
registry.registerPath({
    method: 'post',
    path: `${PATH}/refresh`,
    tags: ['Auth'],
    summary: 'Get a new access token using the refresh cookie',
    description: `${COOKIE_NOTE} Rotates the refresh token; reusing an old one ends every session of that user (REFRESH_REUSED).`,
    responses: {
        200: { description: 'New session', content: jsonContent(envelope(SessionSchema)) },
        ...errorResponses(401, 429),
    },
});

router.post('/logout', asyncHandler(AuthController.logout));
registry.registerPath({
    method: 'post',
    path: `${PATH}/logout`,
    tags: ['Auth'],
    summary: 'Sign out: revoke the session and clear the refresh cookie',
    responses: { 204: { description: 'Signed out' } },
});

router.get('/me', authenticate, asyncHandler(AuthController.me));
registry.registerPath({
    method: 'get',
    path: `${PATH}/me`,
    tags: ['Auth'],
    summary: 'The signed-in user',
    security: requiresAuth,
    responses: {
        200: { description: 'The user', content: jsonContent(envelope(PublicUserSchema)) },
        ...errorResponses(401),
    },
});

export default { path: PATH, router };
