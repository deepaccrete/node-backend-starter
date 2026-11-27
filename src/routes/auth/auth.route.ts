/**
 * Auth routes. Mounted automatically at ${API_PREFIX}/auth by the route loader —
 * the `{ path, router }` export at the bottom IS the registration.
 *
 * login / refresh / logout are public by nature (they create or end a session),
 * as are forgot-password / reset-password (the user cannot sign in).
 * /me and change-password require a signed-in user, and are the only routes a
 * user with a temporary password may reach. There is no self sign-up: Admins
 * create accounts (routes/users). app.ts gives /auth its own, stricter rate limit.
 */

import { Router } from 'express';
import { z } from 'zod';

import { AuthController, REFRESH_COOKIE } from '../../controllers/auth/auth.controller.js';
import { PERMISSIONS, ROLES } from '../../config/permissions.js';
import { authenticateAllowingPasswordChange } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
    envelope,
    errorResponses,
    jsonContent,
    registry,
    requiresAuth,
} from '../../openapi/registry.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { MobileSchema, NewPasswordSchema, OtpCodeSchema } from '../../utils/fields.js';

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
        mustChangePassword: z.boolean().meta({
            description:
                'Signed in with a temporary password: every other endpoint answers 403 PASSWORD_CHANGE_REQUIRED until it is changed.',
        }),
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

const ForgotUsernameSchema = z
    .string({ error: 'Enter your username' })
    .trim()
    .min(1, 'Enter your username')
    .max(64, 'Username is too long');

export const ChangePasswordBodySchema = z
    .object({
        currentPassword: z
            .string({ error: 'Enter your current password' })
            .min(1, 'Enter your current password')
            .max(128, 'Password is too long'),
        newPassword: NewPasswordSchema,
    })
    .meta({ id: 'ChangePasswordRequest' });

export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;

export const ForgotPasswordBodySchema = z
    .object({ username: ForgotUsernameSchema, mobile: MobileSchema })
    .meta({ id: 'ForgotPasswordRequest' });

export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;

export const ResetPasswordBodySchema = z
    .object({
        username: ForgotUsernameSchema,
        mobile: MobileSchema,
        otp: OtpCodeSchema,
        newPassword: NewPasswordSchema,
    })
    .meta({ id: 'ResetPasswordRequest' });

export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;

export const MessageSchema = z.object({ message: z.string() }).meta({ id: 'Message' });

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

router.get('/me', authenticateAllowingPasswordChange, asyncHandler(AuthController.me));
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

router.post(
    '/change-password',
    authenticateAllowingPasswordChange,
    validate({ body: ChangePasswordBodySchema }),
    asyncHandler(AuthController.changePassword)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/change-password`,
    tags: ['Auth'],
    summary: "Change the signed-in user's password",
    description: `${COOKIE_NOTE} Ends every session of the user and returns a fresh one for this device.`,
    security: requiresAuth,
    request: { body: { content: jsonContent(ChangePasswordBodySchema) } },
    responses: {
        200: { description: 'Changed', content: jsonContent(envelope(SessionSchema)) },
        ...errorResponses(400, 401, 429),
    },
});

router.post(
    '/forgot-password',
    validate({ body: ForgotPasswordBodySchema }),
    asyncHandler(AuthController.forgotPassword)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/forgot-password`,
    tags: ['Auth'],
    summary: 'Text a password reset code to the registered mobile',
    description:
        'The same answer whether or not the username and mobile match an account, so it cannot be used to find accounts.',
    request: { body: { content: jsonContent(ForgotPasswordBodySchema) } },
    responses: {
        200: { description: 'Accepted', content: jsonContent(envelope(MessageSchema)) },
        ...errorResponses(400, 429),
    },
});

router.post(
    '/reset-password',
    validate({ body: ResetPasswordBodySchema }),
    asyncHandler(AuthController.resetPassword)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/reset-password`,
    tags: ['Auth'],
    summary: 'Set a new password with the texted code',
    description: 'Ends every session of the user; they sign in with the new password.',
    request: { body: { content: jsonContent(ResetPasswordBodySchema) } },
    responses: {
        200: { description: 'Password reset', content: jsonContent(envelope(MessageSchema)) },
        ...errorResponses(400, 429),
    },
});

export default { path: PATH, router };
