/**
 * Turn this backend into a new project.
 *
 *   pnpm init-project                      asks each question
 *   pnpm init-project --slug inventory --title "Inventory API" \
 *       --description "Stock and orders API." --port 8002 --db inventory \
 *       --auth yes --roles ADMIN,MANAGER,USER --yes
 *
 * Run it once, on a fresh copy, before writing features. It:
 *   - writes the project identity to src/config/project.ts
 *   - with login: writes the roles to src/config/permissions.ts (ADMIN always
 *     exists and holds every permission)
 *   - without login: deletes the login files and every block between
 *     `@auth-start` / `@auth-end` markers, and drops the login packages
 *   - renames the package and the CI database, sets the port in Docker files
 *   - regenerates openapi.json
 *
 * It refuses to remove login a second time once the markers are gone.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'logs', 'coverage', 'uploads']);
const TEXT_EXT = new Set(['.ts', '.js', '.json', '.md', '.yml', '.yaml', '.sql', '.example']);
const MARKER = /^\s*(?:\/\/|#|<!--)\s*@auth-(start|end)\b.*$/;

const AUTH_FILES = [
    'src/routes/auth',
    'src/controllers/auth',
    'src/models/auth',
    'src/services/auth.service.ts',
    'src/services/token.service.ts',
    'src/middleware/authenticate.ts',
    'src/middleware/requirePermission.ts',
    'src/config/permissions.ts',
    'migrations/20261008_auth_tables.sql',
    'scripts/create-admin.ts',
    'tests/auth.test.ts',
];
const AUTH_DEPS = ['bcryptjs', 'jsonwebtoken', 'cookie-parser'];
const AUTH_DEV_DEPS = ['@types/cookie-parser', '@types/jsonwebtoken'];

interface Answers {
    slug: string;
    title: string;
    description: string;
    port: number;
    db: string;
    auth: boolean;
    roles: string[];
}

// ─── Input ────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
    options: {
        slug: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        port: { type: 'string' },
        db: { type: 'string' },
        auth: { type: 'string' },
        roles: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'skip-install': { type: 'boolean', default: false },
    },
});

const rules = {
    slug: (v: string) =>
        /^[a-z][a-z0-9]{1,19}$/.test(v)
            ? null
            : '2–20 lowercase letters or digits, starting with a letter',
    port: (v: string) =>
        /^\d+$/.test(v) && +v >= 1024 && +v <= 65535 ? null : 'a number from 1024 to 65535',
    db: (v: string) =>
        /^[a-z][a-z0-9_]{0,39}$/.test(v)
            ? null
            : 'lowercase letters, digits or _, starting with a letter',
    auth: (v: string) => (/^(y|yes|n|no)$/i.test(v) ? null : 'yes or no'),
    roles: (v: string) => {
        const list = splitRoles(v);
        if (!list.length) return 'at least one role';
        const bad = list.find((r) => !/^[A-Z][A-Z0-9_]{0,29}$/.test(r));
        return bad ? `"${bad}": use CAPITALS, digits or _ (max 30)` : null;
    },
    text: (v: string) => (v.trim() ? null : 'cannot be empty'),
};

function splitRoles(v: string): string[] {
    const list = v
        .split(',')
        .map((r) => r.trim().toUpperCase())
        .filter(Boolean);
    return [...new Set(['ADMIN', ...list])];
}

async function ask(): Promise<Answers> {
    const rl = flags.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
    const get = async (
        key: keyof typeof flags,
        question: string,
        fallback: string,
        check: (v: string) => string | null
    ): Promise<string> => {
        const given = flags[key];
        if (typeof given === 'string') {
            const problem = check(given);
            if (problem) throw new Error(`--${key}: ${problem}`);
            return given;
        }
        if (!rl) {
            const problem = check(fallback);
            if (problem) throw new Error(`--${key} is required (${problem})`);
            return fallback;
        }
        for (;;) {
            const raw = (
                await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)
            ).trim();
            const value = raw || fallback;
            const problem = check(value);
            if (!problem) return value;
            console.log(`  ✖ ${problem}`);
        }
    };

    try {
        const slug = await get(
            'slug',
            'Project id (short, lowercase, e.g. inventory)',
            '',
            rules.slug
        );
        const title = await get('title', 'Display title', `${slug.toUpperCase()} API`, rules.text);
        const description = await get(
            'description',
            'One-line description',
            `${title}.`,
            rules.text
        );
        const port = Number(await get('port', 'API port', '8001', rules.port));
        const db = await get('db', 'Database name', slug, rules.db);
        const auth = /^y/i.test(
            await get('auth', 'Include username + password login? (yes/no)', 'yes', rules.auth)
        );
        const roles = auth
            ? splitRoles(
                  await get(
                      'roles',
                      'Roles, comma-separated (ADMIN is always added)',
                      'ADMIN,USER',
                      rules.roles
                  )
              )
            : [];
        return { slug, title, description, port, db, auth, roles };
    } finally {
        rl?.close();
    }
}

// ─── File helpers ─────────────────────────────────────────────────────

const abs = (p: string) => path.join(ROOT, p);
const read = (p: string) => fs.readFileSync(abs(p), 'utf8');
const write = (p: string, text: string) => {
    fs.writeFileSync(abs(p), text);
};

function edit(p: string, change: (text: string) => string) {
    if (!fs.existsSync(abs(p))) return;
    const before = read(p);
    const after = change(before);
    if (after !== before) write(p, after);
}

function textFiles(dir = ''): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(abs(dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...textFiles(rel));
        } else if (TEXT_EXT.has(path.extname(entry.name)) && rel !== 'scripts/init-project.ts') {
            out.push(rel);
        }
    }
    return out;
}

/** Keep (only drop the marker lines) or remove each `@auth-start … @auth-end` block. */
function processMarkers(keepAuth: boolean): number {
    let blocks = 0;
    for (const file of textFiles()) {
        const lines = read(file).split('\n');
        if (!lines.some((l) => MARKER.test(l))) continue;
        const out: string[] = [];
        let inside = false;
        for (const [i, line] of lines.entries()) {
            const m = MARKER.exec(line);
            if (m) {
                const opening = m[1] === 'start';
                if (opening === inside)
                    throw new Error(`${file}:${i + 1}: unbalanced @auth marker`);
                inside = opening;
                if (opening) blocks++;
                continue;
            }
            if (keepAuth || !inside) out.push(line);
        }
        if (inside) throw new Error(`${file}: @auth-start without @auth-end`);
        write(file, out.join('\n').replace(/\n{3,}/g, '\n\n'));
    }
    return blocks;
}

