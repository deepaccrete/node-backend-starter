/**
 * The single exit for every error in the app. Must be the LAST `app.use`, and
 * must keep four arguments — that arity is how Express recognises an error
 * handler.
 *
 * The rule it enforces: **4xx messages are ours, 5xx messages are not.**
 *
 * A 4xx message was written by the route that raised it, for the user
 * ("Current password is incorrect"). A 5xx message is whatever a driver, a
 * library or a remote service happened to say. Those get replaced with something
 * generic, because they are useless to the user and describe our internals. A
 * real example this prevents: a failed password-reset email surfacing as
 * "Invalid login: 535-5.7.8 Username and Password not accepted … gsmtp" — our
 * mail provider talking to us about our own credentials, shown to a customer.
 *
 * The real message and stack always reach the logs. That is where they belong.
 */

const env = require('../config/env');
const logger = require('../config/winston');
const { friendlyDbError } = require('../utils/pgError');

// `next` is unused but MUST stay: Express identifies an error handler by its
// four-argument arity, and dropping it turns this into ordinary middleware that
// never runs.
const errorHandler = (err, req, res, next) => {
    // A constraint violation means the client sent a value the database cannot
    // store: bad input, so 400 with a message naming the fields at fault. Routes
    // validate their own inputs; this is the backstop for values computed in SQL
    // (running totals, generated numbers) and for paths that did not check.
    const friendly = friendlyDbError(err);
    if (friendly) {
        logger.warn('Rejected by database constraint', {
            requestId: req.id,
            path: req.originalUrl,
            code: err.code,
            constraint: err.constraint,
        });
        return res.status(400).json({
            success: false,
            message: friendly.message,
            ...(friendly.fields.length ? { fields: friendly.fields } : {}),
        });
    }

    // Bodies that fail to parse arrive here as SyntaxError from express.json.
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ success: false, message: 'Request body is not valid JSON.' });
    }

    if (err?.message === 'Not allowed by CORS') {
        return res.status(403).json({ success: false, message: 'Origin not allowed.' });
    }

    const status = err.statusCode || err.status || 500;

    // Expected 4xx are noise at error level; unexpected 5xx are the whole point
    // of the log.
    const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log(`${status} ${req.method} ${req.originalUrl} — ${err.message}`, {
        requestId: req.id,
        userId: req.userId,
        durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
        ...(status >= 500 ? { stack: err.stack } : {}),
    });

    const message =
        status < 500
            ? err.message || 'Request could not be completed'
            : 'Something went wrong at our end. Please try again in a moment.';

    res.status(status).json({
        success: false,
        message,
        ...(err.errors ? { errors: err.errors } : {}),
        requestId: req.id,
        // The underlying message and stack are development-only.
        ...(!env.isProduction && status >= 500 ? { detail: err.message, stack: err.stack } : {}),
    });
};

module.exports = errorHandler;
