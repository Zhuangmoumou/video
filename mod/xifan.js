/**
 * 稀饭动漫 Next (next.xifanacg.com) 搜索、分集和直链插件。
 *
 * 下载输入支持：
 *   - episode_id
 *   - anime_id-episode_id（episodes() 返回的 input）
 *   - episode_id@source_id（可选指定线路）
 *   - https://next.xifanacg.com/anime/{anime_id}/play/{episode_id}
 */

const axios = require('axios');
const { getAxiosProxyConfig } = require('../src/download/mp4');

const SITE = 'https://next.xifanacg.com';
const API_BASE = 'https://api.xifanacg.com';
const API_KEY = 'sb_publishable_OBIVAWACIX6lPXrO98_z24_HcsmalkA';
const SITE_HOSTS = new Set(['next.xifanacg.com', 'xifanacg.com', 'www.xifanacg.com']);
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_MAX_EPISODES = 300;
const MAX_EPISODES = 500;
const PLAYBACK_INTERVAL_MS = 1200;

const http = axios.create({
    timeout: 25000,
    maxRedirects: 5,
    headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
    },
    validateStatus: () => true,
});

let playbackQueue = Promise.resolve();
let lastPlaybackStartedAt = 0;

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const error = new Error('任务被中止');
        error.name = 'AbortError';
        throw error;
    }
}

function sleep(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            const error = new Error('任务被中止');
            error.name = 'AbortError';
            reject(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function playbackError(payload) {
    const code = String(payload?.error || payload?.code || '').trim();
    const messages = {
        rate_limited: '请求过于频繁',
        unauthenticated: '播放接口鉴权失败',
        forbidden: '该番剧需要登录后才能播放',
        not_found: '找不到该集或该集尚未发布',
        hls_not_ready: '该集的 HLS 线路尚未就绪',
        hls_not_supported: '该集暂不支持 HLS 线路',
        playback_service_unavailable: '播放服务暂时不可用',
    };
    const detail = payload?.message || payload?.detail || payload?.msg;
    const error = new Error(
        `稀饭直链解析失败：${messages[code] || detail || code || '接口返回失败'}`,
    );
    error.apiCode = code;
    error.retryAfter = payload?.retry_after;
    error.status = code === 'rate_limited'
        ? 429
        : code === 'playback_service_unavailable'
            ? 503
            : 400;
    return error;
}

function responseError(response) {
    const payload = response.data;
    const code = String(payload?.code || payload?.error || '').trim();
    const detail = typeof payload === 'string'
        ? payload.trim()
        : payload?.message || payload?.details || payload?.hint || payload?.msg;
    const text = [code, detail].filter(Boolean).join(': ');
    const error = new Error(
        `稀饭 API HTTP ${response.status}${text ? `：${text}` : ` ${response.statusText || ''}`}`.trim(),
    );
    error.status = response.status;
    error.retryAfter = response.headers?.['retry-after'] || payload?.retry_after;
    error.apiCode = code;
    return error;
}

function isAborted(error, signal) {
    return signal?.aborted || error?.name === 'AbortError' || error?.name === 'CanceledError' ||
        error?.code === 'ERR_CANCELED';
}

function isRetryable(error) {
    return error?.apiCode === 'rate_limited' || error?.status === 429 ||
        [502, 503, 504].includes(error?.status) || !error?.status;
}

function retryDelay(error, attempt) {
    const retryAfter = Number(error?.retryAfter);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(30000, Math.max(500, retryAfter * 1000));
    }
    if (error?.status === 429 || error?.apiCode === 'rate_limited') {
        return Math.min(30000, PLAYBACK_INTERVAL_MS * (attempt + 1));
    }
    return 400 * (attempt + 1);
}

async function apiRequest(path, { method = 'get', data, signal, retries = 2, headers = {} } = {}) {
    const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        throwIfAborted(signal);
        try {
            const response = await http.request({
                method,
                url,
                data,
                signal,
                proxy: getAxiosProxyConfig(),
                headers,
            });
            if (response.status < 200 || response.status >= 300) {
                throw responseError(response);
            }
            if (path.startsWith('/functions/') && response.data?.ok === false) {
                throw playbackError(response.data);
            }
            return response;
        } catch (error) {
            if (isAborted(error, signal)) throw error;
            lastError = error;
            if (attempt >= retries || !isRetryable(error)) throw error;
            await sleep(retryDelay(error, attempt), signal);
        }
    }

    throw lastError || new Error(`请求失败: ${path}`);
}

