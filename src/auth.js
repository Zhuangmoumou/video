const crypto = require('crypto');
const path = require('path');
const { PAGE_DIR, readRuntimeConfig } = require('./config');

const SESSION_COOKIE_NAME = 'video_console_session';
const DEFAULT_AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_BLOCK_MS = 30 * 60 * 1000;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;

function createAuthService() {
    const authSessions = new Map();
    const authLoginAttempts = new Map();
    const authBearerAttempts = new Map();
const firstFilledValue = (...values) => {
    for (const value of values) {
        const text = typeof value === 'string' ? value.trim() : value;
        if (text !== undefined && text !== null && text !== '') {
            return typeof value === 'string' ? value : text;
        }
    }
    return null;
};

const readPositiveInteger = (value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const normalized = Math.floor(numeric);
    if (normalized < min || normalized > max) return fallback;
    return normalized;
};

const getUiAuthConfig = async () => {
    const raw = await readRuntimeConfig();
    const auth = raw?.auth && typeof raw.auth === 'object' ? raw.auth : {};
    return {
        configured: Boolean(firstFilledValue(process.env.VIDEO_UI_PASSWORD_HASH, auth.passwordHash, process.env.VIDEO_UI_PASSWORD, auth.password)),
        passwordHash: firstFilledValue(process.env.VIDEO_UI_PASSWORD_HASH, auth.passwordHash),
        password: firstFilledValue(process.env.VIDEO_UI_PASSWORD, auth.password),
        sessionTtlMs: readPositiveInteger(
            firstFilledValue(process.env.VIDEO_UI_SESSION_TTL_MS, auth.sessionTtlMs),
            DEFAULT_AUTH_SESSION_TTL_MS,
            { min: 60 * 1000, max: 14 * 24 * 60 * 60 * 1000 }
        ),
        loginWindowMs: readPositiveInteger(
            firstFilledValue(process.env.VIDEO_UI_LOGIN_WINDOW_MS, auth.loginWindowMs),
            DEFAULT_LOGIN_WINDOW_MS,
            { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }
        ),
        loginBlockMs: readPositiveInteger(
            firstFilledValue(process.env.VIDEO_UI_LOGIN_BLOCK_MS, auth.loginBlockMs),
            DEFAULT_LOGIN_BLOCK_MS,
            { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }
        ),
        loginMaxAttempts: readPositiveInteger(
            firstFilledValue(process.env.VIDEO_UI_LOGIN_MAX_ATTEMPTS, auth.loginMaxAttempts),
            DEFAULT_LOGIN_MAX_ATTEMPTS,
            { min: 1, max: 20 }
        )
    };
};

const stableDigest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();

const safeTextEqual = (left, right) => crypto.timingSafeEqual(stableDigest(left), stableDigest(right));

const verifyScryptPassword = (password, encodedHash) => {
    try {
        const [scheme, saltText, hashText] = String(encodedHash || '').split('$');
        if (scheme !== 'scrypt' || !saltText || !hashText) return false;
        const salt = Buffer.from(saltText, 'base64');
        const stored = Buffer.from(hashText, 'base64');
        if (!salt.length || !stored.length) return false;
        const derived = crypto.scryptSync(String(password ?? ''), salt, stored.length);
        return crypto.timingSafeEqual(derived, stored);
    } catch (e) {
        return false;
    }
};

const verifyUiPassword = async (password, authConfig) => {
    if (!authConfig?.configured) return false;
    if (authConfig.passwordHash) {
        return verifyScryptPassword(password, authConfig.passwordHash);
    }
    if (authConfig.password) {
        return safeTextEqual(password, authConfig.password);
    }
    return false;
};

const parseCookieHeader = (cookieHeader = '') => {
    const entries = {};
    for (const chunk of String(cookieHeader).split(';')) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (!key) continue;
        try {
            entries[key] = decodeURIComponent(value);
        } catch (e) {
            entries[key] = value;
        }
    }
    return entries;
};

const getRequestSessionId = (req) => parseCookieHeader(req.headers.cookie || '')[SESSION_COOKIE_NAME] || null;

const hasSessionCookie = (req) => Boolean(getRequestSessionId(req));

const getClientFingerprint = (req) => crypto.createHash('sha256')
    .update(`${req.socket?.remoteAddress || ''}\n${req.get('user-agent') || ''}`)
    .digest('base64');

const cleanupExpiredSessions = () => {
    const now = Date.now();
    for (const [sessionId, session] of authSessions.entries()) {
        if (!session || session.expiresAt <= now) {
            authSessions.delete(sessionId);
        }
    }
};

