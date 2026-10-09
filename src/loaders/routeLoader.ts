/**
 * Dynamic route loader — the registration mechanism for this API.
 *
 * Walks `src/routes/` recursively, imports every route file, and mounts any
 * module whose default export is `{ path, router }` at `${API_PREFIX}${path}`.
 *
 * **Creating the file IS the registration.** There is no central registry.
 *   - A file without that export is warned about at boot, not skipped silently.
 *   - A file renamed to `*.disabled` is skipped: how a route is parked.
 *   - Two modules claiming the same path is a startup error, not silent shadowing.
 *   - Entries are sorted, so mount order is identical on every machine.
 *
 * Route files are `.ts` when running from source (tsx) and `.js` once compiled.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Router } from 'express';

import { logger } from '../config/logger.js';

export interface RouteModule {
    path: string;
    router: Router;
}

/** The part of an Express app the loader uses; tests pass a recorder instead. */
export interface Mountable {
    use: (mountPath: string, router: Router) => unknown;
}

const SKIP_SUFFIXES = [
    '.disabled',
    '.test.ts',
    '.test.js',
    '.spec.ts',
    '.spec.js',
    '.d.ts',
    '.map',
];
const SKIP_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);
const ROUTE_EXTENSIONS = ['.ts', '.js'];

function collectRouteFiles(dir: string, found: string[] = []): string[] {
    const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collectRouteFiles(full, found);
            continue;
        }
        if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
        if (ROUTE_EXTENSIONS.includes(path.extname(entry.name))) found.push(full);
    }
    return found;
}

function isRouteModule(value: unknown): value is RouteModule {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<RouteModule>;
    return typeof candidate.path === 'string' && typeof candidate.router === 'function';
}

/** Returns the mounted paths, in mount order. */
export async function loadRoutes(
    app: Mountable,
    routesDir: string,
    apiPrefix: string
): Promise<string[]> {
    if (!fs.existsSync(routesDir)) {
        logger.warn(`No routes directory at ${routesDir}`);
        return [];
    }

    const mounted = new Map<string, string>(); // path -> source file, for duplicate detection

    for (const file of collectRouteFiles(routesDir)) {
        const relative = path.relative(routesDir, file);

        let mod: { default?: unknown };
        try {
            mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
        } catch (err) {
            // One broken route file must not take the others with it, but it must be impossible to miss.
            const e = err as Error;
            logger.error(`Route file failed to load: ${relative} — ${e.message}`, {
                stack: e.stack,
            });
            continue;
        }

        if (!isRouteModule(mod.default)) {
            logger.warn(
                `Skipped ${relative}: a route module must \`export default { path, router }\`. ` +
                    'Rename it to *.disabled if that is intentional.'
            );
            continue;
        }

        const { path: routePath, router } = mod.default;
        const existing = mounted.get(routePath);
        if (existing) {
            throw new Error(
                `Duplicate route path "${routePath}": ${relative} collides with ${existing}. ` +
                    'Give one of them a different path.'
            );
        }

        app.use(`${apiPrefix}${routePath}`, router);
        mounted.set(routePath, relative);
        logger.info(`Route: ${apiPrefix}${routePath}`);
        logger.debug(`  mounted from ${relative}`);
    }

    logger.info(`${mounted.size} route module(s) mounted under ${apiPrefix}`);
    return [...mounted.keys()];
}
