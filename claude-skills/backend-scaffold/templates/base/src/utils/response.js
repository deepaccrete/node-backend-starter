/**
 * The response envelope. Every endpoint answers through one of these helpers, so
 * a client can parse any response the same way:
 *
 *   success  { "success": true,  "message": "...", "data": …, "meta": { … } }
 *   failure  { "success": false, "message": "...", "errors": [ … ] }
 *
 * ONE naming style, on purpose. A codebase that offers both `success()` and
 * `sendSuccess()` ends up with both in use, and then "which envelope does this
 * endpoint return" becomes a question you have to open the file to answer.
 */

// ─── Success ──────────────────────────────────────────────────────────

const success = (res, data = null, message = 'Success', statusCode = 200, meta = undefined) => {
    const body = { success: true, message, data };
    if (meta && Object.keys(meta).length) body.meta = meta;
    return res.status(statusCode).json(body);
};

const created = (res, data = null, message = 'Created successfully') =>
    success(res, data, message, 201);

// 204 carries no body by definition — for deletes where the client needs nothing back.
const noContent = (res) => res.status(204).end();

/**
 * A list response with its pagination block in `meta`.
 * Pair with `parsePagination(req.query)` in the controller.
 */
const paginated = (res, rows, total, page, limit, message = 'Data fetched') => {
    const totalCount = Number(total) || 0;
    const currentPage = Number(page) || 1;
    const perPage = Number(limit) || 20;
    return success(res, rows, message, 200, {
        pagination: {
            total: totalCount,
            page: currentPage,
            limit: perPage,
            totalPages: Math.ceil(totalCount / perPage) || 0,
            hasNext: currentPage * perPage < totalCount,
            hasPrev: currentPage > 1,
        },
    });
};

// ─── Failure ──────────────────────────────────────────────────────────

const error = (res, message = 'Something went wrong', statusCode = 500, errors = null) => {
    const body = { success: false, message };
    if (errors) body.errors = errors;
    return res.status(statusCode).json(body);
};

const badRequest = (res, message = 'Bad request', errors = null) => error(res, message, 400, errors);
const unauthorized = (res, message = 'Authentication required') => error(res, message, 401);
const forbidden = (res, message = 'You do not have access to this resource') =>
    error(res, message, 403);
const notFound = (res, message = 'Resource not found') => error(res, message, 404);
const conflict = (res, message = 'Conflict', errors = null) => error(res, message, 409, errors);
const unprocessable = (res, message = 'Validation failed', errors = null) =>
    error(res, message, 422, errors);
const tooManyRequests = (res, message = 'Too many requests') => error(res, message, 429);

// ─── Query helpers ────────────────────────────────────────────────────

/**
 * Normalise ?page/?limit/?search/?sortBy/?sortOrder.
 *
 * `limit` is capped at 100 — an uncapped limit lets one request ask for the
 * whole table, which is both a performance and a data-exposure problem.
 * `sortBy` is returned raw: pass it through `sortColumn()` from config/database
 * before it reaches SQL, since identifiers cannot be parameterized.
 */
const parsePagination = (query = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    return {
        page,
        limit,
        offset: (page - 1) * limit,
        search: String(query.search || '').trim(),
        sortBy: query.sortBy ? String(query.sortBy) : null,
        sortOrder: String(query.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    };
};

module.exports = {
    success,
    created,
    noContent,
    paginated,
    error,
    badRequest,
    unauthorized,
    forbidden,
    notFound,
    conflict,
    unprocessable,
    tooManyRequests,
    parsePagination,
};
