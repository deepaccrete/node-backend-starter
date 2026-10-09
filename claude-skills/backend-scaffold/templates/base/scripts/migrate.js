#!/usr/bin/env node
/**
 * Migration runner.
 *
 *   node scripts/migrate.js up       apply every pending migration
 *   node scripts/migrate.js status   list applied vs pending
 *
 * Migrations are plain `.sql` files in `migrations/`, applied in filename order,
 * each inside its own transaction. Two rules make this safe to run repeatedly
 * and in a team:
 *
 *   - A file that has been applied is NEVER re-run. Applied filenames and their
 *     checksums live in `schemamigrations`.
 *   - A file that has been applied and then EDITED is a hard error. Editing an
 *     applied migration means production and a fresh database end up with
 *     different schemas, and nothing will tell you until something breaks. Write
 *     a new migration instead.
 *
 * Name files `<YYYYMMDD>_<what_it_does>.sql`, e.g. `20260825_add_customer_gstin.sql`.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { pool } = require('../src/config/database');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const checksum = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

const ensureTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schemamigrations (
            filename   varchar(255) PRIMARY KEY,
            checksum   varchar(64)  NOT NULL,
            appliedat  timestamp    NOT NULL DEFAULT NOW()
        )
    `);
};

const readMigrations = () => {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((filename) => {
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
            return { filename, sql, checksum: checksum(sql) };
        });
};

const loadApplied = async (client) => {
    const { rows } = await client.query('SELECT filename, checksum FROM schemamigrations');
    return new Map(rows.map((r) => [r.filename, r.checksum]));
};

const up = async () => {
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const applied = await loadApplied(client);
        const files = readMigrations();

        let ran = 0;
        for (const file of files) {
            const previous = applied.get(file.filename);

            if (previous && previous !== file.checksum) {
                throw new Error(
                    `${file.filename} was already applied but its contents have changed. ` +
                        'Never edit an applied migration — add a new one instead.'
                );
            }
            if (previous) continue;

            // Each migration is its own transaction: a failure rolls back that
            // file only, leaving everything before it applied and recorded.
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
                throw new Error(`${file.filename} failed: ${err.message}`);
            }
        }

        console.log(ran ? `\n${ran} migration(s) applied.` : '\nAlready up to date.');
    } finally {
        client.release();
    }
};

const status = async () => {
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const applied = await loadApplied(client);
        for (const file of readMigrations()) {
            const state = applied.has(file.filename)
                ? applied.get(file.filename) === file.checksum
                    ? 'applied'
                    : 'MODIFIED!'
                : 'pending';
            console.log(`  ${state.padEnd(10)} ${file.filename}`);
        }
    } finally {
        client.release();
    }
};

const main = async () => {
    const command = process.argv[2] || 'up';
    if (command === 'up') await up();
    else if (command === 'status') await status();
    else {
        console.error(`Unknown command "${command}". Use: up | status`);
        process.exitCode = 1;
    }
};

main()
    .catch((err) => {
        console.error(`\nMigration error: ${err.message}`);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