function normalizeLimit(value, fallback, maximum, name) {
    if (value == null) return fallback;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`${name} 必须是正整数`);
    }
    return Math.min(limit, maximum);
}

function responseRows(data, label) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.results)) return data.results;
    throw new Error(`${label}接口返回格式无效`);
}

function cleanText(value) {
    return String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function formatEpisodeNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value ?? '').trim();
    return Number.isInteger(number) ? String(number) : String(number);
}

function statusForAnime(anime) {
    if (anime?.is_finished === true) return '已完结';
    const current = positiveNumber(anime?.current_episodes);
    if (current != null) return `更新至${formatEpisodeNumber(current)}集`;
    return '未知';
}

function normalizeSearchResult(anime) {
    const id = String(anime?.id ?? '').trim();
    const title = cleanText(anime?.title || anime?.title_original || '');
    if (!/^\d+$/.test(id) || !title) return null;

    const currentEpisodes = positiveNumber(anime.current_episodes);
    const totalEpisodes = positiveNumber(anime.total_episodes);
    const episodeCount = currentEpisodes ?? totalEpisodes;
    const aliases = Array.isArray(anime.aliases)
        ? anime.aliases.map(cleanText).filter(Boolean)
        : [];

    const score = anime.bangumi_score == null ? null : Number(anime.bangumi_score);
    return {
        id,
        title,
        url: `${SITE}/anime/${id}`,
        status: statusForAnime(anime),
        episodeCount,
        currentEpisodes,
        totalEpisodes,
        releaseYear: positiveNumber(anime.release_year),
        score: Number.isFinite(score) ? score : null,
        coverUrl: cleanText(anime.cover_url),
        aliases,
    };
}

async function search(keyword, options = {}) {
    const query = String(keyword || '').trim();
    if (!query) throw new Error('搜索关键词不能为空');
    const limit = normalizeLimit(options.limit, DEFAULT_LIMIT, MAX_SEARCH_LIMIT, 'limit');
    const response = await apiRequest('/rest/v1/rpc/search_animes', {
        method: 'post',
        signal: options.signal,
        data: {
            search_term: query,
            page_number: 1,
            items_per_page: limit,
            sort_by: 'view_count',
            sort_order: 'desc',
        },
    });
    return responseRows(response.data, '搜索').map(normalizeSearchResult).filter(Boolean).slice(0, limit);
}

function parseAnimeReference(input) {
    const series = input && typeof input === 'object' ? input : { id: input };
    const rawValue = series.id ?? series.animeId ?? series.seriesId ?? series.url;
    const raw = String(rawValue ?? '').trim();
    if (!raw) throw new Error('xifan 作品编号不能为空');

    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
        let url;
        try {
            url = new URL(raw);
        } catch (_) {
            throw new Error(`非法 xifan URL: ${raw}`);
        }
        if (!SITE_HOSTS.has(url.hostname.toLowerCase())) {
            throw new Error(`xifan URL 域名不受支持: ${url.hostname}`);
        }
        path = url.pathname;
    }

    const match = path.match(/(?:^|\/)anime\/(\d+)(?:\/|$)/i) || path.match(/^(\d+)$/);
    if (!match) throw new Error(`非法 xifan 作品编号: ${raw}`);
    return { ...series, animeId: match[1] };
}

function contentRangeTotal(value) {
    const match = String(value || '').match(/\/(\d+|\*)$/);
    return match && match[1] !== '*' ? Number(match[1]) : null;
}

