/**
 * Configuration is validated at boot; these pin the rules that stop a bad deploy.
 */

import { describe, expect, it } from 'vitest';

import { parseEnv } from '../src/config/env.js';

const valid = {
    PORT: '8001',
    MONGODB_URI: 'mongodb://db:27017/app',
    // @auth-start
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    // @auth-end
};

describe('parseEnv', () => {
    it('accepts a complete configuration and applies the agreed defaults', () => {
        const env = parseEnv(valid);
        expect(env.db.uri).toBe('mongodb://db:27017/app');
        // @auth-start
        expect(env.auth.accessTtlSeconds).toBe(15 * 60);
        expect(env.auth.refreshTtlSeconds).toBe(7 * 24 * 60 * 60);
        // @auth-end
    });

    it('names a missing connection string instead of defaulting it', () => {
        const { MONGODB_URI: _omit, ...rest } = valid;
        expect(() => parseEnv(rest)).toThrow(/MONGODB_URI/);
    });

    it('accepts Atlas (mongodb+srv) strings with options', () => {
        const uri = 'mongodb+srv://u:p@cluster0.example.net/tpjp?retryWrites=true&w=majority';
        expect(parseEnv({ ...valid, MONGODB_URI: uri }).db.uri).toBe(uri);
    });

    it('rejects a string that is not MongoDB or names no database', () => {
        expect(() => parseEnv({ ...valid, MONGODB_URI: 'postgres://db:5432/app' })).toThrow(
            /must start with mongodb/
        );
        expect(() => parseEnv({ ...valid, MONGODB_URI: 'mongodb://db:27017' })).toThrow(
            /must name the database/
        );
        expect(() => parseEnv({ ...valid, MONGODB_URI: 'mongodb://db:27017/?tls=true' })).toThrow(
            /must name the database/
        );
    });

    // @auth-start
    it('rejects short or shared token secrets', () => {
        expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32/);
        expect(() => parseEnv({ ...valid, JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(
            /must differ/
        );
    });
    // @auth-end

    it('requires a CORS allowlist in production', () => {
        expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/CORS_ORIGIN/);
        expect(
            parseEnv({ ...valid, NODE_ENV: 'production', CORS_ORIGIN: 'https://a.example' })
                .corsOrigins
        ).toEqual(['https://a.example']);
    });
});
