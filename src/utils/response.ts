/**
 * The response envelope. Every endpoint answers through one of these helpers:
 *
 *   success  { "success": true,  "message": "...", "data": …, "meta": { … } }
 *   failure  { "success": false, "code": "...", "message": "...", "errors": [ … ] }
 *
 * `code` on failures is the TPJP addition to the house envelope: a stable,
 * machine-readable reason (see errorCodes.ts). ONE naming style, on purpose.
 */

import type { Response } from 'express';

import type { ErrorCode } from './errorCodes.js';
import type { FieldError } from './errors.js';

export interface Pagination {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
}

// ─── Success ──────────────────────────────────────────────────────────

export function success(
    res: Response,
    data: unknown = null,
    message = 'Success',
    statusCode = 200,
    meta?: Record<string, unknown>
) {
    const body: Record<string, unknown> = { success: true, message, data };
    if (meta && Object.keys(meta).length) body.meta = meta;
    return res.status(statusCode).json(body);
}

export const created = (res: Response, data: unknown = null, message = 'Created successfully') =>
    success(res, data, message, 201);

/** 204 carries no body by definition. */
export const noContent = (res: Response) => res.status(204).end();

/** A list response with its pagination block in `meta`. Pair with `parsePagination`. */
export function paginated(
    res: Response,
    rows: unknown[],
    total: number,
    page: number,
    limit: number,
    message = 'Data fetched'
) {
    const pagination: Pagination = {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0,
        hasNext: page * limit < total,
        hasPrev: page > 1,
    };
    return success(res, rows, message, 200, { pagination });
}

// ─── Failure ──────────────────────────────────────────────────────────

export function error(
    res: Response,
    message: string,
    statusCode: number,
    code: ErrorCode,
    errors: FieldError[] | null = null
) {
    const body: Record<string, unknown> = { success: false, code, message };
    if (errors?.length) body.errors = errors;
    // The correlation id lets a user report the exact failing request.
    const requestId = (res.req as { id?: unknown } | undefined)?.id;
    if (typeof requestId === 'string') body.requestId = requestId;
    return res.status(statusCode).json(body);
}

export const badRequest = (
    res: Response,
    message = 'Bad request',
    errors: FieldError[] | null = null
) => error(res, message, 400, 'BAD_REQUEST', errors);
export const unauthorized = (res: Response, message = 'Authentication required') =>
    error(res, message, 401, 'UNAUTHENTICATED');
export const forbidden = (res: Response, message = 'You do not have access to this resource') =>
    error(res, message, 403, 'FORBIDDEN');
export const notFound = (res: Response, message = 'Resource not found') =>
    error(res, message, 404, 'NOT_FOUND');
export const conflict = (res: Response, message = 'Conflict', errors: FieldError[] | null = null) =>
    error(res, message, 409, 'CONFLICT', errors);

// ─── Query helpers ────────────────────────────────────────────────────

export interface PaginationQuery {
    page?: unknown;
    limit?: unknown;
    search?: unknown;
    sortBy?: unknown;
    sortOrder?: unknown;
}

/**
 * Normalise ?page/?limit/?search/?sortBy/?sortOrder.
 *
 * `limit` is capped at 100: an uncapped limit lets one request ask for the whole
 * table. `sortBy` is returned raw — pass it through `sortColumn()` before SQL.
 */
export function parsePagination(query: PaginationQuery = {}) {
    const toInt = (value: unknown) => Number.parseInt(String(value), 10);
    const page = Math.max(1, toInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, toInt(query.limit) || 20));
    return {
        page,
        limit,
        offset: (page - 1) * limit,
        search: typeof query.search === 'string' ? query.search.trim() : '',
        sortBy: typeof query.sortBy === 'string' ? query.sortBy : null,
        sortOrder:
            String(query.sortOrder).toUpperCase() === 'ASC' ? ('ASC' as const) : ('DESC' as const),
    };
}