async function listEpisodes(input, options = {}) {
    const series = parseAnimeReference(input);
    const animeId = series.animeId;
    const maxEpisodes = normalizeLimit(
        options.maxEpisodes,
        DEFAULT_MAX_EPISODES,
        MAX_EPISODES,
        'maxEpisodes',
    );
    const query = new URLSearchParams({
        anime_id: `eq.${animeId}`,
        select: 'id,episode_number,title,kind,release_date,duration_seconds',
        order: 'episode_number.asc',
        limit: String(maxEpisodes),
    });
    const response = await apiRequest(`/rest/v1/episodes?${query.toString()}`, {
        signal: options.signal,
        headers: { Prefer: 'count=exact' },
    });
    const rows = responseRows(response.data, '分集');
    const sorted = rows
        .filter((episode) => positiveNumber(episode?.id) != null)
        .slice()
        .sort((a, b) => Number(a.episode_number) - Number(b.episode_number));
    const episodes = sorted.map((episode) => {
        const episodeId = String(episode.id);
        const episodeNumber = positiveNumber(episode.episode_number);
        const order = episodeNumber == null ? null : formatEpisodeNumber(episodeNumber);
        const episodeTitle = cleanText(episode.title) || (order ? `第${order}集` : `剧集 ${episodeId}`);
        const pageUrl = `${SITE}/anime/${animeId}/play/${episodeId}`;
        return {
            id: episodeId,
            input: order == null ? `${animeId}-${episodeId}` : `${animeId}-${episodeId}-${order}`,
            episodeId,
            animeId,
            order,
            episodeNumber,
            title: episodeTitle,
            kind: episode.kind || null,
            releaseDate: episode.release_date || null,
            durationSeconds: positiveNumber(episode.duration_seconds),
            url: pageUrl,
        };
    });

    const countFromHeader = contentRangeTotal(response.headers?.['content-range']);
    const sourceCount = positiveNumber(
        series.currentEpisodes ?? series.current_episodes ?? series.episodeCount ?? series.total_episodes,
    );
    const episodeCount = countFromHeader ?? sourceCount ?? episodes.length;
    const status = series.status && series.status !== '未知'
        ? series.status
        : statusForAnime(series);

    return {
        id: animeId,
        animeId,
        title: cleanText(series.title) || animeId,
        url: `${SITE}/anime/${animeId}`,
        status,
        episodeCount,
        episodes,
        truncated: episodeCount > episodes.length,
    };
}

async function episodes(input, options = {}) {
    return listEpisodes(input, options);
}

function parseDownloadInput(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('xifan 下载编号不能为空');

    let text = raw;
    let sourceId = null;
    let animeId = null;
    let episodeNumber = null;
    if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) {
        let url;
        try {
            url = new URL(raw, SITE);
        } catch (_) {
            throw new Error(`非法 xifan 播放页 URL: ${raw}`);
        }
        if (!SITE_HOSTS.has(url.hostname.toLowerCase())) {
            throw new Error(`xifan URL 域名不受支持: ${url.hostname}`);
        }
        const match = url.pathname.match(/\/anime\/(\d+)\/play\/(\d+)/i);
        if (!match) throw new Error(`无法从 xifan 播放页提取番剧和剧集编号: ${raw}`);
        animeId = match[1];
        text = match[2];
        sourceId = positiveNumber(url.searchParams.get('source_id'));
    } else {
        const sourceMatch = text.match(/^(.*)@(\d+)$/);
        if (sourceMatch) {
            text = sourceMatch[1];
            sourceId = positiveNumber(sourceMatch[2]);
        }
        if (/^\d+$/.test(text)) {
            // 裸数字是 episodes 表中的 episode_id。
        } else {
            const compound = text.match(/^(\d+)-(\d+)(?:-(\d+(?:\.\d+)?))?$/);
            if (!compound) {
                throw new Error(`非法 xifan 下载编号: ${raw}，期望 episode_id 或 anime_id-episode_id-集序号`);
            }
            animeId = compound[1];
            text = compound[2];
            episodeNumber = compound[3] == null ? null : Number(compound[3]);
        }
    }

    const episodeId = positiveNumber(text);
    if (episodeId == null || !Number.isInteger(episodeId)) {
        throw new Error(`非法 xifan episode_id: ${text}`);
    }
    if (sourceId != null && !Number.isInteger(sourceId)) {
        throw new Error(`非法 xifan source_id: ${sourceId}`);
    }
    return { animeId, episodeId, episodeNumber, sourceId };
}

