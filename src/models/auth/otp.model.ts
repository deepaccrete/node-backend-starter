/**
 * OTP model — every database call for the `otpcode` collection.
 *
 * One document per code sent. The code itself is never stored, only a keyed hash
 * (see otp.service.ts). A code is live while `consumedat` is null, it has not
 * expired and it has tries left. Asking for a new code retires the older ones.
 */

import { mongoose } from '../../config/database.js';
import { SequenceModel, SYSTEM_USER } from '../sequence.model.js';

export const OTP_PURPOSES = [
    // Telecaller signs in to the Android app.
    'APP_LOGIN',
    // Dashboard user resets a forgotten password.
    'PASSWORD_RESET',
    // A number added by the Primary Contact proves it is real.
    'CONTACT_VERIFY',
    // The Primary Contact authorises that new number.
    'CONTACT_APPROVE',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

interface OtpDoc {
    otpcodeid: number;
    purpose: OtpPurpose;
    // The number the code was texted to.
    mobileno: string;
    codehash: string;
    expiresat: Date;
    attempts: number;
    consumedat: Date | null;
    // For CONTACT_VERIFY / CONTACT_APPROVE: the number being added.
    distributorcontactid: number | null;
    createdby: number;
    createdat: Date;
    updatedby: number;
    updatedat: Date;
    isdeleted: number;
}

const otpSchema = new mongoose.Schema<OtpDoc>(
    {
        otpcodeid: { type: Number, required: true },
        purpose: { type: String, required: true, enum: OTP_PURPOSES },
        mobileno: { type: String, required: true, match: /^[6-9]\d{9}$/ },
        codehash: { type: String, required: true, maxlength: 64 },
        expiresat: { type: Date, required: true },
        attempts: { type: Number, required: true, default: 0 },
        consumedat: { type: Date, default: null },
        distributorcontactid: { type: Number, default: null },
        createdby: { type: Number, required: true, default: SYSTEM_USER },
        createdat: { type: Date, required: true, default: Date.now },
        updatedby: { type: Number, required: true, default: SYSTEM_USER },
        updatedat: { type: Date, required: true, default: Date.now },
        isdeleted: { type: Number, required: true, default: 0, enum: [0, 1] },
    },
    { collection: 'otpcode', timestamps: false, versionKey: false }
);

otpSchema.index({ otpcodeid: 1 }, { name: 'uq_otpcode_otpcodeid', unique: true });
otpSchema.index(
    { mobileno: 1, purpose: 1, distributorcontactid: 1, createdat: -1 },
    { name: 'idx_otpcode_mobileno_purpose' }
);

const Otp = mongoose.model<OtpDoc>('Otp', otpSchema);

export interface OtpRow {
    id: number;
    codehash: string;
    expiresat: Date;
    attempts: number;
    createdat: Date;
}

const FIELDS = {
    _id: 0,
    otpcodeid: 1,
    codehash: 1,
    expiresat: 1,
    attempts: 1,
    createdat: 1,
} as const;
type Projected = Pick<OtpDoc, 'otpcodeid' | 'codehash' | 'expiresat' | 'attempts' | 'createdat'>;

const toRow = (d: Projected): OtpRow => ({
    id: d.otpcodeid,
    codehash: d.codehash,
    expiresat: d.expiresat,
    attempts: d.attempts,
    createdat: d.createdat,
});

export interface OtpTarget {
    purpose: OtpPurpose;
    mobileno: string;
    distributorcontactid?: number | null;
}

const filterOf = (t: OtpTarget) => ({
    purpose: t.purpose,
    mobileno: t.mobileno,
    distributorcontactid: t.distributorcontactid ?? null,
    consumedat: null,
    isdeleted: 0,
});

export const OtpModel = {
    /** The newest unused code for this purpose and number (expired or not). */
    findLatestUnused: async (t: OtpTarget): Promise<OtpRow | null> => {
        const d = await Otp.findOne(filterOf(t), FIELDS).sort({ createdat: -1 }).lean<Projected>();
        return d ? toRow(d) : null;
    },

    /** Retires every unused code for this target, then stores the new one. */
    replace: async (t: OtpTarget, codehash: string, expiresat: Date): Promise<void> => {
        const now = new Date();
        await Otp.updateMany(filterOf(t), { $set: { consumedat: now, updatedat: now } });
        await Otp.create({
            otpcodeid: await SequenceModel.next('otpcode'),
            purpose: t.purpose,
            mobileno: t.mobileno,
            distributorcontactid: t.distributorcontactid ?? null,
            codehash,
            expiresat,
        });
    },

    /** Counts a wrong try. */
    addAttempt: async (id: number) => {
        await Otp.updateOne(
            { otpcodeid: id, consumedat: null, isdeleted: 0 },
            { $inc: { attempts: 1 }, $set: { updatedat: new Date() } }
        );
    },

    /** Marks the code used. False if another request used it first. */
    consume: async (id: number): Promise<boolean> => {
        const now = new Date();
        const r = await Otp.updateOne(
            { otpcodeid: id, consumedat: null, isdeleted: 0 },
            { $set: { consumedat: now, updatedat: now } }
        );
        return r.modifiedCount === 1;
    },
};
