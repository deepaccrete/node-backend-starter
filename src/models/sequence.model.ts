/**
 * Sequence model — hands out the integer keys (`userid`, `authsessionid`, …).
 *
 * MongoDB has no auto-increment. Every collection keeps MongoDB's own `_id` and
 * adds a house key `<entity>id`, numbered here: one document per collection in
 * `sequencemaster`, and an atomic `$inc` so two inserts never get the same number.
 * `sequencemaster` is the one collection keyed by its name instead of a number.
 */

import { mongoose } from '../config/database.js';

/** Created by the system (no signed-in user). */
export const SYSTEM_USER = 1;

interface SequenceDoc {
    sequencename: string;
    lastvalue: number;
    createdby: number;
    createdat: Date;
    updatedby: number;
    updatedat: Date;
    isdeleted: number;
}

const sequenceSchema = new mongoose.Schema<SequenceDoc>(
    {
        sequencename: { type: String, required: true, maxlength: 64 },
        lastvalue: { type: Number, required: true, default: 0 },
        createdby: { type: Number, required: true, default: SYSTEM_USER },
        createdat: { type: Date, required: true, default: Date.now },
        updatedby: { type: Number, required: true, default: SYSTEM_USER },
        updatedat: { type: Date, required: true, default: Date.now },
        isdeleted: { type: Number, required: true, default: 0, enum: [0, 1] },
    },
    { collection: 'sequencemaster', timestamps: false, versionKey: false }
);

sequenceSchema.index({ sequencename: 1 }, { name: 'uq_sequencemaster_sequencename', unique: true });

const Sequence = mongoose.model<SequenceDoc>('Sequence', sequenceSchema);

export const SequenceModel = {
    /** The next key for `collection` (1 for the first document). */
    next: async (collection: string, by: number = SYSTEM_USER): Promise<number> => {
        const now = new Date();
        const doc = await Sequence.findOneAndUpdate(
            { sequencename: collection },
            {
                $inc: { lastvalue: 1 },
                $setOnInsert: { createdby: by, createdat: now, isdeleted: 0 },
                $set: { updatedby: by, updatedat: now },
            },
            { upsert: true, returnDocument: 'after', projection: { lastvalue: 1 } }
        ).lean<Pick<SequenceDoc, 'lastvalue'>>();
        if (!doc) throw new Error(`sequencemaster returned no value for ${collection}`);
        return doc.lastvalue;
    },
};
