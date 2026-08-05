/**
 * www.sorani.net (青空次元) HLS 解析插件。
 *
 * 直链形态是 AES-128 m3u8（不是 mp4）。
 *
 * 接受：
 *   - 458              番剧编号（取最新一集）
 *   - 458-1            番剧编号-集序号
 *   - 458-1-1          番剧编号-线路序号(从1起)-集序号
 *   - 458-anime_jp_m3u8-1
 *   - https://www.sorani.net/anime/mal/4634
 *   - https://www.sorani.net/anime/mal/4634/episode/01   ← 站点真实分集链接
 *   - /anime/mal/4634/episode/01
 *
 * 用法：
 *   { "url": "https://www.sorani.net/anime/mal/4634/episode/01", "code": 1, "mod": "sorani" }
 *   { "url": "4634-1", "code": 1, "mod": "sorani" }
 *   node mod/sorani.js 4634-1
 */

const axios = require('axios');
const { getAxiosProxyConfig } = require('../src/download/mp4');

const SITE = 'https://www.sorani.net';
const API_BASE = 'https://api.sorani.cc/sorani-cms';
const HOSTS = new Set(['www.sorani.net', 'sorani.net']);
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const http = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Origin: SITE,
        Referer: `${SITE}/`,
    },
    validateStatus: (status) => status >= 200 && status < 500,
});

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const err = new Error('任务被中止');
        err.name = 'AbortError';
        throw err;
    }
}

function sleep(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            const err = new Error('任务被中止');
            err.name = 'AbortError';
            reject(err);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

function formatEpisodePath(order) {
    const n = Number(order);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`非法集序号: ${order}`);
    }
    // 站点真实路径是 /episode/01、/episode/12；个位数会 308 到补零形式
    if (Number.isInteger(n)) {
        return String(n).padStart(2, '0');
    }
    const text = String(n);
    const [intPart, frac = ''] = text.split('.');
    return `${intPart.padStart(2, '0')}${frac ? `.${frac}` : ''}`;
}

function buildPageUrl(videoId, episodeOrder = null) {
    const id = Math.floor(Number(videoId));
    if (episodeOrder == null) {
        return `${SITE}/anime/mal/${id}`;
    }
    return `${SITE}/anime/mal/${id}/episode/${formatEpisodePath(episodeOrder)}`;
}

function normalizeInput(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('sorani 输入不能为空');

    if (/^https?:\/\//i.test(raw)) {
        let urlObj;
        try {
            urlObj = new URL(raw);
        } catch (e) {
            throw new Error(`非法 sorani URL: ${raw}`);
        }

        const host = urlObj.hostname.toLowerCase();
        if (!HOSTS.has(host)) {
            throw new Error(`sorani URL 域名必须是 www.sorani.net: ${host}`);
        }

        return parsePathInput(urlObj.pathname + urlObj.search + urlObj.hash, raw);
    }

    // 允许直接塞路径：/anime/mal/4634/episode/01
    if (/anime\/mal\//i.test(raw) || /\/episode\//i.test(raw)) {
        return parsePathInput(raw, raw);
    }

    const text = raw
        .replace(/^\/+/, '')
        .replace(/\.html?$/i, '');

    // 458 | 458-1 | 458-1-12 | 458-anime_jp_m3u8-12
    const matched = text.match(/^(\d+)(?:-([A-Za-z_][\w]*|\d+))?(?:-(\d+(?:\.\d+)?))?$/);
    if (!matched) {
        throw new Error(
            `非法 sorani 编号: ${raw}，期望 458 / 458-1 / 458-1-12 或 /anime/mal/458/episode/01`,
        );
    }

    const videoId = Number(matched[1]);
    if (!Number.isFinite(videoId) || videoId <= 0) {
        throw new Error(`非法 sorani 番剧编号: ${matched[1]}`);
    }

    let episodeOrder = null;
    let lineIndex = null;
    let lineCode = null;

    if (matched[3] != null) {
        episodeOrder = parseEpisodeOrder(matched[3]);
        const mid = matched[2];
        if (/^\d+$/.test(mid)) {
            lineIndex = Number(mid);
            if (!Number.isFinite(lineIndex) || lineIndex < 1) {
                throw new Error(`非法线路序号: ${mid}`);
            }
        } else {
            lineCode = mid;
        }
    } else if (matched[2] != null) {
        episodeOrder = parseEpisodeOrder(matched[2]);
    }

    return {
        videoId: Math.floor(videoId),
        episodeOrder,
        lineIndex,
        lineCode,
        pageUrl: buildPageUrl(videoId, episodeOrder),
    };
}

