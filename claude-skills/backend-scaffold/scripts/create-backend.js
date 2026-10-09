#!/usr/bin/env node
/**
 * Scaffold a complete Express + PostgreSQL backend from nothing.
 *
 *   node create-backend.js --name my-api --dir ../my-api [--port 8001] [--db my_db]
 *                          [--desc "..."] [--prefix /api/v1] [--force]
 *
 * Copies templates/base into --dir, substituting {{PLACEHOLDERS}} and restoring
 * the dotfile names that cannot be stored as dotfiles inside a skill package
 * (gitignore → .gitignore, env.example → .env.example, and so on).
 *
 * The script refuses to write into a non-empty directory unless --force is
 * given, so a mistyped path can never overwrite an existing project.
 */

const fs = require('fs');
const path = require('path');

// Files that must land under a different name than they are stored under.
// A leading dot inside a template package tends to be swallowed by packagers,
// editors and `cp -r` globs, so they are stored undotted.
const RENAMES = {
    gitignore: '.gitignore',
    dockerignore: '.dockerignore',
    editorconfig: '.editorconfig',
    nvmrc: '.nvmrc',
    prettierrc: '.prettierrc',
    'env.example': '.env.example',
};

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

/** npm package names: lowercase, digits, dash. */
const isValidName = (name) => /^[a-z0-9][a-z0-9-]{0,49}$/.test(name);

/** Postgres identifiers: lowercase, digits, underscore, not starting with a digit. */
const toDbName = (name) => name.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');

const isEmptyDir = (dir) => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;

const substitute = (text, vars) =>
    text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));

// Binary-ish extensions are copied byte-for-byte; everything else is treated as
// text so placeholders can be substituted.
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.pdf']);

const copyTree = (from, to, vars, written) => {
    fs.mkdirSync(to, { recursive: true });

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const targetName = RENAMES[entry.name] || entry.name;
        const target = path.join(to, targetName);

        if (entry.isDirectory()) {
            copyTree(source, target, vars, written);
            continue;
        }

        if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) {
            fs.copyFileSync(source, target);
        } else {
            fs.writeFileSync(target, substitute(fs.readFileSync(source, 'utf8'), vars), 'utf8');
        }
        written.push(path.relative(to, target) || targetName);
    }
};

const main = () => {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || !args.name || !args.dir) {
        console.log(`
Usage:
  node create-backend.js --name <package-name> --dir <target-dir> [options]

Options:
  --name    npm package name, lowercase-with-dashes        (required)
  --dir     where to create the project                    (required)
  --desc    one-line description for package.json / README
  --port    HTTP port                                      (default 8001)
  --db      PostgreSQL database name                       (default: name with _)
  --prefix  API mount prefix                               (default /api/v1)
  --force   allow writing into a non-empty directory
`);
        process.exit(args.help ? 0 : 1);
    }

    const name = String(args.name);
    if (!isValidName(name)) {
        die(`"${name}" is not a valid package name. Use lowercase letters, digits and dashes.`);
    }

    const targetDir = path.resolve(String(args.dir));
    if (!isEmptyDir(targetDir) && !args.force) {
        die(`${targetDir} is not empty. Pass --force to write into it anyway.`);
    }

    const templateDir = path.join(__dirname, '..', 'templates', 'base');
    if (!fs.existsSync(templateDir)) die(`Template directory missing: ${templateDir}`);

    const port = String(parseInt(args.port, 10) || 8001);
    const vars = {
        PROJECT_NAME: name,
        PROJECT_DESC: String(args.desc || `${name} — Express + PostgreSQL REST API`),
        PORT: port,
        DB_NAME: String(args.db || toDbName(name)),
        API_PREFIX: String(args.prefix || '/api/v1'),
    };

    const written = [];
    copyTree(templateDir, targetDir, vars, written);

    // No .env is written and no value is invented. The developer states their
    // own connection settings once, in one place, and the server refuses to
    // boot until they have -- see src/config/env.js.
    console.log(`\nCreated ${written.length} files in ${targetDir}\n`);
    console.log('This project has NO database tables and NO .env yet -- both are yours to write.');
    console.log('Scaffold complete: structure only. No schema, no features, nothing assumed.\n');
    console.log('Next:');
    console.log(`  cd ${args.dir}`);
    console.log('  npm install');
    console.log('');
    console.log('  cp .env.example .env      # then open .env and fill in every (required) value:');
    console.log('                            #   PORT, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD');
    console.log('');
    console.log('  npm run dev               # boots once .env is complete');
    console.log('');
    console.log('  # To define a schema, add a .sql file to migrations/ (see its README),');
    console.log('  # then:  npm run migrate');
    console.log(`\n  Health check: http://localhost:${port}${vars.API_PREFIX}/health\n`);
};

main();
