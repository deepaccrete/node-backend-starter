/**
 * One-time codes (OTP): issue one by SMS, and check one.
 *
 * Six digits, live for OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS wrong tries, and no new
 * code within OTP_RESEND_SECONDS of the last. A new code retires the older ones.
 *
 * Only a keyed hash is stored. A plain SHA-256 of a six-digit code could be
 * reversed by trying all million codes; keyed with a server secret it cannot be,
 * even from a copy of the database.
 */

import crypto from 'node:crypto';

import { env } from '../config/env.js';
import { OtpModel, type OtpTarget } from '../models/auth/otp.model.js';
import { OtpCooldownError, OtpInvalidError } from '../utils/errors.js';
import { sendSms } from './sms.service.js';

const CODE_DIGITS = 6;

const hashCode = (t: OtpTarget, code: string) =>
    crypto
        .createHmac('sha256', env.auth.refreshSecret)
        .update(`otp:${t.purpose}:${t.mobileno}:${t.distributorcontactid ?? ''}:${code}`)
        .digest('hex');

const newCode = () => String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');

export const OtpService = {
    /**
     * Texts a new code to `t.mobileno`. `message` builds the SMS text around the code.
     * Throws OTP_COOLDOWN when the last code was sent too recently.
     */
    async issue(t: OtpTarget, message: (code: string, minutes: number) => string): Promise<void> {
        const last = await OtpModel.findLatestUnused(t);
        if (last) {
            const wait = Math.ceil(
                (last.createdat.getTime() + env.auth.otpResendSeconds * 1000 - Date.now()) / 1000
            );
            if (wait > 0) throw new OtpCooldownError(wait);
        }
        const code = newCode();
        await OtpModel.replace(
            t,
            hashCode(t, code),
            new Date(Date.now() + env.auth.otpTtlSeconds * 1000)
        );
        await sendSms(t.mobileno, message(code, Math.round(env.auth.otpTtlSeconds / 60)));
    },

    /** Uses up the code if it matches; otherwise throws OTP_INVALID. */
    async verify(t: OtpTarget, code: string): Promise<void> {
        const otp = await OtpModel.findLatestUnused(t);
        if (
            !otp ||
            otp.expiresat.getTime() <= Date.now() ||
            otp.attempts >= env.auth.otpMaxAttempts
        ) {
            throw new OtpInvalidError();
        }
        const given = Buffer.from(hashCode(t, code));
        const stored = Buffer.from(otp.codehash);
        if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
            await OtpModel.addAttempt(otp.id);
            const left = env.auth.otpMaxAttempts - otp.attempts - 1;
            throw new OtpInvalidError(
                left > 0
                    ? `That code is not right. ${left} tr${left === 1 ? 'y' : 'ies'} left.`
                    : 'That code is not right. Request a new one.'
            );
        }
        // Two requests with the same right code: only one gets through.
        if (!(await OtpModel.consume(otp.id))) throw new OtpInvalidError();
    },
};
