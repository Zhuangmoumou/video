class ApiError extends Error {
    constructor(message, status, code) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

const state = {
    originConfig: [],
    mods: ['none'],
    resolutions: [],
    selectedOrigin: '',
    selectedResolution: 'api-default',
    files: [],
    busy: false,
    streamText: '正在初始化...',
    streamLock: false,
    timer: null,
    lastServerLogText: ''
};

const els = {
    logoutBtn: document.getElementById('logout-btn'),
    serverStatus: document.getElementById('server-status'),
    apiStatus: document.getElementById('api-status'),
    taskId: document.getElementById('task-id'),
    regenCode: document.getElementById('regen-code'),
    taskForm: document.getElementById('task-form'),
    originSelect: document.getElementById('origin-select'),
    inputText: document.getElementById('input-text'),
    fileInput: document.getElementById('file-input'),
    modSelect: document.getElementById('mod-select'),
    resolutionSelect: document.getElementById('resolution-select'),
    sourcePreview: document.getElementById('source-preview'),
    stopBtn: document.getElementById('stop-btn'),
    clearBtn: document.getElementById('clear-btn'),
    refreshState: document.getElementById('refresh-state'),
    refreshFiles: document.getElementById('refresh-files'),
    logView: document.getElementById('log-view'),
    fileList: document.getElementById('file-list'),
    templateList: document.getElementById('template-list')
};

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setLog(text) {
    state.streamText = text || '等待提交...';
    els.logView.textContent = state.streamText;
}

function appendLog(text) {
    const next = state.streamText && state.streamText !== '等待提交...'
        ? `${state.streamText}\n\n${text}`
        : text;
    setLog(next);
}

function buildCode() {
    return String(Date.now()).slice(-6);
}

function stopAutoRefresh() {
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
}

function startAutoRefresh() {
    stopAutoRefresh();
    state.timer = setInterval(() => {
        refreshAll().catch((error) => {
            if (!handleProtectedError(error)) {
                appendLog(`错误: ${error.message || error}`);
            }
        });
    }, 5000);
}

function readConfigSourceParts(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    return raw.split('-').map((item) => item.trim()).filter(Boolean);
}

function applyTemplate(template, parts) {
    let output = String(template || '');
    for (let i = 0; i < 9; i += 1) {
        output = output.replaceAll(`{${i + 1}}`, parts[i] ?? '');
    }
    return output;
}

function renderOrigins(list = []) {
    state.originConfig = list;
    if (!list.length) {
        state.selectedOrigin = '';
        els.originSelect.innerHTML = '<option value="">未加载来源</option>';
        els.originSelect.value = '';
        els.sourcePreview.value = '';
        return;
    }

    const fallback = list.length ? '0' : '';
    const nextSelected = list[Number(state.selectedOrigin)] ? state.selectedOrigin : fallback;
    state.selectedOrigin = nextSelected;
    els.originSelect.innerHTML = list.map((item, index) => (
        `<option value="${esc(String(index))}">${esc(item.name)}</option>`
    )).join('');
    els.originSelect.value = nextSelected;
    renderTemplatePreview();
}

function renderTemplatePreview() {
    const item = state.originConfig[Number(state.selectedOrigin)] || state.originConfig[0];
    if (!item) {
        els.sourcePreview.value = '';
        return;
    }

    const parts = readConfigSourceParts(els.inputText.value);
    els.sourcePreview.value = applyTemplate(item.url, parts);
}

function renderMods(mods = ['none']) {
    state.mods = mods.length ? mods : ['none'];
    const nextSelected = state.mods.includes(els.modSelect.value)
        ? els.modSelect.value
        : (state.mods.includes('none') ? 'none' : state.mods[0]);
    els.modSelect.innerHTML = state.mods.map((mod) => `<option value="${esc(mod)}">${esc(mod)}</option>`).join('');
    els.modSelect.value = nextSelected || 'none';
}

function renderResolutions(resolutions = []) {
    state.resolutions = resolutions;
    if (!resolutions.length) {
        state.selectedResolution = 'api-default';
        els.resolutionSelect.innerHTML = '<option value="api-default">未加载分辨率</option>';
        els.resolutionSelect.value = 'api-default';
        els.apiStatus.textContent = '等待加载';
        return;
    }

    els.resolutionSelect.innerHTML = resolutions
        .map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`)
        .join('');
    const selected = resolutions.find((item) => item.id === state.selectedResolution)
        ? state.selectedResolution
        : (resolutions[0]?.id || 'api-default');
    state.selectedResolution = selected;
    els.resolutionSelect.value = selected;
    els.apiStatus.textContent = selected === 'api-default' ? 'API 默认 320x170' : `网页分辨率 ${selected}`;
}

function renderFiles(files = []) {
    state.files = files;
    if (!files.length) {
        els.fileList.innerHTML = '<div class="item"><span>暂无输出</span></div>';
        return;
    }

    els.fileList.innerHTML = files.map((file) => `
        <div class="item">
            <strong>${esc(file.name)}</strong>
            <span>${esc(file.sizeText)} · ${esc(file.modifiedAt)}</span>
            <a href="${esc(file.href)}" target="_blank" rel="noreferrer">打开</a>
        </div>
    `).join('');
}

function renderTemplates() {
    if (!state.originConfig.length) {
        els.templateList.innerHTML = '<div class="item"><span>暂无模板</span></div>';
        return;
    }

    els.templateList.innerHTML = state.originConfig.map((item) => `
        <div class="item">
            <strong>${esc(item.name)}</strong>
            <span>${esc(item.url)}</span>
        </div>
    `).join('');
}

function renderState(data = {}) {
    state.busy = Boolean(data.busy);
    els.serverStatus.textContent = state.busy ? '忙碌' : '空闲';
    els.taskId.textContent = `#${String(data.code || els.taskId.textContent.replace('#', '') || buildCode())}`;
    if (Array.isArray(data.logs) && data.logs.length) {
        state.lastServerLogText = data.logs.join('\n');
        if (!state.streamLock) {
            setLog(state.lastServerLogText);
        }
    }
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

async function postLines(payload) {
    const response = await request('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok || !response.body) {
        await throwApiError(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) handleStreamMessage(JSON.parse(line));
            idx = buffer.indexOf('\n');
        }
        if (done) break;
    }

    const tail = buffer.trim();
    if (tail) handleStreamMessage(JSON.parse(tail));
}

function formatJsonBlock(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return String(value);
    }
}

