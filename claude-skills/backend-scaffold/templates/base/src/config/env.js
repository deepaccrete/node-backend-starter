/**
 * Configuration — read process.env ONCE, validate it, and export plain values.
 *
 * Nothing else in the codebase should touch `process.env`. Two reasons, both of
 * which have bitten real deploys:
 *
 *   1. A missing or malformed variable must fail at BOOT, not at the first
 *      request that happens to need it. A missing DB_NAME should stop the
 *      process immediately, not surface as a confusing error on the first query.
 *
 *   2. `process.env` values are always strings. Scattering
 *      `parseInt(process.env.X) || default` across the codebase means two files
 *      can disagree about the default for the same setting.
 *
 * Connection details are deliberately NOT defaulted. This project does not
 * guess which database you meant — you state it in `.env`, once.
 */

const fs = require('fs');

// No fallbacks for these on purpose: a silent default here is a request sent to
// the wrong database.
const REQUIRED = ['PORT', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER'];

const num = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
};

const list = (value) =>
    String(value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

// Database TLS. `require` encrypts AND verifies the server certificate — the safe
// choice for managed/remote Postgres, and the default behaviour here. `no-verify`
// encrypts without verification: a documented escape hatch for a self-signed cert
// on a trusted network, never the default because it is open to a man-in-the-
// middle. Anything else (incl. `disable`) means no TLS.
const sslConfig = () => {
    const mode = process.env.DB_SSL;
    if (mode === 'no-verify') return { rejectUnauthorized: false };
    if (mode === 'require') {
        const ca = process.env.DB_SSL_CA ? fs.readFileSync(process.env.DB_SSL_CA, 'utf8') : undefined;
        return { rejectUnauthorized: true, ca };
    }
    return false;
};

const env = {
    APP_NAME: process.env.APP_NAME || '{{PROJECT_NAME}}',
    NODE_ENV: process.env.NODE_ENV || 'development',
    get isProduction() {
        return this.NODE_ENV === 'production';
    },
    get isTest() {
        return this.NODE_ENV === 'test';
    },

    PORT: num(process.env.PORT, {{PORT}}),
    HOST: process.env.HOST || '0.0.0.0',
    API_PREFIX: process.env.API_PREFIX || '/api/v1',

    // Every value comes from .env. `password` tolerates an empty string because
    // local Postgres installs using trust/peer authentication legitimately have
    // none — but the variable must still be present in the file.
    db: {
        host: process.env.DB_HOST,
        port: num(process.env.DB_PORT, 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD || '',
        min: num(process.env.DB_POOL_MIN, 2),
        max: num(process.env.DB_POOL_MAX, 10),
        ssl: sslConfig(),
    },

    corsOrigins: list(process.env.CORS_ORIGIN),

    log: {
        level: process.env.LOG_LEVEL || 'info',
        dir: process.env.LOG_DIR || './logs',
    },

    rateLimit: {
        windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
        max: num(process.env.RATE_LIMIT_MAX, 100),
    },

    uploadMaxBytes: num(process.env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
};

/**
 * Throws on the first problem found, with a message that says how to fix it.
 * Called at the bottom of this file so a bad config cannot be imported at all.
 */
function assertValid() {
    const missing = REQUIRED.filter((key) => !process.env[key]);
    if (missing.length) {
        throw new Error(
            `Missing required environment variable(s): ${missing.join(', ')}.\n` +
                'This project ships no default connection settings. Copy .env.example ' +
                'to .env and fill in every value before starting the server.'
        );
    }

    if (!('DB_PASSWORD' in process.env)) {
        throw new Error(
            'DB_PASSWORD is not set in .env. If your database genuinely has no ' +
                'password, keep the line and leave it empty: DB_PASSWORD='
        );
    }

    if (env.isProduction && !env.corsOrigins.length) {
        throw new Error('CORS_ORIGIN must list at least one allowed origin in production.');
    }
}

// A test run has no .env; let it construct its own config instead of crashing
// at import time.
if (!env.isTest) assertValid();

module.exports = env;
module.exports.assertValid = assertValid;
