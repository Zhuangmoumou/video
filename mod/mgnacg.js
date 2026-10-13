/**
 * mgnacg.com 视频直链解析
 *
 * 路径格式: {vodId}-{sid}-{nid}
 *   sid 线路:
 *     2 -> 云端线路   (from=2_  -> cloudplay/?url=)
 *     3 -> 船新线路   (from=5_  -> cloudplay/yp2.php?url=)
 *     5 -> Mahoo      (from=6_  -> cloudplay/yp3.php?url=)
 *     4 -> 存储线路   (from=4_  -> cloudplay/ccxl.php?url=)
 *     1 -> 本地线路(已下线)
 *   nid: 集数
 *
 * 用法:
 *   const { download } = require('./mod/mgnacg');
 *   const url = await download('1619-3-2');
 */

const crypto = require('crypto');
const axios = require('axios');
const { parseSafeObjectLiteral } = require('../src/utils/objectLiteral');

const SITE = 'https://mgnacg.com';
const SEARCH_PATH = '/index.php/ajax/suggest';
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SEARCH_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SEARCH_EPISODE_PATTERN = /(?:\/bangumi\/|\/play\/|\/video\/)?(\d+-[1-5]-\d+)(?![\d-])/g;

/** 线路 sid -> 说明（与站点选集中间数字一致） */
const SID_LINE = {
    '1': { name: '本地线路（已下线）', from: '1_' },
    '2': { name: '云端线路', from: '2_' },
    '3': { name: '船新线路', from: '5_' },
    '4': { name: '存储线路', from: '4_' },
    '5': { name: 'Mahoo', from: '6_' },
};

/**
 * player from 代码 -> 解析接口
 * 与 /static/js/playerconfig.js 保持一致
 */
const FROM_PARSE = {
    '2_': 'https://play.mknacg.top:8585/cloudplay/?url=',
    '5_': 'https://play.mknacg.top:8585/cloudplay/yp2.php?url=',
    '6_': 'https://play.mknacg.top:8585/cloudplay/yp3.php?url=',
    '4_': 'https://play.mknacg.top:8585/cloudplay/ccxl.php?url=',
    '3_': 'https://play.mknacg.top:8585/muiplayer/?url=',
    '1_': null, // 本地已下线
};

const AES_SALT = 'Mknacg123321';

const http = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    validateStatus: (s) => s >= 200 && s < 400,
});

function normalizeEpisodeId(input) {
    if (input == null) throw new Error('episode id 不能为空');
    let id = String(input).trim();
    // 允许传入完整路径/URL
    id = id.replace(/^https?:\/\/[^/]+/i, '');
    id = id.replace(/^\/?(bangumi\/)?/i, '');
    id = id.replace(/\/+$/, '');
    if (!/^\d+-\d+-\d+$/.test(id)) {
        throw new Error(`非法 episode id: ${input}，期望形如 1619-3-2`);
    }
    return id;
}

function parseEpisodeId(id) {
    const [vodId, sid, nid] = id.split('-');
    return { vodId, sid, nid, line: SID_LINE[sid] || null };
}

/**
 * 从播放页 HTML 提取 player_aaaa
 */
function extractPlayerAaaa(html) {
    const m = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?})\s*;?\s*<\/script>/i);
    if (!m) throw new Error('页面中未找到 player_aaaa，可能被拦截或页面结构变更');
    try {
        return JSON.parse(m[1]);
    } catch (e) {
        try {
            return parseSafeObjectLiteral(m[1]);
        } catch (e2) {
            throw new Error('player_aaaa 解析失败: ' + e2.message);
        }
    }
}

function extractPageTitle(html) {
    if (!html) return null;
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (og && og[1]) return og[1].trim();

    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag && titleTag[1]) {
        return titleTag[1].replace(/\s+/g, ' ').trim();
    }
    return null;
}

/**
 * MacCMS encrypt 字段处理
 * encrypt=1: unescape
 * encrypt=2: 站点前端已注释解密，密文原样给解析接口；这里也按「不解密」处理
 */
function resolvePlayUrl(player) {
    let url = player.url || '';
    const enc = String(player.encrypt ?? '');
    if (enc === '1') {
        try {
            url = unescape(url);
        } catch (_) {}
    }
    // enc === '2'：保持原样（URL 编码的 base64 类密文）
    return url;
}