function parsePathInput(pathnameLike, rawForError) {
    const cleaned = String(pathnameLike || '').trim();
    let pathOnly = cleaned;
    let search = '';
    let hash = '';

    try {
        // 兼容完整 URL 已拆过，也兼容裸路径 + query
        if (/^https?:\/\//i.test(cleaned)) {
            const u = new URL(cleaned);
            pathOnly = u.pathname;
            search = u.search;
            hash = u.hash;
        } else {
            const q = cleaned.indexOf('?');
            const h = cleaned.indexOf('#');
            if (q >= 0 && (h < 0 || q < h)) {
                pathOnly = cleaned.slice(0, q);
                search = cleaned.slice(q, h >= 0 ? h : undefined);
                hash = h >= 0 ? cleaned.slice(h) : '';
            } else if (h >= 0) {
                pathOnly = cleaned.slice(0, h);
                hash = cleaned.slice(h);
            }
        }
    } catch (e) {
        // keep raw pathOnly
    }

    const episodeMatch = pathOnly.match(/\/anime\/mal\/(\d+)\/episode\/(\d+(?:\.\d+)?)/i);
    const malMatch = pathOnly.match(/\/anime\/mal\/(\d+)/i);
    if (!episodeMatch && !malMatch) {
        throw new Error(`无法从路径解析番剧编号: ${rawForError}`);
    }

    const videoId = Number((episodeMatch || malMatch)[1]);
    let episodeOrder = episodeMatch ? parseEpisodeOrder(episodeMatch[2]) : null;

    if (episodeOrder == null) {
        const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
        const epText =
            params.get('ep') ||
            params.get('episode') ||
            params.get('order') ||
            hash.replace(/^#/, '').replace(/^(ep|episode|order)=/i, '');
        if (epText) episodeOrder = parseEpisodeOrder(epText);
    }

    return {
        videoId,
        episodeOrder,
        lineIndex: null,
        lineCode: null,
        pageUrl: buildPageUrl(videoId, episodeOrder),
    };
}

function parseEpisodeOrder(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`非法集序号: ${value}`);
    }
    return n;
}

function unwrapApi(payload, label) {
    if (payload == null) {
        throw new Error(`${label}: 空响应`);
    }
    if (typeof payload !== 'object') {
        throw new Error(`${label}: 响应不是 JSON 对象`);
    }

    const code = payload.code;
    const ok =
        payload.success === true ||
        code === 200 ||
        code === '200' ||
        code === 0 ||
        code === '0' ||
        code == null;

    if (!ok) {
        const msg = payload.message || payload.msg || `code=${code}`;
        throw new Error(`${label}: ${msg}`);
    }

    return payload.data !== undefined ? payload.data : payload;
}