const cleanupExpiredAttempts = (store, authConfig) => {
    const now = Date.now();
    const maxAge = Math.max(authConfig.loginWindowMs, authConfig.loginBlockMs);
    for (const [key, entry] of store.entries()) {
        if (!entry || (entry.blockedUntil && entry.blockedUntil <= now && now - entry.windowStartedAt > maxAge)) {
            store.delete(key);
            continue;
        }
        if (!entry.blockedUntil && now - entry.windowStartedAt > authConfig.loginWindowMs) {
            store.delete(key);
        }
    }
};

const shouldUseSecureCookies = (req) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim()
        .toLowerCase();
    return Boolean(req.secure || forwardedProto === 'https');
};

const buildSessionCookieOptions = (req, maxAge) => ({
    httpOnly: true,
    sameSite: 'strict',
    secure: shouldUseSecureCookies(req),
    path: '/',
    maxAge
});

const clearSessionCookie = (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'strict',
        secure: shouldUseSecureCookies(req),
        path: '/'
    });
};

const createUiSession = (req, authConfig) => {
    cleanupExpiredSessions();
    const now = Date.now();
    const session = {
        id: crypto.randomBytes(32).toString('base64url'),
        createdAt: now,
        updatedAt: now,
        expiresAt: now + authConfig.sessionTtlMs,
        fingerprint: getClientFingerprint(req)
    };
    authSessions.set(session.id, session);
    return session;
};

const getUiSession = (req) => {
    cleanupExpiredSessions();
    const sessionId = getRequestSessionId(req);
    if (!sessionId) return null;
    const session = authSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        authSessions.delete(sessionId);
        return null;
    }
    if (session.fingerprint !== getClientFingerprint(req)) {
        authSessions.delete(sessionId);
        return null;
    }
    return session;
};

const refreshUiSession = (req, res, session, authConfig) => {
    const now = Date.now();
    session.updatedAt = now;
    session.expiresAt = now + authConfig.sessionTtlMs;
    authSessions.set(session.id, session);
    res.cookie(SESSION_COOKIE_NAME, session.id, buildSessionCookieOptions(req, authConfig.sessionTtlMs));
    return session;
};

const destroyUiSession = (req, res) => {
    const sessionId = getRequestSessionId(req);
    if (sessionId) {
        authSessions.delete(sessionId);
    }
    clearSessionCookie(req, res);
};

const getLoginAttemptKey = (req) => req.socket?.remoteAddress || 'unknown';

const getAttemptState = (store, req, authConfig) => {
    cleanupExpiredAttempts(store, authConfig);
    const key = getLoginAttemptKey(req);
    const entry = store.get(key);
    if (!entry) {
        return {
            blocked: false,
            remaining: authConfig.loginMaxAttempts,
            retryAfterMs: 0
        };
    }

    const now = Date.now();
    if (entry.blockedUntil && entry.blockedUntil > now) {
        return {
            blocked: true,
            remaining: 0,
            retryAfterMs: entry.blockedUntil - now
        };
    }

    if (now - entry.windowStartedAt > authConfig.loginWindowMs) {
        store.delete(key);
        return {
            blocked: false,
            remaining: authConfig.loginMaxAttempts,
            retryAfterMs: 0
        };
    }

    return {
        blocked: false,
        remaining: Math.max(authConfig.loginMaxAttempts - entry.count, 0),
        retryAfterMs: 0
    };
};

const recordFailedAttempt = (store, req, authConfig) => {
    cleanupExpiredAttempts(store, authConfig);
    const key = getLoginAttemptKey(req);
    const now = Date.now();
    const current = store.get(key);
    const isNewWindow = !current || now - current.windowStartedAt > authConfig.loginWindowMs;
    const next = isNewWindow
        ? { count: 1, windowStartedAt: now, blockedUntil: null }
        : { ...current, count: current.count + 1 };

    if (next.count >= authConfig.loginMaxAttempts) {
        next.blockedUntil = now + authConfig.loginBlockMs;
    }

    store.set(key, next);
    return {
        blocked: Boolean(next.blockedUntil && next.blockedUntil > now),
        remaining: Math.max(authConfig.loginMaxAttempts - next.count, 0),
        retryAfterMs: next.blockedUntil ? Math.max(next.blockedUntil - now, 0) : 0
    };
};

const getLoginAttemptState = (req, authConfig) => getAttemptState(authLoginAttempts, req, authConfig);

const recordFailedLogin = (req, authConfig) => recordFailedAttempt(authLoginAttempts, req, authConfig);

const clearLoginAttempts = (req) => {
    authLoginAttempts.delete(getLoginAttemptKey(req));
};

const getBearerAttemptState = (req, authConfig) => {
    return getAttemptState(authBearerAttempts, req, authConfig);
};

