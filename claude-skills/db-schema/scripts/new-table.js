#!/usr/bin/env node
/**
 * Generate a house-style migration for one or more new tables, from a JSON spec.
 *
 *   node new-table.js --spec ./spec.json --out ./migrations
 *   node new-table.js --spec ./spec.json --stdout
 *
 * The spec format is documented in references/templates.md. What this produces is
 * correct-SHAPED DDL, not a finished design: it cannot know the real state tokens,
 * the business invariants, or which queries the table will serve. Read the emitted
 * file, finish it, then run verify-ddl.js on the result.
 *
 * It refuses to emit anything that breaks a Tier-A rule — an uppercase or
 * underscored identifier, a `boolean`, a `timestamptz`, an unbounded `varchar`,
 * an enum type. That refusal is the point: the generator exists so those cannot
 * be typed by accident.
 *
 * No dependencies. It never connects to a database and never applies anything.
 */

const fs = require('fs');
const path = require('path');

const AUDIT_BLOCK = [
    { name: 'createdby', type: 'integer', default: '1', notNull: true },
    { name: 'createdat', type: 'timestamp', default: 'now()', notNull: true },
    { name: 'updatedby', type: 'integer', default: '1', notNull: true },
    {
        name: 'updatedat',
        type: 'timestamp',
        default: 'now()',
        notNull: true,
        comment: 'written by the application on every UPDATE; there is no trigger',
    },
    { name: 'isdeleted', type: 'smallint', default: '0', notNull: true },
];

const APPEND_ONLY_BLOCK = [
    { name: 'createdby', type: 'integer', comment: 'NULL for system-written rows' },
    { name: 'createdat', type: 'timestamp', default: 'now()', notNull: true },
];

const SHAPES = {
    master: { pk: 'serial', isactive: true, tenancy: true },
    document: { pk: 'bigserial', isactive: false, tenancy: true },
    lineitem: { pk: 'bigserial', isactive: false, tenancy: true },
    map: { pk: 'serial', isactive: false, tenancy: true },
    log: { pk: 'bigserial', isactive: false, tenancy: true, appendOnly: true },
};

const errors = [];
const fail = (msg) => errors.push(msg);

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

/** Short forms in, long-form authored spelling out. */
const longType = (raw, where) => {
    const t = String(raw || '').toLowerCase().replace(/\s+/g, '');
    // The base name may contain digits (`int2`, `int8`, `jsonb`), so the class
    // cannot be letters-only — `int2` then reads as unparseable.
    const m = t.match(/^([a-z][a-z0-9 ]*?)(\(([\d,]+)\))?$/);
    if (!m) {
        fail(`${where}: unreadable type "${raw}"`);
        return raw;
    }
    const base = m[1];
    const arg = m[3];

    if (base === 'boolean' || base === 'bool') {
        fail(
            `${where}: \`boolean\` is not used in this schema (1 column in 2 061). Use \`int2\` holding 0/1 — the frontend tests \`flag === 1\`.`
        );
        return 'smallint';
    }
    if (base === 'timestamptz' || base === 'timestampwithtimezone') {
        fail(
            `${where}: \`timestamptz\` is not used (1 column in 2 061). Use \`timestamp\` without time zone.`
        );
        return 'timestamp';
    }
    if ((base === 'varchar' || base === 'charactervarying') && !arg) {
        fail(`${where}: unbounded varchar. Give it a length from the ladder (20/30/50/100/150/200/255/500).`);
        return 'character varying(100)';
    }
    if (base === 'serial' || base === 'bigserial') {
        fail(`${where}: serial types belong to \`id\` only — this generator writes the PK for you.`);
    }

    const map = {
        int2: 'smallint',
        smallint: 'smallint',
        int4: 'integer',
        int: 'integer',
        integer: 'integer',
        int8: 'bigint',
        bigint: 'bigint',
        varchar: 'character varying',
        charactervarying: 'character varying',
        text: 'text',
        date: 'date',
        timestamp: 'timestamp',
        numeric: 'numeric',
        decimal: 'numeric',
        jsonb: 'jsonb',
        uuid: 'uuid',
        serial: 'serial',
        bigserial: 'bigserial',
    };
    const out = map[base];
    if (!out) {
        fail(`${where}: unknown type "${raw}". Pick from the dictionary in references/conventions.md §3.`);
        return raw;
    }
    if (out === 'jsonb') {
        console.error(
            `  note  ${where}: jsonb appears twice in 2 061 columns. Prefer real columns unless the payload is genuinely opaque.`
        );
    }
    return arg ? `${out}(${arg})` : out;
};