function withPlaybackRateLimit(task, signal) {
    const queued = playbackQueue.catch(() => undefined).then(async () => {
        const waitMs = Math.max(0, PLAYBACK_INTERVAL_MS - (Date.now() - lastPlaybackStartedAt));
        if (waitMs > 0) await sleep(waitMs, signal);
        throwIfAborted(signal);
        lastPlaybackStartedAt = Date.now();
        return task();
    });
    playbackQueue = queued.then(() => undefined, () => undefined);
    return queued;
}

function normalizeMediaUrl(value) {
    const text = String(value || '').trim();
    try {
        const url = new URL(text);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_) {
        // Turn invalid media URLs into a readable plugin error below.
    }
    throw new Error(`稀饭播放接口返回了无效媒体 URL: ${text.slice(0, 120) || '空地址'}`);
}

async function download(input, options = {}) {
    const parsed = parseDownloadInput(input);
    const signal = options.signal;
    throwIfAborted(signal);
    const requestBody = { action: 'fallback', episode_id: parsed.episodeId };
    if (parsed.sourceId != null) requestBody.source_id = parsed.sourceId;

    const response = await withPlaybackRateLimit(
        () => apiRequest('/functions/v1/issue-web-playback', {
            method: 'post',
            data: requestBody,
            signal,
            retries: 2,
        }),
        signal,
    );
    const payload = response.data;
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates.filter(Boolean) : [];
    const selected = parsed.sourceId == null
        ? candidates[0]
        : candidates.find((candidate) => Number(candidate.source_id) === parsed.sourceId);
    if (parsed.sourceId != null && candidates.length > 0 && !selected) {
        throw new Error(`稀饭播放接口未返回 source_id=${parsed.sourceId} 的线路`);
    }
    const mediaUrl = normalizeMediaUrl(selected?.url || payload?.url);
    const animeId = String(payload?.anime_id || parsed.animeId || '').trim() || null;
    const sourceCode = String(selected?.source_code || '').trim() || null;
    const pageUrl = animeId
        ? `${SITE}/anime/${animeId}/play/${parsed.episodeId}${sourceCode ? `?source=${encodeURIComponent(sourceCode)}` : ''}`
        : null;
    const isHls = payload?.resolved_action === 'hls' || /\.m3u8(?:[?#]|$)/i.test(mediaUrl);

    if (!options.meta) return mediaUrl;
    return {
        url: mediaUrl,
        pageUrl,
        pageTitle: parsed.episodeNumber == null ? null : `第${formatEpisodeNumber(parsed.episodeNumber)}集`,
        animeId,
        episodeId: parsed.episodeId,
        episodeNumber: parsed.episodeNumber,
        sourceId: selected?.source_id ?? parsed.sourceId,
        sourceCode,
        sourceName: selected?.source_name || null,
        expectedBytes: positiveNumber(selected?.expected_bytes),
        expiresAt: positiveNumber(payload?.expires_at),
        resolvedAction: payload?.resolved_action || null,
        hls: isHls,
        candidates,
    };
}

module.exports = {
    download,
    search,
    episodes,
    listEpisodes,
    parseAnimeReference,
    parseDownloadInput,
    SITE,
    API_BASE,
};

if (require.main === module) {
    const arg = process.argv[2] || '121958';
    download(arg, { meta: true })
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => {
            console.error('[xifan] failed:', error.message);
            process.exit(1);
        });
}
