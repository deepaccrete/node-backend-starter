#!/usr/bin/env node
/**
 * Generate a route → controller → model triplet (plus a migration) for one
 * resource, in the folder-per-domain layout this codebase uses.
 *
 *   node create-module.js --project ../my-api --domain warehouse --resource warehouse
 *                         [--path /warehouses] [--table warehousemaster]
 *                         [--label "Warehouse"] [--prefix WH] [--no-migration]
 *
 * Writes:
 *   src/routes/<domain>/<resource>.route.js
 *   src/controllers/<domain>/<resource>.controller.js
 *   src/models/<domain>/<resource>.model.js
 *   migrations/<YYYYMMDD>_create_<table>.sql
 *
 * Nothing else has to change: the route loader discovers the new route file at
 * the next restart because it exports { path, router }.
 *
 * The generated files are a STARTING POINT with working CRUD. Replace the sample
 * columns with the resource's real ones — in the migration, in the model's
 * SELECT/INSERT/UPDATE lists, and in the route's validators, which should mirror
 * the column widths so an over-long paste is a 400 rather than a database error.
 */

const fs = require('fs');
const path = require('path');

const parseArgs = (argv) => {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            args[key] = next;
            i++;
        } else {
            args[key] = true;
        }
    }
    return args;
};

const die = (message) => {
    console.error(`\nError: ${message}\n`);
    process.exit(1);
};

const pascal = (s) =>
    s
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

const titleCase = (s) =>
    s
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

/**
 * A stable per-resource advisory-lock namespace, derived from the table name.
 * Two resources must not share one, or creating a record in A would block
 * creating a record in B. Derivation keeps it deterministic without a registry.
 */
const lockClass = (table) => {
    let hash = 0;
    for (const ch of table) hash = (hash * 31 + ch.charCodeAt(0)) % 2_000_000_000;
    return 1000 + (hash % 1_000_000);
};

/**
 * Normalise `--path` into a mount path.
 *
 * Git Bash on Windows rewrites an argument that looks like a Unix absolute path
 * into a Windows one, so `--path /warehouses` arrives as
 * `C:/Program Files/Git/warehouses`. That is a shell behaviour, not a mistake by
 * the caller, so detect it and say what to do rather than writing a route that
 * mounts at a filesystem path. Passing the value without a leading slash
 * (`--path warehouses`) sidesteps the conversion entirely and is accepted here.
 */
const normalizeRoutePath = (raw, resource) => {
    if (raw === undefined || raw === true) return `/${resource}s`;

    const value = String(raw).replace(/\\/g, '/');

    if (/^[A-Za-z]:\//.test(value) || /\/(Program Files|usr|mingw64)\//i.test(value)) {
        die(
            `--path was rewritten by the shell into a filesystem path ("${value}").\n` +
                '  This is Git Bash MSYS path conversion. Either drop the leading slash\n' +
                '  (--path warehouses) or prefix the command with MSYS_NO_PATHCONV=1.'
        );
    }

    const trimmed = value.replace(/\/+$/, '');
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const today = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

const substitute = (text, vars) =>
    text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match));

const writeFile = (target, contents, written) => {
    if (fs.existsSync(target)) {
        // Overwriting a controller someone has already filled in would destroy
        // work with no undo. Skip and report instead.
        console.log(`  skipped (exists)  ${target}`);
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
    written.push(target);
    console.log(`  created           ${target}`);
};

const main = () => {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || !args.domain || !args.resource) {
        console.log(`
Usage:
  node create-module.js --domain <domain> --resource <resource> [options]

Options:
  --project        project root                     (default: cwd)
  --domain         folder name under routes/controllers/models   (required)
  --resource       file basename and column prefix               (required)
  --path           URL path to mount at             (default: /<resource>s)
  --table          database table                   (default: <resource>master)
  --label          human label used in messages     (default: Title Case resource)
  --prefix         document-code prefix             (default: first 2 letters, uppercased)
  --no-migration   skip generating the migration file

Example:
  node create-module.js --project ../my-api --domain purchase --resource supplier \\
                        --path /suppliers --table suppliermaster --prefix SUP
`);
        process.exit(args.help ? 0 : 1);
    }

    const projectRoot = path.resolve(String(args.project || process.cwd()));
    if (!fs.existsSync(path.join(projectRoot, 'src', 'routes'))) {
        die(`${projectRoot} does not look like a project of this shape (no src/routes). Pass --project.`);
    }

    const domain = String(args.domain).toLowerCase();
    const resource = String(args.resource).toLowerCase();

    if (!/^[a-z][a-z0-9]*$/.test(resource)) {
        die(
            `--resource must be a single lowercase word with no underscores ("${resource}"). ` +
                'Column names in this database follow that rule, and the generated SQL builds ' +
                'them as <resource>name / <resource>code.'
        );
    }

    const table = String(args.table || `${resource}master`).toLowerCase();
    const routePath = normalizeRoutePath(args.path, resource);

    const vars = {
        domain,
        resource,
        table,
        ROUTE_PATH: routePath,
        API_PREFIX: '/api/v1',
        ResourcePascal: pascal(resource),
        ResourceLabel: String(args.label || titleCase(resource)),
        resourceLower: String(args.label || titleCase(resource)).toLowerCase(),
        CODE_PREFIX: String(args.prefix || resource.slice(0, 2)).toUpperCase(),
        LOCK_CLASS: lockClass(table),
        DATE: today(),
    };

    const templateDir = path.join(__dirname, '..', 'templates', 'module');
    const read = (file) => fs.readFileSync(path.join(templateDir, file), 'utf8');

    const written = [];
    console.log('');

    writeFile(
        path.join(projectRoot, 'src', 'routes', domain, `${resource}.route.js`),
        substitute(read('route.js.tmpl'), vars),
        written
    );
    writeFile(
        path.join(projectRoot, 'src', 'controllers', domain, `${resource}.controller.js`),
        substitute(read('controller.js.tmpl'), vars),
        written
    );
    writeFile(
        path.join(projectRoot, 'src', 'models', domain, `${resource}.model.js`),
        substitute(read('model.js.tmpl'), vars),
        written
    );

    if (!args['no-migration']) {
        writeFile(
            path.join(projectRoot, 'migrations', `${vars.DATE}_create_${table}.sql`),
            substitute(read('migration.sql.tmpl'), vars),
            written
        );
    }

    console.log(`\n${written.length} file(s) written.`);
    console.log(`\nThe route mounts itself at /api/v1${routePath} on the next restart.`);
    console.log('\nBefore using it:');
    console.log(`  1. Replace the sample columns in the migration with ${vars.ResourceLabel}'s real ones.`);
    console.log('  2. Mirror those columns in the model SELECT / INSERT / UPDATE lists.');
    console.log('  3. Match the validators in the route to the column types and widths.');
    console.log('  4. npm run migrate && npm run dev\n');
};

main();
