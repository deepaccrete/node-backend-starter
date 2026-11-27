/**
 * Create a dashboard ADMIN account from the terminal.
 *
 *   pnpm create-admin
 *
 * Asks for username, full name, mobile (optional; needed for forgot-password)
 * and password (typed hidden, entered twice). The
 * password is hashed with bcrypt before it reaches the database and is never
 * written to a file or log. Run once per environment.
 */

import 'dotenv/config';

import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { UQ_USER_MOBILENO, UQ_USERNAME, UserModel } from '../src/models/auth/user.model.js';
import { SYSTEM_USER } from '../src/models/sequence.model.js';
import { hashPassword, normaliseUsername } from '../src/services/auth.service.js';
import { isDuplicateKey } from '../src/utils/mongoError.js';
import { project } from '../src/config/project.js';
import { MAX_PASSWORD, MIN_PASSWORD } from '../src/utils/fields.js';

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
    console.log(`\nCreate a ${project.title} Administrator\n`);

    const username = normaliseUsername(await ask('Username: '));
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
        throw new Error(
            'Username must be 3–64 characters: letters, digits, dot, dash or underscore.'
        );
    }

    const fullname = (await ask('Full name: ')).trim();
    if (fullname.length < 2 || fullname.length > 150)
        throw new Error('Full name must be 2–150 characters.');

    const mobile = (await ask('Mobile (10 digits, Enter to skip): ')).trim();
    if (mobile && !/^[6-9]\d{9}$/.test(mobile)) {
        throw new Error('Mobile must be a 10-digit number starting 6–9.');
    }

    const password = await ask('Password: ', true);
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
        throw new Error(`Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`);
    }
    if ((await ask('Repeat password: ', true)) !== password)
        throw new Error('The passwords do not match.');

    // Also builds the indexes: the unique username index must exist before the insert.
    await connectDatabase();
    try {
        const user = await UserModel.create(SYSTEM_USER, {
            username,
            fullname,
            rolecode: 'ADMIN',
            mobileno: mobile || null,
            passwordhash: await hashPassword(password),
        });
        console.log(`\nCreated ADMIN "${user.username}" (id ${user.id}).`);
    } catch (err) {
        if (isDuplicateKey(err, UQ_USERNAME))
            throw new Error(`Username "${username}" is taken.`, { cause: err });
        if (isDuplicateKey(err, UQ_USER_MOBILENO))
            throw new Error(`Mobile ${mobile} belongs to another user.`, { cause: err });
        throw err;
    }
}

try {
    await main();
} catch (err) {
    console.error(`\nNot created: ${(err as Error).message}`);
    process.exitCode = 1;
} finally {
    await disconnectDatabase();
}
