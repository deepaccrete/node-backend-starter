/**
 * The single exit for every error. Must be the LAST `app.use` and keep four
 * arguments — that arity is how Express recognises an error handler.
 *
 * The rule: **4xx messages are ours, 5xx messages are not.** A 4xx message was
 * written for the user; a 5xx message is whatever a driver or library said and is
 * replaced with something generic. The real message and stack always reach the logs.
 */

import type { ErrorRequestHandler } from 'express';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { ErrorCode } from '../utils/errorCodes.js';
import { AppError } from '../utils/errors.js';
import { friendlyDbError } from '../utils/pgError.js';

export const CORS_REJECTED = 'Not allowed by CORS';

const statusOf = (err: unknown): number => {
    if (err instanceof AppError) return err.statusCode;
    if (typeof err === 'object' && err !== null) {
        const e = err as { statusCode?: unknown; status?: unknown };
        if (typeof e.statusCode === 'number') return e.statusCode;
        if (typeof e.status === 'number') return e.status;
    }
    return 500;
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
    // A constraint violation is bad input: 400 naming the fields at fault.
    const friendly = friendlyDbError(err);
    if (friendly) {
        const e = err as { code?: string; constraint?: string };
        logger.warn('Rejected by database constraint', {
            requestId: req.id,
            path: req.originalUrl,
            code: e.code,
            constraint: e.constraint,
        });
        res.status(400).json({
            success: false,
            code: 'DB_CONSTRAINT' satisfies ErrorCode,
            message: friendly.message,
            ...(friendly.fields.length
                ? { errors: friendly.fields.map((field) => ({ field, message: friendly.message })) }
                : {}),
            requestId: req.id,
        });
        return;
    }

    // Bodies that fail to parse arrive as SyntaxError from express.json.
    if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({
            success: false,
            code: 'INVALID_JSON' satisfies ErrorCode,
            message: 'Request body is not valid JSON.',
            requestId: req.id,
        });
        return;
    }

    if (err instanceof Error && err.message === CORS_REJECTED) {
        res.status(403).json({
            success: false,
            code: 'ORIGIN_NOT_ALLOWED' satisfies ErrorCode,
            message: 'Origin not allowed.',
            requestId: req.id,
        });
        return;
    }

    const status = statusOf(err);
    const error = err instanceof Error ? err : new Error(String(err));

    // Expected 4xx are noise at error level; unexpected 5xx are the point of the log.
    const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log(`${status} ${req.method} ${req.originalUrl} — ${error.message}`, {
        requestId: req.id,
        userId: req.user?.id,
        durationMs: Date.now() - req.startedAt,
        ...(status >= 500 ? { stack: error.stack } : {}),
    });

    const code: ErrorCode =
        err instanceof AppError ? err.code : status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
    const message =
        status < 500
            ? error.message || 'Request could not be completed'
            : 'Something went wrong at our end. Please try again in a moment.';

    res.status(status).json({
        success: false,
        code,
        message,
        ...(err instanceof AppError && err.errors ? { errors: err.errors } : {}),
        requestId: req.id,
        // The underlying message and stack are development-only.
        ...(!env.isProduction && status >= 500
            ? { detail: error.message, stack: error.stack }
            : {}),
    });
};
