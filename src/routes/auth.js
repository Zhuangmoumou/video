const express = require('express');

module.exports = function createAuthRouter(auth) {
    const router = express.Router();
    const {
        getUiAuthConfig, getUiSession, refreshUiSession, getLoginAttemptState,
        recordFailedLogin, clearLoginAttempts, destroyUiSession, createUiSession,
        buildSessionCookieOptions, verifyUiPassword, sendJsonError, requireSameOrigin,
        getUiPageAuthState, sendUiPage
    } = auth;

    router.get(['/', '/login'], async (req, res) => {
        const { session } = await getUiPageAuthState(req, res);
        if (session) return res.redirect('/console');
        sendUiPage(res, 'login.html');
    });
    router.get('/console', async (req, res) => {
        const { session } = await getUiPageAuthState(req, res);
        if (!session) return res.redirect('/?reauth=1');
        sendUiPage(res, 'console.html');
    });
    router.get('/api/auth/status', async (req, res) => {
        const { authConfig, session } = await getUiPageAuthState(req, res);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            configured: authConfig.configured,
            authenticated: Boolean(session),
            sessionExpiresAt: session?.expiresAt || null
        });
    });
    router.post('/api/auth/login', requireSameOrigin, async (req, res) => {
        const authConfig = await getUiAuthConfig();
        if (!authConfig.configured) return sendJsonError(res, 503, 'AUTH_NOT_CONFIGURED', '服务端未配置访问密码');
        const existingSession = getUiSession(req);
        if (existingSession) {
            refreshUiSession(req, res, existingSession, authConfig);
            return res.status(204).end();
        }
        const loginState = getLoginAttemptState(req, authConfig);
        if (loginState.blocked) {
            const seconds = Math.max(1, Math.ceil(loginState.retryAfterMs / 1000));
            return sendJsonError(res, 429, 'AUTH_RATE_LIMITED', `尝试过多，请在 ${seconds} 秒后再试`);
        }
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!password) return sendJsonError(res, 400, 'AUTH_PASSWORD_REQUIRED', '请输入访问密码');
        if (!await verifyUiPassword(password, authConfig)) {
            const nextState = recordFailedLogin(req, authConfig);
            if (nextState.blocked) {
                const seconds = Math.max(1, Math.ceil(nextState.retryAfterMs / 1000));
                return sendJsonError(res, 429, 'AUTH_RATE_LIMITED', `尝试过多，请在 ${seconds} 秒后再试`);
            }
            return sendJsonError(res, 401, 'AUTH_INVALID', '密码错误');
        }
        clearLoginAttempts(req);
        destroyUiSession(req, res);
        const session = createUiSession(req, authConfig);
        res.cookie('video_console_session', session.id, buildSessionCookieOptions(req, authConfig.sessionTtlMs));
        res.setHeader('Cache-Control', 'no-store');
        res.status(204).end();
    });
    router.post('/api/auth/logout', requireSameOrigin, (req, res) => {
        destroyUiSession(req, res);
        res.setHeader('Cache-Control', 'no-store');
        res.status(204).end();
    });
    return router;
};
