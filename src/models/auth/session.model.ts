/**
 * Session model — every database call for the `authsession` collection.
 *
 * Rules for EVERY call here: filter on `isdeleted: 0`; project explicit fields;
 * `.lean()` so callers get plain objects; set `updatedat` on every update.
 * Models never touch `req` or `res`.
 */

import { mongoose } from '../../config/database.js';
import { SequenceModel, SYSTEM_USER } from '../sequence.model.js';

/**
 * One signed-in device, as stored. `_id` is MongoDB's; the key is `authsessionid`.
 * Exactly one owner is set: `userid` for the dashboard, `distributorcontactid` for the app.
 */
interface SessionDoc {
    authsessionid: number;
    userid: number | null;
    distributorcontactid: number | null;
    // SHA-256 of the refresh token; the token itself is never stored.
    refreshtokenhash: string;
    // Increases on every refresh, so a replayed older token is detected.
    generation: number;
    useragent: string | null;
    ipaddress: string | null;
    expiresat: Date;
    revokedat: Date | null;
    createdby: number;
    createdat: Date;
    updatedby: number;
    updatedat: Date;
    isdeleted: number;
}

const sessionSchema = new mongoose.Schema<SessionDoc>(
    {
        authsessionid: { type: Number, required: true },
        userid: { type: Number, default: null },
        distributorcontactid: { type: Number, default: null },
        refreshtokenhash: { type: String, required: true, maxlength: 64 },
        generation: { type: Number, required: true, default: 1 },
        useragent: { type: String, default: null, maxlength: 255 },
        ipaddress: { type: String, default: null, maxlength: 45 },
        expiresat: { type: Date, required: true },
        revokedat: { type: Date, default: null },
        createdby: { type: Number, required: true },
        createdat: { type: Date, required: true, default: Date.now },
        updatedby: { type: Number, required: true },
        updatedat: { type: Date, required: true, default: Date.now },
        isdeleted: { type: Number, required: true, default: 0, enum: [0, 1] },
    },
    { collection: 'authsession', timestamps: false, versionKey: false }
);

sessionSchema.index({ authsessionid: 1 }, { name: 'uq_authsession_authsessionid', unique: true });
sessionSchema.index({ userid: 1, isdeleted: 1 }, { name: 'idx_authsession_userid' });
sessionSchema.index(
    { distributorcontactid: 1, isdeleted: 1 },
    { name: 'idx_authsession_distributorcontactid' }
);

const Session = mongoose.model<SessionDoc>('Session', sessionSchema);

export interface SessionRow {
    id: string;
    /** Null for an app session. */
    usermaster_id: number | null;
    /** Null for a dashboard session. */
    distributorcontactid: number | null;
    refreshtokenhash: string;
    generation: number;
    expiresat: Date;
    revokedat: Date | null;
}

const FIELDS = {
    _id: 0,
    authsessionid: 1,
    userid: 1,
    distributorcontactid: 1,
    refreshtokenhash: 1,
    generation: 1,
    expiresat: 1,
    revokedat: 1,
} as const;

type Projected = Pick<
    SessionDoc,
    | 'authsessionid'
    | 'userid'
    | 'distributorcontactid'
    | 'refreshtokenhash'
    | 'generation'
    | 'expiresat'
    | 'revokedat'
>;

// The rest of the app knows a session by the string in the token's `sid` claim.
const toRow = (d: Projected): SessionRow => ({
    id: String(d.authsessionid),
    usermaster_id: d.userid ?? null,
    distributorcontactid: d.distributorcontactid ?? null,
    refreshtokenhash: d.refreshtokenhash,
    generation: d.generation,
    expiresat: d.expiresat,
    revokedat: d.revokedat,
});

/** `sid` from a token → key. A sid that is not a positive integer cannot match a session. */
const keyOf = (id: string) => (/^[1-9]\d{0,15}$/.test(id) ? Number(id) : null);

interface NewSession {
    refreshTokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ipAddress: string | null;
}

async function insert(
    id: string,
    owner: { userid?: number; distributorcontactid?: number; createdby: number },
    data: NewSession
): Promise<SessionRow> {
    const authsessionid = keyOf(id);
    if (authsessionid === null) throw new Error(`Invalid session id ${id}`);
    const doc = await Session.create({
        authsessionid,
        userid: owner.userid ?? null,
        distributorcontactid: owner.distributorcontactid ?? null,
        refreshtokenhash: data.refreshTokenHash,
        generation: 1,
        useragent: data.userAgent?.slice(0, 255) ?? null,
        ipaddress: data.ipAddress?.slice(0, 45) ?? null,
        expiresat: data.expiresAt,
        createdby: owner.createdby,
        updatedby: owner.createdby,
    });
    return toRow(doc);
}

export const SessionModel = {
    /** The next session key: the refresh token names the session before it is stored. */
    newId: async (): Promise<string> => String(await SequenceModel.next('authsession')),

    /** Stores a dashboard session at generation 1 with its first token's hash, in one write. */
    create: (id: string, userId: number, data: NewSession): Promise<SessionRow> =>
        insert(id, { userid: userId, createdby: userId }, data),

    /** Same, for an app (telecaller) session. */
    createForContact: (id: string, contactId: number, data: NewSession): Promise<SessionRow> =>
        insert(id, { distributorcontactid: contactId, createdby: SYSTEM_USER }, data),

    findById: async (id: string): Promise<SessionRow | null> => {
        const authsessionid = keyOf(id);
        if (authsessionid === null) return null;
        const d = await Session.findOne({ authsessionid, isdeleted: 0 }, FIELDS).lean<Projected>();
        return d ? toRow(d) : null;
    },

    /**
     * Moves a live session to its next generation and stores the new token hash.
     * The filter on the CURRENT generation makes it atomic: if two refreshes race
     * with the same token, only one wins; the other gets null.
     */
    rotate: async (
        id: string,
        currentGeneration: number,
        nextHash: string,
        expiresAt: Date
    ): Promise<SessionRow | null> => {
        const authsessionid = keyOf(id);
        if (authsessionid === null) return null;
        const d = await Session.findOneAndUpdate(
            { authsessionid, generation: currentGeneration, revokedat: null, isdeleted: 0 },
            {
                $inc: { generation: 1 },
                $set: { refreshtokenhash: nextHash, expiresat: expiresAt, updatedat: new Date() },
            },
            { returnDocument: 'after', projection: FIELDS }
        ).lean<Projected>();
        return d ? toRow(d) : null;
    },

    revoke: async (id: string) => {
        const authsessionid = keyOf(id);
        if (authsessionid === null) return;
        const now = new Date();
        await Session.updateOne(
            { authsessionid, revokedat: null, isdeleted: 0 },
            { $set: { revokedat: now, updatedat: now } }
        );
    },

    /** Used when a replayed refresh token suggests theft: sign the user out everywhere. */
    revokeAllForUser: async (userId: number) => {
        const now = new Date();
        await Session.updateMany(
            { userid: userId, revokedat: null, isdeleted: 0 },
            { $set: { revokedat: now, updatedat: now } }
        );
    },

    /** Signs a telecaller number out of the app everywhere (replay, or the number was deactivated). */
    revokeAllForContact: async (contactId: number) => {
        const now = new Date();
        await Session.updateMany(
            { distributorcontactid: contactId, revokedat: null, isdeleted: 0 },
            { $set: { revokedat: now, updatedat: now } }
        );
    },
};
