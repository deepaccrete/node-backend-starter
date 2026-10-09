import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        restoreMocks: true,
        // Fixed values so tests never read a developer's .env. No database is
        // reached: tests that touch SQL replace the model layer.
        env: {
            NODE_ENV: 'test',
            PORT: '8001',
            DB_HOST: '127.0.0.1',
            DB_PORT: '5432',
            DB_NAME: 'app_test',
            DB_USER: 'test',
            DB_PASSWORD: '',
            JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123',
            JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef012',
        },
        coverage: {
            provider: 'v8',
            include: ['src/**', 'server.ts'],
        },
    },
});
