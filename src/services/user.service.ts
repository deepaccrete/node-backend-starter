/**
 * Dashboard user management, for Admins (`users:manage`).
 *
 * There is no self sign-up: an Admin creates every account with a temporary
 * password, and the user must change it at first sign-in. Each user reports to
 * one manager a level up (REPORTS_TO_ROLE), which is what later scopes the data
 * a manager can see.
 */

import { REPORTS_TO_ROLE, type Role } from '../config/permissions.js';
import { SessionModel } from '../models/auth/session.model.js';
import {
    UserModel,
    type UserChanges,
    type UserDetailRow,
    type UserSortField,
} from '../models/auth/user.model.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import { hashPassword, normaliseUsername } from './auth.service.js';

/** A user as the management screens see it. */
export interface ManagedUser {
    id: number;
    username: string;
    name: string;
    role: Role;
    mobile: string | null;
    reportsToUserId: number | null;
    isActive: boolean;
    mustChangePassword: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
}

const toManaged = (r: UserDetailRow): ManagedUser => ({
    id: r.id,
    username: r.username,
    name: r.fullname,
    role: r.rolecode,
    mobile: r.mobileno,
    reportsToUserId: r.reportstouserid,
    isActive: r.isactive === 1,
    mustChangePassword: r.mustchangepassword === 1,
    lastLoginAt: r.lastloginat,
    createdAt: r.createdat,
});

const fieldError = (field: string, message: string) =>
    new BadRequestError(message, 'VALIDATION_FAILED', [{ field, message }]);

/** The manager must be an active user of the role one level up; top roles have none. */
async function checkManager(role: Role, reportsToUserId: number | null, selfId?: number) {
    const expected = REPORTS_TO_ROLE[role];
    if (expected === null) {
        if (reportsToUserId !== null) {
            throw fieldError('reportsToUserId', `A ${role} does not report to anyone.`);
        }
        return;
    }
    if (reportsToUserId === null) {
        throw fieldError('reportsToUserId', `Choose the ${expected} this ${role} reports to.`);
    }
    if (reportsToUserId === selfId) {
        throw fieldError('reportsToUserId', 'A user cannot report to themselves.');
    }
    const manager = await UserModel.findDetailById(reportsToUserId);
    if (manager?.isactive !== 1 || manager.rolecode !== expected) {
        throw fieldError('reportsToUserId', `A ${role} must report to an active ${expected}.`);
    }
}

export const UserService = {
    async list(q: {
        page: number;
        limit: number;
        search: string;
        role?: Role;
        sortBy: UserSortField;
        sortOrder: 'ASC' | 'DESC';
    }) {
        const { rows, total } = await UserModel.list({ ...q, rolecode: q.role });
        return { rows: rows.map(toManaged), total };
    },

    async get(id: number): Promise<ManagedUser> {
        const user = await UserModel.findDetailById(id);
        if (!user) throw new NotFoundError('User not found.');
        return toManaged(user);
    },

    async create(
        adminId: number,
        data: {
            username: string;
            name: string;
            role: Role;
            mobile: string | null;
            reportsToUserId: number | null;
            password: string;
        }
    ): Promise<ManagedUser> {
        await checkManager(data.role, data.reportsToUserId);
        const created = await UserModel.create(adminId, {
            username: normaliseUsername(data.username),
            fullname: data.name,
            rolecode: data.role,
            mobileno: data.mobile,
            reportstouserid: data.reportsToUserId,
            passwordhash: await hashPassword(data.password),
            mustchangepassword: 1,
        });
        return this.get(created.id);
    },

    async update(
        adminId: number,
        id: number,
        changes: {
            name?: string;
            role?: Role;
            mobile?: string | null;
            reportsToUserId?: number | null;
            isActive?: boolean;
        }
    ): Promise<ManagedUser> {
        const current = await UserModel.findDetailById(id);
        if (!current) throw new NotFoundError('User not found.');

        const role = changes.role ?? current.rolecode;
        const deactivating = changes.isActive === false && current.isactive === 1;
        const roleChanging = role !== current.rolecode;

        if (id === adminId && (deactivating || roleChanging)) {
            throw new BadRequestError(
                'You cannot deactivate your own account or change your own role.'
            );
        }

        // A role change moves the user to a new level, so the manager is checked again.
        const reportsTo =
            changes.reportsToUserId !== undefined
                ? changes.reportsToUserId
                : REPORTS_TO_ROLE[role] === null
                  ? null
                  : current.reportstouserid;
        if (roleChanging || changes.reportsToUserId !== undefined) {
            await checkManager(role, reportsTo, id);
        }

        if (deactivating || roleChanging) {
            const reports = await UserModel.countActiveReports(id);
            if (reports > 0) {
                throw new ConflictError(
                    `${reports} active user${reports === 1 ? ' reports' : 's report'} to ${current.username}. Move them to another manager first.`
                );
            }
        }

        const update: UserChanges = {};
        if (changes.name !== undefined) update.fullname = changes.name;
        if (roleChanging) update.rolecode = role;
        if (changes.mobile !== undefined) update.mobileno = changes.mobile;
        if (reportsTo !== current.reportstouserid) update.reportstouserid = reportsTo;
        if (changes.isActive !== undefined) update.isactive = changes.isActive ? 1 : 0;

        const updated = await UserModel.update(id, update, adminId);
        if (!updated) throw new NotFoundError('User not found.');
        // A deactivated user, or one whose role (and so permissions) changed, signs in again.
        if (deactivating || roleChanging) await SessionModel.revokeAllForUser(id);
        return toManaged(updated);
    },

    /** Set a temporary password: the user must change it at next sign-in. Ends their sessions. */
    async resetPassword(adminId: number, id: number, password: string): Promise<void> {
        const user = await UserModel.findDetailById(id);
        if (!user) throw new NotFoundError('User not found.');
        await UserModel.setPassword(id, await hashPassword(password), 1, adminId);
        await SessionModel.revokeAllForUser(id);
    },
};
