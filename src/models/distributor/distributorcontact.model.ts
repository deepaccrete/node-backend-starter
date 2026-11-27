/**
 * Distributor contact model — every database call for `distributorcontact`.
 *
 * One document per telecaller mobile number. A number signs in to the app only
 * while ACTIVE. A number added by the Primary Contact starts PENDING and becomes
 * ACTIVE once BOTH steps are done: the new number confirmed its code
 * (`verifiedat`) and the Primary Contact confirmed theirs (`approvedat`).
 *
 * App-side writes have no dashboard user behind them, so `createdby` /
 * `updatedby` are the system user; who approved is kept in `approvedbycontactid`.
 */

import { mongoose } from '../../config/database.js';
import { SequenceModel, SYSTEM_USER } from '../sequence.model.js';

export const CONTACT_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const UQ_CONTACT_MOBILENO = 'uq_distributorcontact_mobileno';
export const UQ_CONTACT_PRIMARY = 'uq_distributorcontact_primary';

interface ContactDoc {
    distributorcontactid: number;
    distributorid: number;
    mobileno: string;
    contactname: string;
    // 1 for the one number that manages the distributor's contact list.
    isprimary: number;
    status: ContactStatus;
    verifiedat: Date | null;
    approvedat: Date | null;
    // The Primary Contact (a `distributorcontactid`) who authorised this number.
    approvedbycontactid: number | null;
    createdby: number;
    createdat: Date;
    updatedby: number;
    updatedat: Date;
    isdeleted: number;
}

const contactSchema = new mongoose.Schema<ContactDoc>(
    {
        distributorcontactid: { type: Number, required: true },
        distributorid: { type: Number, required: true },
        mobileno: { type: String, required: true, match: /^[6-9]\d{9}$/ },
        contactname: { type: String, required: true, maxlength: 150 },
        isprimary: { type: Number, required: true, default: 0, enum: [0, 1] },
        status: { type: String, required: true, default: 'PENDING', enum: CONTACT_STATUSES },
        verifiedat: { type: Date, default: null },
        approvedat: { type: Date, default: null },
        approvedbycontactid: { type: Number, default: null },
        createdby: { type: Number, required: true, default: SYSTEM_USER },
        createdat: { type: Date, required: true, default: Date.now },
        updatedby: { type: Number, required: true, default: SYSTEM_USER },
        updatedat: { type: Date, required: true, default: Date.now },
        isdeleted: { type: Number, required: true, default: 0, enum: [0, 1] },
    },
    { collection: 'distributorcontact', timestamps: false, versionKey: false }
);

contactSchema.index(
    { distributorcontactid: 1 },
    { name: 'uq_distributorcontact_distributorcontactid', unique: true }
);
// A number belongs to one distributor at a time.
contactSchema.index(
    { mobileno: 1 },
    { name: UQ_CONTACT_MOBILENO, unique: true, partialFilterExpression: { isdeleted: 0 } }
);
// At most one Primary Contact per distributor.
contactSchema.index(
    { distributorid: 1 },
    {
        name: UQ_CONTACT_PRIMARY,
        unique: true,
        partialFilterExpression: { isprimary: 1, isdeleted: 0 },
    }
);
contactSchema.index(
    { distributorid: 1, isdeleted: 1 },
    { name: 'idx_distributorcontact_distributorid' }
);

const Contact = mongoose.model<ContactDoc>('DistributorContact', contactSchema);

export interface ContactRow {
    id: number;
    distributorid: number;
    mobileno: string;
    contactname: string;
    isprimary: number;
    status: ContactStatus;
    verifiedat: Date | null;
    approvedat: Date | null;
}

const FIELDS = {
    _id: 0,
    distributorcontactid: 1,
    distributorid: 1,
    mobileno: 1,
    contactname: 1,
    isprimary: 1,
    status: 1,
    verifiedat: 1,
    approvedat: 1,
} as const;
type Projected = Pick<
    ContactDoc,
    | 'distributorcontactid'
    | 'distributorid'
    | 'mobileno'
    | 'contactname'
    | 'isprimary'
    | 'status'
    | 'verifiedat'
    | 'approvedat'
>;

