/**
 * anime.xifanacg.com (稀饭动漫) MP4 直链解析插件。
 *
 * 播放页是 MacCMS 结构，player_aaaa.url 直接就是当前集的 mp4 直链（encrypt=0 明文），
 * 不需要像 mgnacg 那样再走线路解析页解密。
 *
 * 接受：
 *   - 1489-1-1           剧编号-线路序号-集序号
 *   - https://anime.xifanacg.com/watch/1489/1/1.html
 *   - /watch/1489/1/1.html
 *
 * 用法：
 *   { "url": "https://anime.xifanacg.com/watch/1489/1/1.html", "code": 1, "mod": "xifan" }
 *   { "url": "1489-1-1", "code": 1, "mod": "xifan" }
 *   node mod/xifan.js 1489-1-1
 */

const axios = require('axios');
const { parseSafeObjectLiteral } = require('../src/utils/objectLiteral');

const SITE = 'https://anime.xifanacg.com';
const HOST = 'anime.xifanacg.com';
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
    if (!raw) throw new Error('xifan 输入不能为空');

    if (/^https?:\/\//i.test(raw)) {
        let urlObj;
        try {
            urlObj = new URL(raw);
        } catch (e) {
            throw new Error(`非法 xifan URL: ${raw}`);
        }

        const host = urlObj.hostname.toLowerCase();
        if (host !== HOST) {
            throw new Error(`xifan URL 域名必须是 ${HOST}: ${host}`);
        }

        const parts = parseWatchPath(urlObj.pathname);
        return {
            ...parts,
            pageUrl: urlObj.href,
        };
    }

    const parts = parseWatchPath(raw);
    return {
        ...parts,
        pageUrl: `${SITE}/watch/${parts.vodId}/${parts.sid}/${parts.nid}.html`,
    };
}

/**
 * 解析 /watch/{vodId}/{sid}/{nid}.html 或编号 vodId-sid-nid
 * 都归一化为 { vodId, sid, nid, id }，id 形如 1489-1-1
 */
function parseWatchPath(value) {
    const text = String(value || '').trim().replace(/\.html?$/i, '');

    // 路径形式：/watch/1489/1/1
    const pathMatch = text.match(/\/watch\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/i);
    if (pathMatch) {
        const [vodId, sid, nid] = pathMatch.slice(1);
        return { vodId, sid, nid, id: `${vodId}-${sid}-${nid}` };
    }

    // 编号形式：1489-1-1
    const idMatch = text.replace(/^\/+/, '').match(/^(\d+)-(\d+)-(\d+)$/);
    if (idMatch) {
        const [vodId, sid, nid] = idMatch.slice(1);
        return { vodId, sid, nid, id: `${vodId}-${sid}-${nid}` };
    }

    throw new Error(
        `非法 xifan 视频编号: ${value}，期望形如 1489-1-1 或 https://anime.xifanacg.com/watch/1489/1/1.html`,
    );
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
            return parseSafeObjectLiteral(literal);
        } catch (fnError) {
            throw new Error(`player_aaaa 解析失败: ${fnError.message}`);
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
    // 只展开 %uXXXX（JavaScript unicode 转义）；普通 %XX 是标准 URL 编码，
    // UTF-8 多字节中文不能 unescape，否则会解成 Latin-1 乱码导致 404
    if (/%u[0-9a-f]{4}/i.test(text)) {
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

function normalizeMediaUrl(candidate, pageUrl) {
    const text = decodeMaybeUrl(candidate);
    if (!text) return null;

    let url = text;
    if (url.startsWith('//')) {
        url = `https:${url}`;
    } else if (url.startsWith('/')) {
        url = new URL(url, pageUrl).href;
    }

    if (/^https?:\/\//i.test(url) && /\.mp4(?:[?#]|$)/i.test(url)) {
        return url;
    }
    return null;
}

/**
 * 取当前集 mp4 直链。
 * 主字段是 player.url；兜底扫描其它字段时跳过 url_next/url_pre，
 * 避免抓到相邻集（MacCMS 里它们是独立字段）。
 */
function extractMediaUrl(player, pageUrl) {
    const primary = normalizeMediaUrl(decodePlayerUrl(player), pageUrl);
    if (primary) return primary;

    for (const [key, value] of Object.entries(player || {})) {
        if (key === 'url_next' || key === 'url_pre') continue;
        if (typeof value !== 'string') continue;
        const candidate = normalizeMediaUrl(value, pageUrl);
        if (candidate) return candidate;
    }

    throw new Error('player_aaaa 中未找到当前视频的 mp4 直链');
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const err = new Error('任务被中止');
        err.name = 'AbortError';
        throw err;
    }
}

async function fetchText(url, refererUrl, accept = '*/*', signal) {
    throwIfAborted(signal);
    const res = await http.get(url, {
        signal,
        responseType: 'text',
        headers: {
            Accept: accept,
            Referer: refererUrl || SITE + '/',
            Origin: new URL(refererUrl || SITE).origin,
        },
    });
    return typeof res.data === 'string' ? res.data : String(res.data);
}

/**
 * @param {string} input 播放页 URL 或 vodId-sid-nid 编号
 * @param {object} [options]
 * @param {boolean} [options.meta] true 时返回完整元数据对象
 * @param {AbortSignal} [options.signal] 任务中止信号（主程序 stop 时传入）
 */
async function download(input, options = {}) {
    const { id, vodId, sid, nid, pageUrl } = normalizeInput(input);
    const signal = options.signal;
    throwIfAborted(signal);

    const pageHtml = await fetchText(pageUrl, SITE + '/', 'text/html,*/*', signal);
    const player = parsePlayerAaaa(pageHtml);
    const mediaUrl = extractMediaUrl(player, pageUrl);

    // 标题：优先 vod_name + 集序号；缺省用 <title>（去掉站点后缀）
    const vodName = String(player?.vod_data?.vod_name || '').trim() || null;
    let pageTitle = null;
    if (vodName) {
        pageTitle = `${vodName} 第${String(nid).padStart(2, '0')}集`;
    } else {
        const rawTitle = extractPageTitle(pageHtml);
        if (rawTitle) {
            pageTitle = rawTitle.replace(/\s*-\s*稀饭动漫.*$/i, '').trim() || rawTitle;
        }
    }

    if (!/^https?:\/\//i.test(mediaUrl)) {
        throw new Error(`解析结果不是合法 URL: ${String(mediaUrl).slice(0, 120)}`);
    }

    const result = {
        url: mediaUrl,
        pageUrl,
        pageTitle,
        episodeId: id,
        vodId,
        sid,
        nid,
        vodName,
        from: player?.from || null,
        // 下一集播放页路径（相对），方便用户手动排队列
        nextPageUrl: String(player?.link_next || '').trim() || null,
    };

    if (options.meta) {
        return result;
    }

    return { url: mediaUrl, pageUrl, pageTitle };
}

module.exports = {
    download,
    normalizeInput,
    parseWatchPath,
    SITE,
};

if (require.main === module) {
    const arg = process.argv[2] || '1489-1-1';
    download(arg, { meta: true })
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((err) => {
            console.error('[xifan] failed:', err.message);
            process.exit(1);
        });
}