const checkIdent = (name, where) => {
    if (!name) return fail(`${where}: missing name`);
    if (/[A-Z]/.test(name))
        fail(`${where}: "${name}" has an uppercase letter — no table name and none of the 2 061 columns do. For a column, the name is the exact JSON key the frontend receives.`);
    if (name.includes('_'))
        fail(`${where}: "${name}" has an underscore — no table name does, and only 1.2% of columns do, all inside two named legacy pockets (D1).`);
    if (!/^[a-z][a-z0-9]*$/.test(name.replace(/_/g, '').replace(/[A-Z]/g, 'a')))
        fail(`${where}: "${name}" is not a plain lowercase identifier`);
};

/** `warehousemaster` -> `warehouse`; `usermaster` -> `user`. */
const entityOf = (table) => table.replace(/(master|lineitem|map|log|history)$/, '') || table;

/**
 * FK constraint name, derived from the COLUMN rather than the target table.
 *
 * For the common case they are the same — `warehouseid` -> `fk_x_warehouse`,
 * pointing at `warehousemaster`. They diverge exactly where the schema's own
 * rule says to qualify the prefix: two FKs to `warehousemaster` become
 * `fk_x_fromwarehouse` and `fk_x_towarehouse` rather than one duplicated name,
 * which Postgres would reject.
 */
const fkName = (table, column, target) =>
    `fk_${table}_${column.replace(/id$/, '') || entityOf(target)}`;

/** `organizationid` -> `org` in an index name; the schema abbreviates it everywhere. */
const indexPart = (column) =>
    column.split(' ')[0].replace(/^organizationid$/, 'org').replace(/^isdeleted$/, '');

/** The default rendered the way pg writes it back, so a re-dump is a no-op diff. */
const renderDefault = (value, type) => {
    const v = String(value);
    if (/^'.*'$/.test(v) && type.startsWith('character varying')) return `${v}::character varying`;
    return v;
};

/**
 * One column, as `{ text, comment }`.
 *
 * The comment is kept separate because it has to land AFTER the comma — a
 * trailing `-- …` before the separator swallows it, and the whole CREATE TABLE
 * fails to parse.
 */
const renderColumn = (col, widths) => {
    const tail = [];
    if (col.default !== undefined && col.default !== null)
        tail.push(`DEFAULT ${renderDefault(col.default, col.type)}`);
    if (col.notNull) tail.push('NOT NULL');
    if (col.pk) tail.push('PRIMARY KEY');
    const text =
        `    ${col.name.padEnd(widths.name)} ${col.type.padEnd(widths.type)}` +
        (tail.length ? ` ${tail.join(' ')}` : '');
    return { text: text.replace(/\s+$/, ''), comment: col.comment };
};

/** Join column and constraint lines, commas first, then any trailing comment. */
const joinBody = (items, width) =>
    items
        .map((item, i) => {
            const line = `${item.text}${i < items.length - 1 ? ',' : ''}`;
            return item.comment ? `${line.padEnd(width)}  -- ${item.comment}` : line;
        })
        .join('\n');

const buildStates = (table, col, abbrev) => {
    for (const token of col.states) {
        if (!/^[a-z][a-z0-9_]*$/.test(token))
            fail(
                `${table}.${col.name}: state "${token}" is not lower_snake_case. The three uppercase exceptions in the schema are all external codes (GET/POST, FIFO, LMV).`
            );
    }
    const values = col.states.map((s) => `        '${s}'::character varying`).join(',\n');
    return {
        text:
            `    CONSTRAINT chk_${abbrev}_${col.name} CHECK (((${col.name})::text = ANY ((ARRAY[\n` +
            `${values}])::text[])))`,
    };
};

