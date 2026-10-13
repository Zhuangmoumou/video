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
const SEARCH_API_PATH = '/api/video';
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

async function listEpisodes(input, options = {}) {
    const parsed = normalizeInput(input);
    const { videoId } = parsed;
    const signal = options.signal;
    const maxEpisodes = Number(options.maxEpisodes ?? 300);
    if (!Number.isInteger(maxEpisodes) || maxEpisodes < 1 || maxEpisodes > 500) {
        throw new Error('maxEpisodes 必须是 1 到 500 之间的整数');
    }
    throwIfAborted(signal);

    const detail = await apiGet(`/api/video/${videoId}`, { signal });

    // The detail endpoint already contains episode IDs, orders, and titles.
    // Prefer this embedded list so recursive listing does not depend on the
    // separate play-lines endpoint being available.
    const detailEpisodes = Array.isArray(detail?.episodes)
        ? detail.episodes
            .filter((episode) => episode && episode.enable !== false && episode.enabled !== false)
            .map((episode) => ({
                episode,
                order: Number(episode.episodeOrder ?? episode.order),
            }))
            .filter(({ order }) => Number.isFinite(order) && order > 0)
            .sort((a, b) => a.order - b.order)
        : [];

    if (detailEpisodes.length > 0) {
        const selectedEpisodes = detailEpisodes.slice(0, maxEpisodes);
        const episodes = selectedEpisodes.map(({ episode, order }) => {
            const episodeId = Number(episode.episodeId ?? episode.id);
            const downloadId = parsed.lineIndex != null
                ? `${videoId}-${parsed.lineIndex}-${order}`
                : parsed.lineCode
                    ? `${videoId}-${parsed.lineCode}-${order}`
                    : `${videoId}-${order}`;
            return {
                id: downloadId,
                input: downloadId,
                episodeId: Number.isFinite(episodeId) && episodeId > 0 ? episodeId : null,
                order,
                title: pickEpisodeTitle(episode, order),
                url: buildPageUrl(videoId, order),
            };
        });
        const reportedCount = Number(detail?.episodeCount);
        const episodeCount = Number.isFinite(reportedCount) && reportedCount > detailEpisodes.length
            ? reportedCount
            : detailEpisodes.length;
        const status = [detail?.statusText, detail?.updateStatus, detail?.stateText, detail?.status]
            .map((value) => String(value || '').trim())
            .find(Boolean) || (detail?.isFinished === true ? '已完结' : '未知');

        return {
            id: String(videoId),
            title: String(detail?.title || '').trim() || String(videoId),
            url: buildPageUrl(videoId),
            status,
            episodeCount,
            episodes,
            truncated: episodes.length < episodeCount,
            lineCode: parsed.lineCode || null,
        };
    }

    const lines = await apiGet(`/api/video/${videoId}/play-lines`, { signal });
    const line = pickLine(lines, parsed);
    const lineCode = String(line?.code || '').trim();
    if (!lineCode) throw new Error('播放线路缺少 code');

    const enabledLines = Array.isArray(lines)
        ? lines.filter((item) => item && item.enable !== false && item.enabled !== false)
        : [];
    const availableLines = enabledLines.length > 0 ? enabledLines : (Array.isArray(lines) ? lines.filter(Boolean) : []);
    const lineIndex = Math.max(0, availableLines.indexOf(line)) + 1;
    const rawOrders = await apiGet(
        `/api/video/${videoId}/play-lines/${encodeURIComponent(lineCode)}/episode-orders`,
        { signal },
    );
    const orders = [...new Set(normalizeOrders(rawOrders))];
    const episodes = await mapWithConcurrency(orders.slice(0, maxEpisodes), 4, async (order) => {
        throwIfAborted(signal);
        const episode = await apiGet(
            `/api/video/episode/video/${videoId}/episode/${encodeURIComponent(String(order))}`,
            { signal },
        );
        const episodeId = Number(episode?.episodeId ?? episode?.id);
        if (!Number.isFinite(episodeId) || episodeId <= 0) {
            throw new Error(`无法解析 episodeId: ${JSON.stringify(episode)?.slice(0, 120)}`);
        }
        const title = pickEpisodeTitle(episode, order);
        const downloadId = `${videoId}-${lineIndex}-${order}`;
        return {
            id: downloadId,
            input: downloadId,
            episodeId,
            order,
            title,
            url: buildPageUrl(videoId, order),
        };
    }, signal);

    const status = [detail?.statusText, detail?.updateStatus, detail?.stateText, detail?.status]
        .map((value) => String(value || '').trim())
        .find(Boolean) || (detail?.isFinished === true ? '已完结' : '未知');

    return {
        id: String(videoId),
        title: String(detail?.title || '').trim() || String(videoId),
        url: buildPageUrl(videoId),
        status,
        episodeCount: orders.length,
        episodes,
        truncated: episodes.length < orders.length,
        lineCode,
    };
}