/**
 * 从解析页 meta id 还原 AES key 材料
 * charset id: now_9753218604
 * viewport id: now_9zVHFWUESu
 * 按 charset 数字排序后拼接 viewport 对应字符 => key_material
 * md5(key_material + 'Mknacg123321')
 * key = md5[16..32] (utf8), iv = md5[0..16] (utf8)
 */
function extractMetaKeyParts(html) {
    const charset =
        html.match(/<meta[^>]*charset=["']?UTF-8["']?[^>]*\sid=["']now_([^"']+)["']/i) ||
        html.match(/<meta[^>]*\sid=["']now_([^"']+)["'][^>]*charset=["']?UTF-8["']/i);
    const viewport =
        html.match(/<meta[^>]*name=["']viewport["'][^>]*\sid=["']now_([^"']+)["']/i) ||
        html.match(/<meta[^>]*\sid=["']now_([^"']+)["'][^>]*name=["']viewport["']/i);

    if (!charset || !viewport) {
        throw new Error('解析页缺少 charset/viewport meta id，无法生成 AES 密钥');
    }

    const charsetId = charset[1];
    const viewportId = viewport[1];
    if (charsetId.length !== viewportId.length) {
        throw new Error(`meta id 长度不一致: charset=${charsetId.length}, viewport=${viewportId.length}`);
    }

    const pairs = [];
    for (let i = 0; i < charsetId.length; i++) {
        pairs.push({ id: charsetId[i], text: viewportId[i] });
    }
    pairs.sort((a, b) => Number(a.id) - Number(b.id));
    return pairs.map((p) => p.text).join('');
}

function extractConfigCipher(html) {
    // var config = { "url": "...", ... }
    const m =
        html.match(/"url"\s*:\s*"([A-Za-z0-9+/=]{16,})"/) ||
        html.match(/url\s*:\s*["']([A-Za-z0-9+/=]{16,})["']/);
    if (!m) throw new Error('解析页未找到 AES 密文 url 字段');
    return m[1];
}

function aesDecryptPlayUrl(cipherB64, keyMaterial) {
    const md5 = crypto.createHash('md5').update(keyMaterial + AES_SALT, 'utf8').digest('hex');
    const key = Buffer.from(md5.substring(16), 'utf8'); // 16 bytes
    const iv = Buffer.from(md5.substring(0, 16), 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([
        decipher.update(Buffer.from(cipherB64, 'base64')),
        decipher.final(),
    ]).toString('utf8');
    return plain.trim();
}

function pickParseBase(player, sid) {
    const from = player.from || '';
    const mappedFrom = FROM_PARSE[from] !== undefined ? from : SID_LINE[sid]?.from;

    if (mappedFrom && FROM_PARSE[mappedFrom]) {
        return FROM_PARSE[mappedFrom];
    }
    if (FROM_PARSE[from] === null) {
        throw new Error(`线路 ${from} 已下线或不可用`);
    }
    throw new Error(`未知线路 sid=${sid} from=${from}，请更新线路映射`);
}

/**
 * 解析并返回原始下载链接（不跟随 302）
 * @param {string} episodeId 如 '1619-3-2' / 'bangumi/1619-3-2' / 完整 URL
 * @param {object} [options]
 * @param {string} [options.site] 站点根，默认 https://mgnacg.com
 * @param {boolean} [options.meta] 为 true 时返回详情对象，否则只返回 url 字符串
 * @param {AbortSignal} [options.signal] 任务中止信号（主程序 stop 时传入）
 * @returns {Promise<string|object>}
 */
async function download(episodeId, options = {}) {
    const id = normalizeEpisodeId(episodeId);
    const info = parseEpisodeId(id);
    const site = (options.site || SITE).replace(/\/+$/, '');
    const pageUrl = `${site}/bangumi/${id}`;
    const signal = options.signal;
    if (signal?.aborted) {
        const err = new Error('任务被中止');
        err.name = 'AbortError';
        throw err;
    }

    // 1) 拉播放页
    const pageRes = await http.get(pageUrl, {
        signal,
        headers: { Referer: site + '/' },
    });
    const pageHtml = typeof pageRes.data === 'string' ? pageRes.data : String(pageRes.data);
    const pageTitle = extractPageTitle(pageHtml);
    const player = extractPlayerAaaa(pageHtml);
    const playUrl = resolvePlayUrl(player);
    if (!playUrl) throw new Error('player_aaaa.url 为空');

    const parseBase = pickParseBase(player, info.sid);
    const parseUrl = parseBase + playUrl;

    // 2) 拉线路解析页
    const parseRes = await http.get(parseUrl, {
        signal,
        headers: {
            Referer: pageUrl,
            Origin: site,
        },
    });
    const parseHtml = typeof parseRes.data === 'string' ? parseRes.data : String(parseRes.data);

    // 3) AES 解密真实直链
    const keyMaterial = extractMetaKeyParts(parseHtml);
    const cipher = extractConfigCipher(parseHtml);
    const mediaUrl = aesDecryptPlayUrl(cipher, keyMaterial);

    if (!/^https?:\/\//i.test(mediaUrl)) {
        throw new Error('解密结果不是合法 URL: ' + mediaUrl.slice(0, 120));
    }

    if (options.meta) {
        return {
            episodeId: id,
            vodId: info.vodId,
            sid: info.sid,
            nid: info.nid,
            lineName: info.line?.name || player.from,
            from: player.from,
            pageUrl,
            pageTitle,
            parseUrl,
            url: mediaUrl,
            player,
        };
    }
    return mediaUrl;
}

async function search(keyword, options = {}) {
    const query = String(keyword || '').trim();
    if (!query) throw new Error('搜索关键词不能为空');
    const limit = normalizeSearchLimit(options.limit, 20, 50);
    const { response, data: payload } = await fetchWithTimeout(`${SITE}${SEARCH_PATH}?${new URLSearchParams({ wd: query, limit: '200', mid: '1' })}`, {
        signal: options.signal,
        headers: {
            'User-Agent': SEARCH_UA,
            Accept: 'application/json,text/plain,*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Referer: `${SITE}/`,
        },
    }, 15000, 'json');
    if (!response.ok) {
        const detail = typeof payload === 'string' ? `: ${payload.replace(/\s+/g, ' ').slice(0, 160)}` : '';
        throw new Error(`HTTP ${response.status} ${response.statusText}${detail}`);
    }
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (error) {
            throw new Error(`HTTP ${response.status} 搜索接口未返回有效 JSON: ${payload.replace(/\s+/g, ' ').slice(0, 160)}`);
        }
    }
    if (Number(payload?.code) !== 1) throw new Error(payload?.msg || 'mgnacg 搜索接口返回异常');

    const results = [];
    const seen = new Set();
    for (const item of Array.isArray(payload.list) ? payload.list : []) {
        const id = String(item?.id ?? '').trim();
        const title = cleanSearchText(item?.name);
        if (!/^\d+$/.test(id) || !title || seen.has(id)) continue;
        seen.add(id);
        results.push({
            id,
            title,
            url: `${SITE}/media/${id}/`,
            status: searchStatus(item),
            episodeCount: searchEpisodeCount(item),
        });
        if (results.length >= limit) break;
    }

    return results;
}

async function episodes(input, options = {}) {
    const maxEpisodes = normalizeSearchLimit(options.maxEpisodes, 300, 500);
    const value = input && typeof input === 'object' ? input : { id: input };
    const rawId = value.id ?? value.videoId ?? value.seriesId ?? value.url;
    let vodId = String(rawId ?? '').trim();
    const urlMatch = vodId.match(/\/media\/(\d+)(?:\/|$)/i);
    if (urlMatch) vodId = urlMatch[1];
    if (!/^\d+$/.test(vodId)) throw new Error(`非法 mgnacg 作品编号: ${rawId}`);

    const series = {
        id: vodId,
        title: cleanSearchText(value.title),
        url: `${SITE}/media/${vodId}/`,
        status: cleanSearchText(value.status) || '未知',
        episodeCount: value.episodeCount != null && Number.isFinite(Number(value.episodeCount))
            ? Number(value.episodeCount)
            : null,
    };
    const detail = await fetchSeriesDetails(series, options.signal);
    return {
        id: series.id,
        title: series.title || detail.title || series.id,
        url: series.url,
        status: series.status,
        episodeCount: detail.episodeCount ?? series.episodeCount ?? 0,
        episodes: detail.episodes.slice(0, maxEpisodes),
        truncated: detail.episodes.length > maxEpisodes,
    };
}

async function fetchSeriesDetails(series, signal) {
    const { response, data: html } = await fetchWithTimeout(series.url, {
        signal,
        headers: {
            'User-Agent': DEFAULT_UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Referer: `${SITE}/`,
        },
    }, 15000, 'text');
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const normalizedHtml = html.replace(/\\\//g, '/').replace(/\\u002f/gi, '/');
    const episodeEntries = parseSeriesEpisodeIds(normalizedHtml, series.id);
    const episodeCount = new Set(episodeEntries.map((episode) => episode.nid)).size;
    const titleMatch = normalizedHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
        title: titleMatch ? cleanSearchText(titleMatch[1].replace(/<[^>]*>/g, '')) : null,
        episodeCount: episodeCount || series.episodeCount || countEpisodesInText(series.status),
        episodes: episodeEntries.map((episode) => ({
            id: episode.id,
            input: episode.id,
            title: episode.title || `第${episode.nid}集`,
            url: `${SITE}/bangumi/${episode.id}`,
            sid: episode.sid,
            nid: Number(episode.nid),
            lineName: SID_LINE[episode.sid]?.name || null,
        })),
    };
}

function parseSeriesEpisodeIds(html, vodId) {
    const source = String(html || '').replace(/&amp;/gi, '&');
    const anchorTitles = new Map();
    const anchorPattern = /<a\b([^>]*?)href\s*=\s*(["'])([\s\S]*?)\2[^>]*>([\s\S]*?)<\/a>/gi;
    let anchor;
    while ((anchor = anchorPattern.exec(source))) {
        const found = parseSearchEpisodeIds(`${anchor[1]} ${anchor[3]}`)
            .find((episode) => episode.vodId === String(vodId));
        if (found) anchorTitles.set(found.id, cleanSearchText(anchor[4].replace(/<[^>]*>/g, '')));
    }

    const seen = new Set();
    return parseSearchEpisodeIds(source)
        .filter((episode) => episode.vodId === String(vodId)
            && episode.sid !== '1'
            && !seen.has(episode.id)
            && seen.add(episode.id))
        .map((episode) => ({ ...episode, title: anchorTitles.get(episode.id) || '' }))
        .sort((a, b) => Number(a.sid) - Number(b.sid) || Number(a.nid) - Number(b.nid));
}

function parseSearchEpisodeIds(value) {
    const episodes = [];
    SEARCH_EPISODE_PATTERN.lastIndex = 0;
    let match;
    while ((match = SEARCH_EPISODE_PATTERN.exec(String(value || '')))) {
        const id = match[1];
        const [vodId, sid, nid] = id.split('-');
        episodes.push({ id, vodId, sid, nid });
    }
    return episodes;
}

function searchStatus(item) {
    const status = [item?.remarks, item?.remark, item?.vod_remarks, item?.updateStatus, item?.statusText, item?.stateText]
        .find((value) => value != null && String(value).trim());
    return cleanSearchText(status) || '未知';
}

function searchEpisodeCount(item) {
    for (const value of [item?.episodeCount, item?.totalEpisodes, item?.vod_total, item?.total]) {
        if (value == null || value === '') continue;
        const count = Number(value);
        if (Number.isFinite(count) && count >= 0) return count;
    }
    return countEpisodesInText(searchStatus(item));
}

function countEpisodesInText(value) {
    const match = String(value || '').match(/(?:第\s*)?(\d+(?:\.\d+)?)\s*集/);
    return match ? Number(match[1]) : null;
}

function cleanSearchText(value) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(value ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x?[\da-f]+|[a-z]+);/gi, (match, entity) => {
            const key = entity.toLowerCase();
            if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
            if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
            return entities[key] || match;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeSearchLimit(value, fallback, max) {
    if (value == null) return fallback;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
    return Math.min(limit, max);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, readAs = null) {
    const controller = new AbortController();
    const parentSignal = options.signal;
    const abort = () => controller.abort(parentSignal.reason);
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (readAs === 'json') {
            const text = await response.text();
            if (!response.ok) return { response, data: text };
            try {
                return { response, data: JSON.parse(text) };
            } catch (error) {
                return { response, data: text };
            }
        }
        if (readAs === 'text') return { response, data: await response.text() };
        return { response };
    } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
    }
}

module.exports = {
    download,
    search,
    episodes,
    SID_LINE,
    FROM_PARSE,
    normalizeEpisodeId,
    parseEpisodeId,
};

// 直接运行: node mod/mgnacg.js 1619-3-2
if (require.main === module) {
    const arg = process.argv[2] || '1619-3-2';
    download(arg, { meta: true })
        .then((r) => {
            console.log(JSON.stringify(r, null, 2));
        })
        .catch((err) => {
            console.error('[mgnacg] failed:', err.message);
            process.exit(1);
        });
}
