const axios = require('axios');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const getDownloadProxy = () => (process.env.DOWNLOAD_PROXY || process.env.VIDEO_PROXY || '').trim();
const getProxyDomain = () => (process.env.PROXY_DOMAIN || '').trim();

const applyProxyDomain = (originalUrl) => {
    // 两个代理都允许为空：都为空则直连。
    // DOWNLOAD_PROXY 是真正 HTTP 代理，优先级最高；设置后不再使用 PROXY_DOMAIN 改写 URL，避免双代理冲突。
    if (getDownloadProxy() || !getProxyDomain() || !originalUrl) return originalUrl;
    const prefix = getProxyDomain().replace(/\/+$/, '') + '/';
    return prefix + originalUrl.replace('://', '/');
};

const formatAxiosError = (error, context = '') => {
    const lines = [];
    const add = (label, value) => {
        if (value !== undefined && value !== null && value !== '') lines.push(`${label}: ${value}`);
    };

    if (context) lines.push(context);
    add('name', error?.name);
    add('message', error?.message);
    add('code', error?.code);
    add('method', error?.config?.method?.toUpperCase());
    add('url', error?.config?.url);
    add('timeout', error?.config?.timeout);
    add('status', error?.response?.status);
    add('statusText', error?.response?.statusText);

    const cause = error?.cause;
    if (cause) {
        add('cause', `${cause.name || 'Error'}: ${cause.message || String(cause)}`);
        add('cause.code', cause.code);
        if (Array.isArray(cause.errors)) {
            cause.errors.forEach((inner, index) => {
                add(`cause.errors[${index}]`, `${inner.name || 'Error'}: ${inner.message || String(inner)}`);
                add(`cause.errors[${index}].code`, inner.code);
                add(`cause.errors[${index}].address`, inner.address);
                add(`cause.errors[${index}].port`, inner.port);
            });
        }
    }

    return lines.join('\n');
};

const formatSpeed = (bytesPerSec) => {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0B/s';
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)}MB/s`;
    if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)}KB/s`;
    return `${Math.round(bytesPerSec)}B/s`;
};

const sameOrigin = (a, b) => {
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        return ua.protocol === ub.protocol && ua.host === ub.host;
    } catch (e) {
        return false;
    }
};

const stripCrossSiteHeaders = (headers = {}) => {
    const next = { ...headers };
    delete next.Referer;
    delete next.referer;
    delete next.Origin;
    delete next.origin;
    delete next.Cookie;
    delete next.cookie;
    return next;
};

const isRedirectStatus = (status) => [301, 302, 303, 307, 308].includes(status);

/**
 * 下载 MP4：手动跟随 302 中转链。
 * 跳转到跨站对象存储/网盘时剥离 Referer/Origin/Cookie，避免被 403。
 */
const downloadMp4WithRedirects = async (startUrl, headers, signal, proxy) => {
    let currentUrl = startUrl;
    let currentHeaders = { ...headers };
    const maxHops = 10;
    const hopLog = [];

    // 初始链接已是跨站（相对 Referer）时，首跳就剥离跨站头
    const initialReferer = currentHeaders.Referer || currentHeaders.referer;
    if (initialReferer && !sameOrigin(initialReferer, currentUrl)) {
        currentHeaders = stripCrossSiteHeaders(currentHeaders);
        hopLog.push(`init strip cross-site headers for ${currentUrl.substring(0, 80)}`);
    }

    for (let hop = 0; hop < maxHops; hop++) {
        const requestUrl = applyProxyDomain(currentUrl);
        let response;
        try {
            response = await axios({
                url: requestUrl,
                method: 'GET',
                responseType: 'stream',
                maxRedirects: 0,
                validateStatus: (status) => (status >= 200 && status < 400),
                signal,
                headers: currentHeaders,
                proxy: proxy || undefined
            });
        } catch (error) {
            // axios 在 maxRedirects:0 时，部分版本仍把 3xx 当成功；若走 error 且有 response 则继续处理
            if (error.response && isRedirectStatus(error.response.status)) {
                response = error.response;
            } else {
                console.error('[Axios Error] MP4请求失败\n' + formatAxiosError(error, `mediaUrl=${currentUrl} hop=${hop}`));
                throw error;
            }
        }

        if (isRedirectStatus(response.status)) {
            const location = response.headers?.location || response.headers?.Location;
            if (!location) {
                throw new Error(`MP4 重定向缺少 Location (status=${response.status})`);
            }
            // 丢弃 redirect body
            if (response.data && typeof response.data.destroy === 'function') {
                response.data.destroy();
            }

            const nextUrl = new URL(location, currentUrl).href;
            const crossSite = !sameOrigin(currentUrl, nextUrl);
            hopLog.push(`${response.status} -> ${nextUrl.substring(0, 80)}${crossSite ? ' [跨站,剥离Referer/Origin/Cookie]' : ''}`);

            if (crossSite) {
                currentHeaders = stripCrossSiteHeaders(currentHeaders);
            }
            currentUrl = nextUrl;
            continue;
        }

        if (hopLog.length) {
            console.log(`[MP4 Redirect] ${hopLog.join(' | ')}`);
        }
        return { response, finalUrl: currentUrl, hops: hopLog };
    }

    throw new Error(`MP4 重定向次数过多(>${maxHops})，可能存在循环跳转`);
};

const parseProxyUrl = () => {
    const raw = getDownloadProxy();
    if (!raw) return null;
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error('DOWNLOAD_PROXY 只支持 http/https 代理，例如 http://user:pass@host:port');
    }
    return u;
};

const getPlaywrightProxyConfig = () => {
    const u = parseProxyUrl();
    if (!u) return null;
    const cfg = { server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}` };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
};

const getAxiosProxyConfig = () => {
    const u = parseProxyUrl();
    if (!u) return null;
    const cfg = {
        protocol: u.protocol.slice(0, -1),
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    };
    if (u.username || u.password) {
        cfg.auth = {
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password)
        };
    }
    return cfg;
};

module.exports = {
    DEFAULT_UA, getDownloadProxy, applyProxyDomain, formatAxiosError, formatSpeed,
    getPlaywrightProxyConfig, getAxiosProxyConfig, downloadMp4WithRedirects
};
