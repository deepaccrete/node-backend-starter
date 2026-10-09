/**
 * Validate a request against Zod schemas declared in the route file.
 *
 *   router.post('/', validate({ body: CreateThingBody }), Controller.create);
 *
 * Failures answer 400 VALIDATION_FAILED with one message per field, which the
 * frontend attaches to the matching input. On success the parsed (trimmed,
 * coerced) values are on `req.validated`, and `req.body` is replaced with the
 * parsed body. Express 5 makes `req.query` read-only, hence `req.validated`.
 *
 * The same schemas are registered in the OpenAPI document, so the published
 * contract and the real validation cannot drift apart.
 */

import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';

import type { FieldError } from '../utils/errors.js';
import { error } from '../utils/response.js';

export interface RequestSchemas {
    body?: z.ZodType;
    query?: z.ZodType;
    params?: z.ZodType;
}

const PARTS = ['params', 'query', 'body'] as const;

export function validate(schemas: RequestSchemas): RequestHandler {
    return (req, res, next) => {
        const errors: FieldError[] = [];
        const parsed: Request['validated'] = {};

        for (const part of PARTS) {
            const schema = schemas[part];
            if (!schema) continue;
            const result = schema.safeParse(req[part] ?? {});
            if (result.success) {
                parsed[part] = result.data;
            } else {
                for (const issue of result.error.issues) {
                    // One message per field: the first issue wins.
                    const field = issue.path.length ? issue.path.join('.') : part;
                    if (!errors.some((e) => e.field === field))
                        errors.push({ field, message: issue.message });
                }
            }
        }

        if (errors.length) {
            error(res, 'Validation failed', 400, 'VALIDATION_FAILED', errors);
            return;
        }

        req.validated = parsed;
        if (parsed.body !== undefined) req.body = parsed.body;
        next();
    };
}