const toRow = (d: Projected): ContactRow => ({
    id: d.distributorcontactid,
    distributorid: d.distributorid,
    mobileno: d.mobileno,
    contactname: d.contactname,
    isprimary: d.isprimary,
    status: d.status,
    verifiedat: d.verifiedat,
    approvedat: d.approvedat,
});

/** Update one contact and return it as it is now; null when the filter did not match. */
async function change(
    filter: Record<string, unknown>,
    set: Record<string, unknown>
): Promise<ContactRow | null> {
    const d = await Contact.findOneAndUpdate(
        { ...filter, isdeleted: 0 },
        { $set: { ...set, updatedby: SYSTEM_USER, updatedat: new Date() } },
        { returnDocument: 'after', projection: FIELDS, runValidators: true }
    ).lean<Projected>();
    return d ? toRow(d) : null;
}

export const DistributorContactModel = {
    findById: async (id: number): Promise<ContactRow | null> => {
        const d = await Contact.findOne(
            { distributorcontactid: id, isdeleted: 0 },
            FIELDS
        ).lean<Projected>();
        return d ? toRow(d) : null;
    },

    /** The number in any status: a number belongs to one distributor at a time. */
    findByMobile: async (mobileno: string): Promise<ContactRow | null> => {
        const d = await Contact.findOne({ mobileno, isdeleted: 0 }, FIELDS).lean<Projected>();
        return d ? toRow(d) : null;
    },

    findPrimary: async (distributorid: number): Promise<ContactRow | null> => {
        const d = await Contact.findOne(
            { distributorid, isprimary: 1, isdeleted: 0 },
            FIELDS
        ).lean<Projected>();
        return d ? toRow(d) : null;
    },

    listByDistributor: async (distributorid: number): Promise<ContactRow[]> => {
        const docs = await Contact.find({ distributorid, isdeleted: 0 }, FIELDS)
            .sort({ isprimary: -1, distributorcontactid: 1 })
            .lean<Projected[]>();
        return docs.map(toRow);
    },

    create: async (
        distributorid: number,
        data: { mobileno: string; contactname: string; isprimary: 0 | 1; status: ContactStatus },
        by: number = SYSTEM_USER
    ): Promise<ContactRow> => {
        const distributorcontactid = await SequenceModel.next('distributorcontact', by);
        const now = new Date();
        // A number created ACTIVE (seed / plan upload) needs no app-side verification.
        const done = data.status === 'ACTIVE' ? now : null;
        return toRow(
            await Contact.create({
                ...data,
                distributorcontactid,
                distributorid,
                verifiedat: done,
                approvedat: done,
                createdby: by,
                updatedby: by,
            })
        );
    },

    /** Puts an INACTIVE or PENDING number back to the start of verification. */
    restartVerification: (id: number, contactname: string) =>
        change(
            { distributorcontactid: id, status: { $in: ['PENDING', 'INACTIVE'] }, isprimary: 0 },
            {
                contactname,
                status: 'PENDING',
                verifiedat: null,
                approvedat: null,
                approvedbycontactid: null,
            }
        ),

    markVerified: (id: number) =>
        change({ distributorcontactid: id, status: 'PENDING' }, { verifiedat: new Date() }),

    markApproved: (id: number, primaryContactId: number) =>
        change(
            { distributorcontactid: id, status: 'PENDING' },
            { approvedat: new Date(), approvedbycontactid: primaryContactId }
        ),

    /** PENDING → ACTIVE, only once both steps are recorded. Null if not both done yet. */
    activateIfComplete: (id: number) =>
        change(
            {
                distributorcontactid: id,
                status: 'PENDING',
                verifiedat: { $ne: null },
                approvedat: { $ne: null },
            },
            { status: 'ACTIVE' }
        ),

    rename: (id: number, contactname: string) =>
        change({ distributorcontactid: id }, { contactname }),

    /** The Primary Contact itself cannot be deactivated: hand the role over first. */
    deactivate: (id: number) =>
        change(
            { distributorcontactid: id, isprimary: 0, status: { $ne: 'INACTIVE' } },
            { status: 'INACTIVE' }
        ),

    setPrimary: (id: number, isprimary: 0 | 1) =>
        change({ distributorcontactid: id }, { isprimary }),
};
