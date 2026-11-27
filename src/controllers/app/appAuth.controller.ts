/**
 * App auth controller — thin: read the validated request, call one service
 * function, pick a response helper. Tokens travel in the body (see the route file).
 */

import type { Request, Response } from 'express';

import type {
    AppOtpRequestBody,
    AppOtpVerifyBody,
    AppRefreshBody,
} from '../../routes/app/appAuth.route.js';
import { AppAuthService } from '../../services/appAuth.service.js';
import { UnauthorizedError } from '../../utils/errors.js';
import { noContent, success } from '../../utils/response.js';
import { clientOf } from '../auth/auth.controller.js';

export const AppAuthController = {
    requestOtp: async (req: Request, res: Response) => {
        const { mobile } = req.body as AppOtpRequestBody;
        const message = await AppAuthService.requestOtp(mobile);
        return success(res, { message }, message);
    },

    verifyOtp: async (req: Request, res: Response) => {
        const { mobile, otp } = req.body as AppOtpVerifyBody;
        return success(
            res,
            await AppAuthService.verifyOtp(mobile, otp, clientOf(req)),
            'Signed in'
        );
    },

    refresh: async (req: Request, res: Response) => {
        const { refreshToken } = req.body as AppRefreshBody;
        return success(res, await AppAuthService.refresh(refreshToken), 'Session refreshed');
    },

    logout: async (req: Request, res: Response) => {
        const body = req.body as { refreshToken?: unknown } | undefined;
        const token = typeof body?.refreshToken === 'string' ? body.refreshToken : undefined;
        await AppAuthService.logout(token);
        return noContent(res);
    },

    me: async (req: Request, res: Response) => {
        if (!req.contact) throw new UnauthorizedError();
        return success(res, await AppAuthService.me(req.contact.id), 'Signed-in number');
    },
};