async function search(keyword, options = {}) {
    const query = String(keyword || '').trim();
    if (!query) throw new Error('搜索关键词不能为空');
    const limit = normalizeSearchLimit(options.limit, 20, 50);
    const sources = buildSearchSources(query, limit);
    const errors = [];
    let completed = 0;

    for (const source of sources) {
        throwIfAborted(options.signal);
        try {
            const results = await fetchSearchSource(source, query, options.signal);
            completed += 1;
            if (results.length) return results.slice(0, limit);
        } catch (error) {
            if (options.signal?.aborted) throw error;
            errors.push(`${source.url}: ${error.message}`);
        }
    }

    if (completed === 0 && errors.length) throw new Error(errors[0]);
    return [];
}

async function episodes(input, options = {}) {
    const series = input && typeof input === 'object' ? input : { id: input };
    const rawId = series.id ?? series.videoId ?? series.seriesId ?? series.url;
    const idText = String(rawId ?? '').trim();
    const urlMatch = idText.match(/\/anime\/mal\/(\d+)/i);
    const videoId = urlMatch ? urlMatch[1] : idText;
    if (!/^\d+$/.test(videoId)) throw new Error(`非法 sorani 作品编号: ${rawId}`);

    const result = await listEpisodes(videoId, { ...options, maxEpisodes: options.maxEpisodes ?? 300 });
    return {
        ...result,
        title: String(series.title || result.title || videoId).trim(),
        status: series.status && series.status !== '未知' ? series.status : result.status,
        url: normalizeSoraniResultUrl(series.url, videoId),
    };
}

function buildSearchSources(keyword, limit) {
    const apiUrl = new URL(SEARCH_API_PATH.replace(/^\/+/, ''), `${API_BASE.replace(/\/+$/, '')}/`);
    apiUrl.searchParams.set('page', '1');
    apiUrl.searchParams.set('size', String(Math.min(limit, 100)));
    apiUrl.searchParams.set('keyword', keyword);
    const exploreUrl = new URL('anime/explore', `${SITE}/`);
    exploreUrl.searchParams.set('keyword', keyword);
    return [
        { type: 'json', trusted: true, url: apiUrl.toString() },
        { type: 'html', trusted: false, url: exploreUrl.toString() },
        { type: 'html', trusted: false, url: `${SITE}/` },
    ];
}

async function fetchSearchSource(source, keyword, parentSignal) {
    const { response, body } = await fetchTextWithTimeout(source.url, {
        signal: parentSignal,
        headers: {
            'User-Agent': DEFAULT_UA,
            Accept: source.type === 'json'
                ? 'application/json,text/plain,*/*'
                : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Referer: `${SITE}/`,
        },
    });
    if (!response.ok) {
        if ([400, 404, 405].includes(response.status)) return [];
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') || '';
    const parsed = source.type === 'json' || contentType.includes('application/json')
        ? parseSearchJson(body)
        : parseSearchHtml(body);
    return selectSearchResults(parsed, keyword, source.trusted);
}

function parseSearchJson(body) {
    let payload;
    try {
        payload = JSON.parse(body);
    } catch (_) {
        return [];
    }
    const results = [];
    const seen = new Set();
    collectSearchObjects(payload, results, seen);
    return results;
}

function collectSearchObjects(value, results, seen) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) collectSearchObjects(item, results, seen);
        return;
    }

    const id = value.id ?? value.videoId ?? value.animeId ?? value.bangumiVideoId;
    const title = value.title ?? value.name ?? value.videoTitle ?? value.animeTitle;
    if (id != null && title) {
        const episodeCountValue = value.episodeCount ?? value.totalEpisodes ?? value.episodesCount ?? value.latestEpisodeOrder;
        const episodeCount = episodeCountValue == null || episodeCountValue === '' ? NaN : Number(episodeCountValue);
        addSearchResult(results, seen, {
            id: String(id),
            title: cleanSearchText(String(title)),
            alias: cleanSearchText(String(value.alias || '')),
            pinyin: cleanSearchText(String(value.pinyin || '')),
            initial: cleanSearchText(String(value.initial || '')),
            categoryName: cleanSearchText(String(value.categoryName || '')),
            status: pickSearchStatus(value),
            episodeCount: Number.isFinite(episodeCount) && episodeCount >= 0
                ? episodeCount
                : countEpisodesInText(pickSearchStatus(value)),
            url: normalizeSoraniResultUrl(value.url || value.path || value.href, id),
        });
    }
    for (const item of Object.values(value)) collectSearchObjects(item, results, seen);
}

