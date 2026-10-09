/**
 * The HTTP surface without a database: health, the 404 envelope, malformed
 * JSON, validation errors and the OpenAPI document.
 */

import request from 'supertest';
import type * as DatabaseModule from '../src/config/database.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

vi.mock('../src/config/database.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DatabaseModule>();
    return { ...actual, query: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
});

const { createApp } = await import('../src/app.js');

let app: Express;
beforeAll(async () => {
    app = await createApp();
});

describe('health', () => {
    it('reports liveness without touching the database', async () => {
        const res = await request(app).get('/api/v1/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, status: 'ok' });
    });

    it('reports not ready (503) when the database is down, without leaking the driver message', async () => {
        const res = await request(app).get('/api/v1/health/ready');
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
            success: false,
            database: 'down',
            message: 'Database unavailable',
        });
    });
});

describe('error envelope', () => {
    it('answers unknown routes with ROUTE_NOT_FOUND in JSON', async () => {
        const res = await request(app).get('/api/v1/nope');
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
    });

    it('answers malformed JSON with INVALID_JSON', async () => {
        const res = await request(app)
            .post('/api/v1/health')
            .set('Content-Type', 'application/json')
            .send('{bad');
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'INVALID_JSON' });
    });

    it('echoes a request id on every response', async () => {
        const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123');
        expect(res.headers['x-request-id']).toBe('abc-123');
    });
});

describe('OpenAPI', () => {
    it('publishes every registered path with the shared schemas', async () => {
        const res = await request(app).get('/api/v1/openapi.json');
        expect(res.status).toBe(200);
        const doc = res.body as {
            paths: Record<string, unknown>;
            components: { schemas: Record<string, unknown> };
        };
        expect(Object.keys(doc.paths)).toEqual(
            expect.arrayContaining([
                // @auth-start
                '/auth/login',
                '/auth/refresh',
                '/auth/logout',
                '/auth/me',
                // @auth-end
                '/health',
            ])
        );
        expect(Object.keys(doc.components.schemas)).toEqual(
            expect.arrayContaining([
                // @auth-start
                'ErrorResponse',
                'User',
                'Session',
                'LoginRequest',
                // @auth-end
            ])
        );
    });
});
