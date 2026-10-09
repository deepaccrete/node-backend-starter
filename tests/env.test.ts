/**
 * Configuration is validated at boot; these pin the rules that stop a bad deploy.
 */

import { describe, expect, it } from 'vitest';

import { parseEnv } from '../src/config/env.js';

const valid = {
    PORT: '8001',
    DB_HOST: 'db',
    DB_PORT: '5432',
    DB_NAME: 'app',
    DB_USER: 'app',
    DB_PASSWORD: '',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('parseEnv', () => {
    it('accepts a complete configuration and applies the agreed defaults', () => {
        const env = parseEnv(valid);
        expect(env.db.port).toBe(5432);
        expect(env.auth.accessTtlSeconds).toBe(15 * 60);
        expect(env.auth.refreshTtlSeconds).toBe(7 * 24 * 60 * 60);
        expect(env.db.ssl).toBe(false);
    });

    it('names a missing connection setting instead of defaulting it', () => {
        const { DB_NAME: _omit, ...rest } = valid;
        expect(() => parseEnv(rest)).toThrow(/DB_NAME/);
    });

    it('requires DB_PASSWORD to be present even when empty', () => {
        const { DB_PASSWORD: _omit, ...rest } = valid;
        expect(() => parseEnv(rest)).toThrow(/DB_PASSWORD/);
    });

    it('rejects short or shared token secrets', () => {
        expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32/);
        expect(() => parseEnv({ ...valid, JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(
            /must differ/
        );
    });

    it('requires a CORS allowlist in production', () => {
        expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/CORS_ORIGIN/);
        expect(
            parseEnv({ ...valid, NODE_ENV: 'production', CORS_ORIGIN: 'https://a.example' })
                .corsOrigins
        ).toEqual(['https://a.example']);
    });

    it('verifies the database certificate when SSL is required', () => {
        expect(parseEnv({ ...valid, DB_SSL: 'require' }).db.ssl).toEqual({
            rejectUnauthorized: true,
        });
    });
});
