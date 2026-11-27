/**
 * User model — every database call for the `usermaster` collection.
 *
 * Rules for EVERY call here: filter on `isdeleted: 0`; project explicit fields
 * (never return the whole document — it holds the password hash); `.lean()` so
 * callers get plain objects; set `updatedat` / `updatedby` on every update.
 * Models never touch `req` or `res`.
 */

import { mongoose } from '../../config/database.js';
import { ROLES, type Role } from '../../config/permissions.js';
import { SequenceModel, SYSTEM_USER } from '../sequence.model.js';

/** Index name → message, read by the error handler (src/utils/mongoError.ts). */
export const UQ_USERNAME = 'uq_usermaster_username';
export const UQ_USER_MOBILENO = 'uq_usermaster_mobileno';

/** A dashboard user, as stored. `_id` is MongoDB's; links use `userid`. */
interface UserDoc {
    userid: number;
    username: string;
    fullname: string;
    rolecode: Role;
    // 10-digit Indian mobile; receives the password-reset code.
    mobileno: string | null;
    // The manager one level up (ASM → RM → ZM → GM). Null for GM and ADMIN.
    reportstouserid: number | null;
    passwordhash: string;
    // 1 after an Admin sets a temporary password: the user must change it first.
    mustchangepassword: number;
    failedlogins: number;
    lockeduntil: Date | null;
    lastloginat: Date | null;
    isactive: number;
    createdby: number;
    createdat: Date;
    updatedby: number;
    updatedat: Date;
    isdeleted: number;
}

const userSchema = new mongoose.Schema<UserDoc>(
    {
        userid: { type: Number, required: true },
        // Stored lower-cased by the application.
        username: { type: String, required: true, maxlength: 64 },
        fullname: { type: String, required: true, maxlength: 150 },
        rolecode: { type: String, required: true, enum: ROLES },
        mobileno: { type: String, default: null, match: /^[6-9]\d{9}$/ },
        reportstouserid: { type: Number, default: null },
        passwordhash: { type: String, required: true, maxlength: 100 },
        mustchangepassword: { type: Number, required: true, default: 0, enum: [0, 1] },
        failedlogins: { type: Number, required: true, default: 0 },
        lockeduntil: { type: Date, default: null },
        lastloginat: { type: Date, default: null },
        isactive: { type: Number, required: true, default: 1, enum: [0, 1] },
        createdby: { type: Number, required: true, default: SYSTEM_USER },
        createdat: { type: Date, required: true, default: Date.now },
        updatedby: { type: Number, required: true, default: SYSTEM_USER },
        updatedat: { type: Date, required: true, default: Date.now },
        isdeleted: { type: Number, required: true, default: 0, enum: [0, 1] },
    },
    { collection: 'usermaster', timestamps: false, versionKey: false }
);

userSchema.index({ userid: 1 }, { name: 'uq_usermaster_userid', unique: true });
// Partial: a deleted user must not reserve the name forever.
userSchema.index(
    { username: 1 },
    { name: UQ_USERNAME, unique: true, partialFilterExpression: { isdeleted: 0 } }
);
// Also partial on a string value, so users without a mobile number do not collide on null.
userSchema.index(
    { mobileno: 1 },
    {
        name: UQ_USER_MOBILENO,
        unique: true,
        partialFilterExpression: { isdeleted: 0, mobileno: { $type: 'string' } },
    }
);
userSchema.index({ reportstouserid: 1, isdeleted: 1 }, { name: 'idx_usermaster_reportstouserid' });

const User = mongoose.model<UserDoc>('User', userSchema);

/** What the login flow needs, including the hash. Never send this to a client. */
export interface UserCredentialsRow {
    id: number;
    username: string;
    fullname: string;
    rolecode: Role;
    mustchangepassword: number;
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
    mustchangepassword: number;
}

/** What the user-management screens show. Never includes the hash. */
export interface UserDetailRow extends UserRow {
    mobileno: string | null;
    reportstouserid: number | null;
    isactive: number;
    lastloginat: Date | null;
    createdat: Date;
}

/** Fields an Admin may change on an existing user. */
export interface UserChanges {
    fullname?: string;
    rolecode?: Role;
    mobileno?: string | null;
    reportstouserid?: number | null;
    isactive?: number;
}

export const USER_SORT_FIELDS = [
    'userid',
    'username',
    'fullname',
    'rolecode',
    'createdat',
] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

const PUBLIC = {
    _id: 0,
    userid: 1,
    username: 1,
    fullname: 1,
    rolecode: 1,
    mustchangepassword: 1,
} as const;
const CREDENTIALS = {
    ...PUBLIC,
    passwordhash: 1,
    failedlogins: 1,
    lockeduntil: 1,
    isactive: 1,
} as const;
const DETAIL = {
    ...PUBLIC,
    mobileno: 1,
    reportstouserid: 1,
    isactive: 1,
    lastloginat: 1,
    createdat: 1,
} as const;

type PublicDoc = Pick<
    UserDoc,
    'userid' | 'username' | 'fullname' | 'rolecode' | 'mustchangepassword'
>;
type CredentialsDoc = PublicDoc &
    Pick<UserDoc, 'passwordhash' | 'failedlogins' | 'lockeduntil' | 'isactive'>;
type DetailDoc = PublicDoc &
    Pick<UserDoc, 'mobileno' | 'reportstouserid' | 'isactive' | 'lastloginat' | 'createdat'>;

const toRow = (d: PublicDoc): UserRow => ({
    id: d.userid,
    username: d.username,
    fullname: d.fullname,
    rolecode: d.rolecode,
    mustchangepassword: d.mustchangepassword,
});

