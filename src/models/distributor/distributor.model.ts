                                                                                                                                                            /**
 * Distributor model — every database call for the `distributor` collection.
 *
 * A distributor runs telecalling through one or more contact numbers
 * (`distributorcontact`). For now distributors are added by
 * `pnpm seed-distributor`; the plan upload will add them later.
 */

import { mongoose } from '../../config/database.js';
import { SequenceModel, SYSTEM_USER } from '../sequence.model.js';

export const UQ_DISTRIBUTORCODE = 'uq_distributor_distributorcode';

interface DistributorDoc {
    distributorid: number;
    // Lotte's own code for the distributor.
    distributorcode: string;
    distributorname: string;
    // The ASM who covers this distributor (a `usermaster.userid`).
    asmuserid: number | null;
    isactive: number;
    createdby: number;
    createdat: Date;
    updatedby: number;
    updatedat: Date;
    isdeleted: number;
}

const distributorSchema = new mongoose.Schema<DistributorDoc>(
    {
        distributorid: { type: Number, required: true },
        distributorcode: { type: String, required: true, maxlength: 32 },
        distributorname: { type: String, required: true, maxlength: 150 },
        asmuserid: { type: Number, default: null },
        isactive: { type: Number, required: true, default: 1, enum: [0, 1] },
        createdby: { type: Number, required: true, default: SYSTEM_USER },
        createdat: { type: Date, required: true, default: Date.now },
        updatedby: { type: Number, required: true, default: SYSTEM_USER },
        updatedat: { type: Date, required: true, default: Date.now },
        isdeleted: { type: Number, required: true, default: 0, enum: [0, 1] },
    },
    { collection: 'distributor', timestamps: false, versionKey: false }
);

distributorSchema.index(
    { distributorid: 1 },
    { name: 'uq_distributor_distributorid', unique: true }
);
distributorSchema.index(
    { distributorcode: 1 },
    { name: UQ_DISTRIBUTORCODE, unique: true, partialFilterExpression: { isdeleted: 0 } }
);
distributorSchema.index({ asmuserid: 1, isdeleted: 1 }, { name: 'idx_distributor_asmuserid' });

const Distributor = mongoose.model<DistributorDoc>('Distributor', distributorSchema);

export interface DistributorRow {
    id: number;
    code: string;
    name: string;
}

const FIELDS = { _id: 0, distributorid: 1, distributorcode: 1, distributorname: 1 } as const;
type Projected = Pick<DistributorDoc, 'distributorid' | 'distributorcode' | 'distributorname'>;

const toRow = (d: Projected): DistributorRow => ({
    id: d.distributorid,
    code: d.distributorcode,
    name: d.distributorname,
});

export const DistributorModel = {
    findActiveById: async (id: number): Promise<DistributorRow | null> => {
        const d = await Distributor.findOne(
            { distributorid: id, isactive: 1, isdeleted: 0 },
            FIELDS
        ).lean<Projected>();
        return d ? toRow(d) : null;
    },

    create: async (
        createdBy: number,
        data: { distributorcode: string; distributorname: string; asmuserid?: number | null }
    ): Promise<DistributorRow> => {
        const distributorid = await SequenceModel.next('distributor', createdBy);
        return toRow(
            await Distributor.create({
                ...data,
                distributorid,
                createdby: createdBy,
                updatedby: createdBy,
            })
        );
    },
};
