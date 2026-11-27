/**
 * The ONE MongoDB connection for this process (Mongoose's default connection).
 *
 * Models import `mongoose` from HERE, not from the package, so the settings below
 * are applied before any model is compiled. Do not call `mongoose.createConnection`
 * elsewhere: a second connection doubles the pool and its models miss these settings.
 */

import mongoose from 'mongoose';

import { env } from './env.js';
import { logger } from './logger.js';

// Fail a query at once while disconnected instead of queueing it for 10 seconds:
// a request should get its 503/500 now, not hang.
mongoose.set('bufferCommands', false);
// Reject query filters on fields the schema does not declare (a typo would match everything).
mongoose.set('strictQuery', true);
// Nothing touches the database when a model is compiled (that happens at import,
// before the connection exists). Indexes are built by `connectDatabase` instead.
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

export { mongoose };

mongoose.connection.on('disconnected', () => {
    logger.warn('Database disconnected');
});
mongoose.connection.on('reconnected', () => {
    logger.info('Database reconnected');
});
// An error after the first connect (network blip, server restart) is emitted here.
mongoose.connection.on('error', (err: Error) => {
    logger.error('Database error', { message: err.message });
});

/**
 * Open the connection, then build every index the schemas declare. Unique indexes
 * are what reject duplicates, so they must exist before the first write.
 * `createIndexes` only adds: it never drops an index that is no longer declared.
 * The URI holds credentials: it is never logged.
 */
export async function connectDatabase(): Promise<void> {
    await mongoose.connect(env.db.uri, { serverSelectionTimeoutMS: 5_000 });
    await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}

export async function disconnectDatabase(): Promise<void> {
    await mongoose.disconnect();
}

/** Round-trip to the server. Throws when it cannot be reached. */
export async function ping(): Promise<void> {
    const db = mongoose.connection.db;
    if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) {
        throw new Error('Database not connected');
    }
    await db.admin().ping();
}

/** Connect once; returns the database NAME so the banner shows which one was reached. */
export async function testConnection(): Promise<
    { ok: true; database: string } | { ok: false; error: string }
> {
    try {
        await connectDatabase();
        await ping();
        const database = mongoose.connection.name;
        logger.info(`Database connected: ${database}`);
        return { ok: true, database };
    } catch (err) {
        const message = (err as Error).message;
        logger.error(`Database connection failed: ${message}`);
        return { ok: false, error: message };
    }
}
