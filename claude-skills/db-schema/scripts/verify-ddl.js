#!/usr/bin/env node
/**
 * Checks a migration against the house rules in references/conventions.md.
 *
 *   node verify-ddl.js <file.sql>  [--dialect postgres|mysql|mssql|sqlite]
 *   node verify-ddl.js <file.collection.json>          (MongoDB collection spec)
 *
 * ERROR = a [must] rule is broken. WARN = a [default] rule, fix it or explain it.
 * Exit code 1 when there is at least one ERROR. No dependencies; never connects
 * to a database. It reads SQL with regular expressions, so it checks the shapes
 * this skill writes, not every possible SQL statement.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LADDER = [20, 30, 50, 64, 100, 150, 200, 255, 500];
const AUDIT = ['createdby', 'createdat', 'updatedby', 'updatedat', 'isdeleted'];
const APPEND_ONLY_AUDIT = ['createdby', 'createdat'];
const NAME_RE = /^[a-z][a-z0-9]*$/;
const BOOL_NAME_RE = /^(is|can|allow|has)[a-z0-9]+$/;

const findings = [];
const err = (rule, where, msg) => findings.push({ level: 'ERROR', rule, where, msg });
const warn = (rule, where, msg) => findings.push({ level: 'WARN', rule, where, msg });

// usermaster -> userid; invoicelineitem -> invoicelineitemid
const expectedPk = (table) => table.replace(/master$/, '') + 'id';

// ---------------------------------------------------------------- SQL helpers

// Replace comments with spaces so character positions stay the same.
function blankComments(sql) {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < sql.length) {
        const c = sql[i];
        const n = sql[i + 1];
        if (quote) {
            out += c;
            if (c === quote) quote = null;
            i++;
        } else if (c === "'") {
            quote = c;
            out += c;
            i++;
        } else if (c === '-' && n === '-') {
            while (i < sql.length && sql[i] !== '\n') {
                out += ' ';
                i++;
            }
        } else if (c === '/' && n === '*') {
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                out += sql[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += '  ';
            i += 2;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

const unquote = (name) => {
    const last = name.trim().split('.').pop();
    return last.replace(/^[`"[]|[`"\]]$/g, '');
};

function splitTopLevel(body) {
    const parts = [];
    let depth = 0;
    let cur = '';
    let quote = null;
    for (const c of body) {
        if (quote) {
            cur += c;
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'") {
            quote = c;
            cur += c;
            continue;
        }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === ',' && depth === 0) {
            parts.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

function matchParen(text, openIdx) {
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'") {
            quote = c;
            continue;
        }
        if (c === '(') depth++;
        if (c === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function detectDialect(sql) {
    if (/`|AUTO_INCREMENT|ENGINE\s*=/i.test(sql)) return 'mysql';
    if (/IDENTITY\s*\(|NVARCHAR|\bGO\b|OBJECT_ID\s*\(|SYSDATETIME/i.test(sql)) return 'mssql';
    if (/AUTOINCREMENT|PRAGMA/i.test(sql)) return 'sqlite';
    return 'postgres';
}

const CONSTRAINT_START =
    /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|KEY|INDEX|EXCLUDE)\b/i;

// ------------------------------------------------------------ column checks

function checkColumn(table, name, def, dialect) {
    const where = `${table}.${name}`;
    const d = def.toLowerCase();
    if (!NAME_RE.test(name))
        err('R1', where, 'column name must be lowercase letters/digits, no separators');

    if (/\b(boolean|bool)\b/.test(d) || /^\s*bit\b/.test(d) || /tinyint\s*\(\s*1\s*\)/.test(d)) {
        err('R13', where, 'booleans are smallint 0/1, not a boolean/bit/tinyint(1) type');
    }
    if (/timestamptz|with\s+time\s+zone/.test(d))
        err('R17', where, 'timestamps are without time zone');
    if (dialect === 'mysql' && /^\s*timestamp\b/.test(d))
        err('R17', where, 'MySQL: use datetime, not the TIMESTAMP type (it converts time zones)');
    if (/\benum\s*\(/.test(d)) err('R15', where, 'no ENUM types: varchar + CHECK');
    if (/on\s+update\s+current_timestamp/.test(d))
        err('R12', where, 'no ON UPDATE CURRENT_TIMESTAMP: the app sets updatedat');
    if (/\b(n?varchar|character\s+varying)\b(?!\s*\()/.test(d))
        err('R18', where, 'varchar must have a length from the ladder');
    const len = d.match(/\b(?:n?varchar|character\s+varying)\s*\(\s*(\d+)\s*\)/);
    if (len && !LADDER.includes(Number(len[1])))
        warn('R18', where, `varchar(${len[1]}) is not on the ladder ${LADDER.join('/')}`);
    if (/\bjsonb?\b/.test(d))
        warn('R19', where, 'JSON column: ask for the fields and make them real columns');

    const isSmallint = /^\s*(smallint|int2)\b/.test(d);
    if (BOOL_NAME_RE.test(name) && !isSmallint)
        err('R13', where, `"${name}" reads as a flag, so it must be smallint 0/1`);
    if (name === 'isactive' && !(isSmallint && /default\s+1\b/.test(d) && /not\s+null/.test(d))) {
        err('R14', where, 'isactive must be smallint DEFAULT 1 NOT NULL');
    }
    if (name === 'status' && !/^\s*(n?varchar|character\s+varying)\s*\(\s*(20|30)\s*\)/.test(d)) {
        warn('R15', where, 'status is usually varchar(20) or varchar(30)');
    }
}

function checkAuditColumn(table, name, def) {
    const where = `${table}.${name}`;
    const d = def.toLowerCase();
    const notNull = /not\s+null/.test(d);
    if (name === 'createdby' || name === 'updatedby') {
        if (!/^\s*(integer|int|int4)\b/.test(d) || !/default\s+1\b/.test(d) || !notNull)
            err('R7', where, 'must be integer DEFAULT 1 NOT NULL');
    } else if (name === 'createdat' || name === 'updatedat') {
        const typeOk = /^\s*(timestamp|datetime2?)\b/.test(d) && !/time\s+zone|timestamptz/.test(d);
        const defOk = /default\s+(now\(\)|current_timestamp|sysdatetime\(\)|getdate\(\))/.test(d);
        if (!typeOk || !defOk || !notNull)
            err('R7', where, 'must be timestamp DEFAULT now() NOT NULL (dialect spelling allowed)');
    } else if (name === 'isdeleted') {
        if (!/^\s*(smallint|int2)\b/.test(d) || !/default\s+0\b/.test(d) || !notNull)
            err('R7', where, 'must be smallint DEFAULT 0 NOT NULL');
    }
}

function checkForeignKey(table, col, target, targetCol, tail) {
    const where = `${table}.${col}`;
    const t = unquote(target);
    const tc = unquote(targetCol);
    if (tc !== expectedPk(t) && t !== 'sequencemaster')
        err(
            'R6',
            where,
            `must reference ${t}(${expectedPk(t)}), the target's primary key, not ${t}(${tc})`
        );
    const pk = expectedPk(t);
    const nameOk = col === pk || col.endsWith(pk) || (t === 'usermaster' && /by$/.test(col));
    if (!nameOk)
        err(
            'R5',
            where,
            `a link to ${t} should be named ${pk} (or <qualifier>${pk}${t === 'usermaster' ? ', or <verb>by' : ''})`
        );
    if (/on\s+(delete|update)\s+(cascade|set\s+null|set\s+default)/i.test(tail))
        err('R11', where, 'no cascades: remove ON DELETE/ON UPDATE action');
}

// ------------------------------------------------------------- SQL: tables

function checkTable(raw, clean, start, tableName, body, dialect, wholeClean) {
    const table = unquote(tableName);
    if (!NAME_RE.test(table))
        err('R1', table, 'table name must be lowercase letters/digits, no separators');

    // append-only: name ends in "log", or an "append-only" comment on the lines directly above
    const above = raw.slice(0, start).split('\n');
    above.pop(); // the part of the CREATE line before "CREATE"
    const comment = [];
    while (above.length && /^\s*--/.test(above[above.length - 1])) comment.push(above.pop());
    const appendOnly = /log$/.test(table) || /append-only/i.test(comment.join('\n'));

    const items = splitTopLevel(body);
    const columns = [];
    const constraints = [];
    for (const item of items) {
        if (CONSTRAINT_START.test(item)) constraints.push(item);
        else {
            const m = item.match(/^([`"[]?[A-Za-z0-9_]+[`"\]]?)\s+([\s\S]*)$/);
            if (m) columns.push({ name: unquote(m[1]), def: m[2] });
        }
    }
    const names = columns.map((c) => c.name);

    // R3 primary key
    const pkCols = columns.filter((c) => /primary\s+key/i.test(c.def)).map((c) => c.name);
    for (const c of constraints) {
        const m = c.match(/primary\s+key\s*\(([^)]*)\)/i);
        if (m) pkCols.push(...m[1].split(',').map(unquote));
    }
    const pk = expectedPk(table);
    if (pkCols.length === 0) err('R3', table, `no primary key; expected ${pk}`);
    else if (pkCols.length > 1)
        err(
            'R3',
            table,
            `composite primary key (${pkCols.join(', ')}); expected single column ${pk}`
        );
    else if (pkCols[0] !== pk) err('R3', table, `primary key is "${pkCols[0]}"; expected "${pk}"`);

    // R7 / R8 audit block
    const want = appendOnly ? APPEND_ONLY_AUDIT : AUDIT;
    const tail = names.slice(-want.length);
    if (tail.join(',') !== want.join(',')) {
        err(
            appendOnly ? 'R8' : 'R7',
            table,
            `last columns must be ${want.join(', ')}${appendOnly ? ' (append-only table)' : ''}; found ${tail.join(', ') || 'none'}`
        );
    }
    if (appendOnly) {
        for (const extra of ['updatedby', 'updatedat', 'isdeleted']) {
            if (names.includes(extra))
                err(
                    'R8',
                    table,
                    `append-only table must not have ${extra} (or drop the append-only marking)`
                );
        }
    }
    for (const c of columns) {
        if (AUDIT.includes(c.name)) checkAuditColumn(table, c.name, c.def);
        else checkColumn(table, c.name, c.def, dialect);
    }

    // R14 isactive needs isdeleted
    if (names.includes('isactive') && !names.includes('isdeleted'))
        err('R14', table, 'a table with isactive must also have isdeleted');

    // CHECK coverage: status (R15) and flags (R13)
    const tableChecks =
        constraints.filter((c) => /\bcheck\s*\(/i.test(c)).join('\n') +
        columns
            .filter((c) => /\bcheck\s*\(/i.test(c.def))
            .map((c) => `${c.name} ${c.def}`)
            .join('\n');
    const alterChecks = [
        ...wholeClean.matchAll(
            new RegExp(`ALTER\\s+TABLE\\s+[^;]*\\b${table}\\b[^;]*CHECK\\s*\\(([^;]*)`, 'gi')
        ),
    ]
        .map((m) => m[1])
        .join('\n');
    const allChecks = (tableChecks + '\n' + alterChecks).toLowerCase();
    if (names.includes('status') && !/\bstatus\b/.test(allChecks))
        err(
            'R15',
            `${table}.status`,
            'every status column needs a CHECK listing its allowed values'
        );
    for (const n of names) {
        if (
            BOOL_NAME_RE.test(n) &&
            !new RegExp(`\\b${n}\\b[^,]*in\\s*\\(\\s*0\\s*,\\s*1\\s*\\)`).test(allChecks)
        ) {
            warn('R13', `${table}.${n}`, 'add CHECK (... IN (0, 1))');
        }
    }

    // foreign keys: inline and table-level
    for (const c of columns) {
        const m = c.def.match(/references\s+([^\s(]+)\s*\(\s*([^)\s]+)\s*\)([\s\S]*)/i);
        if (m) {
            checkForeignKey(table, c.name, m[1], m[2], m[3]);
            warn(
                'R21',
                `${table}.${c.name}`,
                `name the foreign key: CONSTRAINT fk_${table}_${unquote(m[1]).replace(/master$/, '')} FOREIGN KEY ...`
            );
        }
    }
    for (const c of constraints) {
        const m = c.match(
            /foreign\s+key\s*\(\s*([^)]+)\)\s*references\s+([^\s(]+)\s*\(\s*([^)\s]+)\s*\)([\s\S]*)/i
        );
        if (m) checkForeignKey(table, unquote(m[1]), m[2], m[3], m[4]);
        const named = c.match(
            /^constraint\s+([^\s]+)\s+(primary\s+key|foreign\s+key|unique|check|exclude)/i
        );
        if (named) {
            const [, cname, kind] = named;
            const prefix = { 'foreign key': 'fk_', unique: 'uq_', check: 'chk_' }[
                kind.toLowerCase().replace(/\s+/, ' ')
            ];
            if (prefix && !unquote(cname).startsWith(prefix))
                warn('R21', table, `constraint ${cname} should start with ${prefix}`);
        } else if (/^(foreign\s+key|check|unique)/i.test(c)) {
            warn('R21', table, `name this constraint by hand: ${c.slice(0, 60)}`);
        }
    }
    return { table, names };
}

function verifySql(file, dialectArg) {
    const raw = fs.readFileSync(file, 'utf8');
    const clean = blankComments(raw);
    const dialect = dialectArg || detectDialect(clean);
    const tables = {};

    const re = /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/gi;
    let m;
    while ((m = re.exec(clean))) {
        const open = m.index + m[0].length - 1;
        const close = matchParen(clean, open);
        if (close < 0) {
            err('PARSE', unquote(m[2]), 'unbalanced parentheses');
            continue;
        }
        if (!m[1] && dialect !== 'mssql')
            warn(
                'R23',
                unquote(m[2]),
                'use CREATE TABLE IF NOT EXISTS so the migration can be re-run'
            );
        const info = checkTable(
            raw,
            clean,
            m.index,
            m[2],
            clean.slice(open + 1, close),
            dialect,
            clean
        );
        tables[info.table] = info.names;
        re.lastIndex = close;
    }

    // ALTER TABLE ... ADD [COLUMN] [IF NOT EXISTS] name def
    const addRe =
        /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s]+)\s+ADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b)([`"[]?[A-Za-z0-9_]+[`"\]]?)\s+([^;]*)/gi;
    while ((m = addRe.exec(clean))) {
        const table = unquote(m[1]);
        const name = unquote(m[4]);
        if (/^(primary|foreign|unique|check|index|key)$/i.test(name)) continue;
        checkColumn(table, name, m[5], dialect);
        if (!m[3] && dialect === 'postgres')
            warn('R23', `${table}.${name}`, 'use ADD COLUMN IF NOT EXISTS');
        if (/not\s+null/i.test(m[5]) && !/default/i.test(m[5]))
            warn(
                'R24',
                `${table}.${name}`,
                'NOT NULL without DEFAULT fails on a table that already has rows'
            );
    }

    // file-level rules
    if (/CREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/i.test(clean))
        err('R12', path.basename(file), 'no triggers: the app maintains every value');
    if (/CREATE\s+TYPE\s+[^;]*\bAS\s+ENUM\b/i.test(clean))
        err('R15', path.basename(file), 'no ENUM types: varchar + CHECK');
    if (/\bDELETE\s+FROM\b/i.test(clean))
        err('R10', path.basename(file), 'no DELETE: soft delete with UPDATE ... SET isdeleted = 1');
    if (/\bTRUNCATE\b/i.test(clean))
        err('R10', path.basename(file), 'no TRUNCATE: soft delete only');

    const idxRe =
        /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?([^\s]+)\s+ON\s+([^\s(]+)([^;]*)/gi;
    while ((m = idxRe.exec(clean))) {
        const [, unique, , ifne, iname, itable, rest] = m;
        const name = unquote(iname);
        const table = unquote(itable);
        const want = unique ? 'uq_' : 'idx_';
        if (!name.startsWith(want))
            warn('R21', name, `${unique ? 'unique ' : ''}index name should start with ${want}`);
        if (!ifne && (dialect === 'postgres' || dialect === 'sqlite'))
            warn('R23', name, 'use CREATE INDEX IF NOT EXISTS');
        const hasDeleted = (tables[table] || []).includes('isdeleted');
        const liveOnly = /isdeleted\s*=\s*0/i.test(rest);
        if (unique && hasDeleted && !liveOnly) {
            warn(
                'R20',
                name,
                'unique index includes deleted rows; add WHERE isdeleted = 0 (MySQL: CASE WHEN isdeleted = 0 ...) unless numbers must never be reused'
            );
        }
    }

    if (!/rollback/i.test(raw))
        warn('R23', path.basename(file), 'add a commented ROLLBACK section at the end');
    if (!Object.keys(tables).length && !/ALTER\s+TABLE/i.test(clean))
        warn('PARSE', path.basename(file), 'no CREATE TABLE or ALTER TABLE found');
    return { dialect, count: Object.keys(tables).length };
}

// ---------------------------------------------------------------- MongoDB spec

function verifyMongo(file) {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const coll = spec.collection;
    const fields = spec.fields || {};
    const names = Object.keys(fields);
    const indexes = spec.indexes || [];
    if (!coll || !NAME_RE.test(coll))
        err('R1', String(coll), 'collection name must be lowercase letters/digits, no separators');

    for (const n of names)
        if (n !== '_id' && !NAME_RE.test(n))
            err('R1', `${coll}.${n}`, 'field name must be lowercase letters/digits, no separators');

    // R3 key
    const pk = expectedPk(coll || '');
    if (coll === 'sequencemaster') {
        if (spec.primarykey !== 'sequencename')
            err('R3', coll, 'sequencemaster is keyed by sequencename');
    } else if (spec.primarykey !== pk) {
        err('R3', coll, `primarykey is "${spec.primarykey}"; expected "${pk}"`);
    }
    const pkField = fields[spec.primarykey];
    if (!pkField) err('R3', coll, `primary key field "${spec.primarykey}" is not in fields`);
    else if (
        coll !== 'sequencemaster' &&
        (!['int', 'long'].includes(pkField.type) || !pkField.required)
    ) {
        err('R3', `${coll}.${spec.primarykey}`, 'house key must be a required int or long');
    }
    const uniqueOn = (f) =>
        indexes.some(
            (ix) =>
                ix.unique &&
                Object.keys(ix.keys || {}).length === 1 &&
                Object.keys(ix.keys)[0] === f
        );
    if (pkField && !uniqueOn(spec.primarykey))
        err('R3', coll, `add a unique index on ${spec.primarykey}`);

    // R7 / R8
    const appendOnly = spec.appendonly === true || /log$/.test(coll || '');
    const want = appendOnly ? APPEND_ONLY_AUDIT : AUDIT;
    const tail = names.slice(-want.length);
    if (tail.join(',') !== want.join(','))
        err(
            appendOnly ? 'R8' : 'R7',
            coll,
            `last fields must be ${want.join(', ')}; found ${tail.join(', ')}`
        );
    if (appendOnly)
        for (const x of ['updatedby', 'updatedat', 'isdeleted'])
            if (fields[x]) err('R8', coll, `append-only collection must not have ${x}`);
    const audit = {
        createdby: { type: 'int', default: 1 },
        updatedby: { type: 'int', default: 1 },
        createdat: { type: 'date', default: 'now' },
        updatedat: { type: 'date', default: 'now' },
        isdeleted: { type: 'int', default: 0 },
    };
    for (const [n, a] of Object.entries(audit)) {
        const f = fields[n];
        if (!f) continue;
        if (f.type !== a.type || f.default !== a.default || !f.required)
            err('R7', `${coll}.${n}`, `must be ${a.type}, default ${a.default}, required`);
    }
    if (fields.isdeleted && JSON.stringify(fields.isdeleted.enum) !== '[0,1]')
        err('R13', `${coll}.isdeleted`, 'enum must be [0, 1]');

    for (const [n, f] of Object.entries(fields)) {
        const where = `${coll}.${n}`;
        if (!['int', 'long', 'decimal', 'string', 'date', 'array', 'object'].includes(f.type))
            err(
                'TYPE',
                where,
                `unknown or forbidden type "${f.type}"${f.type === 'bool' ? ' (R13: booleans are int 0/1)' : ''}`
            );
        if (f.type === 'object')
            warn('R19', where, 'free-form object: ask for the fields and make them real fields');
        if (f.type === 'double') err('R18', where, 'money/decimals are decimal, never double');
        if (BOOL_NAME_RE.test(n)) {
            if (
                f.type !== 'int' ||
                JSON.stringify(f.enum) !== '[0,1]' ||
                f.default === undefined ||
                !f.required
            ) {
                err('R13', where, 'flag must be int, enum [0, 1], with a default, required');
            }
        }
        if (n === 'isactive' && f.default !== 1) err('R14', where, 'isactive defaults to 1');
        if (n === 'status' && (f.type !== 'string' || !Array.isArray(f.enum)))
            err('R15', where, 'status must be a string with an enum of allowed values');
        if (f.type === 'string' && !f.enum && !f.pattern && f.maxlength === undefined)
            warn(
                'R18',
                where,
                'give strings a maxlength from the ladder (omit only for long text)'
            );
        if (f.maxlength !== undefined && !LADDER.includes(f.maxlength))
            warn('R18', where, `maxlength ${f.maxlength} is not on the ladder ${LADDER.join('/')}`);
        if (/date$/.test(n) && f.type === 'date')
            warn(
                'R17',
                where,
                'business dates are string YYYY-MM-DD; use type date only for event times (*at)'
            );
        if (f.ref) {
            const rpk = expectedPk(f.ref);
            const ok = n === rpk || n.endsWith(rpk) || (f.ref === 'usermaster' && /by$/.test(n));
            if (!ok)
                err(
                    'R5',
                    where,
                    `a link to ${f.ref} should be named ${rpk} (or <qualifier>${rpk})`
                );
            if (!indexes.some((ix) => Object.keys(ix.keys || {})[0] === n))
                warn('R21', where, 'index every link field');
        }
    }
    if (fields.isactive && !fields.isdeleted)
        err('R14', coll, 'a collection with isactive must also have isdeleted');

    for (const ix of indexes) {
        const want2 = ix.unique ? 'uq_' : 'idx_';
        if (!ix.name || !ix.name.startsWith(want2))
            warn('R21', String(ix.name), `index name should start with ${want2}`);
        const key0 = Object.keys(ix.keys || {})[0];
        if (
            ix.unique &&
            key0 !== spec.primarykey &&
            fields.isdeleted &&
            !(ix.partialFilterExpression && ix.partialFilterExpression.isdeleted === 0)
        ) {
            warn(
                'R20',
                String(ix.name),
                'unique index includes deleted rows; add partialFilterExpression { isdeleted: 0 }'
            );
        }
    }
    return { dialect: 'mongodb', count: 1 };
}

// ------------------------------------------------------------------- main

function main() {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--dialect');
    const di = args.indexOf('--dialect');
    const dialect = di >= 0 ? args[di + 1] : null;
    if (!file) {
        console.error(
            'usage: node verify-ddl.js <file.sql | file.collection.json> [--dialect postgres|mysql|mssql|sqlite]'
        );
        process.exit(2);
    }
    const result = file.endsWith('.json') ? verifyMongo(file) : verifySql(file, dialect);
    const errors = findings.filter((f) => f.level === 'ERROR');
    const warns = findings.filter((f) => f.level === 'WARN');
    for (const f of [...errors, ...warns])
        console.log(`${f.level.padEnd(5)} ${f.rule.padEnd(5)} ${f.where}: ${f.msg}`);
    console.log(
        `\n${path.basename(file)} (${result.dialect}, ${result.count} table(s)): ${errors.length} error(s), ${warns.length} warning(s)`
    );
    process.exit(errors.length ? 1 : 0);
}

main();
