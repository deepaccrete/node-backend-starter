/**
 * Operational errors — raised deliberately because the request cannot be
 * satisfied, as opposed to a bug.
 *
 * The global error handler sends `message` and `code` straight to the caller for
 * anything below 500, so the message is written FOR THE USER.
 */

import type { ErrorCode } from './errorCodes.js';

export interface FieldError {
    field: string;
    message: string;
}

export class AppError extends Error {
    readonly statusCode: number;
    readonly code: ErrorCode;
    readonly errors: FieldError[] | null;
    /** "We raised this on purpose": logged at warn, not error. */
    readonly isOperational = true;

    constructor(
        message: string,
        statusCode: number,
        code: ErrorCode,
        errors: FieldError[] | null = null
    ) {
        super(message);
        this.name = new.target.name;
        this.statusCode = statusCode;
        this.code = code;
        this.errors = errors;
    }
}

export class BadRequestError extends AppError {
    constructor(
        message = 'Bad request',
        code: ErrorCode = 'BAD_REQUEST',
        errors: FieldError[] | null = null
    ) {
        super(message, 400, code, errors);
    }
}

export class ValidationError extends AppError {
    constructor(errors: FieldError[], message = 'Validation failed') {
        super(message, 400, 'VALIDATION_FAILED', errors);
    }
}

export class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required', code: ErrorCode = 'UNAUTHENTICATED') {
        super(message, 401, code);
    }
}

export class ForbiddenError extends AppError {
    constructor(message = 'You do not have access to this resource') {
        super(message, 403, 'FORBIDDEN');
    }
}

export class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404, 'NOT_FOUND');
    }
}

export class ConflictError extends AppError {
    constructor(message = 'Conflict', errors: FieldError[] | null = null) {
        super(message, 409, 'CONFLICT', errors);
    }
}

export class LockedError extends AppError {
    constructor(message: string) {
        super(message, 423, 'ACCOUNT_LOCKED');
    }
}
