/**
 * Process entry point.
 *
 * Everything that is *the HTTP app* lives in src/app.ts; this file owns only what
 * a process owns — reading config, opening the listener, and closing it down.
 */

import 'dotenv/config';

import type { Server } from 'node:http';

import { createApp } from './src/app.js';
import { pool, testConnection } from './src/config/database.js';
import { env } from './src/config/env.js';
import { logger } from './src/config/logger.js';
import { printBanner } from './src/utils/banner.js';

let server: Server | undefined;

async function start(): Promise<void> {
    const db = await testConnection();
    if (!db.ok) {
        // In production an API that cannot reach its database is broken, not
        // degraded: fail the deploy. In development stay up so routes can be worked on.
        if (env.isProduction) {
            logger.error('Cannot start: database unavailable');
            process.exit(1);
        }
        logger.warn('Database unavailable — starting anyway (NODE_ENV is not production)');
    }

    const app = await createApp();
    const routes = app.locals.mountedRoutes as string[];

    server = app.listen(env.PORT, env.HOST, () => {
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
            routeCount: routes.length,
        });
    });
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then close the pool so the database is not left holding connections.
 */
async function shutdown(signal: string): Promise<void> {
    logger.info(`${signal} received — shutting down`);
    const forced = setTimeout(() => {
        logger.error('Shutdown timed out after 10s — forcing exit');
        process.exit(1);
    }, 10_000).unref();

    try {
        const running = server;
        if (running)
            await new Promise<void>((resolve) =>
                running.close(() => {
                    resolve();
                })
            );
        await pool.end();
        clearTimeout(forced);
        logger.info('Shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error(`Shutdown error: ${(err as Error).message}`);
        process.exit(1);
    }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// An unhandled rejection leaves the process in an unknown state: log it and let
// the orchestrator restart a clean one.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { message: err.message, stack: err.stack });
    void shutdown('uncaughtException');
});

start().catch((err: unknown) => {
    logger.error('Startup failed', { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
