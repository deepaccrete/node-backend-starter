/**
 * Operational errors — the ones a controller or model raises deliberately
 * because the request cannot be satisfied, as opposed to a bug.
 *
 * The global error handler reads `statusCode` and, for anything below 500, sends
 * `message` straight to the caller. So the message on these classes is written
 * FOR THE USER: "This warehouse still holds stock", not "FK violation on
 * inventorymaster.warehouseid".
 */

class AppError extends Error {
    /**
     * @param {string} message  user-facing wording for 4xx
     * @param {number} statusCode
     * @param {Array|null} errors  optional field-level detail
     */
    constructor(message, statusCode = 500, errors = null) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.errors = errors;
        // Marks "we raised this on purpose". The handler uses it to decide
        // between logging at warn (expected) and error (needs investigation).
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

class BadRequestError extends AppError {
    constructor(message = 'Bad request', errors = null) {
        super(message, 400, errors);
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required') {
        super(message, 401);
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'You do not have access to this resource') {
        super(message, 403);
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404);
    }
}

class ConflictError extends AppError {
    constructor(message = 'Conflict', errors = null) {
        super(message, 409, errors);
    }
}

class ValidationError extends AppError {
    constructor(message = 'Validation failed', errors = null) {
        super(message, 422, errors);
    }
}

module.exports = {
    AppError,
    BadRequestError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    ValidationError,
};
