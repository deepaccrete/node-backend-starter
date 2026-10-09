/**
 * The ONE PostgreSQL pool for this process.
 *
 * Every model imports `query` / `withTransaction` from here. Do not create a
 * second pool module: two pools mean two sets of connections against the same
 * `max`, so the database hits its connection limit at half the configured load,
 * and a transaction started on one pool cannot be joined by a query issued on
 * the other — which fails as a silent partial write, not as an error.
 */

const { Pool } = require('pg');

const env = require('./env');
const logger = require('./winston');

const pool = new Pool({
    host: env.db.host,
    port: env.db.port,
    database: env.db.database,
    user: env.db.user,
    password: env.db.password,
    min: env.db.min,
    max: env.db.max,
    ssl: env.db.ssl,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

// An error on an IDLE client (network blip, database restart) is emitted here,
// not at a call site. Without this handler Node treats it as an unhandled
// 'error' event and kills the process.
pool.on('error', (err) => logger.error('Idle client error', { message: err.message }));

/**
 * Run a parameterized query.
 *
 * ALWAYS pass values through `params` ($1, $2, …). String-interpolating a value
 * into `sql` is SQL injection; there is no case in this codebase where it is
 * needed. When an identifier (a column to sort by) must vary, validate it
 * against a whitelist first — see `sortColumn()` below.
 *
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<import('pg').QueryResult>}
 */
const query = async (sql, params = []) => {
    const start = Date.now();
    try {
        const result = await pool.query(sql, params);
        const ms = Date.now() - start;
        // Slow queries are the ones worth seeing; logging every query at info
        // level buries them.
        if (ms > 500) logger.warn(`Slow query ${ms}ms: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
        return result;
    } catch (err) {
        logger.error('Query failed', {
            message: err.message,
            code: err.code,
            sql: sql.replace(/\s+/g, ' ').slice(0, 300),
        });
        throw err;
    }
};

/**
 * Run `callback` inside a transaction on a single client.
 *
 * Use this whenever one request writes to more than one table, or reads a value
 * it is about to write against (sequence numbers, stock balances). The callback
 * receives the client — issue EVERY statement in the unit of work through
 * `client.query`, never through the module-level `query`, or that statement runs
 * on a different connection outside the transaction and will not roll back.
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 * @template T
 */
const withTransaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        // A failed ROLLBACK must not mask the error that caused it.
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            logger.error('Rollback failed', { message: rollbackErr.message });
        }
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Whitelist an ORDER BY column. Identifiers cannot be parameterized, so the only
 * safe way to let a client choose a sort column is to check it against a list of
 * columns you wrote yourself.
 *
 * @param {string} requested   value from req.query
 * @param {string[]} allowed   column names this endpoint permits
 * @param {string} fallback    used when `requested` is absent or not allowed
 */
const sortColumn = (requested, allowed, fallback) =>
    allowed.includes(String(requested)) ? String(requested) : fallback;

/**
 * Ping the database once at startup.
 *
 * @returns {Promise<{ ok: boolean, database: string|null, error: string|null }>}
 *   The database NAME is returned, not just a boolean, so the startup banner can
 *   show which database this process actually reached — the single most useful
 *   thing to see when an API is somehow serving the wrong data.
 */
const testConnection = async () => {
    try {
        const { rows } = await query('SELECT current_database() AS db');
        logger.info(`[32m✓[0m Database connected: ${rows[0].db}`);
        return { ok: true, database: rows[0].db, error: null };
    } catch (err) {
        logger.error(`Database connection failed: ${err.message}`);
        return { ok: false, database: null, error: err.message };
    }
};

module.exports = { pool, query, withTransaction, sortColumn, testConnection };
