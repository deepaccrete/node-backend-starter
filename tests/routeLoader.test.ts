/**
 * The route loader is the registration mechanism for the whole API: mount the
 * right shape, skip the rest, and refuse to start on a duplicate path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Router } from 'express';
import { describe, expect, it } from 'vitest';

import { loadRoutes, type Mountable } from '../src/loaders/routeLoader.js';

function recorder(): Mountable & { mounts: string[] } {
    const mounts: string[] = [];
    return {
        mounts,
        use: (mountPath: string, _router: Router) => mounts.push(mountPath),
    };
}

function tmpRoutes(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    for (const [name, contents] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contents);
    }
    return dir;
}

const routeModule = (routePath: string) =>
    `export default { path: '${routePath}', router: function (req, res, next) { next(); } };`;

describe('loadRoutes', () => {
    it('mounts every module exporting { path, router }', async () => {
        const app = recorder();
        await loadRoutes(
            app,
            tmpRoutes({
                'customers/customers.route.js': routeModule('/customers'),
                'sales/sales.route.js': routeModule('/sales'),
            }),
            '/api/v1'
        );
        expect(app.mounts.sort()).toEqual(['/api/v1/customers', '/api/v1/sales']);
    });

    it('skips .disabled files', async () => {
        const app = recorder();
        await loadRoutes(
            app,
            tmpRoutes({
                'a/live.route.js': routeModule('/live'),
                'a/parked.route.js.disabled': routeModule('/parked'),
            }),
            '/api/v1'
        );
        expect(app.mounts).toEqual(['/api/v1/live']);
    });

    it('skips modules with the wrong shape without throwing', async () => {
        const app = recorder();
        await loadRoutes(
            app,
            tmpRoutes({
                'a/helper.js': 'export default { notARoute: true };',
                'a/real.route.js': routeModule('/real'),
            }),
            '/api/v1'
        );
        expect(app.mounts).toEqual(['/api/v1/real']);
    });

    it('throws on a duplicate path rather than shadowing a route', async () => {
        const dir = tmpRoutes({
            'a/first.route.js': routeModule('/things'),
            'b/second.route.js': routeModule('/things'),
        });
        await expect(loadRoutes(recorder(), dir, '/api/v1')).rejects.toThrow(
            /Duplicate route path/
        );
    });

    it('mounts in a deterministic order', async () => {
        const files: Record<string, string> = {};
        for (const name of ['zeta', 'alpha', 'mid'])
            files[`${name}/${name}.route.js`] = routeModule(`/${name}`);
        const app = recorder();
        await loadRoutes(app, tmpRoutes(files), '/api/v1');
        expect(app.mounts).toEqual(['/api/v1/alpha', '/api/v1/mid', '/api/v1/zeta']);
    });
});
