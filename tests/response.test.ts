/**
 * The response envelope and pagination parsing. Pure functions: a small fake
 * stands in for Express's `res`.
 */

import type { Response } from 'express';
import { describe, expect, it } from 'vitest';

import { created, error, paginated, parsePagination, success } from '../src/utils/response.js';

function fakeRes() {
    const res = {
        statusCode: 0,
        body: undefined as unknown,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            return this;
        },
    };
    return res;
}

const asResponse = (res: ReturnType<typeof fakeRes>) => res as unknown as Response;

describe('response envelope', () => {
    it('wraps data in the standard envelope and omits empty meta', () => {
        const res = fakeRes();
        success(asResponse(res), { id: 1 }, 'Fetched', 200, {});
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Fetched', data: { id: 1 } });
    });

    it('answers 201 for created', () => {
        const res = fakeRes();
        created(asResponse(res), { id: 7 });
        expect(res.statusCode).toBe(201);
    });

    it('computes the pagination block', () => {
        const res = fakeRes();
        paginated(asResponse(res), [{ id: 1 }], 45, 2, 20);
        expect(res.body).toMatchObject({
            meta: {
                pagination: {
                    total: 45,
                    page: 2,
                    limit: 20,
                    totalPages: 3,
                    hasNext: true,
                    hasPrev: true,
                },
            },
        });
    });

    it('puts a machine-readable code on every failure', () => {
        const res = fakeRes();
        error(asResponse(res), 'Nope', 409, 'CONFLICT', [{ field: 'code', message: 'Taken' }]);
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            success: false,
            code: 'CONFLICT',
            message: 'Nope',
            errors: [{ field: 'code', message: 'Taken' }],
        });
    });
});

describe('parsePagination', () => {
    it('defaults, caps the limit at 100 and normalises the sort order', () => {
        expect(parsePagination({})).toMatchObject({
            page: 1,
            limit: 20,
            offset: 0,
            sortOrder: 'DESC',
        });
        expect(parsePagination({ page: '3', limit: '500', sortOrder: 'asc' })).toMatchObject({
            page: 3,
            limit: 100,
            offset: 200,
            sortOrder: 'ASC',
        });
        expect(parsePagination({ page: '-4', limit: 'abc' })).toMatchObject({ page: 1, limit: 20 });
    });
});
