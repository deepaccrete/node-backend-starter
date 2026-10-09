/**
 * Unit tests for the response envelope and pagination parsing.
 *
 * These need no database and no server — `src/utils/response.js` is pure apart
 * from the `res` it writes to, so a small fake stands in for Express.
 *
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { success, created, paginated, badRequest, parsePagination } = require('../src/utils/response');

/** Minimal Express `res` double: records status and body instead of sending. */
const fakeRes = () => {
    const res = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
    return res;
};

test('success wraps data in the standard envelope', () => {
    const res = fakeRes();
    success(res, { id: 1 }, 'Fetched');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: 'Fetched', data: { id: 1 } });
});

test('success omits meta when empty', () => {
    const res = fakeRes();
    success(res, [], 'Empty', 200, {});
    assert.ok(!('meta' in res.body), 'meta should be absent when no meta was supplied');
});

test('created answers 201', () => {
    const res = fakeRes();
    created(res, { id: 7 });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.id, 7);
});

test('paginated computes the page block', () => {
    const res = fakeRes();
    paginated(res, [{ id: 1 }], 45, 2, 20);

    assert.deepEqual(res.body.meta.pagination, {
        total: 45,
        page: 2,
        limit: 20,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
    });
});

test('paginated flags the last page correctly', () => {
    const res = fakeRes();
    paginated(res, [], 40, 2, 20);
    assert.equal(res.body.meta.pagination.hasNext, false);
});

test('badRequest returns 400 and carries field errors', () => {
    const res = fakeRes();
    badRequest(res, 'Validation failed', [{ field: 'email', message: 'required' }]);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.errors[0].field, 'email');
});

test('parsePagination applies defaults', () => {
    assert.deepEqual(parsePagination({}), {
        page: 1,
        limit: 20,
        offset: 0,
        search: '',
        sortBy: null,
        sortOrder: 'DESC',
    });
});

test('parsePagination caps limit at 100', () => {
    assert.equal(parsePagination({ limit: '5000' }).limit, 100);
});

test('parsePagination rejects nonsense page numbers', () => {
    assert.equal(parsePagination({ page: '-3' }).page, 1);
    assert.equal(parsePagination({ page: 'abc' }).page, 1);
});

test('parsePagination computes offset from page and limit', () => {
    assert.equal(parsePagination({ page: '3', limit: '25' }).offset, 50);
});