async function apiGet(pathname, { retries = 2, signal } = {}) {
    const url = `${API_BASE}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        throwIfAborted(signal);
        try {
            const res = await http.get(url, { signal, proxy: getAxiosProxyConfig() });
            if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
                throw new Error(`HTTP ${res.status}`);
            }
            if (res.status >= 400) {
                throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
            }
            return unwrapApi(res.data, pathname);
        } catch (error) {
            if (error?.name === 'AbortError' || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED' || signal?.aborted) {
                throw error;
            }
            lastError = error;
            if (attempt < retries) {
                await sleep(400 * (attempt + 1), signal);
                continue;
            }
        }
    }

    throw new Error(`请求失败 ${pathname}: ${lastError?.message || lastError}`);
}

function pickLine(lines, { lineIndex, lineCode } = {}) {
    const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
    if (list.length === 0) {
        throw new Error('该番剧没有可用播放线路');
    }

    const enabled = list.filter((line) => line.enable !== false && line.enabled !== false);
    const pool = enabled.length > 0 ? enabled : list;

    if (lineCode) {
        const found = pool.find((line) => String(line.code || '') === lineCode);
        if (!found) {
            const codes = pool.map((line) => line.code).filter(Boolean).join(', ');
            throw new Error(`找不到线路 code=${lineCode}（可用: ${codes || '无'}）`);
        }
        return found;
    }

    if (lineIndex != null) {
        const found = pool[lineIndex - 1];
        if (!found) {
            throw new Error(`线路序号超出范围: ${lineIndex}/${pool.length}`);
        }
        return found;
    }

    return (
        pool.find((line) => line.isDefault) ||
        pool.find((line) => /m3u8/i.test(String(line.code || ''))) ||
        pool[0]
    );
}

function normalizeOrders(orders) {
    if (!Array.isArray(orders)) return [];
    return orders
        .map((item) => Number(item))
        .filter((n) => Number.isFinite(n) && n > 0);
}

function sameOrder(a, b) {
    return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function pickEpisodeOrder(requested, orders, detail) {
    const list = normalizeOrders(orders);
    if (list.length === 0) {
        throw new Error('该线路没有可播放分集');
    }

    if (requested != null) {
        const found = list.find((n) => sameOrder(n, requested));
        if (found == null) {
            throw new Error(`集序号 ${requested} 不存在（共 ${list.length} 集）`);
        }
        return found;
    }

    const latest = Number(detail?.latestEpisodeOrder);
    if (Number.isFinite(latest) && latest > 0) {
        const found = list.find((n) => sameOrder(n, latest));
        if (found != null) return found;
    }

    return list[list.length - 1];
}

async function resolvePlayUrl(episodeId, lineCode, signal) {
    const query = lineCode ? `?lineCode=${encodeURIComponent(lineCode)}` : '';
    const path = `/api/video/episode/${episodeId}/play${query}`;

    // 播放接口有频率限制，失败时退避重试
    let lastMessage = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
        throwIfAborted(signal);
        if (attempt > 0) {
            await sleep(800 * attempt, signal);
        }

        const data = await apiGet(path, { retries: 1, signal });
        const playUrl = String(data?.playUrl || '').trim();
        const canPlay = data?.canPlay;
        const message = data?.message || data?.msg || '';

        if (playUrl && /^https?:\/\//i.test(playUrl) && canPlay !== false) {
            return {
                playUrl,
                hls: data?.hls,
                canPlay: true,
                message: message || null,
            };
        }

        lastMessage = message || (canPlay === false ? 'canPlay=false' : 'playUrl 为空');
        if (!/频繁|稍后|too many|rate/i.test(String(lastMessage)) && playUrl === '') {
            break;
        }
    }

    throw new Error(`获取播放地址失败: ${lastMessage || '未知原因'}`);
}


function pickEpisodeTitle(episode, order) {
    const candidates = [episode?.episodeLabel, episode?.title, episode?.displayTitle]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    const unique = [];
    for (const item of candidates) {
        if (!unique.includes(item)) unique.push(item);
    }
    return unique[0] || `第${order}集`;
}

/**
 * @param {string} input
 * @param {object} [options]
 * @param {boolean} [options.meta]
 * @param {AbortSignal} [options.signal] 任务中止信号（主程序 stop 时传入）
 */
async function download(input, options = {}) {
    const parsed = normalizeInput(input);
    const { videoId, pageUrl } = parsed;
    const signal = options.signal;
    throwIfAborted(signal);

    const detail = await apiGet(`/api/video/${videoId}`, { signal });
    const title = String(detail?.title || '').trim() || null;

    const lines = await apiGet(`/api/video/${videoId}/play-lines`, { signal });
    const line = pickLine(lines, parsed);
    const lineCode = String(line?.code || '').trim();
    if (!lineCode) {
        throw new Error('播放线路缺少 code');
    }

    const orders = await apiGet(
        `/api/video/${videoId}/play-lines/${encodeURIComponent(lineCode)}/episode-orders`,
        { signal },
    );
    const episodeOrder = pickEpisodeOrder(parsed.episodeOrder, orders, detail);

    // order 可能是 1.0，接口也接受整数/小数
    const orderPath = Number.isInteger(episodeOrder)
        ? String(episodeOrder)
        : String(episodeOrder);
    const episode = await apiGet(
        `/api/video/episode/video/${videoId}/episode/${encodeURIComponent(orderPath)}`,
        { signal },
    );
    const episodeId = Number(episode?.episodeId ?? episode?.id);
    if (!Number.isFinite(episodeId) || episodeId <= 0) {
        throw new Error(`无法解析 episodeId: ${JSON.stringify(episode)?.slice(0, 120)}`);
    }

    const episodeTitle = pickEpisodeTitle(episode, episodeOrder);
    const finalPageUrl = buildPageUrl(videoId, episodeOrder);

    const play = await resolvePlayUrl(episodeId, lineCode, signal);
    const mediaUrl = play.playUrl;

    if (!/^https?:\/\//i.test(mediaUrl)) {
        throw new Error(`解析结果不是合法 URL: ${String(mediaUrl).slice(0, 120)}`);
    }

    const pageTitle = title ? `${title} ${episodeTitle}`.trim() : episodeTitle;

    if (options.meta) {
        return {
            url: mediaUrl,
            pageUrl: finalPageUrl,
            pageTitle,
            videoId,
            episodeId,
            episodeOrder,
            episodeTitle,
            lineCode,
            lineName: line?.name || null,
            hls: play.hls !== false || /\.m3u8(?:[?#]|$)/i.test(mediaUrl),
            videoTitle: title,
        };
    }

    return {
        url: mediaUrl,
        pageUrl: finalPageUrl,
        pageTitle,
    };
}

module.exports = {
    download,
    normalizeInput,
    buildPageUrl,
    formatEpisodePath,
    SITE,
    API_BASE,
};

if (require.main === module) {
    const arg = process.argv[2] || 'https://www.sorani.net/anime/mal/4634/episode/01';
    download(arg, { meta: true })
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((err) => {
            console.error('[sorani] failed:', err.message);
            process.exit(1);
        });
}
