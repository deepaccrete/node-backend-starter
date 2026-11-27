/**
 * Primary Contact Management (Scope of Work, Module 2), from the Android app.
 *
 * Only the distributor's Primary Contact can list, add, edit or deactivate its
 * telecaller numbers, or hand the primary role to another number. A new number
 * becomes ACTIVE only after two codes are entered:
 *
 *   1. CONTACT_VERIFY   texted to the NEW number: proves the number is real and
 *                       reachable (its user reads the code to the Primary Contact).
 *   2. CONTACT_APPROVE  texted to the PRIMARY CONTACT's own number: confirms the
 *                       Primary Contact authorises it, even if their app session
 *                       was taken over.
 *
 * Either order works; the number turns ACTIVE when both are done.
 */

import {
    DistributorContactModel,
    type ContactRow,
    type ContactStatus,
} from '../models/distributor/distributorcontact.model.js';
import { SessionModel } from '../models/auth/session.model.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { OtpService } from './otp.service.js';

/** A telecaller number as the Primary Contact's screen shows it. */
export interface ContactView {
    id: number;
    name: string;
    mobile: string;
    isPrimary: boolean;
    status: ContactStatus;
    /** Step 1 done: the new number entered its code. */
    verified: boolean;
    /** Step 2 done: the Primary Contact entered theirs. */
    approved: boolean;
}

const toView = (c: ContactRow): ContactView => ({
    id: c.id,
    name: c.contactname,
    mobile: c.mobileno,
    isPrimary: c.isprimary === 1,
    status: c.status,
    verified: c.verifiedat !== null,
    approved: c.approvedat !== null,
});

/** The signed-in number, only if it is its distributor's ACTIVE Primary Contact. */
async function primaryOf(contactId: number): Promise<ContactRow> {
    const me = await DistributorContactModel.findById(contactId);
    if (me?.status !== 'ACTIVE' || me.isprimary !== 1) {
        throw new ForbiddenError('Only the Primary Contact can manage contact numbers.');
    }
    return me;
}

/** A number of the same distributor; anything else is "not found", never "forbidden". */
async function contactOf(primary: ContactRow, id: number): Promise<ContactRow> {
    const contact = await DistributorContactModel.findById(id);
    if (contact?.distributorid !== primary.distributorid) {
        throw new NotFoundError('Contact number not found.');
    }
    return contact;
}

/** Texts both codes for a PENDING number. */
async function sendCodes(primary: ContactRow, contact: ContactRow) {
    await OtpService.issue(
        { purpose: 'CONTACT_VERIFY', mobileno: contact.mobileno, distributorcontactid: contact.id },
        (code, minutes) =>
            `${code} is the code to add this number to TPJP telecalling. Give it to your Primary Contact. It expires in ${minutes} minutes.`
    );
    await OtpService.issue(
        {
            purpose: 'CONTACT_APPROVE',
            mobileno: primary.mobileno,
            distributorcontactid: contact.id,
        },
        (code, minutes) =>
            `${code} authorises ${contact.mobileno} as a TPJP telecalling number. Enter it only if you added this number. It expires in ${minutes} minutes.`
    );
}

const pending = (contact: ContactRow) => {
    if (contact.status !== 'PENDING') {
        throw new BadRequestError('This number is not waiting for verification.');
    }
};

export const ContactService = {
    async list(contactId: number): Promise<ContactView[]> {
        const primary = await primaryOf(contactId);
        return (await DistributorContactModel.listByDistributor(primary.distributorid)).map(toView);
    },

    /**
     * Add a number, or restart verification for one of this distributor's PENDING
     * or INACTIVE numbers (which also resends both codes).
     */
    async add(contactId: number, data: { mobile: string; name: string }): Promise<ContactView> {
        const primary = await primaryOf(contactId);
        const existing = await DistributorContactModel.findByMobile(data.mobile);

        let contact: ContactRow | null;
        if (!existing) {
            contact = await DistributorContactModel.create(primary.distributorid, {
                mobileno: data.mobile,
                contactname: data.name,
                isprimary: 0,
                status: 'PENDING',
            });
        } else if (existing.distributorid !== primary.distributorid) {
            throw new ConflictError('This mobile number is already registered to a distributor.');
        } else if (existing.status === 'ACTIVE') {
            throw new ConflictError('This number is already an active telecalling number.');
        } else {
            contact = await DistributorContactModel.restartVerification(existing.id, data.name);
            if (!contact) throw new ConflictError('This number cannot be added again.');
        }

        await sendCodes(primary, contact);
        return toView(contact);
    },

    /** Step 1: the code the new number received. */
    async verify(contactId: number, id: number, code: string): Promise<ContactView> {
        const primary = await primaryOf(contactId);
        const contact = await contactOf(primary, id);
        pending(contact);
        await OtpService.verify(
            { purpose: 'CONTACT_VERIFY', mobileno: contact.mobileno, distributorcontactid: id },
            code
        );
        await DistributorContactModel.markVerified(id);
        return toView(
            (await DistributorContactModel.activateIfComplete(id)) ?? (await contactOf(primary, id))
        );
    },

    /** Step 2: the code the Primary Contact received. */
    async approve(contactId: number, id: number, code: string): Promise<ContactView> {
        const primary = await primaryOf(contactId);
        const contact = await contactOf(primary, id);
        pending(contact);
        await OtpService.verify(
            { purpose: 'CONTACT_APPROVE', mobileno: primary.mobileno, distributorcontactid: id },
            code
        );
        await DistributorContactModel.markApproved(id, primary.id);
        return toView(
            (await DistributorContactModel.activateIfComplete(id)) ?? (await contactOf(primary, id))
        );
    },

    /** Only the name can be edited: a different number is added as a new one. */
    async rename(contactId: number, id: number, name: string): Promise<ContactView> {
        const primary = await primaryOf(contactId);
        await contactOf(primary, id);
        const updated = await DistributorContactModel.rename(id, name);
        if (!updated) throw new NotFoundError('Contact number not found.');
        return toView(updated);
    },

    /** Stops a number signing in and ends its app sessions. */
    async deactivate(contactId: number, id: number): Promise<ContactView> {
        const primary = await primaryOf(contactId);
        const contact = await contactOf(primary, id);
        if (contact.isprimary === 1) {
            throw new BadRequestError(
                'The Primary Contact cannot be deactivated. Make another number primary first.'
            );
        }
        if (contact.status === 'INACTIVE') return toView(contact);
        const updated = await DistributorContactModel.deactivate(id);
        if (!updated) throw new ConflictError('This number could not be deactivated.');
        await SessionModel.revokeAllForContact(id);
        return toView(updated);
    },

    /** Hands the Primary Contact role to another ACTIVE number of the same distributor. */
    async makePrimary(contactId: number, id: number): Promise<ContactView[]> {
        const primary = await primaryOf(contactId);
        const target = await contactOf(primary, id);
        if (target.id === primary.id) return this.list(contactId);
        if (target.status !== 'ACTIVE') {
            throw new BadRequestError('Only an active number can become the Primary Contact.');
        }
        // One primary per distributor is a unique index, so the old one steps down
        // first. No transactions (standalone MongoDB): undo it if the second write fails.
        await DistributorContactModel.setPrimary(primary.id, 0);
        try {
            await DistributorContactModel.setPrimary(target.id, 1);
        } catch (err) {
            await DistributorContactModel.setPrimary(primary.id, 1);
            throw err;
        }
        return (await DistributorContactModel.listByDistributor(primary.distributorid)).map(toView);
    },
};
