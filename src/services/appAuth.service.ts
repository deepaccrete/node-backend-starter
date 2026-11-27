/**
 * Android app sign-in for distributor telecallers: mobile number + one-time code.
 *
 * Only an ACTIVE `distributorcontact` number of an active distributor can sign
 * in (Scope of Work: no unauthorised number may reach any calling plan). Sessions
 * live in `authsession` like dashboard ones, with the same refresh rotation and
 * replay detection; the app holds its refresh token itself instead of a cookie.
 */

import { env } from '../config/env.js';
import { SessionModel } from '../models/auth/session.model.js';
import {
    DistributorContactModel,
    type ContactRow,
} from '../models/distributor/distributorcontact.model.js';
import { DistributorModel, type DistributorRow } from '../models/distributor/distributor.model.js';
import { OtpCooldownError, OtpInvalidError, UnauthorizedError } from '../utils/errors.js';
import type { ClientInfo } from './auth.service.js';
import { OtpService } from './otp.service.js';
import {
    hashToken,
    signAppAccessToken,
    signAppRefreshToken,
    verifyRefreshToken,
} from './token.service.js';

/** The signed-in telecaller as the app sees it. */
export interface AppContactView {
    id: number;
    name: string;
    mobile: string;
    isPrimary: boolean;
    distributor: { id: number; code: string; name: string };
}

export interface AppSession {
    contact: AppContactView;
    accessToken: string;
    refreshToken: string;
}

const CODE_SENT = 'If this number is registered, a code has been sent to it.';
const EXPIRED = 'Your session has expired. Please sign in again.';

const toView = (c: ContactRow, d: DistributorRow): AppContactView => ({
    id: c.id,
    name: c.contactname,
    mobile: c.mobileno,
    isPrimary: c.isprimary === 1,
    distributor: { id: d.id, code: d.code, name: d.name },
});

/** The number and its distributor, only while both may sign in. */
async function activeContact(
    by: { mobileno: string } | { id: number }
): Promise<{ contact: ContactRow; distributor: DistributorRow } | null> {
    const contact =
        'id' in by
            ? await DistributorContactModel.findById(by.id)
            : await DistributorContactModel.findByMobile(by.mobileno);
    if (contact?.status !== 'ACTIVE') return null;
    const distributor = await DistributorModel.findActiveById(contact.distributorid);
    return distributor ? { contact, distributor } : null;
}

const refreshExpiry = () => new Date(Date.now() + env.auth.refreshTtlSeconds * 1000);

const accessTokenFor = (contact: ContactRow, sid: string) =>
    signAppAccessToken({ sub: String(contact.id), sid, distributorid: contact.distributorid });

export const AppAuthService = {
    /** Same answer whether or not the number is registered. */
    async requestOtp(mobileno: string): Promise<string> {
        if (!(await activeContact({ mobileno }))) return CODE_SENT;
        try {
            await OtpService.issue(
                { purpose: 'APP_LOGIN', mobileno },
                (code, minutes) =>
                    `${code} is your TPJP sign-in code. It expires in ${minutes} minutes. Do not share it.`
            );
        } catch (err) {
            // A "wait" only for registered numbers would reveal which ones are.
            if (!(err instanceof OtpCooldownError)) throw err;
        }
        return CODE_SENT;
    },

    async verifyOtp(mobileno: string, code: string, client: ClientInfo): Promise<AppSession> {
        const found = await activeContact({ mobileno });
        if (!found) throw new OtpInvalidError();
        await OtpService.verify({ purpose: 'APP_LOGIN', mobileno }, code);

        const { contact, distributor } = found;
        const sid = await SessionModel.newId();
        const refreshToken = signAppRefreshToken({ sub: String(contact.id), sid, gen: 1 });
        await SessionModel.createForContact(sid, contact.id, {
            refreshTokenHash: hashToken(refreshToken),
            expiresAt: refreshExpiry(),
            ...client,
        });
        return {
            contact: toView(contact, distributor),
            accessToken: accessTokenFor(contact, sid),
            refreshToken,
        };
    },

    /** Same rotation and replay rules as the dashboard refresh. */
    async refresh(token: string): Promise<AppSession> {
        const claims = verifyRefreshToken(token, 'app-refresh');
        const session = await SessionModel.findById(claims.sid);
        if (
            session?.distributorcontactid == null ||
            session.revokedat ||
            session.expiresat.getTime() <= Date.now()
        ) {
            throw new UnauthorizedError(EXPIRED, 'SESSION_EXPIRED');
        }
        const contactId = session.distributorcontactid;

        if (claims.gen !== session.generation || hashToken(token) !== session.refreshtokenhash) {
            await SessionModel.revokeAllForContact(contactId);
            throw new UnauthorizedError(
                'Your session was ended for security reasons. Please sign in again.',
                'REFRESH_REUSED'
            );
        }

        // A number deactivated by the Primary Contact, or a deactivated distributor, is out.
        const found = await activeContact({ id: contactId });
        if (!found) {
            await SessionModel.revoke(session.id);
            throw new UnauthorizedError(EXPIRED, 'SESSION_EXPIRED');
        }

        const next = signAppRefreshToken({
            sub: String(contactId),
            sid: session.id,
            gen: session.generation + 1,
        });
        const rotated = await SessionModel.rotate(
            session.id,
            session.generation,
            hashToken(next),
            refreshExpiry()
        );
        if (!rotated) throw new UnauthorizedError(EXPIRED, 'SESSION_EXPIRED');

        return {
            contact: toView(found.contact, found.distributor),
            accessToken: accessTokenFor(found.contact, session.id),
            refreshToken: next,
        };
    },

    /** A missing or invalid token is not an error. */
    async logout(token: string | undefined): Promise<void> {
        if (!token) return;
        try {
            const { sid } = verifyRefreshToken(token, 'app-refresh');
            await SessionModel.revoke(sid);
        } catch (err) {
            if (!(err instanceof UnauthorizedError)) throw err;
        }
    },

    async me(contactId: number): Promise<AppContactView> {
        const found = await activeContact({ id: contactId });
        if (!found) throw new UnauthorizedError();
        return toView(found.contact, found.distributor);
    },
};
