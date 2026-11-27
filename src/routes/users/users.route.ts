/**
 * Dashboard user management. Mounted at ${API_PREFIX}/users by the route loader.
 *
 * Every route needs a signed-in user holding `users:manage` (ADMIN today).
 * Admins create accounts with a temporary password; there is no self sign-up.
 */

import { Router } from 'express';
import { z } from 'zod';

import { UsersController } from '../../controllers/users/users.controller.js';
import { ROLES } from '../../config/permissions.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import { USER_SORT_FIELDS } from '../../models/auth/user.model.js';
import {
    envelope,
    errorResponses,
    jsonContent,
    paginatedEnvelope,
    registry,
    requiresAuth,
} from '../../openapi/registry.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
    IdParamsSchema,
    MobileSchema,
    NewPasswordSchema,
    PersonNameSchema,
    UsernameSchema,
} from '../../utils/fields.js';

// ─── Field rules ──────────────────────────────────────────────────────

const ReportsToSchema = z
    .number({ error: 'Choose a manager' })
    .int()
    .positive()
    .nullable()
    .meta({ description: 'The manager one level up (ASM→RM→ZM→GM). Null for GM and ADMIN.' });

export const ManagedUserSchema = z
    .object({
        id: z.number().int(),
        username: z.string(),
        name: z.string(),
        role: z.enum(ROLES),
        mobile: z.string().nullable(),
        reportsToUserId: z.number().int().nullable(),
        isActive: z.boolean(),
        mustChangePassword: z.boolean(),
        lastLoginAt: z.iso.datetime().nullable(),
        createdAt: z.iso.datetime(),
    })
    .meta({ id: 'ManagedUser' });

export const ListUsersQuerySchema = z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    search: z.string().trim().max(64).optional(),
    role: z.enum(ROLES).optional(),
    sortBy: z.enum(USER_SORT_FIELDS).optional(),
    sortOrder: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
});

export const CreateUserBodySchema = z
    .object({
        username: UsernameSchema,
        name: PersonNameSchema,
        role: z.enum(ROLES, { error: 'Choose a role' }),
        mobile: MobileSchema.nullable().default(null),
        reportsToUserId: ReportsToSchema.default(null),
        password: NewPasswordSchema.meta({
            description: 'Temporary password; the user must change it at first sign-in.',
        }),
    })
    .meta({ id: 'CreateUserRequest' });

export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;

export const UpdateUserBodySchema = z
    .object({
        name: PersonNameSchema.optional(),
        role: z.enum(ROLES).optional(),
        mobile: MobileSchema.nullable().optional(),
        reportsToUserId: ReportsToSchema.optional(),
        isActive: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change')
    .meta({ id: 'UpdateUserRequest' });

export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;

export const ResetUserPasswordBodySchema = z
    .object({ password: NewPasswordSchema })
    .meta({ id: 'ResetUserPasswordRequest' });

export type ResetUserPasswordBody = z.infer<typeof ResetUserPasswordBodySchema>;

// ─── Endpoints ────────────────────────────────────────────────────────

const PATH = '/users';
const router = Router();
router.use(authenticate, requirePermission('users:manage'));

const userResponse = (description: string) => ({
    description,
    content: jsonContent(envelope(ManagedUserSchema)),
});

router.get('/', validate({ query: ListUsersQuerySchema }), asyncHandler(UsersController.list));
registry.registerPath({
    method: 'get',
    path: PATH,
    tags: ['Users'],
    summary: 'List dashboard users',
    security: requiresAuth,
    request: { query: ListUsersQuerySchema },
    responses: {
        200: {
            description: 'One page',
            content: jsonContent(paginatedEnvelope(ManagedUserSchema)),
        },
        ...errorResponses(400, 401, 403),
    },
});

router.post('/', validate({ body: CreateUserBodySchema }), asyncHandler(UsersController.create));
registry.registerPath({
    method: 'post',
    path: PATH,
    tags: ['Users'],
    summary: 'Create a dashboard user with a temporary password',
    security: requiresAuth,
    request: { body: { content: jsonContent(CreateUserBodySchema) } },
    responses: { 201: userResponse('Created'), ...errorResponses(400, 401, 403) },
});

router.get('/:id', validate({ params: IdParamsSchema }), asyncHandler(UsersController.get));
registry.registerPath({
    method: 'get',
    path: `${PATH}/{id}`,
    tags: ['Users'],
    summary: 'One dashboard user',
    security: requiresAuth,
    request: { params: IdParamsSchema },
    responses: { 200: userResponse('The user'), ...errorResponses(401, 403, 404) },
});

router.patch(
    '/:id',
    validate({ params: IdParamsSchema, body: UpdateUserBodySchema }),
    asyncHandler(UsersController.update)
);
registry.registerPath({
    method: 'patch',
    path: `${PATH}/{id}`,
    tags: ['Users'],
    summary: 'Change name, role, mobile, manager or active state',
    description:
        'Deactivating a user, or changing their role, ends their sessions. Refused while active users still report to them.',
    security: requiresAuth,
    request: { params: IdParamsSchema, body: { content: jsonContent(UpdateUserBodySchema) } },
    responses: { 200: userResponse('Updated'), ...errorResponses(400, 401, 403, 404, 409) },
});

router.post(
    '/:id/reset-password',
    validate({ params: IdParamsSchema, body: ResetUserPasswordBodySchema }),
    asyncHandler(UsersController.resetPassword)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/{id}/reset-password`,
    tags: ['Users'],
    summary: 'Set a temporary password for a user',
    description: 'The user must change it at next sign-in. Ends their sessions and any lockout.',
    security: requiresAuth,
    request: {
        params: IdParamsSchema,
        body: { content: jsonContent(ResetUserPasswordBodySchema) },
    },
    responses: { 204: { description: 'Password set' }, ...errorResponses(400, 401, 403, 404) },
});

export default { path: PATH, router };
