#!/usr/bin/env node
/**
 * Lint authored DDL against the house rules and the deviation register.
 *
 *   node verify-ddl.js <file.sql> [more.sql ...]
 *   node verify-ddl.js --dir ./migrations
 *
 * Checks the things that are cheap to get wrong and expensive to find later: a
 * `boolean` the frontend will read as false, a status column with no CHECK that
 * silently accepts a typo, a unique constraint that is not org-scoped and so
 * fails in an unrelated tenant, an `ADD COLUMN NOT NULL` that dies on apply.
 *
 * Exits non-zero on any ERROR. Several rules have legitimate exceptions — a
 * platform-level table has no `organizationid`, an append-only log has no
 * `isdeleted` — so each finding names the rule, to be justified rather than
 * silenced.
 *
 * No dependencies, and it never connects to a database.
 */

const fs = require('fs');
const path = require('path');

const findings = [];
const add = (file, line, level, rule, message) =>
    findings.push({ file, line, level, rule, message });

const parseArgs = (argv) => {
    const args = { files: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--dir') {
            args.dir = argv[++i];
        } else if (token.startsWith('--')) {
            args[token.slice(2)] = true;
        } else {
            args.files.push(token);
        }
    }
    return args;
};

/** Blank out comments but keep the newlines, so line numbers stay true. */
const stripComments = (sql) =>
    sql
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

const lineOf = (sql, index) => sql.slice(0, index).split('\n').length;

const balanced = (sql, start) => {
    let depth = 0;
    let quote = null;
    for (let i = start; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return { body: sql.slice(start + 1, i), end: i };
        }
    }
    return null;
};

/**
 * Split a table body on top-level commas, keeping each item's offset.
 *
 * The offset is what lets a finding point at the column's own line instead of at
 * the CREATE TABLE — a linter that reports twenty problems on line 3 is one the
 * reader has to re-find by hand.
 */
const splitTop = (body) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    let start = 0;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            if (current.trim()) parts.push({ text: current.trim(), offset: start + (current.length - current.trimStart().length) });
            current = '';
            start = i + 1;
            continue;
        }
        current += ch;
    }
    if (current.trim())
        parts.push({ text: current.trim(), offset: start + (current.length - current.trimStart().length) });
    return parts;
};

const CONSTRAINT_START =
    /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like)\b/i;

const LADDER = new Set(['10', '15', '20', '30', '50', '64', '100', '150', '200', '255', '500']);

const AUDIT = ['createdby', 'createdat', 'updatedby', 'updatedat', 'isdeleted'];

const normaliseType = (raw) => {
    let t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    t = t.replace(/^character varying/, 'varchar');
    t = t.replace(/^timestamp\s*(\(\d+\))?\s*without time zone/, 'timestamp');
    t = t.replace(/^timestamp\s*(\(\d+\))?\s*with time zone/, 'timestamptz');
    return t;
};