function parseSearchHtml(html) {
    const results = [];
    const seen = new Set();
    const linkPattern = /<a\b[^>]*href=(["'])(?:https?:\/\/www\.sorani\.net)?\/anime\/mal\/(\d+)(?:[/?#][^"']*)?\1[^>]*>[\s\S]*?<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(html))) {
        const block = match[0];
        const title = searchAttrValue(block, 'title') || searchAttrValue(block, 'alt') || cleanSearchText(block.replace(/<[^>]*>/g, ''));
        addSearchResult(results, seen, {
            id: match[2], title, status: '未知', episodeCount: null,
            url: `${SITE}/anime/mal/${match[2]}`,
        });
    }

    const itemPattern = /\bid:(\d+),title:("(?:\\.|[^"\\])*"|null)/g;
    while ((match = itemPattern.exec(html))) {
        const title = parseSearchJsString(match[2]);
        if (!title) continue;
        const blockEnd = html.indexOf('{id:', match.index + 4);
        const block = html.slice(match.index, blockEnd < 0 ? Math.min(html.length, match.index + 8000) : blockEnd);
        if (!/\b(?:bangumiId|categoryName|cover(?:Small|Thumb|Large)?|episodeCount|latestEpisode|statusText)\b/.test(block)) continue;
        const status = pickSvelteSearchStatus(block);
        addSearchResult(results, seen, {
            id: match[1],
            title: cleanSearchText(title),
            status,
            episodeCount: numberSearchField(block, 'episodeCount') || countEpisodesInText(status),
            url: `${SITE}/anime/mal/${match[1]}`,
        });
    }
    return results;
}

function addSearchResult(results, seen, result) {
    const id = String(result.id || '').trim();
    const title = cleanSearchText(result.title);
    if (!/^\d+$/.test(id) || !title || seen.has(id)) return;
    seen.add(id);
    results.push({
        id,
        title,
        status: result.status || '未知',
        episodeCount: result.episodeCount ?? null,
        url: result.url || `${SITE}/anime/mal/${id}`,
        alias: result.alias || '',
        pinyin: result.pinyin || '',
        initial: result.initial || '',
        categoryName: result.categoryName || '',
    });
}

function selectSearchResults(results, keyword, trusted) {
    const needle = normalizeSearchText(keyword);
    const matched = results.filter((result) => normalizeSearchText(
        [result.title, result.alias, result.pinyin, result.initial, result.categoryName].join(' '),
    ).includes(needle));
    const selected = matched.length || !trusted ? matched : results;
    return selected.map(({ alias, pinyin, initial, categoryName, ...result }) => result);
}

function pickSearchStatus(value) {
    const status = value.statusText || value.updateStatus || value.stateText;
    const latestValue = value.latestEpisodeLabel || value.latestEpisode || value.latestEpisodeOrder || value.episodeLabel;
    const latest = typeof latestValue === 'number' ? `第${latestValue}集` : latestValue;
    if (status && latest) return `${cleanSearchText(String(status))} ${cleanSearchText(String(latest))}`;
    if (latest) return cleanSearchText(String(latest));
    if (status) return cleanSearchText(String(status));
    const count = Number(value.episodeCount);
    return Number.isFinite(count) && count > 0 ? `${count}集` : '未知';
}

function pickSvelteSearchStatus(block) {
    const status = searchJsField(block, 'statusText');
    const latest = searchJsField(block, 'latestEpisodeLabel');
    if (status && latest) return `${status} ${latest}`;
    if (status || latest) return status || latest;
    const count = numberSearchField(block, 'episodeCount');
    return count ? `${count}集` : '未知';
}

function searchJsField(block, name) {
    const match = block.match(new RegExp(`\\b${name}:("(?:\\\\.|[^"\\\\])*"|null)`));
    return match ? cleanSearchText(parseSearchJsString(match[1]) || '') : '';
}

function numberSearchField(block, name) {
    const match = block.match(new RegExp(`\\b${name}:(\\d+)`));
    return match ? Number.parseInt(match[1], 10) : 0;
}

function parseSearchJsString(value) {
    if (!value || value === 'null') return '';
    try { return JSON.parse(value); } catch (_) { return ''; }
}

function searchAttrValue(block, name) {
    const match = block.match(new RegExp(`\\b${name}=(["'])([\\s\\S]*?)\\1`, 'i'));
    return match ? cleanSearchText(decodeSearchEntities(match[2])) : '';
}

function cleanSearchText(value) {
    return decodeSearchEntities(String(value || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeSearchEntities(value) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
        const key = entity.toLowerCase();
        if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
        if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
        return entities[key] || match;
    });
}

function countEpisodesInText(value) {
    const match = String(value || '').match(/(?:第\s*)?(\d+(?:\.\d+)?)\s*集/);
    return match ? Number(match[1]) : null;
}

function normalizeSearchText(value) {
    return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function normalizeSoraniResultUrl(value, id) {
    const fallback = `${SITE}/anime/mal/${id}`;
    if (!value) return fallback;
    try {
        const url = new URL(String(value), SITE);
        if (!HOSTS.has(url.hostname.toLowerCase())) return fallback;
        return url.toString();
    } catch (_) {
        return fallback;
    }
}

function normalizeSearchLimit(value, fallback, max) {
    if (value == null) return fallback;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
    return Math.min(limit, max);
}

async function mapWithConcurrency(items, concurrency, worker, signal) {
    const output = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            throwIfAborted(signal);
            const index = next++;
            if (index >= items.length) return;
            output[index] = await worker(items[index]);
        }
    });
    await Promise.all(workers);
    return output;
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const parentSignal = options.signal;
    const abort = () => controller.abort(parentSignal.reason);
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return { response, body: await response.text() };
    } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
    }
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
    search,
    episodes,
    listEpisodes,
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
