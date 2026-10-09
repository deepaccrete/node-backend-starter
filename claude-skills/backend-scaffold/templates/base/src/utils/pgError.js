/**
 * Translate raw PostgreSQL errors into messages a user can act on.
 *
 * A constraint violation is the database telling you the CLIENT sent something
 * it cannot store — that is a 400, not a 500. Left untranslated it surfaces as
 * `duplicate key value violates unique constraint "uq_customer_org_email"`,
 * which tells the user nothing and leaks the schema.
 *
 * Register each constraint as you add it. The constraint NAME is the key, so
 * name constraints deliberately in migrations (`uq_<table>_<cols>`,
 * `fk_<table>_<ref>`) rather than letting Postgres autogenerate them.
 */

/** Constraint / index name → user-facing message. */
const CONSTRAINT_MESSAGES = {
    // Example — replace with this project's own constraints:
    // uq_customer_org_email: 'A customer with this email already exists in this organisation.',
};

/**
 * Postgres SQLSTATEs that mean "the value the client sent cannot be stored".
 * These become 400s; everything else stays a 500.
 */
const INPUT_ERROR_CODES = new Set([
    '22001', // string_data_right_truncation — value too long for column
    '22003', // numeric_value_out_of_range
    '22007', // invalid_datetime_format
    '22P02', // invalid_text_representation — e.g. 'abc' sent for an integer column
    '23502', // not_null_violation
    '23503', // foreign_key_violation
    '23505', // unique_violation
    '23514', // check_violation
]);

const GENERIC_BY_CODE = {
    '22001': 'One of the values is too long for the field it was entered in.',
    '22003': 'A number in this request is outside the range this field allows.',
    '22007': 'A date in this request is not in a format we recognise.',
    '22P02': 'One of the values is not in the format this field expects.',
    '23502': 'A required field was left empty.',
    '23503': 'This references a record that does not exist, or that is still in use elsewhere.',
    '23505': 'A record with these details already exists.',
    '23514': 'One of the values is not allowed for this field.',
};

/**
 * @param {Error & {code?: string, constraint?: string, column?: string}} err
 * @returns {{ message: string, fields: string[] } | null}
 *          null when the error is not a recognisable input error — the caller
 *          should then fall through to `next(err)`.
 */
const friendlyDbError = (err) => {
    if (!err || !INPUT_ERROR_CODES.has(err.code)) return null;

    const specific = err.constraint && CONSTRAINT_MESSAGES[err.constraint];
    const fields = [err.column].filter(Boolean);

    return {
        message: specific || GENERIC_BY_CODE[err.code] || 'One of the values could not be saved.',
        fields,
    };
};

const isUniqueViolation = (err, constraint) =>
    err?.code === '23505' && (!constraint || err.constraint === constraint);

module.exports = { CONSTRAINT_MESSAGES, INPUT_ERROR_CODES, friendlyDbError, isUniqueViolation };
