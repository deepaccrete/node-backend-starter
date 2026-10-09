/**
 * Machine-readable error codes. Every error response carries one in `code`.
 *
 * Messages are for people and may be reworded; codes are for programs and never
 * change once published. The frontend branches on these, so add new codes here
 * (they appear in the OpenAPI contract) and never rename an existing one.
 */
export const ERROR_CODES = [
    // Generic
    'BAD_REQUEST',
    'VALIDATION_FAILED',
    'INVALID_JSON',
    'NOT_FOUND',
    'ROUTE_NOT_FOUND',
    'CONFLICT',
    'RATE_LIMITED',
    'ORIGIN_NOT_ALLOWED',
    'DB_CONSTRAINT',
    'INTERNAL_ERROR',
    // Auth
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'INVALID_CREDENTIALS',
    'ACCOUNT_LOCKED',
    'SESSION_EXPIRED',
    'REFRESH_REUSED',
    'FORBIDDEN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
