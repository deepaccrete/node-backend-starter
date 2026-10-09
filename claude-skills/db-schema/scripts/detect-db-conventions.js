#!/usr/bin/env node
/**
 * Report what a PostgreSQL schema ACTUALLY does, so a new table can be written
 * to match it instead of to a remembered default.
 *
 *   node detect-db-conventions.js --ddl <dump.sql> [--migrations <dir>] [--json]
 *   node detect-db-conventions.js --migrations <dir>
 *
 * Everything is measured, not assumed: each convention is reported with the
 * number of tables or columns that follow it, so a schema that has drifted shows
 * as a split ("57 serial, 52 bigserial") rather than as a confident wrong answer.
 *
 * Reads both dialects — the `pg_dump` output form (`id bigint NOT NULL` plus a
 * separate sequence and an `ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY`) and the
 * authored form used in migrations (`id bigserial PRIMARY KEY`).
 *
 * No dependencies, and it never connects to a database — it reads SQL text.
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

const read = (file) => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
};

/**
 * Strip comments before matching.
 *
 * Migration files carry commented-out rollback sections and commented cutover
 * steps. Counting those would report the opposite of the truth: a `DROP TABLE`
 * in a rollback block is precisely the statement that was NOT run.
 */
const stripComments = (sql) =>
    sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** Everything from `start` (an open paren index) to its matching close paren. */
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
            if (depth === 0) return sql.slice(start + 1, i);
        }
    }
    return null;
};

/** Split a table body on commas that are not inside parens or quotes. */
const splitTop = (body) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (const ch of body) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
};

const CONSTRAINT_START =
    /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like)\b/i;

/** `character varying(50)` -> `varchar(50)`, `timestamp without time zone` -> `timestamp`. */
const normaliseType = (raw) => {
    let t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    t = t.replace(/^character varying/, 'varchar');
    t = t.replace(/^character\b/, 'char');
    t = t.replace(/^timestamp\s*(\(\d+\))?\s*without time zone/, 'timestamp');
    t = t.replace(/^timestamp\s*(\(\d+\))?\s*with time zone/, 'timestamptz');
    t = t.replace(/^double precision/, 'float8');
    return t;
};

