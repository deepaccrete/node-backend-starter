/**
 * The ONE PostgreSQL pool for this process.
 *
 * Every model imports `query` / `withTransaction` from here. Do not create a
 * second pool module: two pools double the connections against the same limit,
 * and a transaction on one pool cannot be joined by a query on the other — a
 * silent partial write, not an error.
 */

import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import { env } from './env.js';
import { logger } from './logger.js';

export const pool = new pg.Pool({
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

// An error on an IDLE client (network blip, database restart) is emitted here.
// Without this handler Node treats it as an unhandled 'error' event and exits.
pool.on('error', (err) => {
    logger.error('Idle client error', { message: err.message });
});

const oneLine = (sql: string, max: number) => sql.replace(/\s+/g, ' ').slice(0, max);

/**
 * Run a parameterized query.
 *
 * ALWAYS pass values through `params` ($1, $2, …). Never interpolate a value
 * into `sql`. When an identifier (a sort column) must vary, whitelist it with
 * `sortColumn()`.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
        const result = await pool.query<T>(sql, params as unknown[]);
        const ms = Date.now() - start;
        if (ms > 500) logger.warn(`Slow query ${ms}ms: ${oneLine(sql, 160)}`);
        return result;
    } catch (err) {
        const e = err as Error & { code?: string };
        logger.error('Query failed', { message: e.message, code: e.code, sql: oneLine(sql, 300) });
        throw err;
    }
}

/** Anything that can run a query: the pool (via `query`) or a transaction's client. */
export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Run a query on the transaction client when one is given, otherwise on the pool.
 * Models take an optional `db` argument and call this, so the same function works
 * standalone and as one statement inside `withTransaction`.
 */
export function run<T extends QueryResultRow = QueryResultRow>(
    db: Queryable | undefined,
    sql: string,
    params: readonly unknown[] = []
): Promise<QueryResult<T>> {
    return db ? db.query<T>(sql, params as unknown[]) : query<T>(sql, params);
}

/**
 * Run `callback` inside a transaction on a single client.
 *
 * Issue EVERY statement in the unit of work through the `client` it receives,
 * never through the module-level `query` — that runs on a different connection,
 * outside the transaction, and will not roll back.
 */
export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
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
            logger.error('Rollback failed', { message: (rollbackErr as Error).message });
        }
        throw err;
    } finally {
        client.release();
    }
}

/** Whitelist an ORDER BY column: identifiers cannot be parameterized. */
export function sortColumn<T extends string>(
    requested: unknown,
    allowed: readonly T[],
    fallback: T
): T {
    return allowed.find((column) => column === requested) ?? fallback;
}

/** Ping the database once; returns its NAME so the banner shows which one was reached. */
export async function testConnection(): Promise<
    { ok: true; database: string } | { ok: false; error: string }
> {
    try {
        const { rows } = await query<{ db: string }>('SELECT current_database() AS db');
        const database = rows[0]?.db ?? 'unknown';
        logger.info(`Database connected: ${database}`);
        return { ok: true, database };
    } catch (err) {
        const message = (err as Error).message;
        logger.error(`Database connection failed: ${message}`);
        return { ok: false, error: message };
    }
}