const buildTable = (spec, table) => {
    const shapeKey = String(table.shape || '').toLowerCase();
    const shape = SHAPES[shapeKey];
    if (!shape) {
        fail(`${table.table || '(unnamed)'}: shape must be one of ${Object.keys(SHAPES).join(' | ')}`);
        return null;
    }
    checkIdent(table.table, 'table');
    const name = table.table;
    const abbrev = table.abbrev || entityOf(name);
    const tenancy = table.tenancy !== undefined ? Boolean(table.tenancy) : shape.tenancy;
    const isactive = table.isactive !== undefined ? Boolean(table.isactive) : shape.isactive;
    const appendOnly = table.appendOnly !== undefined ? Boolean(table.appendOnly) : Boolean(shape.appendOnly);

    const cols = [];
    const constraints = [];
    const indexes = [];

    cols.push({ name: 'id', type: shape.pk, pk: true });

    if (tenancy) {
        cols.push({
            name: 'organizationid',
            type: 'integer',
            notNull: true,
            comment: shapeKey === 'lineitem' ? 'carried on children too (D5)' : undefined,
        });
        constraints.push({
            text:
                `    CONSTRAINT fk_${name}_org FOREIGN KEY (organizationid)\n` +
                `        REFERENCES public.organizationmaster(id)`,
        });
        // An append-only table has no `isdeleted` to index on, so the tenant
        // index leads with the only thing it is ever scanned by instead.
        indexes.push(
            `CREATE INDEX IF NOT EXISTS idx_${name}_org\n` +
                `    ON public.${name} (organizationid, ${appendOnly ? 'createdat DESC' : 'isdeleted'});`
        );
    }

    if (shapeKey === 'lineitem') {
        if (!table.parent) fail(`${name}: a lineitem shape needs "parent"`);
        else {
            const parentCol = `${entityOf(table.parent)}id`;
            cols.splice(1, 0, {
                name: parentCol,
                type: 'bigint',
                notNull: true,
                comment: 'parent, always first after id',
            });
            constraints.push({
                text:
                    `    CONSTRAINT fk_${name}_parent FOREIGN KEY (${parentCol})\n` +
                    `        REFERENCES public.${table.parent}(id)`,
            });
            indexes.push(
                `CREATE INDEX IF NOT EXISTS idx_${name}_parent\n    ON public.${name} (${parentCol}) WHERE isdeleted = 0;`
            );
        }
    }

    for (const raw of table.columns || []) {
        checkIdent(raw.name, `${name}.${raw.name || '(unnamed)'}`);
        const type = longType(raw.type, `${name}.${raw.name}`);
        if (/^(is|can|allow|auto|has)[a-z]/.test(raw.name || '') && type !== 'smallint')
            fail(
                `${name}.${raw.name}: a flag column is \`int2\` holding 0/1 (223 columns), not ${type}.`
            );
        cols.push({
            name: raw.name,
            type,
            notNull: Boolean(raw.notNull),
            default: raw.default,
            comment: raw.comment,
        });
        if (raw.references) {
            checkIdent(raw.references, `${name}.${raw.name} references`);
            constraints.push({
                text:
                    `    CONSTRAINT ${fkName(name, raw.name, raw.references)} FOREIGN KEY (${raw.name})\n` +
                    `        REFERENCES public.${raw.references}(id)`,
            });
        }
        if (raw.states) constraints.push(buildStates(name, { ...raw, name: raw.name }, abbrev));
        else if (/status$/.test(raw.name || ''))
            console.error(
                `  note  ${name}.${raw.name}: no "states" given, so no CHECK was written. 22 unguarded status columns is deviation D9 — add one.`
            );
    }

    if (isactive)
        cols.push({
            name: 'isactive',
            type: 'smallint',
            default: '1',
            notNull: true,
            comment: '0 = kept for history, not offered for new use',
        });

    cols.push(...(appendOnly ? APPEND_ONLY_BLOCK : AUDIT_BLOCK).map((c) => ({ ...c })));

    for (const chk of table.checks || []) {
        if (!chk.name || !chk.expr) fail(`${name}: each check needs "name" and "expr"`);
        else constraints.push({ text: `    CONSTRAINT ${chk.name} CHECK (${chk.expr})` });
    }

    const colNames = new Set(cols.map((c) => c.name));
    if (table.codeColumn) {
        if (!colNames.has(table.codeColumn))
            fail(`${name}: codeColumn "${table.codeColumn}" is not one of the columns`);
        const cols2 = tenancy ? `organizationid, ${table.codeColumn}` : table.codeColumn;
        if (table.uniqueForever)
            constraints.push({
                text: `    CONSTRAINT uq_${abbrev}_${table.codeColumn} UNIQUE (${cols2})`,
            });
        else
            indexes.push(
                `-- Partial, so the value can be re-used after a soft delete.\n` +
                    `-- A document number must never be reissued — for one of those, set "uniqueForever": true.\n` +
                    `CREATE UNIQUE INDEX IF NOT EXISTS uq_${abbrev}_${tenancy ? 'org_' : ''}${table.codeColumn}\n` +
                    `    ON public.${name} (${cols2}) WHERE isdeleted = 0;`
            );
    }

    // A junction table's whole point is that the pair is unique. Partial, so the
    // pair can be re-created after a soft delete — set "uniqueForever" if it
    // must never recur.
    if (table.pair) {
        for (const c of table.pair)
            if (!colNames.has(c)) fail(`${name}: pair column "${c}" is not one of the columns`);
        if (table.uniqueForever)
            constraints.push({
                text: `    CONSTRAINT uq_${abbrev}_pair UNIQUE (${table.pair.join(', ')})`,
            });
        else
            indexes.push(
                `CREATE UNIQUE INDEX IF NOT EXISTS uq_${abbrev}_pair\n` +
                    `    ON public.${name} (${table.pair.join(', ')}) WHERE isdeleted = 0;`
            );
    } else if (shapeKey === 'map' && !(table.indexes || []).some((i) => i.unique)) {
        console.error(
            `  note  ${name}: a junction table with no unique pair. Give it "pair": ["<a>id", "<b>id"], or the same row can be inserted twice.`
        );
    }

    for (const idx of table.indexes || []) {
        const list = (idx.columns || []).join(', ');
        if (!list) {
            fail(`${name}: an index needs "columns"`);
            continue;
        }
        for (const c of idx.columns)
            if (!colNames.has(c.split(' ')[0]))
                fail(`${name}: index column "${c}" is not one of the columns`);
        const suffix = idx.columns.map(indexPart).filter(Boolean).join('_');
        const idxName = idx.name || `${idx.unique ? 'uq' : 'idx'}_${name}_${suffix}`;
        if (idxName.length > 63)
            fail(
                `${name}: index name "${idxName}" is over PostgreSQL's 63-character limit and would be silently truncated. Give the index an explicit "name".`
            );
        // `partial` is opt-in: the tenant index already carries isdeleted, and the
        // document indexes in the schema are plain.
        indexes.push(
            `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${idxName}\n` +
                `    ON public.${name} (${list})${idx.partial && !appendOnly ? ' WHERE isdeleted = 0' : ''};`
        );
    }

    // Two constraints with the same name is a hard PostgreSQL error, and the
    // usual cause is two FKs to one target — which the naming rule already
    // answers by qualifying the prefix.
    const seen = new Set();
    for (const c of constraints) {
        const cn = (c.text.match(/CONSTRAINT\s+(\w+)/) || [])[1];
        if (!cn) continue;
        if (seen.has(cn))
            fail(`${name}: two constraints are both named "${cn}" — PostgreSQL rejects that.`);
        seen.add(cn);
    }

    const widths = {
        name: Math.max(...cols.map((c) => c.name.length)),
        type: Math.max(...cols.map((c) => c.type.length)),
    };
    // Where trailing comments start: past the longest column line, plus its comma.
    widths.line =
        Math.max(
            ...cols.map((c) => renderColumn(c, { name: widths.name, type: widths.type }).text.length)
        ) + 1;

    const header = appendOnly
        ? `-- Append-only: rows are never updated and never retracted, so this table\n-- deliberately omits updatedby / updatedat / isdeleted.\n`
        : '';

    const body = joinBody(
        [...cols.map((c) => renderColumn(c, widths)), ...constraints],
        widths.line
    );

    return {
        name,
        ddl: `${header}CREATE TABLE IF NOT EXISTS public.${name} (\n${body}\n);`,
        indexes,
    };
};