// ─── Steps ────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function writeProject(a: Answers) {
    const text = read('src/config/project.ts').replace(
        /export const project = \{[\s\S]*?\} as const;/,
        [
            'export const project = {',
            '    /** Short lowercase id: cookie prefix, database names in CI and tests. */',
            `    slug: ${q(a.slug)},`,
            '    /** Package and service name: default APP_NAME, log lines. */',
            `    name: ${q(`${a.slug}-api`)},`,
            '    /** Shown as the OpenAPI title. */',
            `    title: ${q(a.title)},`,
            '    /** One sentence for the OpenAPI document. */',
            `    description: ${q(a.description)},`,
            '} as const;',
        ].join('\n')
    );
    write('src/config/project.ts', text);
}

function writeRoles(roles: string[]) {
    const lines = [
        '/**',
        ' * Roles and permissions. The backend owns this table: the login response sends',
        " * the signed-in user's permission list, and the frontend only checks that list.",
        ' *',
        ' * Code checks PERMISSIONS, never role names, so a role gains or loses a',
        ' * capability by editing this table only. ADMIN holds every permission.',
        ' */',
        '',
        `export const ROLES = [${roles.map(q).join(', ')}] as const;`,
        'export type Role = (typeof ROLES)[number];',
        '',
        "export const PERMISSIONS = ['users:manage'] as const;",
        'export type Permission = (typeof PERMISSIONS)[number];',
        '',
        'export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {',
        ...roles.map((r) => `    ${r}: ${r === 'ADMIN' ? 'PERMISSIONS' : '[]'},`),
        '};',
        '',
        'export function isRole(value: unknown): value is Role {',
        '    return ROLES.some((role) => role === value);',
        '}',
        '',
        'export function permissionsFor(role: Role): Permission[] {',
        '    return [...ROLE_PERMISSIONS[role]];',
        '}',
        '',
    ];
    write('src/config/permissions.ts', lines.join('\n'));
}

