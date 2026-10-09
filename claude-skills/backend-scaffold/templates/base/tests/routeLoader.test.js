/**
 * The route loader is the registration mechanism for the whole API, so its
 * contract is worth pinning down: mount the right shape, skip the rest, and
 * refuse to start on a duplicate path rather than silently shadowing a route.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const { loadRoutes } = require('../src/loaders/routeLoader');

/** Records what would have been mounted instead of mounting it. */
const fakeApp = () => {
    const mounts = [];
    return { mounts, use: (mountPath) => mounts.push(mountPath) };
};

const tmpRoutes = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    for (const [name, contents] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contents);
    }
    return dir;
};

const routeModule = (routePath) =>
    `module.exports = { path: '${routePath}', router: (req, res, next) => next() };`;

test('mounts every module exporting { path, router }', () => {
    const dir = tmpRoutes({
        'customers/customers.route.js': routeModule('/customers'),
        'sales/sales.route.js': routeModule('/sales'),
    });
    const app = fakeApp();

    loadRoutes(app, dir, '/api/v1');

    assert.deepEqual(app.mounts.sort(), ['/api/v1/customers', '/api/v1/sales']);
});

test('skips .disabled files', () => {
    const dir = tmpRoutes({
        'a/live.route.js': routeModule('/live'),
        'a/parked.route.js.disabled': routeModule('/parked'),
    });
    const app = fakeApp();

    loadRoutes(app, dir, '/api/v1');

    assert.deepEqual(app.mounts, ['/api/v1/live']);
});

test('skips modules that export the wrong shape without throwing', () => {
    const dir = tmpRoutes({
        'a/helper.js': 'module.exports = { notARoute: true };',
        'a/real.route.js': routeModule('/real'),
    });
    const app = fakeApp();

    loadRoutes(app, dir, '/api/v1');

    assert.deepEqual(app.mounts, ['/api/v1/real']);
});

test('throws on a duplicate path rather than shadowing a route', () => {
    const dir = tmpRoutes({
        'a/first.route.js': routeModule('/things'),
        'b/second.route.js': routeModule('/things'),
    });
    const app = fakeApp();

    assert.throws(() => loadRoutes(app, dir, '/api/v1'), /Duplicate route path/);
});

test('mount order is deterministic', () => {
    const files = {};
    for (const name of ['zeta', 'alpha', 'mid']) {
        files[`${name}/${name}.route.js`] = routeModule(`/${name}`);
    }
    const app = fakeApp();

    loadRoutes(app, tmpRoutes(files), '/api/v1');

    assert.deepEqual(app.mounts, ['/api/v1/alpha', '/api/v1/mid', '/api/v1/zeta']);
});
