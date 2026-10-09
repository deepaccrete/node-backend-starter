/**
 * Configuration — read process.env ONCE, validate it, and export typed values.
 *
 * Nothing else in the codebase touches `process.env`. A missing or malformed
 * variable fails at BOOT, not at the first request that happens to need it.
 *
 * Connection settings and secrets are deliberately NOT defaulted: this project
 * does not guess which database you meant or invent a secret. You state them in
 * `.env`, once. Tunables (rate limits, token lifetimes) default to the values the
 * team agreed and can be overridden.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { project } from './project.js';

const MIN_SECRET_LENGTH = 32;

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const required = (name: string) =>
    z
        .string({ error: `${name} is required` })
        .trim()
        .min(1, `${name} is required`);
const port = (name: string) =>
    required(name)
        .transform(Number)
        .pipe(
            z
                .number({ error: `${name} must be a number` })
                .int()
                .min(1)
                .max(65535)
        );
const list = z
    .string()
    .default('')
    .transform((value) =>
        value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    );

const schema = z
    .object({
        APP_NAME: z.string().default(project.name),
        NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

        PORT: port('PORT'),
        HOST: z.string().default('0.0.0.0'),
        API_PREFIX: z.string().startsWith('/').default('/api/v1'),

        DB_HOST: required('DB_HOST'),
        DB_PORT: port('DB_PORT'),
        DB_NAME: required('DB_NAME'),
        DB_USER: required('DB_USER'),
        // Must be present; may be empty for local trust/peer authentication.
        DB_PASSWORD: z.string({
            error: 'DB_PASSWORD is not set. If your database has no password, keep the line empty: DB_PASSWORD=',
        }),
        DB_POOL_MIN: int(2),
        DB_POOL_MAX: int(10),
        // disable | require. `require` encrypts AND verifies the server certificate.
        DB_SSL: z.enum(['disable', 'require']).default('disable'),
        // Path to the CA certificate of a managed database, when it is not in the system store.
        DB_SSL_CA: z.string().optional(),

        JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET').min(
            MIN_SECRET_LENGTH,
            `JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`
        ),
        JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET').min(
            MIN_SECRET_LENGTH,
            `JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`
        ),
        ACCESS_TOKEN_TTL_MINUTES: int(15),
        REFRESH_TOKEN_TTL_DAYS: int(7),
        LOGIN_MAX_FAILURES: int(5),
        LOGIN_LOCK_MINUTES: int(15),

        CORS_ORIGIN: list,

        LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
        LOG_DIR: z.string().default('./logs'),

        RATE_LIMIT_WINDOW_MS: int(15 * 60 * 1000),
        RATE_LIMIT_MAX: int(100),
        AUTH_RATE_LIMIT_MAX: int(20),

        UPLOAD_MAX_BYTES: int(5 * 1024 * 1024),
    })
    .superRefine((value, ctx) => {
        // Sharing one secret lets a refresh token verify as an access token.
        if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
            ctx.addIssue({
                code: 'custom',
                path: ['JWT_REFRESH_SECRET'],
                message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
            });
        }
        if (value.NODE_ENV === 'production' && value.CORS_ORIGIN.length === 0) {
            ctx.addIssue({
                code: 'custom',
                path: ['CORS_ORIGIN'],
                message: 'CORS_ORIGIN must list at least one allowed origin in production',
            });
        }
    });

export type RawEnv = z.input<typeof schema>;

/** Validates a set of variables. Exported so tests can check the rules without a process restart. */
export function parseEnv(source: Record<string, string | undefined>) {
    const result = schema.safeParse(source);
    if (!result.success) {
        throw new Error(
            `Invalid environment configuration:\n${z.prettifyError(result.error)}\n` +
                'Copy .env.example to .env and fill in every (required) value before starting.'
        );
    }
    const v = result.data;
    return {
        APP_NAME: v.APP_NAME,
        NODE_ENV: v.NODE_ENV,
        isProduction: v.NODE_ENV === 'production',
        isTest: v.NODE_ENV === 'test',
        PORT: v.PORT,
        HOST: v.HOST,
        API_PREFIX: v.API_PREFIX,
        db: {
            host: v.DB_HOST,
            port: v.DB_PORT,
            database: v.DB_NAME,
            user: v.DB_USER,
            password: v.DB_PASSWORD,
            min: v.DB_POOL_MIN,
            max: v.DB_POOL_MAX,
            // Encryption WITH certificate verification. Skipping verification
            // (rejectUnauthorized: false) would let anyone in between pose as the database.
            ssl:
                v.DB_SSL === 'require'
                    ? {
                          rejectUnauthorized: true,
                          ...(v.DB_SSL_CA ? { ca: readFileSync(v.DB_SSL_CA, 'utf8') } : {}),
                      }
                    : false,
        },
        auth: {
            accessSecret: v.JWT_ACCESS_SECRET,
            refreshSecret: v.JWT_REFRESH_SECRET,
            accessTtlSeconds: v.ACCESS_TOKEN_TTL_MINUTES * 60,
            refreshTtlSeconds: v.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
            maxFailures: v.LOGIN_MAX_FAILURES,
            lockMinutes: v.LOGIN_LOCK_MINUTES,
        },
        corsOrigins: v.CORS_ORIGIN,
        log: { level: v.LOG_LEVEL, dir: v.LOG_DIR },
        rateLimit: {
            windowMs: v.RATE_LIMIT_WINDOW_MS,
            max: v.RATE_LIMIT_MAX,
            authMax: v.AUTH_RATE_LIMIT_MAX,
        },
        uploadMaxBytes: v.UPLOAD_MAX_BYTES,
    };
}

export type Env = ReturnType<typeof parseEnv>;

export const env: Env = parseEnv(process.env);