const toDetail = (d: DetailDoc): UserDetailRow => ({
    ...toRow(d),
    mobileno: d.mobileno,
    reportstouserid: d.reportstouserid,
    isactive: d.isactive,
    lastloginat: d.lastloginat,
    createdat: d.createdat,
});

/** A search typed by a user is matched literally, never as a pattern. */
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const UserModel = {
    findCredentialsByUsername: async (username: string): Promise<UserCredentialsRow | null> => {
        const d = await User.findOne(
            { username, isdeleted: 0 },
            CREDENTIALS
        ).lean<CredentialsDoc>();
        return d
            ? {
                  ...toRow(d),
                  passwordhash: d.passwordhash,
                  failedlogins: d.failedlogins,
                  lockeduntil: d.lockeduntil,
                  isactive: d.isactive,
              }
            : null;
    },

    findActiveById: async (id: number): Promise<UserRow | null> => {
        const d = await User.findOne(
            { userid: id, isactive: 1, isdeleted: 0 },
            PUBLIC
        ).lean<PublicDoc>();
        return d ? toRow(d) : null;
    },

    findPasswordHashById: async (id: number): Promise<string | null> => {
        const d = await User.findOne(
            { userid: id, isactive: 1, isdeleted: 0 },
            { _id: 0, passwordhash: 1 }
        ).lean<Pick<UserDoc, 'passwordhash'>>();
        return d?.passwordhash ?? null;
    },

    /** The active user with this username AND mobile number, for a password reset. */
    findIdForReset: async (username: string, mobileno: string): Promise<number | null> => {
        const d = await User.findOne(
            { username, mobileno, isactive: 1, isdeleted: 0 },
            { _id: 0, userid: 1 }
        ).lean<Pick<UserDoc, 'userid'>>();
        return d?.userid ?? null;
    },

    findDetailById: async (id: number): Promise<UserDetailRow | null> => {
        const d = await User.findOne({ userid: id, isdeleted: 0 }, DETAIL).lean<DetailDoc>();
        return d ? toDetail(d) : null;
    },

    /** One page of users. `search` matches the username or full name, any case. */
    list: async (q: {
        page: number;
        limit: number;
        search: string;
        rolecode?: Role;
        sortBy: UserSortField;
        sortOrder: 'ASC' | 'DESC';
    }): Promise<{ rows: UserDetailRow[]; total: number }> => {
        const filter: Record<string, unknown> = { isdeleted: 0 };
        if (q.rolecode) filter.rolecode = q.rolecode;
        if (q.search) {
            const pattern = new RegExp(escapeRegex(q.search), 'i');
            filter.$or = [{ username: pattern }, { fullname: pattern }];
        }
        const [docs, total] = await Promise.all([
            User.find(filter, DETAIL)
                .sort({ [q.sortBy]: q.sortOrder === 'ASC' ? 1 : -1, userid: 1 })
                .skip((q.page - 1) * q.limit)
                .limit(q.limit)
                .lean<DetailDoc[]>(),
            User.countDocuments(filter),
        ]);
        return { rows: docs.map(toDetail), total };
    },

    /** Active users who report directly to this one. */
    countActiveReports: (id: number): Promise<number> =>
        User.countDocuments({ reportstouserid: id, isactive: 1, isdeleted: 0 }),

    /**
     * Counts a failed attempt; on reaching `maxFailures` locks the account and resets
     * the count. One update pipeline, so two failures at the same moment both count.
     */
    recordFailedLogin: async (id: number, maxFailures: number, lockMinutes: number) => {
        const reached = { $gte: [{ $add: ['$failedlogins', 1] }, maxFailures] };
        await User.updateOne(
            { userid: id, isdeleted: 0 },
            [
                {
                    $set: {
                        lockeduntil: {
                            $cond: [
                                reached,
                                {
                                    $dateAdd: {
                                        startDate: '$$NOW',
                                        unit: 'minute',
                                        amount: lockMinutes,
                                    },
                                },
                                '$lockeduntil',
                            ],
                        },
                        failedlogins: { $cond: [reached, 0, { $add: ['$failedlogins', 1] }] },
                        updatedat: '$$NOW',
                    },
                },
            ],
            { updatePipeline: true }
        );
    },

    recordSuccessfulLogin: async (id: number) => {
        const now = new Date();
        await User.updateOne(
            { userid: id, isdeleted: 0 },
            { $set: { failedlogins: 0, lockeduntil: null, lastloginat: now, updatedat: now } }
        );
    },

    update: async (id: number, changes: UserChanges, by: number): Promise<UserDetailRow | null> => {
        const d = await User.findOneAndUpdate(
            { userid: id, isdeleted: 0 },
            { $set: { ...changes, updatedby: by, updatedat: new Date() } },
            { returnDocument: 'after', projection: DETAIL, runValidators: true }
        ).lean<DetailDoc>();
        return d ? toDetail(d) : null;
    },

    /** Stores a new password hash and clears any lockout. */
    setPassword: async (id: number, passwordhash: string, mustChange: 0 | 1, by: number) => {
        await User.updateOne(
            { userid: id, isdeleted: 0 },
            {
                $set: {
                    passwordhash,
                    mustchangepassword: mustChange,
                    failedlogins: 0,
                    lockeduntil: null,
                    updatedby: by,
                    updatedat: new Date(),
                },
            }
        );
    },

    create: async (
        createdBy: number,
        data: {
            username: string;
            fullname: string;
            rolecode: Role;
            passwordhash: string;
            mobileno?: string | null;
            reportstouserid?: number | null;
            mustchangepassword?: 0 | 1;
        }
    ): Promise<UserRow> => {
        const userid = await SequenceModel.next('usermaster', createdBy);
        return toRow(
            await User.create({ ...data, userid, createdby: createdBy, updatedby: createdBy })
        );
    },
};
