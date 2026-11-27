/**
 * User model — every SQL statement for `usermaster`.
 *
 * Only the Super Admin has a row here; every other role signs in through the
 * .NET team's central user management (CUM) API.
 *
 * Rules for EVERY query here: `isdeleted = 0`; values through $1, $2, …;
 * explicit column lists (never `SELECT *` — this table holds password hashes).
 * Time is always taken from the database (`now()`), never compared in Node:
 * the columns are `timestamp` without a time zone, so mixing the two clocks
 * would shift a lockout by the server's offset. Models never touch `req` or `res`.
 */

import { run, type Queryable } from '../../config/database.js';
import type { Role } from '../../config/permissions.js';

/** Unique index on the username (see migrations/…_create_customer_masters.sql). */
export const UQ_USERNAME = 'uq_usermaster_username';

/** What the login flow needs, including the hash. Never send this to a client. */
export interface UserCredentialsRow {
    id: number;
    username: string;
    fullname: string;
    rolecode: Role;
    passwordhash: string;
    isactive: number;
    /** Whole minutes left on a lockout; 0 when the account is not locked. */
    lockedminutes: number;
}

/** Safe to return to a client. */
export interface UserRow {
    id: number;
    username: string;
    fullname: string;
    rolecode: Role;
}

const PUBLIC_COLUMNS = 'userid AS id, username, fullname, rolecode';

export const UserModel = {
    findCredentialsByUsername: async (
        username: string,
        db?: Queryable
    ): Promise<UserCredentialsRow | null> => {
        const { rows } = await run<UserCredentialsRow>(
            db,
            `SELECT ${PUBLIC_COLUMNS}, passwordhash, isactive,
                    CASE WHEN lockeduntil > now()
                         THEN ceil(extract(epoch FROM lockeduntil - now()) / 60)::int
                         ELSE 0 END AS lockedminutes
             FROM usermaster
             WHERE username = $1 AND isdeleted = 0`,
            [username]
        );
        return rows[0] ?? null;
    },

    findActiveById: async (id: number, db?: Queryable): Promise<UserRow | null> => {
        const { rows } = await run<UserRow>(
            db,
            `SELECT ${PUBLIC_COLUMNS}
             FROM usermaster
             WHERE userid = $1 AND isactive = 1 AND isdeleted = 0`,
            [id]
        );
        return rows[0] ?? null;
    },

    findPasswordHashById: async (id: number, db?: Queryable): Promise<string | null> => {
        const { rows } = await run<{ passwordhash: string }>(
            db,
            `SELECT passwordhash FROM usermaster
             WHERE userid = $1 AND isactive = 1 AND isdeleted = 0`,
            [id]
        );
        return rows[0]?.passwordhash ?? null;
    },

    /**
     * One more wrong password. On reaching `maxFailures` the account is locked for
     * `lockMinutes` and the count starts again. One statement, so two failures at
     * the same moment both count (the right-hand side reads the row's old values).
     */
    recordFailedLogin: async (
        id: number,
        maxFailures: number,
        lockMinutes: number,
        db?: Queryable
    ) => {
        await run(
            db,
            `UPDATE usermaster
             SET lockeduntil  = CASE WHEN failedlogins + 1 >= $2
                                     THEN now() + make_interval(mins => $3) ELSE lockeduntil END,
                 failedlogins = CASE WHEN failedlogins + 1 >= $2 THEN 0 ELSE failedlogins + 1 END,
                 updatedby    = $1,
                 updatedat    = now()
             WHERE userid = $1 AND isdeleted = 0`,
            [id, maxFailures, lockMinutes]
        );
    },

    recordSuccessfulLogin: async (id: number, db?: Queryable) => {
        await run(
            db,
            `UPDATE usermaster
             SET failedlogins = 0, lockeduntil = NULL, lastloginat = now(),
                 updatedby = $1, updatedat = now()
             WHERE userid = $1 AND isdeleted = 0`,
            [id]
        );
    },

    /** Stores a new password hash and clears any lockout. */
    setPassword: async (id: number, passwordhash: string, by: number, db?: Queryable) => {
        await run(
            db,
            `UPDATE usermaster
             SET passwordhash = $2, failedlogins = 0, lockeduntil = NULL,
                 updatedby = $3, updatedat = now()
             WHERE userid = $1 AND isdeleted = 0`,
            [id, passwordhash, by]
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
             RETURNING ${PUBLIC_COLUMNS}`,
            [data.username, data.fullname, data.rolecode, data.passwordhash, createdBy]
        );
        const row = rows[0];
        if (!row) throw new Error('usermaster insert returned no row');
        return row;
    },
};
