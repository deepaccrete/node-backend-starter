/**
 * User model — every SQL statement for `usermaster`.
 *
 * Rules for EVERY query here: `isdeleted = 0`; values through $1, $2, …;
 * explicit column lists (never `SELECT *` — this table holds password hashes).
 * Models never touch `req` or `res`. Pass `db` (a transaction client) to run a
 * statement inside `withTransaction`; omit it to use the pool.
 */

import { run, type Queryable } from '../../config/database.js';
import type { Role } from '../../config/permissions.js';

/** What the login flow needs, including the hash. Never send this to a client. */
export interface UserCredentialsRow {
    id: number;
    username: string;
    fullname: string;
    rolecode: Role;
    passwordhash: string;
    failedlogins: number;
    lockeduntil: Date | null;
    isactive: number;
}

/** Safe to return to a client. */
export interface UserRow {
    id: number;
    username: string;
    fullname: string;
    rolecode: Role;
}

export const UserModel = {
    findCredentialsByUsername: async (
        username: string,
        db?: Queryable
    ): Promise<UserCredentialsRow | null> => {
        const { rows } = await run<UserCredentialsRow>(
            db,
            `SELECT id, username, fullname, rolecode, passwordhash, failedlogins, lockeduntil, isactive
               FROM usermaster
              WHERE username = $1 AND isdeleted = 0`,
            [username]
        );
        return rows[0] ?? null;
    },

    findActiveById: async (id: number, db?: Queryable): Promise<UserRow | null> => {
        const { rows } = await run<UserRow>(
            db,
            `SELECT id, username, fullname, rolecode
               FROM usermaster
              WHERE id = $1 AND isactive = 1 AND isdeleted = 0`,
            [id]
        );
        return rows[0] ?? null;
    },

    /** Counts a failed attempt; on reaching `maxFailures` locks the account and resets the count. */
    recordFailedLogin: async (
        id: number,
        maxFailures: number,
        lockMinutes: number,
        db?: Queryable
    ) => {
        await run(
            db,
            `UPDATE usermaster SET
                    lockeduntil  = CASE WHEN failedlogins + 1 >= $2
                                        THEN NOW() + make_interval(mins => $3) ELSE lockeduntil END,
                    failedlogins = CASE WHEN failedlogins + 1 >= $2 THEN 0 ELSE failedlogins + 1 END,
                    updatedat    = NOW()
              WHERE id = $1 AND isdeleted = 0`,
            [id, maxFailures, lockMinutes]
        );
    },

    recordSuccessfulLogin: async (id: number, db?: Queryable) => {
        await run(
            db,
            `UPDATE usermaster SET failedlogins = 0, lockeduntil = NULL, lastloginat = NOW(), updatedat = NOW()
              WHERE id = $1 AND isdeleted = 0`,
            [id]
        );
    },

    create: async (
        createdBy: number,
        data: { username: string; fullname: string; rolecode: Role; passwordhash: string },
        db?: Queryable
    ): Promise<UserRow> => {
        const { rows } = await run<UserRow>(
            db,
            `INSERT INTO usermaster (username, fullname, rolecode, passwordhash, createdby, updatedby)
             VALUES ($1, $2, $3, $4, $5, $5)
             RETURNING id, username, fullname, rolecode`,
            [data.username, data.fullname, data.rolecode, data.passwordhash, createdBy]
        );
        const row = rows[0];
        if (!row) throw new Error('INSERT into usermaster returned no row');
        return row;
    },
};
