/**
 * Translate raw MongoDB / Mongoose errors into messages a user can act on.
 *
 * A duplicate key or a schema validation failure means the CLIENT sent something
 * the database cannot store: a 400, not a 500. Untranslated it leaks the schema
 * (`E11000 duplicate key error collection: tpjp.usermaster index: uq_…`).
 *
 * Register each named unique index as you add it to a schema.
 */

import mongoose from 'mongoose';

/** Unique index name → user-facing message. */
export const INDEX_MESSAGES: Record<string, string> = {
    // @auth-start
    uq_usermaster_username: 'A user with this username already exists.',
    uq_usermaster_mobileno: 'Another user already has this mobile number.',
    uq_distributor_distributorcode: 'A distributor with this code already exists.',
    uq_distributorcontact_mobileno: 'This mobile number is already registered to a distributor.',
    uq_distributorcontact_primary: 'This distributor already has a Primary Contact.',
    // @auth-end
};

const DUPLICATE_KEY = 11000;

interface MongoErrorLike {
    code?: unknown;
    message?: unknown;
    keyPattern?: unknown;
}

const isObject = (err: unknown): err is MongoErrorLike => typeof err === 'object' && err !== null;

/** The index named in an E11000 message ("… index: uq_name dup key: …"). */
const indexOf = (err: MongoErrorLike) =>
    typeof err.message === 'string' ? /index: (\S+)/.exec(err.message)?.[1] : undefined;

/** Null when the error is not a recognisable input error. */
export function friendlyDbError(err: unknown): { message: string; fields: string[] } | null {
    if (err instanceof mongoose.Error.ValidationError) {
        return {
            message: 'One of the values could not be saved.',
            fields: Object.keys(err.errors),
        };
    }
    if (err instanceof mongoose.Error.CastError) {
        return {
            message: 'One of the values is not in the format this field expects.',
            fields: [err.path],
        };
    }
    if (isObject(err) && err.code === DUPLICATE_KEY) {
        const index = indexOf(err);
        return {
            message:
                (index && INDEX_MESSAGES[index]) ?? 'A record with these details already exists.',
            fields: isObject(err.keyPattern) ? Object.keys(err.keyPattern) : [],
        };
    }
    return null;
}

export const isDuplicateKey = (err: unknown, index?: string) =>
    isObject(err) && err.code === DUPLICATE_KEY && (!index || indexOf(err) === index);
