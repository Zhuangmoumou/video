class ApiError extends Error {
    constructor(message, status, code) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

const els = {
    authForm: document.getElementById('auth-form'),
    authPassword: document.getElementById('auth-password'),
    authSubmit: document.getElementById('auth-submit'),
    authFeedback: document.getElementById('auth-feedback')
};

function setAuthFeedback(text, tone = 'muted') {
    els.authFeedback.textContent = text || '';
    els.authFeedback.dataset.tone = tone;
}

async function readResponsePayload(response) {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (error) {
        return text;
    }
}

async function throwApiError(response) {
    const payload = await readResponsePayload(response);
    const errorMessage = payload && typeof payload === 'object' && payload.error
        ? payload.error
        : `请求失败: ${response.status}`;
    const errorCode = payload && typeof payload === 'object'
        ? payload.code
        : '';
    throw new ApiError(errorMessage, response.status, errorCode);
}

async function request(url, init = {}) {
    return fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...init
    });
}

async function requestJson(url, init = {}) {
    const response = await request(url, init);
    if (!response.ok) {
        await throwApiError(response);
    }
    return response.json();
}

async function requestNoContent(url, init = {}) {
    const response = await request(url, init);
    if (!response.ok) {
        await throwApiError(response);
    }
}

function getInitialMessage() {
    const query = new URLSearchParams(window.location.search);
    if (query.get('logout') === '1') {
        return { text: '已退出登录。', tone: 'muted' };
    }
    if (query.get('reauth') === '1') {
        return { text: '登录已失效，请重新输入密码。', tone: 'error' };
    }
    return { text: '正在检查访问权限...', tone: 'muted' };
}

async function onLogin(event) {
    event.preventDefault();
    const password = els.authPassword.value;
    if (!password) {
        setAuthFeedback('请输入访问密码。', 'error');
        return;
    }

    els.authSubmit.disabled = true;
    setAuthFeedback('正在验证...', 'muted');
    try {
        await requestNoContent('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        window.location.assign('/console');
    } catch (error) {
        setAuthFeedback(error.message || '登录失败', 'error');
    } finally {
        els.authSubmit.disabled = false;
    }
}

async function bootstrap() {
    const initial = getInitialMessage();
    setAuthFeedback(initial.text, initial.tone);
    els.authForm.addEventListener('submit', onLogin);

    const status = await requestJson('/api/auth/status');
    if (status.authenticated) {
        window.location.replace('/console');
        return;
    }

    if (!status.configured) {
        setAuthFeedback('服务端尚未配置访问密码。请设置 `VIDEO_UI_PASSWORD` 或 `auth.passwordHash`。', 'error');
        return;
    }

    if (initial.text === '正在检查访问权限...') {
        setAuthFeedback('请输入访问密码。', 'muted');
    }

    requestAnimationFrame(() => {
        els.authPassword.focus();
    });
}

bootstrap().catch((error) => {
    setAuthFeedback(error.message || '初始化失败', 'error');
});
