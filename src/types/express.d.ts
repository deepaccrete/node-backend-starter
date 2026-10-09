// @auth-start
import type { Permission, Role } from '../config/permissions.js';
// @auth-end

// @auth-start
/** The signed-in user, set by the `authenticate` middleware. */
export interface AuthUser {
    id: number;
    role: Role;
    permissions: Permission[];
    /** Session id from the token; names the authsession row. */
    sid: string;
}
// @auth-end

declare global {
    namespace Express {
        interface Request {
            /** Correlation id, echoed in X-Request-Id. */
            id: string;
            startedAt: number;

            // @auth-start
            user?: AuthUser;
            // @auth-end
            /** Values parsed by the `validate` middleware (typed copies of body/query/params). */
            validated: { body?: unknown; query?: unknown; params?: unknown };
        }
    }
}

// Keeps this file a module, so `declare global` applies with or without the import above.
export {};