const baseType = (type) => type.replace(/\(.*$/, '').trim();

const checkFile = (file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const sql = stripComments(raw);
    const label = path.basename(file);

    // ---- whole-file rules -------------------------------------------------

    if (/create\s+trigger/i.test(sql)) {
        const i = sql.search(/create\s+trigger/i);
        add(label, lineOf(sql, i), 'ERROR', 'no-triggers',
            'CREATE TRIGGER — there are zero triggers across 111 tables. Nothing is maintained by the database: `updatedat` is written by the application on every UPDATE. Make the application change instead.');
    }

    let m;
    const enumRe = /create\s+type\s+[\w.".]+\s+as\s+enum/gi;
    while ((m = enumRe.exec(sql)) !== null)
        add(label, lineOf(sql, m.index), 'ERROR', 'no-enum-types',
            'CREATE TYPE … AS ENUM — there are none in the schema. States are `varchar(20|30)` holding lower_snake_case tokens plus a `chk_*` CHECK, so widening one is an app change rather than an ALTER TYPE.');

    const cascadeRe = /on\s+delete\s+(cascade|set\s+null|set\s+default)/gi;
    while ((m = cascadeRe.exec(sql)) !== null)
        add(label, lineOf(sql, m.index), 'ERROR', 'no-cascade',
            `ON DELETE ${m[1].toUpperCase()} — all 304 existing FKs use the default NO ACTION. Deletes are soft, so cascade semantics are dead code that goes live the day someone hard-deletes.`);

    const dropRe = /^\s*drop\s+(table|index|column|constraint)/gim;
    while ((m = dropRe.exec(sql)) !== null)
        add(label, lineOf(sql, m.index), 'ERROR', 'rollback-commented',
            'An uncommented DROP in a hand-applied file. Migrations are pasted whole into a console — the rollback section must stay commented out.');

    const createTableRe = /create\s+table\s+(if\s+not\s+exists\s+)?(?:only\s+)?([\w.".]+)\s*\(/gi;
    const tableStarts = [];
    while ((m = createTableRe.exec(sql)) !== null) tableStarts.push({ m, index: m.index });

    const createIndexRe = /create\s+(unique\s+)?index\s+(concurrently\s+)?(if\s+not\s+exists\s+)?([\w"]+)?\s*on\s+(?:only\s+)?([\w.".]+)\s*([\s\S]*?);/gi;
    const indexes = [];
    while ((m = createIndexRe.exec(sql)) !== null) {
        const idx = {
            unique: Boolean(m[1]),
            concurrent: Boolean(m[2]),
            guarded: Boolean(m[3]),
            name: (m[4] || '').replace(/"/g, '').toLowerCase(),
            table: m[5].replace(/"/g, '').split('.').pop().toLowerCase(),
            body: m[6].replace(/\s+/g, ' ').trim(),
            line: lineOf(sql, m.index),
        };
        indexes.push(idx);
        if (!idx.guarded)
            add(label, idx.line, 'ERROR', 'idempotent',
                `CREATE INDEX without IF NOT EXISTS (${idx.name || idx.table}) — the file is applied by hand and may be applied twice.`);
        if (!idx.name)
            add(label, idx.line, 'WARN', 'named-objects',
                `Unnamed index on ${idx.table} — name it \`${idx.unique ? 'uq' : 'idx'}_<table>_<cols>\` so it can be dropped without a lookup.`);
        else if (!/^(idx|uq|ux)_/.test(idx.name))
            add(label, idx.line, 'WARN', 'named-objects',
                `Index "${idx.name}" — the prefixes in use are idx_* (65) for lookups and uq_*/ux_* (29) for unique.`);
        if (idx.concurrent && !/^\s*$/.test(''))
            add(label, idx.line, 'NOTE', 'concurrent-index',
                'CREATE INDEX CONCURRENTLY cannot run inside a transaction block — keep it in its own section and say so in a comment.');
    }

    // ---- ALTER TABLE ------------------------------------------------------

    const addColRe = /alter\s+table\s+(?:only\s+)?([\w.".]+)\s+add\s+column\s+(if\s+not\s+exists\s+)?([\w"]+)\s+([\s\S]*?);/gi;
    while ((m = addColRe.exec(sql)) !== null) {
        const line = lineOf(sql, m.index);
        const col = m[3].replace(/"/g, '').toLowerCase();
        const definition = m[4].replace(/\s+/g, ' ').trim();
        if (!m[2])
            add(label, line, 'ERROR', 'idempotent',
                `ADD COLUMN ${col} without IF NOT EXISTS — the file is applied by hand and may be applied twice.`);
        if (/\bnot\s+null\b/i.test(definition) && !/\bdefault\b/i.test(definition))
            add(label, line, 'ERROR', 'additive',
                `ADD COLUMN ${col} NOT NULL with no DEFAULT fails on any populated table. Add it nullable, backfill, then tighten in a later migration.`);
        checkColumnRules(label, line, m[1].replace(/"/g, '').split('.').pop().toLowerCase(), col, definition);
    }

    const addConstraintRe = /alter\s+table\s+(?:only\s+)?([\w.".]+)\s+add\s+constraint\s+([\w"]+)\s+([\s\S]*?);/gi;
    const addedConstraints = [];
    while ((m = addConstraintRe.exec(sql)) !== null) {
        addedConstraints.push({
            table: m[1].replace(/"/g, '').split('.').pop().toLowerCase(),
            name: m[2].replace(/"/g, '').toLowerCase(),
            body: m[3].replace(/\s+/g, ' ').trim(),
            line: lineOf(sql, m.index),
        });
        const isSafe = /^\s*do\s+\$\$/im.test(sql.slice(Math.max(0, m.index - 400), m.index));
        if (!isSafe)
            add(label, lineOf(sql, m.index), 'NOTE', 'idempotent',
                `ADD CONSTRAINT ${m[2]} — PostgreSQL has no IF NOT EXISTS here. Guard it with a DO block testing pg_constraint, or applying twice errors.`);
    }

    // ---- per-table rules --------------------------------------------------

    for (const { m: tm, index } of tableStarts) {
        const line = lineOf(sql, index);
        const rawTable = tm[2].split('.').pop();
        const table = rawTable.replace(/"/g, '').toLowerCase();
        const open = sql.indexOf('(', index + tm[0].length - 1);
        const parsed = balanced(sql, open);
        if (!parsed) continue;

        if (!tm[1])
            add(label, line, 'ERROR', 'idempotent',
                `CREATE TABLE ${table} without IF NOT EXISTS — the file is applied by hand and may be applied twice.`);
        if (!/\./.test(tm[2]))
            add(label, line, 'NOTE', 'schema-qualified',
                `${table} is not schema-qualified — all DDL in this schema is written as public.<table>.`);
        if (/[A-Z]/.test(rawTable))
            add(label, line, rawTable.startsWith('"') ? 'ERROR' : 'WARN', 'lowercase-names',
                `Table ${rawTable} is written mixed-case — 0 of 111 table names are. ${rawTable.startsWith('"') ? 'Quoted, it stays mixed-case and every query must quote it.' : `Postgres folds it to \`${table}\`; write it that way.`}`);
        if (table.includes('_'))
            add(label, line, 'ERROR', 'no-underscores',
                `Table "${table}" has an underscore — no table name in the schema does. Names are <domain><role>, unseparated.`);
        if (/(s|es)$/.test(table) && !/(status|address|settings)$/.test(table))
            add(label, line, 'NOTE', 'singular-names',
                `Table "${table}" looks plural — only 3 of 111 are, all key-value or ledger-ish. Default to singular.`);

        const columns = [];
        const constraints = [];
        for (const item of splitTop(parsed.body)) {
            if (CONSTRAINT_START.test(item.text)) {
                constraints.push(item.text.replace(/\s+/g, ' '));
                continue;
            }
            const cm = item.text.match(/^("?[\w$]+"?)\s+([\s\S]+)$/);
            if (!cm) continue;
            columns.push({
                name: cm[1].replace(/"/g, '').toLowerCase(),
                raw: cm[1],
                line: lineOf(sql, open + 1 + item.offset),
                definition: cm[2].replace(/\s+/g, ' ').trim(),
            });
        }
        if (!columns.length) continue;

        const names = new Set(columns.map((c) => c.name));
        const tableConstraints = [
            ...constraints,
            ...addedConstraints.filter((c) => c.table === table).map((c) => `CONSTRAINT ${c.name} ${c.body}`),
        ];
        const constraintText = tableConstraints.join(' \n ').toLowerCase();

        // primary key
        const inlinePk = columns.find((c) => /\bprimary\s+key\b/i.test(c.definition));
        const declaredPk = tableConstraints.find((c) => /primary\s+key/i.test(c));
        const pkCols = inlinePk
            ? [inlinePk.name]
            : declaredPk
              ? ((declaredPk.match(/primary\s+key\s*\(([^)]*)\)/i) || [, ''])[1]
                    .split(',')
                    .map((s) => s.trim().replace(/"/g, '').toLowerCase())
                    .filter(Boolean))
              : [];
        if (!pkCols.length)
            add(label, line, 'ERROR', 'id-pk',
                `${table} has no primary key. All 111 tables have one, single-column, named id.`);
        else if (pkCols.length > 1)
            add(label, line, 'ERROR', 'id-pk',
                `${table} has a composite primary key (${pkCols.join(', ')}). All 111 are single-column \`id\`; put the pair in a unique index instead.`);
        else if (pkCols[0] !== 'id')
            add(label, line, 'ERROR', 'id-pk',
                `${table} has "${pkCols[0]}" as its primary key. All 111 tables use \`id\`, and the models assume it.`);

        const idCol = columns.find((c) => c.name === 'id');
        if (idCol) {
            if (/generated[\s\S]*as\s+identity/i.test(idCol.definition))
                add(label, line, 'ERROR', 'serial-pk',
                    `${table}.id uses GENERATED AS IDENTITY — that is deviation D2 (2 tables). Use \`serial\` for a master or \`bigserial\` for anything transactional.`);
            else if (!/\b(serial|bigserial)\b/i.test(idCol.definition))
                add(label, line, 'WARN', 'serial-pk',
                    `${table}.id is not serial/bigserial. 109 of 111 are — serial for masters, bigserial for documents, line items, ledgers and logs.`);
        }

        // audit block
        //
        // `raw` and `sql` share offsets (comments are blanked, not removed), so
        // this reads the comment block immediately above the CREATE TABLE. The
        // rule is "omit the update/delete columns only if the table is
        // append-only AND says so" — a file that says so has met it.
        const declaredAppendOnly = /append[- ]only/i.test(raw.slice(Math.max(0, index - 400), index));
        const appendOnly = declaredAppendOnly || /log$/.test(table);
        const missing = AUDIT.filter((c) => !names.has(c));
        if (missing.length && !(declaredAppendOnly && !missing.includes('createdat') && !missing.includes('createdby'))) {
            const level = appendOnly ? 'NOTE' : 'WARN';
            add(label, line, level, 'audit-block',
                `${table} is missing ${missing.join(', ')}. 107 of 111 tables carry all five verbatim.${appendOnly ? ' If it is strictly append-only, keep createdby+createdat only and say so in a comment above the table.' : ''}`);
        }
        const createdat = columns.find((c) => c.name === 'createdat');
        if (createdat && !/default\s+now\(\)/i.test(createdat.definition))
            add(label, line, 'WARN', 'audit-block',
                `${table}.createdat is not \`timestamp DEFAULT now() NOT NULL\` — 111 of 111 are, with zero variance.`);
        if (names.has('isdeleted')) {
            const c = columns.find((x) => x.name === 'isdeleted');
            if (!/smallint|int2/i.test(c.definition) || !/default\s+0/i.test(c.definition))
                add(label, line, 'WARN', 'soft-delete',
                    `${table}.isdeleted is not \`smallint DEFAULT 0 NOT NULL\` — 107 of 107 are, with zero variance.`);
        }

        // tenancy
        const tenancyCol = columns.find((c) => c.name === 'organizationid');
        if (!tenancyCol) {
            add(label, line, 'NOTE', 'tenancy',
                `${table} has no organizationid. That is right for a platform-level table and for nothing else — line items should carry it too (D5). Say which this is.`);
        } else {
            // Second in every table that has it — or third on a child table,
            // where the parent id comes first after id.
            const pos = columns.findIndex((c) => c.name === 'organizationid');
            const childish = pos === 2 && /id$/.test(columns[1].name);
            if (pos > 1 && !childish)
                add(label, line, 'NOTE', 'tenancy',
                    `${table}.organizationid is column ${pos + 1} — it sits immediately after id in every table that has it (after the parent id on a child table).`);
            if (!/\bnot\s+null\b/i.test(tenancyCol.definition))
                add(label, line, 'WARN', 'tenancy',
                    `${table}.organizationid is nullable. Only two tables do that deliberately (organizationsettings, auditlogmaster) and both need complementary partial unique indexes to make it safe.`);
            const hasFk =
                /references/i.test(tenancyCol.definition) ||
                /organizationid[\s\S]*references/.test(constraintText);
            if (!hasFk)
                add(label, line, 'ERROR', 'tenancy-fk',
                    `${table}.organizationid has no FK to organizationmaster(id) — that is deviation D6 (5 tables), and nothing stops an orphan org id.`);
            const hasOrgIndex = indexes.some(
                (i) => i.table === table && /\(\s*organizationid/i.test(i.body)
            );
            if (!hasOrgIndex)
                add(label, line, 'WARN', 'tenant-index',
                    `No index leading with organizationid on ${table}. Every SELECT filters organizationid and isdeleted — without \`idx_${table}_org (organizationid, isdeleted)\` every list endpoint is a sequential scan.`);
        }

        /**
         * A unique on a business VALUE must be org-scoped (D8). A unique on a set
         * of FK columns need not be: the junction tables in the schema use a bare
         * `UNIQUE (<a>id, <b>id)`, and that is already tenant-safe because both
         * targets are themselves org-scoped.
         */
        const valueUnique = (cols) =>
            cols.some((c) => {
                const col = columns.find((x) => x.name === c);
                return !col || !/id$/.test(c) || !/^(integer|bigint|smallint|int\d?)\b/.test(normaliseType(col.definition));
            });

        for (const c of tableConstraints) {
            const um = c.match(/unique\s*\(([^)]*)\)/i);
            if (!um) continue;
            const cols = um[1].split(',').map((s) => s.trim().toLowerCase());
            if (tenancyCol && !cols.includes('organizationid') && valueUnique(cols))
                add(label, line, 'ERROR', 'org-scoped-unique',
                    `UNIQUE (${cols.join(', ')}) on ${table} is not org-scoped — that is deviation D8, the one with real blast radius: two organizations cannot both use the same value, and the failure surfaces as a duplicate-key error in an unrelated tenant.`);
        }
        for (const idx of indexes.filter((i) => i.unique && i.table === table)) {
            const cm = idx.body.match(/\(([^)]*)\)/);
            const cols = cm ? cm[1].split(',').map((s) => s.trim().split(' ')[0].toLowerCase()) : [];
            if (tenancyCol && cols.length && !cols.includes('organizationid') && valueUnique(cols))
                add(label, idx.line, 'ERROR', 'org-scoped-unique',
                    `Unique index ${idx.name} on ${table} is not org-scoped (D8) — two organizations cannot then use the same value. Lead with organizationid.`);
            if (names.has('isdeleted') && !/where/i.test(idx.body))
                add(label, idx.line, 'NOTE', 'partial-unique',
                    `Unique index ${idx.name} has no \`WHERE isdeleted = 0\` — 56 of 109 indexes are partial. Without it, a soft-deleted row keeps blocking its code forever. That is correct for a document number and usually wrong for anything else.`);
        }

        // unnamed FKs
        for (const c of tableConstraints)
            if (/foreign\s+key/i.test(c) && !/^constraint\s+fk_/i.test(c.trim()))
                add(label, line, 'WARN', 'named-fk',
                    `Foreign key on ${table} is not hand-named \`fk_<table>_<target>\` — that is what the last twelve months of migrations do, and it makes DROP CONSTRAINT writable without a lookup.`);
        for (const c of columns)
            if (/\breferences\b/i.test(c.definition))
                add(label, line, 'WARN', 'named-fk',
                    `${table}.${c.name} uses an inline REFERENCES, which Postgres auto-names. Declare it as \`CONSTRAINT fk_${table}_<target> FOREIGN KEY …\`.`);

        // column-level rules
        for (const c of columns)
            checkColumnRules(label, c.line, table, c.name, c.definition, constraintText, c.raw);
    }

    if (!/WHAT THIS IS/i.test(raw) && tableStarts.length)
        add(label, 1, 'NOTE', 'header-block',
            'No header block. The house style opens with WHAT THIS IS / WHY / DECISIONS LOCKED / BEHAVIOUR-NEUTRAL ON ITS OWN — the last line tells whoever applies it whether they have just changed production behaviour.');
    if (!/rollback/i.test(raw) && tableStarts.length)
        add(label, 1, 'NOTE', 'rollback',
            'No rollback section. Every migration ends with one, commented out, in reverse order of creation — or a line saying why a rollback would lose data.');
};

function checkColumnRules(label, line, table, name, definition, constraintText = '', raw = name) {
    const where = `${table}.${name}`;
    const typeMatch = definition.match(
        /^([\s\S]*?)(?=\s+(?:not\s+null|null\b|default\b|primary\s+key|references\b|unique\b|check\b|generated\b|collate\b)|$)/i
    );
    const type = normaliseType(typeMatch ? typeMatch[1] : definition);
    const base = baseType(type);

    // An unquoted identifier folds to lowercase, so `noteNumber` is harmless in
    // the catalog and misleading in the source; a quoted one is uppercase for
    // real, and every query then has to quote it too.
    if (/[A-Z]/.test(raw))
        add(label, line, raw.startsWith('"') ? 'ERROR' : 'WARN', 'lowercase-names',
            raw.startsWith('"')
                ? `${table}."${raw.replace(/"/g, '')}" is a quoted mixed-case identifier — 0 of 2 061 columns are, and every query would have to quote it forever.`
                : `${table}.${raw} is written mixed-case. Postgres folds it to \`${name}\`, so the JSON key the frontend gets is \`${name}\` — write it that way in the DDL too.`);
    if (name.includes('_'))
        add(label, line, 'ERROR', 'no-underscores',
            `${where} has an underscore — only 1.2% of columns do, all inside two named legacy pockets (D1). New columns are unseparated: \`totaltaxamount\`, not \`total_tax_amount\`.`);

    if (base === 'boolean' || base === 'bool')
        add(label, line, 'ERROR', 'int2-flags',
            `${where} is \`boolean\` — there is exactly 1 in 2 061 columns (D4). Use \`smallint\` holding 0/1: the frontend tests \`flag === 1\`, which returns false for a real boolean.`);
    if (/default\s+(true|false)\b/i.test(definition))
        add(label, line, 'ERROR', 'int2-flags',
            `${where} defaults to true/false — flags default to 0 or 1.`);
    if (/^(is|can|allow|auto|has)[a-z]/.test(name) && base && !['smallint', 'int2'].includes(base))
        add(label, line, 'WARN', 'int2-flags',
            `${where} looks like a flag but is \`${type}\`. 223 flag columns are \`int2\` 0/1, 210 of them NOT NULL.`);

    if (base === 'timestamptz')
        add(label, line, 'ERROR', 'no-timestamptz',
            `${where} is \`timestamptz\` — 276 of 277 timestamp columns are without time zone (D3). Mixing them in a comparison silently applies the session TimeZone.`);
    if (base === 'timestamp' && /^(.*date)$/.test(name) && !/at$/.test(name))
        add(label, line, 'NOTE', 'date-vs-timestamp',
            `${where} is a \`timestamp\` but reads like a business date. 65 business dates are \`date\`; \`timestamp\` is for \`*at\` event times.`);

    if (base === 'varchar') {
        const len = (type.match(/\((\d+)\)/) || [])[1];
        if (!len)
            add(label, line, 'ERROR', 'bounded-varchar',
                `${where} is an unbounded \`varchar\` — there is exactly 1 in the schema (D7). Give it a length from the ladder: 20/30/50/100/150/200/255/500.`);
        else if (!LADDER.has(len))
            add(label, line, 'WARN', 'varchar-ladder',
                `${where} is varchar(${len}), which is off the ladder (20 ×86, 100 ×81, 50 ×58, 30 ×47, 200 ×40, 150 ×27, 500 ×11, 255 ×10). A varchar(${len}) will look wrong to a reviewer.`);
    }

    if (base === 'numeric' && !type.includes('('))
        add(label, line, 'WARN', 'numeric-precision',
            `${where} is unconstrained \`numeric\`. Money is numeric(14,2), quantities and unit prices numeric(14,4), percentages numeric(5,2).`);
    if (/(amount|total|price|cost|balance|paid)$/.test(name) && base === 'numeric') {
        const p = (type.match(/\(([\d,]+)\)/) || [, ''])[1];
        if (p && !['14,2', '14,4', '6,2', '5,2'].includes(p.replace(/\s/g, '')))
            add(label, line, 'NOTE', 'numeric-precision',
                `${where} is numeric(${p}) — money is numeric(14,2) in 134 columns, unit prices numeric(14,4).`);
    }
    if (/(percentage|percent|pct)$/.test(name) && base === 'numeric') {
        const p = (type.match(/\(([\d,]+)\)/) || [, ''])[1];
        if (p && p.replace(/\s/g, '') !== '5,2')
            add(label, line, 'NOTE', 'numeric-precision',
                `${where} is numeric(${p}) — percentages are numeric(5,2) in 33 of 35 cases.`);
    }

    if (base === 'jsonb' || base === 'json')
        add(label, line, 'NOTE', 'prefer-columns',
            `${where} is ${base} — there are exactly 2 such columns in 2 061. If the shape is unclear, that is a question for the user rather than a reason for a blob.`);

    if (/status$/.test(name) && base === 'varchar' && constraintText && !constraintText.includes(name))
        add(label, line, 'WARN', 'status-check',
            `${where} has no CHECK constraint — that is deviation D9 (22 unguarded status columns). A typo'd status writes cleanly and then never matches a filter. Add \`chk_<abbrev>_${name}\` with the \`= ANY (ARRAY[…])\` form.`);

    const stateLiterals = [...definition.matchAll(/'([A-Za-z_][\w ]*)'/g)].map((x) => x[1]);
    for (const lit of stateLiterals)
        if (/[A-Z]/.test(lit) && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'FIFO', 'LIFO', 'AVCO', 'STANDARD', 'LMV', 'HMV', 'HGMV', 'MCWG', 'Other'].includes(lit))
            add(label, line, 'NOTE', 'snake-case-states',
                `${where} default '${lit}' is not lower_snake_case. State tokens are lowercase (\`tax_invoice\`, \`partially_received\`); the three uppercase exceptions are all external industry codes.`);

    if (/^(created|updated|deleted|modified)_?(at|by)$/.test(name) && name.includes('_'))
        add(label, line, 'ERROR', 'audit-block',
            `${where} — the audit columns are \`createdby\`, \`createdat\`, \`updatedby\`, \`updatedat\`, \`isdeleted\`. No underscores.`);
}

const main = () => {
    const args = parseArgs(process.argv.slice(2));
    let files = args.files;
    if (args.dir)
        files = files.concat(
            fs
                .readdirSync(args.dir)
                .filter((f) => f.endsWith('.sql'))
                .sort()
                .map((f) => path.join(args.dir, f))
        );
    if (!files.length) {
        console.error('usage: verify-ddl.js <file.sql> [more.sql ...] | --dir <migrations-dir>');
        process.exit(2);
    }

    for (const f of files) {
        if (!fs.existsSync(f)) {
            console.error(`Not found: ${f}`);
            process.exit(2);
        }
        checkFile(f);
    }

    const order = { ERROR: 0, WARN: 1, NOTE: 2 };
    findings.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file) || a.line - b.line);

    const counts = { ERROR: 0, WARN: 0, NOTE: 0 };
    let currentLevel = null;
    for (const f of findings) {
        counts[f.level]++;
        if (f.level !== currentLevel) {
            const heading =
                f.level === 'ERROR'
                    ? '\nERRORS — these break a rule that holds everywhere'
                    : f.level === 'WARN'
                      ? '\nWARNINGS — a strong default, deviate only with a stated reason'
                      : '\nNOTES — worth a look, often fine';
            console.log(heading);
            console.log('─'.repeat(heading.trim().length));
            currentLevel = f.level;
        }
        console.log(`  ${f.file}:${f.line}  [${f.rule}]`);
        console.log(`    ${f.message}`);
    }

    console.log(
        `\n${files.length} file(s): ${counts.ERROR} error(s), ${counts.WARN} warning(s), ${counts.NOTE} note(s).`
    );
    if (!findings.length) console.log('Clean — matches the house conventions.\n');
    else
        console.log(
            'Every rule and its adherence count is in references/conventions.md.\n' +
                'A finding you can justify out loud is fine; one you cannot is a bug.\n'
        );

    process.exit(counts.ERROR > 0 ? 1 : 0);
};

main();
