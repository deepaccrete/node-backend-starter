/**
 * Session model — every SQL statement for `authsession`.
 *
 * Rules for EVERY query here: `isdeleted = 0`; values through $1, $2, …;
 * explicit column lists. Models never touch `req` or `res`. Pass `db` (a
 * transaction client) to run inside `withTransaction`; omit it to use the pool.
 */

import { run, type Queryable } from '../../config/database.js';

export interface SessionRow {
    id: string;
    usermaster_id: number;
    refreshtokenhash: string;
    generation: number;
    expiresat: Date;
    revokedat: Date | null;
}

const COLUMNS = 'id, usermaster_id, refreshtokenhash, generation, expiresat, revokedat';

export const SessionModel = {
    /** Creates the row at generation 0; `rotate` then stores the first token (generation 1). */
    create: async (
        userId: number,
        data: { expiresAt: Date; userAgent: string | null; ipAddress: string | null },
        db?: Queryable
    ): Promise<SessionRow> => {
        const { rows } = await run<SessionRow>(
            db,
            `INSERT INTO authsession (usermaster_id, refreshtokenhash, generation, useragent, ipaddress,
                                      expiresat, createdby, updatedby)
             VALUES ($1, '', 0, $2, $3, $4, $1, $1)
             RETURNING ${COLUMNS}`,
            [
                userId,
                data.userAgent?.slice(0, 255) ?? null,
                data.ipAddress?.slice(0, 45) ?? null,
                data.expiresAt,
            ]
        );
        const row = rows[0];
        if (!row) throw new Error('INSERT into authsession returned no row');
        return row;
    },

    findById: async (id: string, db?: Queryable): Promise<SessionRow | null> => {
        const { rows } = await run<SessionRow>(
            db,
            `SELECT ${COLUMNS} FROM authsession WHERE id = $1 AND isdeleted = 0`,
            [id]
        );
        return rows[0] ?? null;
    },

    /**
     * Moves a live session to its next generation and stores the new token hash.
     * The WHERE on the CURRENT generation makes it atomic: if two refreshes race
     * with the same token, only one wins; the other gets null.
     */
    rotate: async (
        id: string,
        currentGeneration: number,
        nextHash: string,
        expiresAt: Date,
        db?: Queryable
    ): Promise<SessionRow | null> => {
        const { rows } = await run<SessionRow>(
            db,
            `UPDATE authsession SET
                    generation = generation + 1, refreshtokenhash = $3, expiresat = $4, updatedat = NOW()
              WHERE id = $1 AND generation = $2 AND revokedat IS NULL AND isdeleted = 0
              RETURNING ${COLUMNS}`,
            [id, currentGeneration, nextHash, expiresAt]
        );
        return rows[0] ?? null;
    },

    revoke: async (id: string, db?: Queryable) => {
        await run(
            db,
            `UPDATE authsession SET revokedat = NOW(), updatedat = NOW()
              WHERE id = $1 AND revokedat IS NULL AND isdeleted = 0`,
            [id]
        );
    },

    /** Used when a replayed refresh token suggests theft: sign the user out everywhere. */
    revokeAllForUser: async (userId: number, db?: Queryable) => {
        await run(
            db,
            `UPDATE authsession SET revokedat = NOW(), updatedat = NOW()
              WHERE usermaster_id = $1 AND revokedat IS NULL AND isdeleted = 0`,
            [userId]
        );
    },
};
