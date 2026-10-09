/**
 * Create a dashboard ADMIN account from the terminal.
 *
 *   pnpm create-admin
 *
 * Asks for username, full name and password (typed hidden, entered twice). The
 * password is hashed with bcrypt before it reaches the database and is never
 * written to a file or log. Run once per environment, after `pnpm migrate`.
 */

import 'dotenv/config';

import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

import { pool } from '../src/config/database.js';
import { UserModel } from '../src/models/auth/user.model.js';
import { hashPassword, normaliseUsername } from '../src/services/auth.service.js';
import { isUniqueViolation } from '../src/utils/pgError.js';

// Policy for this script (Proposed, confirm with the TL): NIST SP 800-63B minimum.
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

function ask(question: string, hidden = false): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
        if (hidden) {
            // Echo nothing while the password is typed.
            const output = rl as unknown as { _writeToOutput: (s: string) => void };
            output._writeToOutput = (s: string) => {
                if (s.startsWith(question)) stdout.write(question);
            };
        }
        rl.question(question, (answer) => {
            rl.close();
            if (hidden) stdout.write('\n');
            resolve(answer);
        });
    });
}

async function main() {
    console.log('\nCreate a TPJP dashboard Administrator\n');

    const username = normaliseUsername(await ask('Username: '));
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
        throw new Error(
            'Username must be 3–64 characters: letters, digits, dot, dash or underscore.'
        );
    }

    const fullname = (await ask('Full name: ')).trim();
    if (fullname.length < 2 || fullname.length > 150)
        throw new Error('Full name must be 2–150 characters.');

    const password = await ask('Password: ', true);
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
        throw new Error(`Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`);
    }
    if ((await ask('Repeat password: ', true)) !== password)
        throw new Error('The passwords do not match.');

    try {
        const user = await UserModel.create(0, {
            username,
            fullname,
            rolecode: 'ADMIN',
            passwordhash: await hashPassword(password),
        });
        console.log(`\nCreated ADMIN "${user.username}" (id ${user.id}).`);
    } catch (err) {
        if (isUniqueViolation(err, 'uq_usermaster_username'))
            throw new Error(`Username "${username}" is taken.`, { cause: err });
        throw err;
    }
}

try {
    await main();
} catch (err) {
    console.error(`\nNot created: ${(err as Error).message}`);
    process.exitCode = 1;
} finally {
    await pool.end();
}
