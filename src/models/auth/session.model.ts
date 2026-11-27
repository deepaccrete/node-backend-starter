/**
 * Session model — every SQL statement for `authsession`.
 *
 * One row per signed-in device. The refresh token names its row (`sid`) and
 * generation; only the token's SHA-256 hash is stored.
 *
 * Rules: `isdeleted = 0`; values through $1, $2, …; expiry is computed and
 * compared in the database (`now()`), never in Node, because the columns are
 * `timestamp` without a time zone.
 */

import { run, type Queryable } from '../../config/database.js';

export interface SessionRow {
    /** `authsessionid`, as the string carried in the token's `sid` claim. */
    id: string;
    userid: number;
    refreshtokenhash: string;
    generation: number;
    /** True when revoked or past `expiresat`. */
    isended: boolean;
}

/** A `sid` that is not a positive integer cannot name a session. */
const isKey = (id: string) => /^[1-9]\d{0,17}$/.test(id);

const COLUMNS = `authsessionid::text AS id, userid, refreshtokenhash, generation,
                 (revokedat IS NOT NULL OR expiresat <= now()) AS isended`;

interface NewSession {
    refreshTokenHash: string;
    /** Lifetime from now, in seconds. */
    ttlSeconds: number;
    userAgent: string | null;
    ipAddress: string | null;
}

export const SessionModel = {
    /** The next session key: the refresh token names the session before it is stored. */
    newId: async (db?: Queryable): Promise<string> => {
        const { rows } = await run<{ id: string }>(
            db,
            `SELECT nextval(pg_get_serial_sequence('authsession', 'authsessionid'))::text AS id`
        );
        const id = rows[0]?.id;
        if (!id) throw new Error('authsession sequence returned no value');
        return id;
    },

    /** Stores a session at generation 1 with its first token's hash, in one write. */
    create: async (id: string, userId: number, data: NewSession, db?: Queryable) => {
        if (!isKey(id)) throw new Error(`Invalid session id ${id}`);
        await run(
            db,
            `INSERT INTO authsession
                 (authsessionid, userid, refreshtokenhash, generation, useragent, ipaddress,
                  expiresat, createdby, updatedby)
             VALUES ($1, $2, $3, 1, $4, $5, now() + make_interval(secs => $6), $2, $2)`,
            [
                id,
                userId,
                data.refreshTokenHash,
                data.userAgent?.slice(0, 255) ?? null,
                data.ipAddress?.slice(0, 64) ?? null,
                data.ttlSeconds,
            ]
        );
    },

    findById: async (id: string, db?: Queryable): Promise<SessionRow | null> => {
        if (!isKey(id)) return null;
        const { rows } = await run<SessionRow>(
            db,
            `SELECT ${COLUMNS} FROM authsession WHERE authsessionid = $1 AND isdeleted = 0`,
            [id]
        );
        return rows[0] ?? null;
    },

    /**
     * Moves a live session to its next generation and stores the new token hash.
     * The filter on the CURRENT generation makes it atomic: if two refreshes race
     * with the same token, only one wins; the other gets false.
     */
    rotate: async (
        id: string,
        currentGeneration: number,
        nextHash: string,
        ttlSeconds: number,
        db?: Queryable
    ): Promise<boolean> => {
        if (!isKey(id)) return false;
        const { rowCount } = await run(
            db,
            `UPDATE authsession
             SET generation = generation + 1, refreshtokenhash = $3,
                 expiresat = now() + make_interval(secs => $4), updatedat = now()
             WHERE authsessionid = $1 AND generation = $2
               AND revokedat IS NULL AND isdeleted = 0`,
            [id, currentGeneration, nextHash, ttlSeconds]
        );
        return rowCount === 1;
    },

    revoke: async (id: string, db?: Queryable) => {
        if (!isKey(id)) return;
        await run(
            db,
            `UPDATE authsession SET revokedat = now(), updatedat = now()
             WHERE authsessionid = $1 AND revokedat IS NULL AND isdeleted = 0`,
            [id]
        );
    },

    /** Sign the user out everywhere (replayed refresh token, or a password change). */
    revokeAllForUser: async (userId: number, db?: Queryable) => {
        await run(
            db,
            `UPDATE authsession SET revokedat = now(), updatedat = now()
             WHERE userid = $1 AND revokedat IS NULL AND isdeleted = 0`,
            [userId]
        );
    },
};
