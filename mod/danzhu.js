/**
 * dm.danzhuacg.com M3U8 parser.
 *
 * Accepts:
 *   - 6477-1-1
 *   - https://dm.danzhuacg.com/vodpp/6477-1-1
 *
 * Returns the player M3U8 URL plus a cutRanges hint for the main ffmpeg
 * compression step to remove 06:04-06:24.
 */

const axios = require('axios');

const SITE = 'https://dm.danzhuacg.com';
const HOST = 'dm.danzhuacg.com';
const AD_START_SECONDS = 6 * 60 + 3.8;
const AD_END_SECONDS = 6 * 60 + 24;
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const http = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    validateStatus: (status) => status >= 200 && status < 400,
});

function normalizeInput(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('danzhu 输入不能为空');

    if (/^https?:\/\//i.test(raw)) {
        let urlObj;
        try {
            urlObj = new URL(raw);
        } catch (e) {
            throw new Error(`非法 danzhu URL: ${raw}`);
        }

        const host = urlObj.hostname.toLowerCase();
        if (host !== HOST) {
            throw new Error(`danzhu URL 域名必须是 ${HOST}: ${host}`);
        }

        const parts = urlObj.pathname.split('/').filter(Boolean);
        const id = normalizeVideoId(parts[parts.length - 1] || '');
        return { id, pageUrl: urlObj.href };
    }

    const id = normalizeVideoId(raw.split('/').filter(Boolean).pop() || raw);
    return { id, pageUrl: `${SITE}/vodpp/${id}` };
}

function normalizeVideoId(value) {
    const id = String(value || '').trim().replace(/\.html?$/i, '');
    if (!/^\d+-\d+-\d+$/.test(id)) {
        throw new Error(`非法 danzhu 视频编号: ${value}，期望形如 6477-1-1`);
    }
    return id;
}

function extractPageTitle(html) {
    const titleTag = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleTag || !titleTag[1]) return null;
    return titleTag[1].replace(/\s+/g, ' ').trim() || null;
}

function extractObjectLiteral(html, varName) {
    const marker = new RegExp(`${varName}\\s*=`, 'i').exec(html);
    if (!marker) throw new Error(`页面中未找到 ${varName}`);

    const start = html.indexOf('{', marker.index + marker[0].length);
    if (start < 0) throw new Error(`${varName} 后未找到对象开始符`);

    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let i = start; i < html.length; i++) {
        const ch = html[i];

        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return html.slice(start, i + 1);
        }
    }

    throw new Error(`${varName} 对象未闭合`);
}

function parsePlayerAaaa(html) {
    const literal = extractObjectLiteral(html, 'player_aaaa');
    try {
        return JSON.parse(literal);
    } catch (jsonError) {
        try {
            // player_aaaa is a site-controlled object literal.
            // eslint-disable-next-line no-new-func
            return new Function(`return (${literal})`)();
        } catch (fnError) {
            throw new Error(`player_aaaa 解析失败: ${jsonError.message}`);
        }
    }
}

function browserUnescape(value) {
    try {
        return unescape(value);
    } catch (e) {
        return value;
    }
}

function decodeMaybeUrl(value) {
    let text = String(value || '').trim();
    if (!text) return text;

    text = text.replace(/\\\//g, '/');
    if (/%[0-9a-f]{2}/i.test(text) || /%u[0-9a-f]{4}/i.test(text)) {
        text = browserUnescape(text);
    }
    return text;
}

function decodePlayerUrl(player) {
    const encrypt = String(player?.encrypt ?? '');
    let url = String(player?.url || '').trim();

    if (encrypt === '2') {
        const b64 = browserUnescape(url);
        try {
            url = Buffer.from(b64, 'base64').toString('utf8');
        } catch (e) {
            throw new Error('player_aaaa.url base64 解码失败');
        }
    } else if (encrypt === '1') {
        url = browserUnescape(url);
    }

    return decodeMaybeUrl(url);
}

function normalizeM3U8Url(candidate, pageUrl) {
    const text = decodeMaybeUrl(candidate);
    if (!text) return null;

    let url = text;
    if (url.startsWith('//')) {
        url = `https:${url}`;
    } else if (url.startsWith('/')) {
        url = new URL(url, pageUrl).href;
    }

    if (/^https?:\/\//i.test(url) && /\.m3u8(?:[?#]|$)/i.test(url)) {
        return url;
    }
    return null;
}

function extractM3U8Url(player, pageUrl) {
    const primary = normalizeM3U8Url(decodePlayerUrl(player), pageUrl);
    if (primary) return primary;

    for (const value of Object.values(player || {})) {
        if (typeof value !== 'string') continue;
        const candidate = normalizeM3U8Url(value, pageUrl);
        if (candidate) return candidate;
    }

    throw new Error('player_aaaa 中未找到当前视频的 m3u8 链接');
}

async function fetchText(url, refererUrl, accept = '*/*') {
    const res = await http.get(url, {
        responseType: 'text',
        headers: {
            Accept: accept,
            Referer: refererUrl || SITE + '/',
            Origin: new URL(refererUrl || SITE).origin,
        },
    });
    return typeof res.data === 'string' ? res.data : String(res.data);
}

async function download(input, options = {}) {
    const { id, pageUrl } = normalizeInput(input);

    const pageHtml = await fetchText(pageUrl, SITE + '/');
    const pageTitle = extractPageTitle(pageHtml);
    const player = parsePlayerAaaa(pageHtml);
    const m3u8Url = extractM3U8Url(player, pageUrl);

    if (options.meta) {
        return {
            url: m3u8Url,
            pageUrl,
            pageTitle,
            title: pageTitle,
            episodeId: id,
            cutRanges: [{ start: AD_START_SECONDS, end: AD_END_SECONDS }],
        };
    }

    return m3u8Url;
}

module.exports = {
    download,
    normalizeInput,
    AD_START_SECONDS,
    AD_END_SECONDS,
};

if (require.main === module) {
    const arg = process.argv[2] || '6477-1-1';
    download(arg, { meta: true })
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((err) => {
            console.error('[danzhu] failed:', err.message);
            process.exit(1);
        });
}