const recordFailedBearerAuth = (req, authConfig) => {
    return recordFailedAttempt(authBearerAttempts, req, authConfig);
};

const clearBearerAttempts = (req) => {
    authBearerAttempts.delete(getLoginAttemptKey(req));
};

const sendJsonError = (res, status, code, error) => {
    res.status(status);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code, error });
};

const sendRequestError = (req, res, status, code, error) => {
    const requestPath = req.originalUrl || req.path || '';
    if (requestPath.startsWith('/api/') || req.method !== 'GET' || (req.get('accept') || '').includes('application/json')) {
        return sendJsonError(res, status, code, error);
    }
    res.status(status);
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; charset=utf-8').send(error);
};

const requireSameOrigin = (req, res, next) => {
    const fetchSite = String(req.get('sec-fetch-site') || '').trim().toLowerCase();
    if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
        sendRequestError(req, res, 403, 'AUTH_ORIGIN_DENIED', '来源校验失败');
        return;
    }

    const origin = String(req.get('origin') || '').trim();
    if (!origin) {
        next();
        return;
    }

    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch (e) {
        sendRequestError(req, res, 403, 'AUTH_ORIGIN_DENIED', '来源校验失败');
        return;
    }

    if (originUrl.host !== String(req.get('host') || '').trim()) {
        sendRequestError(req, res, 403, 'AUTH_ORIGIN_DENIED', '来源校验失败');
        return;
    }

    next();
};

const requireUiAuth = async (req, res, next) => {
    const authConfig = await getUiAuthConfig();
    if (!authConfig.configured) {
        destroyUiSession(req, res);
        sendRequestError(req, res, 503, 'AUTH_NOT_CONFIGURED', '服务端未配置访问密码');
        return;
    }

    const session = getUiSession(req);
    if (!session) {
        if (hasSessionCookie(req)) {
            clearSessionCookie(req, res);
        }
        sendRequestError(req, res, 401, 'AUTH_REQUIRED', '需要先登录');
        return;
    }

    req.auth = {
        session: refreshUiSession(req, res, session, authConfig),
        settings: authConfig
    };
    next();
};

/** POST / 兼容协议：Authorization: Bearer <明文口令>，与 config 中 passwordHash/password 校验 */
const getBearerToken = (req) => {
    const header = String(req.get('authorization') || '').trim();
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return '';
    return match[1].trim();
};

const requireBearerAuth = async (req, res, next) => {
    const authConfig = await getUiAuthConfig();
    if (!authConfig.configured) {
        sendJsonError(res, 503, 'AUTH_NOT_CONFIGURED', '服务端未配置访问密码');
        return;
    }

    const sendBearerRateLimit = (attemptState) => {
        const seconds = Math.max(1, Math.ceil(attemptState.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        sendJsonError(res, 429, 'AUTH_RATE_LIMITED', `尝试过多，请在 ${seconds} 秒后再试`);
    };

    const attemptState = getBearerAttemptState(req, authConfig);
    if (attemptState.blocked) {
        sendBearerRateLimit(attemptState);
        return;
    }

    const token = getBearerToken(req);
    if (!token) {
        const nextState = recordFailedBearerAuth(req, authConfig);
        if (nextState.blocked) {
            sendBearerRateLimit(nextState);
            return;
        }
        sendJsonError(res, 401, 'AUTH_REQUIRED', '需要 Authorization: Bearer 令牌');
        return;
    }

    const verified = await verifyUiPassword(token, authConfig);
    if (!verified) {
        const nextState = recordFailedBearerAuth(req, authConfig);
        if (nextState.blocked) {
            sendBearerRateLimit(nextState);
            return;
        }
        sendJsonError(res, 401, 'AUTH_INVALID', '令牌无效');
        return;
    }

    clearBearerAttempts(req);

    req.auth = {
        bearer: true,
        settings: authConfig
    };
    next();
};

const getUiPageAuthState = async (req, res) => {
    const authConfig = await getUiAuthConfig();
    const session = authConfig.configured ? getUiSession(req) : null;
    if (session && authConfig.configured) {
        refreshUiSession(req, res, session, authConfig);
    } else if (hasSessionCookie(req)) {
        clearSessionCookie(req, res);
    }
    return { authConfig, session };
};

const sendUiPage = (res, fileName) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(PAGE_DIR, fileName));
};
    return {
        getUiAuthConfig, verifyUiPassword, getUiSession, refreshUiSession, destroyUiSession,
        getLoginAttemptState, recordFailedLogin, clearLoginAttempts, createUiSession,
        buildSessionCookieOptions, sendJsonError, sendRequestError, requireSameOrigin,
        requireUiAuth, requireBearerAuth, getUiPageAuthState, sendUiPage
    };
}

module.exports = { createAuthService };