function handleStreamMessage(message) {
    if (message.type === 'msg') {
        setLog(message.content);
        return;
    }
    if (message.type === 'error') {
        appendLog(`错误: ${message.error}`);
        return;
    }
    if (message.type === 'url') {
        appendLog(`完成: ${message.title ? `${message.title}\n` : ''}${message.url}`);
        return;
    }
    if (message.type === 'stop') {
        appendLog(`任务已停止:\n${formatJsonBlock(message.stop)}`);
        return;
    }
    if (message.type === 'rm') {
        appendLog(`任务已停止并清理:\n${formatJsonBlock(message.stop)}\n\n已删除:\n${formatJsonBlock(message.del)}`);
        return;
    }
    if (message.type === 'log') {
        appendLog(`日志导出:\n${message.log}`);
    }
}

function lockForm(locked) {
    state.streamLock = locked;
    els.taskForm.querySelectorAll('input, select, textarea, button').forEach((el) => {
        if (el === els.refreshState || el === els.refreshFiles || el === els.clearBtn) return;
        el.disabled = locked && el !== els.stopBtn;
    });
    els.stopBtn.disabled = false;
}

function collectPayload() {
    const origin = state.originConfig[Number(state.selectedOrigin)] || state.originConfig[0];
    if (!origin) {
        throw new Error('未加载来源配置');
    }

    const rawInput = els.inputText.value.trim();
    const parts = readConfigSourceParts(rawInput);
    const input = applyTemplate(origin.url || '{1}', parts);
    const payload = {
        url: input,
        code: Number(buildCode()),
        resolution: state.selectedResolution
    };

    const file = els.fileInput.value.trim();
    const mod = els.modSelect.value;
    const autoFile = buildAutoFileField(rawInput);
    if (file) {
        payload.file = file;
    } else if (autoFile) {
        payload.file = autoFile;
    }
    if (mod && mod !== 'none') payload.mod = mod;
    return payload;
}

