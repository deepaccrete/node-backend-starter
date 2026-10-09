/**
 * The validate middleware on its own: one message per field, parsed values on
 * req.validated, and the body replaced by its parsed (trimmed) form.
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { validate } from '../src/middleware/validate.js';

const app = express();
app.use(express.json());
app.post(
    '/things/:id',
    validate({
        params: z.object({ id: z.coerce.number().int().positive('Bad id') }),
        body: z.object({
            name: z.string().trim().min(1, 'Enter a name'),
            code: z.string().min(2, 'Code is too short'),
        }),
    }),
    (req, res) => {
        res.json({ validated: req.validated, body: req.body as unknown });
    }
);

describe('validate', () => {
    it('answers 400 VALIDATION_FAILED with one message per invalid field', async () => {
        const res = await request(app).post('/things/0').send({ name: '   ', code: 'x' });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
            success: false,
            code: 'VALIDATION_FAILED',
            errors: [
                { field: 'id', message: 'Bad id' },
                { field: 'name', message: 'Enter a name' },
                { field: 'code', message: 'Code is too short' },
            ],
        });
    });

    it('passes parsed values on and replaces the body with its parsed form', async () => {
        const res = await request(app).post('/things/7').send({ name: '  Box ', code: 'AB' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            validated: { params: { id: 7 }, body: { name: 'Box', code: 'AB' } },
            body: { name: 'Box', code: 'AB' },
        });
    });
});
