/**
 * The OpenAPI contract, built from the same Zod schemas the routes validate with.
 *
 * Each route file registers its own paths next to its router, so the published
 * contract cannot drift from the real validation. `pnpm gen:openapi` writes the
 * document to openapi.json; the frontend generates its types from that file.
 */

import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { ERROR_CODES } from '../utils/errorCodes.js';

export const registry = new OpenAPIRegistry();

export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
});

/** `security` value for endpoints that need a signed-in user. */
export const requiresAuth = [{ [bearerAuth.name]: [] }];

export const FieldErrorSchema = z
    .object({ field: z.string(), message: z.string() })
    .meta({ id: 'FieldError' });

export const ErrorResponseSchema = z
    .object({
        success: z.literal(false),
        code: z.enum(ERROR_CODES),
        message: z.string(),
        errors: z.array(FieldErrorSchema).optional(),
        requestId: z.string().optional(),
    })
    .meta({ id: 'ErrorResponse' });

export const PaginationSchema = z
    .object({
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
        totalPages: z.number().int(),
        hasNext: z.boolean(),
        hasPrev: z.boolean(),
    })
    .meta({ id: 'Pagination' });

/** Success envelope around a data schema. */
export const envelope = <T extends z.ZodType>(data: T) =>
    z.object({ success: z.literal(true), message: z.string(), data });

/** Success envelope for list endpoints. */
export const paginatedEnvelope = <T extends z.ZodType>(item: T) =>
    z.object({
        success: z.literal(true),
        message: z.string(),
        data: z.array(item),
        meta: z.object({ pagination: PaginationSchema }),
    });

export const jsonContent = (schema: z.ZodType) => ({ 'application/json': { schema } });

const ERROR_DESCRIPTIONS: Record<number, string> = {
    400: 'Invalid input (VALIDATION_FAILED, INVALID_JSON, DB_CONSTRAINT)',
    401: 'Not signed in or token expired',
    403: 'Signed in but not allowed (FORBIDDEN)',
    404: 'Not found',
    409: 'Conflict',
    423: 'Account temporarily locked (ACCOUNT_LOCKED)',
    429: 'Too many requests (RATE_LIMITED)',
};

/** Standard error responses for `registerPath({ responses })`. */
export function errorResponses(...statuses: number[]) {
    return Object.fromEntries(
        statuses.map((status) => [
            status,
            {
                description: ERROR_DESCRIPTIONS[status] ?? 'Error',
                content: jsonContent(ErrorResponseSchema),
            },
        ])
    );
}

export function generateOpenApiDocument(apiPrefix: string, version: string) {
    return new OpenApiGeneratorV31(registry.definitions).generateDocument({
        openapi: '3.1.0',
        info: {
            title: 'TPJP API',
            version,
            description:
                'Lotte India Telecalling Permanent Journey Plan — dashboard API. Every response uses the ' +
                'envelope { success, message, data, meta } or, on failure, { success: false, code, message, errors }.',
        },
        servers: [{ url: apiPrefix }],
    });
}
