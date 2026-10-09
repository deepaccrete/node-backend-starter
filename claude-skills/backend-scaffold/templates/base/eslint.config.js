const globals = require('globals');

/**
 * ESLint flat config (ESLint 9+).
 *
 * The rules here are deliberately few: they catch the mistakes that actually
 * break this codebase (an unawaited promise, a shadowed variable, a `require`
 * that resolves to nothing) and stay out of the way on style, which Prettier
 * owns.
 */
module.exports = [
    {
        ignores: ['node_modules/**', 'logs/**', 'coverage/**', 'dist/**', 'src/public/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_' }],
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'no-var': 'error',
            'prefer-const': 'warn',
            eqeqeq: ['error', 'smart'],
            'no-return-await': 'warn',
            'require-await': 'warn',
            'no-throw-literal': 'error',
        },
    },
    {
        files: ['tests/**/*.js', 'scripts/**/*.js'],
        rules: { 'no-console': 'off' },
    },
];
