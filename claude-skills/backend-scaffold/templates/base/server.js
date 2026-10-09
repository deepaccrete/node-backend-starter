/**
 * Process entry point.
 *
 * Everything that is *the HTTP app* lives in src/app.js; this file owns only the
 * things a process owns — reading config, opening the listener, and closing it
 * down. Keeping them apart is what lets tests `require('./src/app')` and drive
 * the API without binding a port or leaking a live server between test files.
 */

require('dotenv').config();

const env = require('./src/config/env');
const logger = require('./src/config/winston');
const { testConnection, pool } = require('./src/config/database');
const { printBanner } = require('./src/utils/banner');
const app = require('./src/app');

let server;

const start = async () => {
    const db = await testConnection();
    if (!db.ok) {
        // In production an API that cannot reach its database is not degraded,
        // it is broken: every request would 500. Fail the deploy instead of
        // serving errors. In development the server stays up so you can work on
        // routes with Postgres not yet running.
        if (env.isProduction) {
            logger.error('Cannot start: database unavailable');
            process.exit(1);
        }
        logger.warn('Database unavailable — starting anyway (NODE_ENV is not production)');
    }

    server = app.listen(env.PORT, env.HOST, () => {
        // One structured line for the log files, which the banner cannot serve:
        // it is drawn with box characters straight to stdout.
        logger.info(`${env.APP_NAME} listening`, {
            port: env.PORT,
            host: env.HOST,
            env: env.NODE_ENV,
        });

        printBanner({
            name: env.APP_NAME,
            env: env.NODE_ENV,
            port: env.PORT,
            host: env.HOST,
            apiPrefix: env.API_PREFIX,
            database: db.ok ? db.database : 'unavailable',
            routeCount: app.locals.mountedRoutes?.length ?? 0,
        });
    });
};

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then close the pool. Without the pool close, `docker compose down` leaves
 * Postgres holding connections open until they time out.
 */
const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);

    const forced = setTimeout(() => {
        logger.error('Shutdown timed out after 10s — forcing exit');
        process.exit(1);
    }, 10_000).unref();

    try {
        if (server) await new Promise((resolve) => server.close(resolve));
        await pool.end();
        clearTimeout(forced);
        logger.info('Shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error(`Shutdown error: ${err.message}`);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// An unhandled rejection leaves the process in an unknown state. Log it loudly
// and let the orchestrator restart a clean one rather than serving from it.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: reason?.message || String(reason) });
    shutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
});

start();
