/**
 * Users controller — thin: read the validated request, call one service
 * function, pick a response helper.
 */

import type { Request, Response } from 'express';

import { USER_SORT_FIELDS } from '../../models/auth/user.model.js';
import type {
    CreateUserBody,
    ListUsersQuerySchema,
    ResetUserPasswordBody,
    UpdateUserBody,
} from '../../routes/users/users.route.js';
import { UserService } from '../../services/user.service.js';
import { UnauthorizedError } from '../../utils/errors.js';
import type { IdParamsSchema } from '../../utils/fields.js';
import {
    created,
    noContent,
    paginated,
    parsePagination,
    sortField,
    success,
} from '../../utils/response.js';
import type { z } from 'zod';

const adminOf = (req: Request) => {
    if (!req.user) throw new UnauthorizedError();
    return req.user.id;
};

const idOf = (req: Request) => (req.validated.params as z.infer<typeof IdParamsSchema>).id;

export const UsersController = {
    list: async (req: Request, res: Response) => {
        const query = (req.validated.query ?? {}) as z.infer<typeof ListUsersQuerySchema>;
        const { page, limit, search, sortOrder } = parsePagination(query);
        const { rows, total } = await UserService.list({
            page,
            limit,
            search,
            role: query.role,
            sortBy: sortField(query.sortBy, USER_SORT_FIELDS, 'userid'),
            sortOrder,
        });
        return paginated(res, rows, total, page, limit, 'Users');
    },

    get: async (req: Request, res: Response) =>
        success(res, await UserService.get(idOf(req)), 'User'),

    create: async (req: Request, res: Response) => {
        const body = req.body as CreateUserBody;
        return created(res, await UserService.create(adminOf(req), body), 'User created');
    },

    update: async (req: Request, res: Response) => {
        const body = req.body as UpdateUserBody;
        return success(
            res,
            await UserService.update(adminOf(req), idOf(req), body),
            'User updated'
        );
    },

    resetPassword: async (req: Request, res: Response) => {
        const { password } = req.body as ResetUserPasswordBody;
        await UserService.resetPassword(adminOf(req), idOf(req), password);
        return noContent(res);
    },
};
