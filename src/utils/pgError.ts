/**
 * Translate raw PostgreSQL errors into messages a user can act on.
 *
 * A constraint violation means the CLIENT sent something the database cannot
 * store — a 400, not a 500. Untranslated it leaks the schema
 * (`duplicate key value violates unique constraint "uq_…"`).
 *
 * Register each named constraint as you add it in a migration.
 */

/** Constraint / index name → user-facing message. */
export const CONSTRAINT_MESSAGES: Record<string, string> = {
    uq_usermaster_username: 'A user with this username already exists.',
    ck_usermaster_rolecode: 'The role is not one of ADMIN, GM, ZM, RM or ASM.',
};

/** SQLSTATEs that mean "the value the client sent cannot be stored". */
export const INPUT_ERROR_CODES = new Set([
    '22001', // value too long for column
    '22003', // numeric value out of range
    '22007', // invalid datetime format
    '22P02', // invalid text representation
    '23502', // not null violation
    '23503', // foreign key violation
    '23505', // unique violation
    '23514', // check violation
]);

const GENERIC_BY_CODE: Record<string, string> = {
    '22001': 'One of the values is too long for the field it was entered in.',
    '22003': 'A number in this request is outside the range this field allows.',
    '22007': 'A date in this request is not in a format we recognise.',
    '22P02': 'One of the values is not in the format this field expects.',
    '23502': 'A required field was left empty.',
    '23503': 'This references a record that does not exist, or that is still in use elsewhere.',
    '23505': 'A record with these details already exists.',
    '23514': 'One of the values is not allowed for this field.',
};

interface PgErrorLike {
    code?: unknown;
    constraint?: unknown;
    column?: unknown;
}

const isPgErrorLike = (err: unknown): err is PgErrorLike => typeof err === 'object' && err !== null;

/** Null when the error is not a recognisable input error. */
export function friendlyDbError(err: unknown): { message: string; fields: string[] } | null {
    if (!isPgErrorLike(err) || typeof err.code !== 'string' || !INPUT_ERROR_CODES.has(err.code))
        return null;
    const specific =
        typeof err.constraint === 'string' ? CONSTRAINT_MESSAGES[err.constraint] : undefined;
    return {
        message: specific ?? GENERIC_BY_CODE[err.code] ?? 'One of the values could not be saved.',
        fields: typeof err.column === 'string' ? [err.column] : [],
    };
}

export const isUniqueViolation = (err: unknown, constraint?: string) =>
    isPgErrorLike(err) && err.code === '23505' && (!constraint || err.constraint === constraint);
