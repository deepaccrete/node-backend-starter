/**
 * Android app sign-in for distributor telecallers. Mounted at
 * ${API_PREFIX}/app/auth by the route loader.
 *
 * Mobile number + one-time code. The refresh token travels in the request and
 * response BODY (the app keeps it in Android's encrypted storage): a cookie suits
 * a browser, not a native app. app.ts gives this path the strict auth rate limit.
 */

import { Router } from 'express';
import { z } from 'zod';

import { AppAuthController } from '../../controllers/app/appAuth.controller.js';
import { authenticateApp } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
    envelope,
    errorResponses,
    jsonContent,
    registry,
    requiresAuth,
} from '../../openapi/registry.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { MobileSchema, OtpCodeSchema } from '../../utils/fields.js';
import { MessageSchema } from '../auth/auth.route.js';

// ─── Field rules ──────────────────────────────────────────────────────

export const AppOtpRequestBodySchema = z
    .object({ mobile: MobileSchema })
    .meta({ id: 'AppOtpRequest' });

export type AppOtpRequestBody = z.infer<typeof AppOtpRequestBodySchema>;

export const AppOtpVerifyBodySchema = z
    .object({ mobile: MobileSchema, otp: OtpCodeSchema })
    .meta({ id: 'AppOtpVerify' });

export type AppOtpVerifyBody = z.infer<typeof AppOtpVerifyBodySchema>;

export const AppRefreshBodySchema = z
    .object({
        refreshToken: z
            .string({ error: 'Sign in again' })
            .min(1, 'Sign in again')
            .max(2048, 'Sign in again'),
    })
    .meta({ id: 'AppRefreshRequest' });

export type AppRefreshBody = z.infer<typeof AppRefreshBodySchema>;

export const AppContactSchema = z
    .object({
        id: z.number().int(),
        name: z.string(),
        mobile: z.string(),
        isPrimary: z.boolean(),
        distributor: z.object({ id: z.number().int(), code: z.string(), name: z.string() }),
    })
    .meta({ id: 'AppContact' });

export const AppSessionSchema = z
    .object({
        contact: AppContactSchema,
        accessToken: z.string(),
        refreshToken: z
            .string()
            .meta({ description: 'Keep in encrypted storage; send to /app/auth/refresh.' }),
    })
    .meta({ id: 'AppSession' });

// ─── Endpoints ────────────────────────────────────────────────────────

const PATH = '/app/auth';
const router = Router();

router.post(
    '/otp/request',
    validate({ body: AppOtpRequestBodySchema }),
    asyncHandler(AppAuthController.requestOtp)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/otp/request`,
    tags: ['App auth'],
    summary: 'Text a sign-in code to a registered telecaller number',
    description:
        'The same answer whether or not the number is registered and active, so it cannot be used to find numbers.',
    request: { body: { content: jsonContent(AppOtpRequestBodySchema) } },
    responses: {
        200: { description: 'Accepted', content: jsonContent(envelope(MessageSchema)) },
        ...errorResponses(400, 429),
    },
});

router.post(
    '/otp/verify',
    validate({ body: AppOtpVerifyBodySchema }),
    asyncHandler(AppAuthController.verifyOtp)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/otp/verify`,
    tags: ['App auth'],
    summary: 'Sign in with the texted code',
    request: { body: { content: jsonContent(AppOtpVerifyBodySchema) } },
    responses: {
        200: { description: 'Signed in', content: jsonContent(envelope(AppSessionSchema)) },
        ...errorResponses(400, 429),
    },
});

router.post(
    '/refresh',
    validate({ body: AppRefreshBodySchema }),
    asyncHandler(AppAuthController.refresh)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/refresh`,
    tags: ['App auth'],
    summary: 'Get a new token pair',
    description:
        'Rotates the refresh token; reusing an old one ends every app session of that number (REFRESH_REUSED).',
    request: { body: { content: jsonContent(AppRefreshBodySchema) } },
    responses: {
        200: { description: 'New session', content: jsonContent(envelope(AppSessionSchema)) },
        ...errorResponses(400, 401, 429),
    },
});

router.post('/logout', asyncHandler(AppAuthController.logout));
registry.registerPath({
    method: 'post',
    path: `${PATH}/logout`,
    tags: ['App auth'],
    summary: 'Sign out: revoke the session named by the refresh token',
    request: { body: { content: jsonContent(AppRefreshBodySchema) } },
    responses: { 204: { description: 'Signed out' } },
});

router.get('/me', authenticateApp, asyncHandler(AppAuthController.me));
registry.registerPath({
    method: 'get',
    path: `${PATH}/me`,
    tags: ['App auth'],
    summary: 'The signed-in telecaller number',
    security: requiresAuth,
    responses: {
        200: { description: 'The number', content: jsonContent(envelope(AppContactSchema)) },
        ...errorResponses(401),
    },
});

export default { path: PATH, router };
