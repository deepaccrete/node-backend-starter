import type { RequestHandler } from 'express';

import type { Permission } from '../config/permissions.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';

/**
 * Allow the request only if the signed-in user holds EVERY listed permission.
 * Use after `authenticate`. Checks permissions, never role names.
 *
 *   router.post('/', requirePermission('plans:upload'), validate(...), Controller.create);
 */
export const requirePermission =
    (...required: Permission[]): RequestHandler =>
    (req, _res, next) => {
        if (!req.user) {
            next(new UnauthorizedError());
            return;
        }
        const granted = req.user.permissions;
        next(required.every((p) => granted.includes(p)) ? undefined : new ForbiddenError());
    };
