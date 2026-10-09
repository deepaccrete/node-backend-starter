/**
 * Dynamic route loader — the registration mechanism for this API.
 *
 * It walks `src/routes/` recursively, requires every `.js` file, and mounts any
 * module that exports `{ path, router }` at `${API_PREFIX}${path}`.
 *
 * The consequence, and the point: **creating the file IS the registration**.
 * There is no central registry to edit, so a new endpoint can never be written
 * and then forgotten. Two conventions keep that reliable:
 *
 *   - A route module MUST export exactly `{ path, router }`. Anything else is
 *     reported as a warning at boot rather than skipped in silence — a route
 *     that quietly does not exist is far more expensive to debug than one that
 *     announces itself.
 *   - A file renamed to `*.disabled` is skipped. That is how an unfinished or
 *     temporarily withdrawn route is parked without deleting it.
 *
 * Directory entries are sorted so mount order is identical on every machine;
 * readdir order is filesystem-dependent, and route precedence that depends on it
 * is a bug that only reproduces on someone else's laptop.
 */

const fs = require('fs');
const path = require('path');

const logger = require('../config/winston');

const SKIP_SUFFIXES = ['.disabled', '.test.js', '.spec.js'];
const SKIP_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

const collectRouteFiles = (dir, found = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
    )) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collectRouteFiles(full, found);
            continue;
        }
        if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
        if (entry.name.endsWith('.js')) found.push(full);
    }
    return found;
};

/**
 * @param {import('express').Express} app
 * @param {string} routesDir  absolute path to src/routes
 * @param {string} apiPrefix  e.g. '/api/v1'
 * @returns {string[]} the mounted paths, in mount order
 */
const loadRoutes = (app, routesDir, apiPrefix) => {
    if (!fs.existsSync(routesDir)) {
        logger.warn(`No routes directory at ${routesDir}`);
        return [];
    }

    const mounted = new Map(); // path -> source file, for duplicate detection

    for (const file of collectRouteFiles(routesDir)) {
        const relative = path.relative(routesDir, file);

        let mod;
        try {
            mod = require(file);
        } catch (err) {
            // One broken route file must not take the other fifty with it, but
            // it must be impossible to miss.
            logger.error(`Route file failed to load: ${relative} — ${err.message}`, {
                stack: err.stack,
            });
            continue;
        }

        if (!mod || !mod.path || !mod.router) {
            logger.warn(
                `Skipped ${relative}: a route module must export { path, router }. ` +
                    'Rename it to *.disabled if that is intentional.'
            );
            continue;
        }

        if (mounted.has(mod.path)) {
            // Express would mount both and let the first one win every request
            // the second also matches — a shadowing bug with no error message.
            // Refuse to start instead.
            throw new Error(
                `Duplicate route path "${mod.path}": ${relative} collides with ` +
                    `${mounted.get(mod.path)}. Give one of them a different path.`
            );
        }

        app.use(`${apiPrefix}${mod.path}`, mod.router);
        mounted.set(mod.path, relative);
        // The source file is deliberately not on this line: with fifty routes it
        // doubles the width of the startup output for information that only
        // matters when something is wrong — and the two cases where it matters
        // (a load failure, a duplicate path) both name the file in their own
        // message. `logger.debug` still has it when you want it.
        logger.info(`[32m✓[0m Route: ${apiPrefix}${mod.path}`);
        logger.debug(`  mounted from ${relative}`);
    }

    logger.info(`${mounted.size} route module(s) mounted under ${apiPrefix}`);
    return [...mounted.keys()];
};

module.exports = { loadRoutes };
