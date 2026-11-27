/**
 * One-time codes: the rules in otp.service.ts, with the `otpcode` model replaced
 * by an in-memory stand-in and the SMS captured instead of sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOtp {
    id: number;
    target: string;
    codehash: string;
    expiresat: Date;
    attempts: number;
    createdat: Date;
    consumed: boolean;
}

const store = vi.hoisted(() => ({ otps: [] as FakeOtp[], sms: [] as string[] }));

const keyOf = (t: { purpose: string; mobileno: string; distributorcontactid?: number | null }) =>
    `${t.purpose}:${t.mobileno}:${t.distributorcontactid ?? ''}`;

vi.mock('../src/models/auth/otp.model.js', () => ({
    OtpModel: {
        findLatestUnused: vi.fn((t: Parameters<typeof keyOf>[0]) => {
            const live = store.otps.filter((o) => o.target === keyOf(t) && !o.consumed);
            const last = live.at(-1);
            return Promise.resolve(last ? { ...last } : null);
        }),
        replace: vi.fn((t: Parameters<typeof keyOf>[0], codehash: string, expiresat: Date) => {
            for (const o of store.otps) if (o.target === keyOf(t)) o.consumed = true;
            store.otps.push({
                id: store.otps.length + 1,
                target: keyOf(t),
                codehash,
                expiresat,
                attempts: 0,
                createdat: new Date(),
                consumed: false,
            });
            return Promise.resolve();
        }),
        addAttempt: vi.fn((id: number) => {
            const o = store.otps.find((x) => x.id === id);
            if (o) o.attempts += 1;
            return Promise.resolve();
        }),
        consume: vi.fn((id: number) => {
            const o = store.otps.find((x) => x.id === id);
            if (!o || o.consumed) return Promise.resolve(false);
            o.consumed = true;
            return Promise.resolve(true);
        }),
    },
}));

vi.mock('../src/services/sms.service.js', () => ({
    sendSms: vi.fn((_mobile: string, text: string) => {
        store.sms.push(text);
        return Promise.resolve();
    }),
}));

const { OtpService } = await import('../src/services/otp.service.js');

const target = { purpose: 'APP_LOGIN' as const, mobileno: '9876543210' };
const message = (code: string) => `code ${code}`;
const lastCode = () => /code (\d{6})/.exec(store.sms.at(-1) ?? '')?.[1] ?? '';

beforeEach(() => {
    store.otps.length = 0;
    store.sms.length = 0;
});

describe('OtpService', () => {
    it('texts a 6-digit code, stores only a hash, and accepts the code once', async () => {
        await OtpService.issue(target, message);
        const code = lastCode();
        expect(code).toMatch(/^\d{6}$/);
        expect(store.otps[0]?.codehash).not.toContain(code);

        await expect(OtpService.verify(target, code)).resolves.toBeUndefined();
        await expect(OtpService.verify(target, code)).rejects.toMatchObject({
            code: 'OTP_INVALID',
        });
    });

    it('counts wrong tries and gives up after the limit, even for the right code', async () => {
        await OtpService.issue(target, message);
        const code = lastCode();
        const wrong = code === '000000' ? '111111' : '000000';

        await expect(OtpService.verify(target, wrong)).rejects.toMatchObject({
            message: 'That code is not right. 4 tries left.',
        });
        for (let i = 0; i < 4; i++) await OtpService.verify(target, wrong).catch(() => undefined);
        await expect(OtpService.verify(target, code)).rejects.toMatchObject({
            code: 'OTP_INVALID',
        });
    });

    it('refuses a new code within the resend wait (OTP_COOLDOWN)', async () => {
        await OtpService.issue(target, message);
        await expect(OtpService.issue(target, message)).rejects.toMatchObject({
            code: 'OTP_COOLDOWN',
            statusCode: 429,
        });
    });

    it('refuses an expired code', async () => {
        await OtpService.issue(target, message);
        const otp = store.otps[0];
        if (otp) otp.expiresat = new Date(Date.now() - 1000);
        await expect(OtpService.verify(target, lastCode())).rejects.toMatchObject({
            code: 'OTP_INVALID',
        });
    });

    it('ties a code to its purpose and number', async () => {
        await OtpService.issue(target, message);
        const code = lastCode();
        await expect(
            OtpService.verify({ purpose: 'PASSWORD_RESET', mobileno: target.mobileno }, code)
        ).rejects.toMatchObject({ code: 'OTP_INVALID' });
        await expect(
            OtpService.verify({ ...target, mobileno: '9123456789' }, code)
        ).rejects.toMatchObject({ code: 'OTP_INVALID' });
    });
});
