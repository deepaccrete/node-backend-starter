/**
 * Migration runner.
 *
 *   pnpm migrate          apply every pending migration
 *   pnpm migrate:status   list applied vs pending, apply nothing
 *
 * Migrations are plain `.sql` files in `migrations/`, applied in filename order,
 * each in its own transaction. Applied files and their checksums are recorded in
 * `schemamigrations`:
 *   - an applied file is NEVER re-run;
 *   - an applied file that was later EDITED is a hard error — write a new one.
 *
 * Name files `<YYYYMMDD>_<what_it_does>.sql`.
 */

import 'dotenv/config';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { PoolClient } from 'pg';

import { pool } from '../src/config/database.js';

const MIGRATIONS_DIR = path.resolve('migrations');

const checksum = (text: string) =>
    crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

interface MigrationFile {
    filename: string;
    sql: string;
    checksum: string;
}

async function ensureTable(client: PoolClient) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schemamigrations (
            filename   varchar(255) PRIMARY KEY,
            checksum   varchar(64)  NOT NULL,
            appliedat  timestamptz  NOT NULL DEFAULT NOW()
        )
    `);
}

function readMigrations(): MigrationFile[] {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((filename) => {
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
            return { filename, sql, checksum: checksum(sql) };
        });
}

async function loadApplied(client: PoolClient) {
    const { rows } = await client.query<{ filename: string; checksum: string }>(
        'SELECT filename, checksum FROM schemamigrations'
    );
    return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function up() {
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const applied = await loadApplied(client);
        let ran = 0;

        for (const file of readMigrations()) {
            const previous = applied.get(file.filename);
            if (previous && previous !== file.checksum) {
                throw new Error(
                    `${file.filename} was already applied but its contents have changed. ` +
                        'Never edit an applied migration — add a new one instead.'
                );
            }
            if (previous) continue;

            await client.query('BEGIN');
            try {
                await client.query(file.sql);
                await client.query(
                    'INSERT INTO schemamigrations (filename, checksum) VALUES ($1, $2)',
                    [file.filename, file.checksum]
                );
                await client.query('COMMIT');
                console.log(`  applied  ${file.filename}`);
                ran++;
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`${file.filename} failed: ${(err as Error).message}`, {
                    cause: err,
                });
            }
        }

        console.log(ran ? `\n${ran} migration(s) applied.` : '\nAlready up to date.');
    } finally {
        client.release();
    }
}

async function status() {
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const applied = await loadApplied(client);
        for (const file of readMigrations()) {
            const recorded = applied.get(file.filename);
            const state = !recorded
                ? 'pending'
                : recorded === file.checksum
                  ? 'applied'
                  : 'MODIFIED!';
            console.log(`  ${state.padEnd(10)} ${file.filename}`);
        }
    } finally {
        client.release();
    }
}

const command = process.argv[2] ?? 'up';
try {
    if (command === 'up') await up();
    else if (command === 'status') await status();
    else {
        console.error(`Unknown command "${command}". Use: up | status`);
        process.exitCode = 1;
    }
} catch (err) {
    console.error(`\nMigration error: ${(err as Error).message}`);
    process.exitCode = 1;
} finally {
    await pool.end();
}
