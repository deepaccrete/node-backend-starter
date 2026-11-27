import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        restoreMocks: true,
        // Fixed values so tests never read a developer's .env. No database is
        // reached: tests that touch the database replace the model layer.
        env: {
            NODE_ENV: 'test',
            PORT: '8001',
            MONGODB_URI: 'mongodb://127.0.0.1:27017/app_test',
            // @auth-start
            JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123',
            JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef012',
            // @auth-end
        },
        coverage: {
            provider: 'v8',
            include: ['src/**', 'server.ts'],
        },
    },
});