function sanitizeAutoFileToken(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function buildAutoFileField(rawInput) {
    const tokens = String(rawInput || '')
        .split(',')
        .map((item) => item.trim());

    if (!tokens.some(Boolean)) return '';

    const names = tokens.map((item) => {
        if (!item || /^https?:\/\//i.test(item)) return '';
        return sanitizeAutoFileToken(item);
    });

    return names.some(Boolean) ? names.join(',') : '';
}

function redirectToLogin(reason = '') {
    stopAutoRefresh();
    const query = new URLSearchParams();
    if (reason === 'logout') query.set('logout', '1');
    if (reason === 'reauth') query.set('reauth', '1');
    const target = query.size ? `/?${query.toString()}` : '/';
    window.location.replace(target);
}

function isProtectedError(error) {
    return error instanceof ApiError
        && ['AUTH_REQUIRED', 'AUTH_NOT_CONFIGURED', 'AUTH_ORIGIN_DENIED'].includes(error.code);
}

function handleProtectedError(error) {
    if (!isProtectedError(error)) return false;
    redirectToLogin(error.code === 'AUTH_REQUIRED' ? 'reauth' : '');
    return true;
}

async function refreshAll() {
    const bootstrap = await requestJson('/api/ui/bootstrap');
    renderState(bootstrap);
    renderMods(bootstrap.mods || ['none']);
    renderResolutions(bootstrap.resolutions || []);
    renderFiles(bootstrap.files || []);
    renderOrigins(bootstrap.origins || []);
    renderTemplates();
}

async function ensureAuthenticated() {
    const status = await requestJson('/api/auth/status');
    if (!status.configured) {
        redirectToLogin();
        return false;
    }
    if (!status.authenticated) {
        redirectToLogin('reauth');
        return false;
    }
    return true;
}

async function onSubmit(event) {
    event.preventDefault();
    let payload;
    try {
        payload = collectPayload();
    } catch (error) {
        appendLog(`错误: ${error.message || error}`);
        return;
    }

    setLog(`已提交:\n${JSON.stringify(payload, null, 2)}`);
    lockForm(true);
    try {
        await postLines(payload);
    } catch (error) {
        if (!handleProtectedError(error)) {
            appendLog(`错误: ${error.message || error}`);
        }
    } finally {
        lockForm(false);
        await refreshAll().catch((error) => {
            if (!handleProtectedError(error)) {
                appendLog(`错误: ${error.message || error}`);
            }
        });
    }
}

async function onLogout() {
    try {
        await requestNoContent('/api/auth/logout', {
            method: 'POST'
        });
    } catch (error) {
        if (handleProtectedError(error)) return;
    }

    redirectToLogin('logout');
}

function bindEvents() {
    els.logoutBtn.addEventListener('click', onLogout);
    els.originSelect.addEventListener('change', () => {
        state.selectedOrigin = els.originSelect.value;
        renderTemplatePreview();
    });
    els.inputText.addEventListener('input', renderTemplatePreview);
    els.resolutionSelect.addEventListener('change', () => {
        state.selectedResolution = els.resolutionSelect.value;
        els.apiStatus.textContent = state.selectedResolution === 'api-default'
            ? 'API 默认 320x170'
            : `网页分辨率 ${state.selectedResolution}`;
    });
    els.regenCode.addEventListener('click', () => {
        els.taskId.textContent = `#${buildCode()}`;
    });
    els.taskForm.addEventListener('submit', onSubmit);
    els.stopBtn.addEventListener('click', async () => {
        try {
            const result = await requestJson('/api/task/stop', { method: 'POST' });
            handleStreamMessage(result);
        } catch (error) {
            if (!handleProtectedError(error)) {
                appendLog(`错误: ${error.message || error}`);
            }
        } finally {
            lockForm(false);
            await refreshAll().catch((error) => {
                if (!handleProtectedError(error)) {
                    appendLog(`错误: ${error.message || error}`);
                }
            });
        }
    });
    els.clearBtn.addEventListener('click', () => {
        setLog('等待提交...');
    });
    els.refreshState.addEventListener('click', async () => {
        try {
            await refreshAll();
        } catch (error) {
            if (!handleProtectedError(error)) {
                appendLog(`错误: ${error.message || error}`);
            }
        }
    });
    els.refreshFiles.addEventListener('click', async () => {
        try {
            renderFiles(await requestJson('/api/ui/files'));
        } catch (error) {
            if (!handleProtectedError(error)) {
                appendLog(`错误: ${error.message || error}`);
            }
        }
    });
}

async function bootstrap() {
    bindEvents();
    const ready = await ensureAuthenticated();
    if (!ready) return;

    els.taskId.textContent = `#${buildCode()}`;
    await refreshAll();
    startAutoRefresh();
}

bootstrap().catch((error) => {
    if (!handleProtectedError(error)) {
        setLog(`初始化失败:\n${error.message || error}`);
    }
});