/** The bare type word, without the length/precision. */
const baseType = (type) => type.replace(/\(.*$/, '').trim();

const parseTables = (sql, source) => {
    const tables = [];
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?([\w.".]+)\s*\(/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
        const open = sql.indexOf('(', m.index + m[0].length - 1);
        const body = balanced(sql, open);
        if (body === null) continue;
        const name = m[1].replace(/"/g, '').split('.').pop().toLowerCase();
        const columns = [];
        const constraints = [];
        for (const item of splitTop(body)) {
            if (CONSTRAINT_START.test(item)) {
                constraints.push(item.replace(/\s+/g, ' '));
                continue;
            }
            const cm = item.match(/^("?[\w$]+"?)\s+([\s\S]+)$/);
            if (!cm) continue;
            const definition = cm[2].replace(/\s+/g, ' ').trim();
            // The type ends where a column constraint begins.
            const typeMatch = definition.match(
                /^([\s\S]*?)(?=\s+(?:not\s+null|null\b|default\b|primary\s+key|references\b|unique\b|check\b|generated\b|collate\b)|$)/i
            );
            columns.push({
                name: cm[1].replace(/"/g, '').toLowerCase(),
                type: normaliseType(typeMatch ? typeMatch[1] : definition),
                definition,
                notNull: /\bnot\s+null\b/i.test(definition),
                hasDefault: /\bdefault\b/i.test(definition),
                inlinePk: /\bprimary\s+key\b/i.test(definition),
                inlineRef: /\breferences\b/i.test(definition),
                identity: /\bgenerated\b[\s\S]*\bas\s+identity\b/i.test(definition),
            });
        }
        tables.push({ name, columns, constraints, source });
    }
    return tables;
};

/** Statements that live outside the CREATE TABLE body. */
const parseOutOfLine = (sql) => {
    const out = {
        addConstraints: [],
        addColumns: [],
        indexes: [],
        triggers: [],
        enumTypes: [],
        sequences: [],
        alterDefaults: [],
    };
    let m;

    const addC =
        /alter\s+table\s+(?:only\s+)?([\w.".]+)\s+add\s+constraint\s+([\w"]+)\s+([\s\S]*?);/gi;
    while ((m = addC.exec(sql)) !== null) {
        out.addConstraints.push({
            table: m[1].replace(/"/g, '').split('.').pop().toLowerCase(),
            name: m[2].replace(/"/g, '').toLowerCase(),
            body: m[3].replace(/\s+/g, ' ').trim(),
        });
    }

    const addCol =
        /alter\s+table\s+(?:only\s+)?([\w.".]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"]+)\s+([\s\S]*?);/gi;
    while ((m = addCol.exec(sql)) !== null) {
        out.addColumns.push({
            table: m[1].replace(/"/g, '').split('.').pop().toLowerCase(),
            name: m[2].replace(/"/g, '').toLowerCase(),
            definition: m[3].replace(/\s+/g, ' ').trim(),
        });
    }

    const idx =
        /create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w"]+)\s+on\s+(?:only\s+)?([\w.".]+)\s*([\s\S]*?);/gi;
    while ((m = idx.exec(sql)) !== null) {
        out.indexes.push({
            unique: Boolean(m[1]),
            name: m[2].replace(/"/g, '').toLowerCase(),
            table: m[3].replace(/"/g, '').split('.').pop().toLowerCase(),
            body: m[4].replace(/\s+/g, ' ').trim(),
        });
    }

    const trg = /create\s+(?:or\s+replace\s+)?trigger\s+([\w"]+)/gi;
    while ((m = trg.exec(sql)) !== null) out.triggers.push(m[1].replace(/"/g, ''));

    const enm = /create\s+type\s+([\w.".]+)\s+as\s+enum/gi;
    while ((m = enm.exec(sql)) !== null) out.enumTypes.push(m[1].replace(/"/g, ''));

    const seq = /alter\s+table\s+(?:only\s+)?([\w.".]+)\s+alter\s+column\s+([\w"]+)\s+set\s+default\s+nextval/gi;
    while ((m = seq.exec(sql)) !== null) {
        out.alterDefaults.push({
            table: m[1].replace(/"/g, '').split('.').pop().toLowerCase(),
            column: m[2].replace(/"/g, '').toLowerCase(),
        });
    }

    return out;
};

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : 'n/a');

/** "57 serial, 52 bigserial" — sorted, so the dominant convention leads. */
const tally = (map, limit = 8) =>
    [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

const main = () => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.ddl && !args.migrations) {
        console.error(
            'usage: detect-db-conventions.js --ddl <dump.sql> [--migrations <dir>] [--json]'
        );
        process.exit(2);
    }

    const sources = [];
    if (args.ddl) {
        if (!fs.existsSync(args.ddl)) {
            console.error(`DDL file not found: ${args.ddl}`);
            process.exit(2);
        }
        sources.push({ label: 'ddl', sql: stripComments(read(args.ddl)) });
    }
    if (args.migrations) {
        const dir = args.migrations;
        const files = fs.existsSync(dir)
            ? fs
                  .readdirSync(dir)
                  .filter((f) => f.endsWith('.sql'))
                  .sort()
            : [];
        for (const f of files) {
            sources.push({
                label: `migrations/${f}`,
                sql: stripComments(read(path.join(dir, f))),
            });
        }
        if (!files.length) console.error(`(no .sql files under ${dir})`);
    }

    // A table created in the dump and altered in a migration is one table. Later
    // definitions win, because the migration post-dates the snapshot.
    const byName = new Map();
    const outOfLine = {
        addConstraints: [],
        addColumns: [],
        indexes: [],
        triggers: [],
        enumTypes: [],
        alterDefaults: [],
    };
    for (const src of sources) {
        for (const t of parseTables(src.sql, src.label)) byName.set(t.name, t);
        const o = parseOutOfLine(src.sql);
        for (const key of Object.keys(outOfLine)) outOfLine[key].push(...(o[key] || []));
    }

    // Fold ALTER TABLE ADD COLUMN into its table, so a migration-added column is
    // measured like any other.
    for (const add of outOfLine.addColumns) {
        const t = byName.get(add.table);
        if (!t || t.columns.some((c) => c.name === add.name)) continue;
        t.columns.push({
            name: add.name,
            type: normaliseType(add.definition.replace(/\s+(not\s+null|default|references|check|unique)[\s\S]*$/i, '')),
            definition: add.definition,
            notNull: /\bnot\s+null\b/i.test(add.definition),
            hasDefault: /\bdefault\b/i.test(add.definition),
            inlinePk: false,
            inlineRef: /\breferences\b/i.test(add.definition),
            identity: false,
        });
    }

    const tables = [...byName.values()];
    if (!tables.length) {
        console.error('No CREATE TABLE statements found. Wrong file?');
        process.exit(2);
    }

    const allColumns = tables.flatMap((t) => t.columns.map((c) => ({ ...c, table: t.name })));
    const seqDefaults = new Set(outOfLine.alterDefaults.map((d) => `${d.table}.${d.column}`));

    // ---- primary keys -----------------------------------------------------
    const pkTypes = new Map();
    let pkNamedId = 0;
    let pkComposite = 0;
    const pkMissing = [];
    for (const t of tables) {
        const inline = t.columns.find((c) => c.inlinePk);
        const declared = t.constraints.find((c) => /primary\s+key/i.test(c));
        const added = outOfLine.addConstraints.find(
            (c) => c.table === t.name && /primary\s+key/i.test(c.body)
        );
        const cols = inline
            ? [inline.name]
            : (declared || added)
              ? ((declared || added.body).match(/primary\s+key\s*\(([^)]*)\)/i) || [, ''])[1]
                    .split(',')
                    .map((s) => s.trim().replace(/"/g, '').toLowerCase())
                    .filter(Boolean)
              : [];
        if (!cols.length) {
            pkMissing.push(t.name);
            continue;
        }
        if (cols.length > 1) pkComposite++;
        if (cols.length === 1 && cols[0] === 'id') pkNamedId++;
        const pkCol = t.columns.find((c) => c.name === cols[0]);
        if (!pkCol) continue;
        const base = baseType(pkCol.type);
        if (pkCol.identity) bump(pkTypes, 'GENERATED AS IDENTITY');
        else if (base === 'serial' || base === 'bigserial' || base === 'smallserial')
            bump(pkTypes, base);
        else if (seqDefaults.has(`${t.name}.${pkCol.name}`))
            bump(pkTypes, base === 'bigint' ? 'bigserial (via sequence)' : 'serial (via sequence)');
        else bump(pkTypes, base);
    }

    // ---- naming -----------------------------------------------------------
    const upperTables = tables.filter((t) => /[A-Z]/.test(t.name));
    const underscoreTables = tables.filter((t) => t.name.includes('_'));
    const upperColumns = allColumns.filter((c) => /[A-Z]/.test(c.name));
    const underscoreColumns = allColumns.filter((c) => c.name.includes('_'));
    const suffixes = new Map();
    for (const t of tables) {
        const suffix = ['master', 'lineitem', 'map', 'log', 'history', 'settings'].find((s) =>
            t.name.endsWith(s)
        );
        bump(suffixes, suffix || '(other)');
    }

    // ---- audit block ------------------------------------------------------
    const AUDIT = ['createdby', 'createdat', 'updatedby', 'updatedat', 'isdeleted'];
    const auditCoverage = new Map(AUDIT.map((c) => [c, 0]));
    let fullAudit = 0;
    const partialAudit = [];
    for (const t of tables) {
        const names = new Set(t.columns.map((c) => c.name));
        const has = AUDIT.filter((c) => names.has(c));
        for (const c of has) bump(auditCoverage, c);
        if (has.length === AUDIT.length) fullAudit++;
        else partialAudit.push(`${t.name} (${has.join('+') || 'none'})`);
    }
    const createdatDefs = new Map();
    for (const c of allColumns.filter((c) => c.name === 'createdat'))
        bump(createdatDefs, `${c.type}${c.hasDefault ? ' DEFAULT now()' : ' no default'}${c.notNull ? ' NOT NULL' : ''}`);

    // ---- tenancy ----------------------------------------------------------
    const tenancyCandidates = new Map();
    for (const c of allColumns)
        if (/^(organizationid|organisationid|orgid|tenantid|companyid)$/.test(c.name))
            bump(tenancyCandidates, c.name);
    const tenancyCol = [...tenancyCandidates.entries()].sort((a, b) => b[1] - a[1])[0];
    let tenancySecond = 0;
    let tenancyFk = 0;
    let tenancyNullable = 0;
    const tenancyNoFk = [];
    if (tenancyCol) {
        for (const t of tables) {
            const col = t.columns.find((c) => c.name === tenancyCol[0]);
            if (!col) continue;
            if (t.columns[1] && t.columns[1].name === tenancyCol[0]) tenancySecond++;
            if (!col.notNull) tenancyNullable++;
            const inTable = t.constraints.some(
                (c) => c.toLowerCase().includes(tenancyCol[0]) && /references/i.test(c)
            );
            const added = outOfLine.addConstraints.some(
                (c) => c.table === t.name && c.body.toLowerCase().includes(tenancyCol[0]) && /references/i.test(c.body)
            );
            if (inTable || added || col.inlineRef) tenancyFk++;
            else tenancyNoFk.push(t.name);
        }
    }

    // ---- types ------------------------------------------------------------
    const typeCounts = new Map();
    for (const c of allColumns) bump(typeCounts, c.type);
    const boolCols = allColumns.filter((c) => baseType(c.type) === 'boolean' || baseType(c.type) === 'bool');
    const flagCols = allColumns.filter((c) => /^(is|can|allow|auto|has)[a-z]/.test(c.name));
    const flagTypes = new Map();
    for (const c of flagCols) bump(flagTypes, baseType(c.type));
    const tzCols = allColumns.filter((c) => baseType(c.type) === 'timestamptz');
    const tsCols = allColumns.filter((c) => baseType(c.type) === 'timestamp');
    const varcharLens = new Map();
    const unboundedVarchar = [];
    for (const c of allColumns) {
        if (baseType(c.type) !== 'varchar') continue;
        const len = (c.type.match(/\((\d+)\)/) || [])[1];
        if (len) bump(varcharLens, len);
        else unboundedVarchar.push(`${c.table}.${c.name}`);
    }
    const numericScales = new Map();
    for (const c of allColumns)
        if (baseType(c.type) === 'numeric' && c.type.includes('('))
            bump(numericScales, c.type.replace('numeric', ''));

    // ---- constraints and indexes -----------------------------------------
    const allConstraints = [
        ...tables.flatMap((t) =>
            t.constraints
                .map((c) => (c.match(/^constraint\s+([\w"]+)/i) || [])[1])
                .filter(Boolean)
                .map((n) => n.replace(/"/g, '').toLowerCase())
        ),
        ...outOfLine.addConstraints.map((c) => c.name),
    ];
    const prefixes = new Map();
    for (const n of allConstraints) {
        const p = n.endsWith('_pkey')
            ? '<table>_pkey'
            : n.endsWith('_fkey')
              ? '<table>_<col>_fkey'
              : n.endsWith('_key')
                ? '<table>_<col>_key'
                : (n.match(/^(fk|chk|ck|uq|ux|idx|no)_/) || [, '(unprefixed)'])[1];
        bump(prefixes, p === '(unprefixed)' ? p : `${p}${p.includes('<') ? '' : '_*'}`);
    }
    const idxPrefixes = new Map();
    for (const i of outOfLine.indexes)
        bump(idxPrefixes, (i.name.match(/^(idx|uq|ux|ix)_/) || [, '(unprefixed)'])[1]);
    const partialIdx = outOfLine.indexes.filter((i) => /where[\s\S]*isdeleted\s*=\s*0/i.test(i.body));
    const constraintText = [
        ...tables.flatMap((t) => t.constraints),
        ...outOfLine.addConstraints.map((c) => c.body),
    ];
    const fkCount =
        constraintText.filter((c) => /foreign\s+key/i.test(c)).length +
        allColumns.filter((c) => c.inlineRef).length;
    const cascades = constraintText.filter((c) => /on\s+delete\s+(cascade|set\s+null)/i.test(c));
    const checkCount = constraintText.filter((c) => /\bcheck\s*\(/i.test(c)).length;
    const excludeCount = constraintText.filter((c) => /\bexclude\s+using/i.test(c)).length;

    // Uniqueness that is not org-scoped is the D8 class: two tenants cannot then
    // use the same value, and the failure lands in an unrelated tenant's request.
    const uniqueTargets = [];
    for (const t of tables) {
        const tenant = tenancyCol && t.columns.some((c) => c.name === tenancyCol[0]);
        if (!tenant) continue;
        const declared = [
            ...t.constraints.filter((c) => /unique\s*\(/i.test(c)),
            ...outOfLine.addConstraints.filter((c) => c.table === t.name && /unique\s*\(/i.test(c.body)).map((c) => c.body),
            ...outOfLine.indexes.filter((i) => i.unique && i.table === t.name).map((i) => i.body),
        ];
        for (const d of declared) {
            const cols = ((d.match(/\(([^)]*)\)/) || [, ''])[1] || '')
                .split(',')
                .map((s) => s.trim().split(' ')[0].toLowerCase());
            // A bare `UNIQUE (<a>id, <b>id)` on a junction table is already
            // tenant-safe — both targets are org-scoped. Only a unique on a
            // business VALUE is the D8 case.
            const onValue = cols.some((c) => {
                const col = t.columns.find((x) => x.name === c);
                return !col || !/id$/.test(c) || !/^(integer|bigint|smallint|int\d?)\b/.test(col.type);
            });
            if (cols.length && !cols.includes(tenancyCol[0]) && onValue)
                uniqueTargets.push(`${t.name} (${cols.join(', ')})`);
        }
    }

    // A status column is guarded if any CHECK anywhere mentions it.
    const statusCols = allColumns.filter((c) => /status$/.test(c.name) && baseType(c.type) === 'varchar');
    const guarded = statusCols.filter((c) => {
        const t = byName.get(c.table);
        const inTable = t.constraints.some((x) => /check/i.test(x) && x.toLowerCase().includes(c.name));
        const added = outOfLine.addConstraints.some(
            (x) => x.table === c.table && /check/i.test(x.body) && x.body.toLowerCase().includes(c.name)
        );
        return inTable || added;
    });

    const report = {
        tables: tables.length,
        columns: allColumns.length,
        pkTypes: Object.fromEntries(pkTypes),
        tenancyColumn: tenancyCol ? tenancyCol[0] : null,
        fullAudit,
        triggers: outOfLine.triggers.length,
        enumTypes: outOfLine.enumTypes.length,
        cascades: cascades.length,
    };

    if (args.json) {
        console.log(JSON.stringify({ ...report, tableNames: tables.map((t) => t.name) }, null, 2));
        return;
    }

    const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
    const section = (title) => console.log(`\n${title}\n${'─'.repeat(title.length)}`);

    console.log(`\nSchema conventions — ${tables.length} tables, ${allColumns.length} columns`);
    console.log(`Sources: ${sources.map((s) => s.label).join(', ')}`);

    section('Primary keys');
    line('types', tally(pkTypes) || 'none found');
    line('named `id`', `${pkNamedId}/${tables.length} (${pct(pkNamedId, tables.length)})`);
    if (pkComposite) line('composite', `${pkComposite}  <- house style is single-column`);
    if (pkMissing.length)
        line('no PK found', `${pkMissing.length}: ${pkMissing.slice(0, 5).join(', ')}`);

    section('Naming');
    line('table names with uppercase', upperTables.length ? `${upperTables.length}: ${upperTables.slice(0, 5).join(', ')}` : '0  ✓');
    line('table names with underscore', underscoreTables.length ? `${underscoreTables.length}: ${underscoreTables.slice(0, 5).join(', ')}` : '0  ✓');
    line('columns with uppercase', upperColumns.length ? `${upperColumns.length}` : '0  ✓');
    line(
        'columns with underscore',
        underscoreColumns.length
            ? `${underscoreColumns.length} (${pct(underscoreColumns.length, allColumns.length)}): ${underscoreColumns.slice(0, 6).map((c) => `${c.table}.${c.name}`).join(', ')}`
            : '0  ✓'
    );
    line('table suffixes', tally(suffixes));

    section('Audit block');
    line('all five columns', `${fullAudit}/${tables.length} (${pct(fullAudit, tables.length)})`);
    for (const [col, n] of auditCoverage) line(`  ${col}`, `${n}/${tables.length}`);
    line('createdat definition', tally(createdatDefs, 4) || 'none');
    if (partialAudit.length)
        console.log(
            `  partial/none (${partialAudit.length}): ${partialAudit.slice(0, 6).join(', ')}${partialAudit.length > 6 ? ', …' : ''}`
        );

    section('Tenancy');
    if (!tenancyCol) {
        line('tenancy column', 'none found — single-tenant, or named unusually');
    } else {
        const n = tenancyCol[1];
        line('column', `${tenancyCol[0]} on ${n}/${tables.length} tables (${pct(n, tables.length)})`);
        line('positioned second', `${tenancySecond}/${n}`);
        line('carries an FK', `${tenancyFk}/${n}`);
        if (tenancyNullable) line('nullable', `${tenancyNullable}/${n}`);
        if (tenancyNoFk.length)
            console.log(
                `  no FK (${tenancyNoFk.length}): ${tenancyNoFk.slice(0, 8).join(', ')}${tenancyNoFk.length > 8 ? ', …' : ''}`
            );
    }

    section('Types');
    line('most common', tally(typeCounts, 10));
    line(
        'flag columns (is*/can*/allow*)',
        `${flagCols.length} — ${tally(flagTypes, 4) || 'none'}`
    );
    line('real `boolean` columns', boolCols.length ? `${boolCols.length}: ${boolCols.slice(0, 5).map((c) => `${c.table}.${c.name}`).join(', ')}` : '0  ✓');
    line('timestamp vs timestamptz', `${tsCols.length} timestamp, ${tzCols.length} timestamptz`);
    line('varchar length ladder', tally(varcharLens, 10));
    if (unboundedVarchar.length)
        line('unbounded varchar', `${unboundedVarchar.length}: ${unboundedVarchar.slice(0, 5).join(', ')}`);
    line('numeric precisions', tally(numericScales, 8));

    section('Constraints & indexes');
    line('foreign keys', `${fkCount}`);
    line('ON DELETE CASCADE / SET NULL', cascades.length ? `${cascades.length}  <- house style is none` : '0  ✓');
    line('CHECK constraints', `${checkCount}`);
    line('EXCLUDE constraints', `${excludeCount}`);
    line('constraint name prefixes', tally(prefixes, 8));
    line('indexes', `${outOfLine.indexes.length} (${outOfLine.indexes.filter((i) => i.unique).length} unique)`);
    line('index name prefixes', tally(idxPrefixes, 6) || 'none');
    line('partial on isdeleted = 0', `${partialIdx.length}/${outOfLine.indexes.length}`);
    line(
        'status columns guarded by CHECK',
        statusCols.length ? `${guarded.length}/${statusCols.length}` : 'no status columns'
    );
    if (uniqueTargets.length)
        console.log(
            `  unique but NOT org-scoped (${uniqueTargets.length}) — the D8 class, two tenants cannot share a value:\n` +
                uniqueTargets.slice(0, 8).map((u) => `      ${u}`).join('\n')
        );

    section('Database-side behaviour');
    line('triggers', outOfLine.triggers.length ? `${outOfLine.triggers.length}  <- house style is zero` : '0  ✓ nothing is maintained by the DB');
    line('ENUM types', outOfLine.enumTypes.length ? `${outOfLine.enumTypes.length}: ${outOfLine.enumTypes.join(', ')}` : '0  ✓ states are varchar + CHECK');

    const newest = tables.filter((t) => t.source !== 'ddl');
    if (newest.length) {
        section('Most recently authored tables');
        console.log(
            '  In a drifted schema the newest tables are the live convention.\n  Read these before copying an older one:'
        );
        for (const t of newest.slice(-8)) console.log(`    ${t.name.padEnd(32)} ${t.source}`);
    }

    console.log(
        '\nNext: read two neighbouring tables in full, then plan the columns with the user.\n'
    );
};

main();
