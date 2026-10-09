import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Strict, type-aware rules (same level as the frontend), plus the skill's own
 * rules that catch the mistakes that break this codebase. Prettier owns style.
 */
export default defineConfig([
    globalIgnores(['dist', 'coverage', 'logs', 'src/public', 'openapi.json']),
    {
        files: ['**/*.ts'],
        extends: [
            js.configs.recommended,
            tseslint.configs.strictTypeChecked,
            tseslint.configs.stylisticTypeChecked,
        ],
        languageOptions: {
            ecmaVersion: 2023,
            globals: globals.node,
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_' },
            ],
            'no-console': ['error', { allow: ['warn', 'error'] }],
            eqeqeq: ['error', 'smart'],
            'no-throw-literal': 'error',
        },
    },
    {
        // Scripts and the startup banner talk to a human at a terminal.
        files: ['scripts/**', 'src/utils/banner.ts', 'tests/**'],
        rules: { 'no-console': 'off' },
    },
    {
        files: ['**/*.js'],
        extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
        languageOptions: { globals: globals.node },
    },
    prettier,
]);