function removeAuth() {
    for (const p of AUTH_FILES) fs.rmSync(abs(p), { recursive: true, force: true });
    for (const dir of ['src/controllers', 'src/models', 'src/services']) {
        if (fs.existsSync(abs(dir)) && fs.readdirSync(abs(dir)).length === 0)
            write(`${dir}/.gitkeep`, '');
    }
}

function updatePackage(a: Answers) {
    const pkg = JSON.parse(read('package.json')) as {
        name: string;
        description: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
    };
    pkg.name = `${a.slug}-api`;
    pkg.description = a.description;
    if (!a.auth) {
        for (const d of AUTH_DEPS) Reflect.deleteProperty(pkg.dependencies, d);
        for (const d of AUTH_DEV_DEPS) Reflect.deleteProperty(pkg.devDependencies, d);
        Reflect.deleteProperty(pkg.scripts, 'create-admin');
    }
    write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}

function updateDelivery(a: Answers) {
    edit('.github/workflows/ci.yml', (t) =>
        t
            .replace(/^(\s*)PORT: .*$/m, `$1PORT: ${a.port}`)
            .replace(/^(\s*)(DB_NAME|POSTGRES_DB): .*$/gm, `$1$2: ${a.db}_ci`)
            .replace(
                /^(\s*)(DB_USER|DB_PASSWORD|POSTGRES_USER|POSTGRES_PASSWORD): .*$/gm,
                `$1$2: ${a.db}`
            )
            .replace(/pg_isready -U \S+/g, `pg_isready -U ${a.db}`)
    );
    edit('docker-compose.yml', (t) => t.replace(/\$\{PORT:-\d+\}/g, `\${PORT:-${a.port}}`));
    edit('Dockerfile', (t) =>
        t.replace(/^EXPOSE \d+$/m, `EXPOSE ${a.port}`).replace(/PORT\|\|\d+/g, `PORT||${a.port}`)
    );
    edit('vitest.config.ts', (t) => t.replace(/PORT: '\d+'/, `PORT: '${a.port}'`));
    edit('README.md', (t) =>
        t
            .replace(/^# .*$/m, `# ${a.title}`)
            .replace(
                /<!-- @intro-start -->[\s\S]*?<!-- @intro-end -->/,
                `<!-- @intro-start -->\n${a.description}\n<!-- @intro-end -->`
            )
            .replace(/localhost:\d{4,5}/g, `localhost:${a.port}`)
    );
}

function run(cmd: string, env: NodeJS.ProcessEnv = {}) {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
}

// ─── Main ─────────────────────────────────────────────────────────────

const answers = await ask();
const hasAuthFiles = fs.existsSync(abs('src/routes/auth'));

if (answers.auth && !hasAuthFiles) {
    throw new Error(
        'Login was already removed from this copy; start again from a fresh copy to include it.'
    );
}

console.log('\nSetting up the project…');
writeProject(answers);
const blocks = processMarkers(answers.auth);
if (!answers.auth && hasAuthFiles && blocks === 0) {
    throw new Error(
        'No @auth markers found: login code was already kept, so it cannot be removed automatically.'
    );
}
if (answers.auth) writeRoles(answers.roles);
else removeAuth();
updatePackage(answers);
updateDelivery(answers);
console.log(`  ✔ files updated (${blocks} login block(s) ${answers.auth ? 'kept' : 'removed'})`);

if (!answers.auth && !flags['skip-install']) run('pnpm install');
run('pnpm exec prettier --write . --log-level warn');
// The contract needs a valid configuration to build the app; these values are
// throwaway and only exist for this one command.
run('pnpm gen:openapi', {
    PORT: String(answers.port),
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: answers.db,
    DB_USER: answers.db,
    DB_PASSWORD: '',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_REFRESH_SECRET: 'y'.repeat(32),
});

console.log(`
Done: ${answers.title} (${answers.slug}-api)
  login: ${answers.auth ? `yes, roles ${answers.roles.join(', ')}` : 'no'}

Next:
  1. cp .env.example .env and fill in every (required) value (PORT=${answers.port}, DB_NAME=${answers.db})
  2. pnpm migrate${answers.auth ? '\n  3. pnpm create-admin' : ''}
  ${answers.auth ? '4' : '3'}. pnpm dev
  Then commit: git add -A && git commit -m "chore: initialise ${answers.slug}"
`);