const main = () => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.spec) {
        console.error('usage: new-table.js --spec <spec.json> [--out <migrations-dir>] [--stdout]');
        process.exit(2);
    }
    let spec;
    try {
        spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
    } catch (err) {
        console.error(`Cannot read spec: ${err.message}`);
        process.exit(2);
    }

    const list = Array.isArray(spec.tables) ? spec.tables : [spec];
    const built = list.map((t) => buildTable(spec, t)).filter(Boolean);

    if (errors.length) {
        console.error('\nThe spec breaks house rules — nothing was written:\n');
        for (const e of errors) console.error(`  ✗ ${e}`);
        console.error('\nSee references/conventions.md for the rule and its adherence count.\n');
        process.exit(1);
    }

    const first = list[0] || {};
    const stamp =
        spec.date ||
        first.date ||
        new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const topic =
        spec.topic ||
        first.topic ||
        built.map((b) => b.name).join('_').slice(0, 60) ||
        'new_table';
    const title = spec.title || first.title || built.map((b) => b.name).join(', ');
    const author = spec.author || first.author || 'TODO';
    const why = spec.why || first.why || 'TODO — why this table exists, in one or two lines.';
    const neutral =
        spec.neutral ||
        first.neutral ||
        'Yes. Nothing reads these tables until the API ships.';
    const decisions = spec.decisions || first.decisions || ['TODO — what was decided, and by whom'];

    const rollback = built
        .slice()
        .reverse()
        .flatMap((b) => [
            ...b.indexes
                .filter((i) => i.includes('CREATE'))
                .map((i) => {
                    const n = (i.match(/INDEX IF NOT EXISTS (\w+)/) || [, ''])[1];
                    return n ? `-- DROP INDEX IF EXISTS public.${n};` : null;
                })
                .filter(Boolean),
            `-- DROP TABLE IF EXISTS public.${b.name};`,
        ])
        .join('\n');

    const tmpl = fs.readFileSync(
        path.join(__dirname, '..', 'templates', 'migration.sql.tmpl'),
        'utf8'
    );

    const sql = tmpl
        .replace('{{TITLE}}', title)
        .replace('{{WHY}}', why)
        .replace(
            '--   - {{DECISION}}    ({{AUTHOR}})',
            decisions.map((d) => `--   - ${d}  (${author})`).join('\n')
        )
        .replace('{{NEUTRAL}}', neutral)
        .replace('{{TABLES}}', built.map((b) => b.ddl).join('\n\n'))
        .replace('{{INDEXES}}', built.flatMap((b) => b.indexes).join('\n\n'))
        .replace('{{ROLLBACK}}', rollback);

    if (args.stdout || !args.out) {
        process.stdout.write(sql);
        return;
    }

    const file = path.join(args.out, `${stamp}_${topic}.sql`);
    if (fs.existsSync(file)) {
        console.error(`Refusing to overwrite ${file}`);
        process.exit(1);
    }
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(file, sql);

    console.log(`\nWrote ${file}`);
    console.log(`  ${built.length} table(s): ${built.map((b) => b.name).join(', ')}`);
    console.log('\nNot finished — this is correct-shaped DDL, not a finished design:');
    console.log('  1. Fill in the WHY and DECISIONS in the header block.');
    console.log('  2. Add the business-invariant CHECKs (non-negativity, date ordering,');
    console.log('     mutual exclusion) — a generator cannot infer them.');
    console.log('  3. Add an index per hot filter the API will actually run.');
    console.log('  4. Check the rollback section.');
    console.log(`\nThen: node ${path.relative(process.cwd(), path.join(__dirname, 'verify-ddl.js'))} ${file}`);
    console.log('And hand the apply command to the user — there is no migration runner.\n');
};

main();
