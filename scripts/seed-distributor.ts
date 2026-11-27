/**
 * Add a distributor and its Primary Contact number from the terminal, so the
 * app sign-in and Primary Contact Management can be used before the plan
 * upload exists.
 *
 *   pnpm seed-distributor
 *
 * The Primary Contact number is created ACTIVE: it can sign in to the app at
 * once and add further numbers from there.
 */

import 'dotenv/config';

import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import {
    DistributorContactModel,
    UQ_CONTACT_MOBILENO,
} from '../src/models/distributor/distributorcontact.model.js';
import {
    DistributorModel,
    UQ_DISTRIBUTORCODE,
} from '../src/models/distributor/distributor.model.js';
import { SYSTEM_USER } from '../src/models/sequence.model.js';
import { isDuplicateKey } from '../src/utils/mongoError.js';

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function main() {
    console.log('\nAdd a distributor and its Primary Contact\n');

    const code = (await ask('Distributor code: ')).toUpperCase();
    if (!/^[A-Z0-9._-]{1,32}$/.test(code)) {
        throw new Error('Code must be 1–32 letters, digits, dot, dash or underscore.');
    }
    const name = await ask('Distributor name: ');
    if (name.length < 2 || name.length > 150) throw new Error('Name must be 2–150 characters.');

    const contactName = await ask('Primary Contact name: ');
    if (contactName.length < 2 || contactName.length > 150) {
        throw new Error('Contact name must be 2–150 characters.');
    }
    const mobile = await ask('Primary Contact mobile (10 digits): ');
    if (!/^[6-9]\d{9}$/.test(mobile)) {
        throw new Error('Mobile must be a 10-digit number starting 6–9.');
    }

    // Also builds the indexes: the unique code and mobile indexes must exist first.
    await connectDatabase();

    if (await DistributorContactModel.findByMobile(mobile)) {
        throw new Error(`Mobile ${mobile} is already registered to a distributor.`);
    }
    try {
        const distributor = await DistributorModel.create(SYSTEM_USER, {
            distributorcode: code,
            distributorname: name,
        });
        const contact = await DistributorContactModel.create(
            distributor.id,
            { mobileno: mobile, contactname: contactName, isprimary: 1, status: 'ACTIVE' },
            SYSTEM_USER
        );
        console.log(
            `\nCreated distributor ${distributor.code} (id ${distributor.id}) with Primary Contact ${contact.mobileno} (id ${contact.id}).`
        );
    } catch (err) {
        if (isDuplicateKey(err, UQ_DISTRIBUTORCODE))
            throw new Error(`Distributor code "${code}" is taken.`, { cause: err });
        if (isDuplicateKey(err, UQ_CONTACT_MOBILENO))
            throw new Error(`Mobile ${mobile} is already registered.`, { cause: err });
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
