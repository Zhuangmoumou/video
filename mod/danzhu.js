/**
 * dm.danzhuacg.com M3U8 parser.
 *
 * Accepts:
 *   - 6477-1-1
 *   - https://dm.danzhuacg.com/vodpp/6477-1-1
 *
 * 解析出播放器 m3u8 后，先用 EXTINF 粗略估计 06:03～06:04 附近的 TS 范围，
 * 只下载这个候选窗口内的片段；再用已验证的广告字节特征（首片 1796904 bytes，
 * 广告片通常 > 1MiB）定位首个广告 TS，删除它及后 4 个片段，最后改写 m3u8
 * 到 /tmp 交给主程序下载。
 */

const axios = require('axios');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSafeObjectLiteral } = require('../src/utils/objectLiteral');

const SITE = 'https://dm.danzhuacg.com';
const HOST = 'dm.danzhuacg.com';
/** 播放器时间轴上的广告点位：约 06:03～06:04 */
const AD_START_SECONDS = 6 * 60 + 3;
const AD_END_SECONDS = 6 * 60 + 4;
/** 从首个广告 TS 起连续删除的分片数（含首个） */
const AD_SEGMENT_COUNT = 5;
/** 首个广告 TS 的稳定字节特征；候选窗口内优先用它定位 */
const FIRST_AD_BYTES = 1796904;
const FIRST_AD_BYTES_TOLERANCE = 4096;
/** 广告片通常大于 1MiB；仅作 exact bytes 找不到时的兜底 */
const BIG_AD_BYTES = 1024 * 1024;
/** 候选窗口：粗估索引前后各取若干片，只下载这个小窗口 */
const AD_SEARCH_BEFORE_SEGMENTS = 5;
const AD_SEARCH_AFTER_SEGMENTS = 8;
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

async function fetchBuffer(url, refererUrl, signal) {
    throwIfAborted(signal);
    const res = await http.get(url, {
        signal,
        responseType: 'arraybuffer',
        headers: {
            Accept: '*/*',
            Referer: refererUrl || SITE + '/',
            Origin: new URL(refererUrl || SITE).origin,
        },
    });
    return Buffer.from(res.data);
}

function resolveSegmentUrl(uri, playlistUrl) {
    const text = String(uri || '').trim();
    if (!text) return text;
    if (text.startsWith('http://') || text.startsWith('https://')) return text;
    if (text.startsWith('//')) return `https:${text}`;
    return new URL(text, playlistUrl).href;
}

/**
 * 解析媒体 m3u8，保留重建所需字段。
 * segments[i] = { duration, url, name, extinfLine, uriLine }
 */
function parseM3u8Media(content, playlistUrl) {
    const lines = String(content || '').split(/\r?\n/);
    const headerLines = [];
    const segments = [];
    let pendingExtinf = null;
    let pendingTags = []; // EXTINF 前的标签（KEY / DISCONTINUITY 等）
    let sawHeaderEnd = false;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            sawHeaderEnd = true;
            const duration = parseFloat(line.replace('#EXTINF:', '').replace(',', ''));
            pendingExtinf = {
                duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
                extinfLine: line,
                tags: pendingTags,
            };
            pendingTags = [];
            continue;
        }

        if (line.startsWith('#')) {
            if (!sawHeaderEnd && !line.startsWith('#EXT-X-ENDLIST')) {
                // 头部：VERSION / TARGETDURATION / MEDIA-SEQUENCE / PLAYLIST-TYPE 等
                // KEY / DISCONTINUITY 也可能出现在头部落到首段前，这里仍进 header
                if (
                    line.startsWith('#EXT-X-KEY:')
                    || line.startsWith('#EXT-X-DISCONTINUITY')
                    || line.startsWith('#EXT-X-MAP:')
                ) {
                    pendingTags.push(line);
                } else if (!line.startsWith('#EXT-X-ENDLIST')) {
                    headerLines.push(line);
                }
            } else if (
                line.startsWith('#EXT-X-KEY:')
                || line.startsWith('#EXT-X-DISCONTINUITY')
                || line.startsWith('#EXT-X-MAP:')
                || line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')
            ) {
                pendingTags.push(line);
            }
            continue;
        }

        // URI 行
        if (pendingExtinf) {
            const url = resolveSegmentUrl(line, playlistUrl);
            const name = line.split('?')[0].split('/').pop();
            segments.push({
                duration: pendingExtinf.duration,
                url,
                name,
                extinfLine: pendingExtinf.extinfLine,
                tags: pendingExtinf.tags,
                uriLine: url,
            });
            pendingExtinf = null;
        }
    }

    return { headerLines, segments };
}

/** 处理多码率 master playlist，跟随到实际媒体列表 */
async function resolvePlaylist(url, refererUrl, signal) {
    let currentUrl = url;
    for (let depth = 0; depth < 3; depth++) {
        throwIfAborted(signal);
        const content = await fetchText(currentUrl, refererUrl, 'application/vnd.apple.mpegurl,*/*', signal);
        const lines = content.split('\n');
        let subPath = null;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const candidate = lines[i + 1]?.trim();
                if (candidate && !candidate.startsWith('#')) {
                    subPath = candidate;
                    break;
                }
            }
        }
        if (!subPath) {
            return { content, url: currentUrl };
        }
        currentUrl = subPath.startsWith('http')
            ? subPath
            : (subPath.startsWith('/')
                ? new URL(subPath, currentUrl).href
                : currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1) + subPath);
    }
    throw new Error('m3u8 多码率嵌套过深');
}

/** 用 ffprobe 读取 TS 真实播放时长（秒） */
function getRealDuration(file) {
    const r = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file,
    ], { timeout: 10000, encoding: 'utf8' });

    if (r.status !== 0) return null;
    const out = String(r.stdout || '').trim();
    const lines = out.split('\n').filter((l) => /^[\d.]+$/.test(l.trim()));
    if (!lines.length) return null;
    const value = parseFloat(lines[lines.length - 1]);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/** 用 EXTINF 粗估目标时间落在哪个片段索引 */
function approxSegmentIndex(segments, targetTime) {
    let cum = 0;
    for (let i = 0; i < segments.length; i++) {
        const dur = segments[i].duration || 0;
        if (cum <= targetTime && targetTime < cum + dur) return i;
        cum += dur;
    }
    cum = 0;
    let last = -1;
    for (let i = 0; i < segments.length; i++) {
        if (cum <= targetTime) last = i;
        cum += segments[i].duration || 0;
    }
    return last;
}

/**
 * 粗略估计广告候选窗口，只下载这个小范围内的 TS 做字节/ffprobe 识别。
 */
function buildCandidateWindow(segments) {
    const startIdx = approxSegmentIndex(segments, AD_START_SECONDS);
    const endIdx = approxSegmentIndex(segments, AD_END_SECONDS);
    const lo = Math.min(
        startIdx >= 0 ? startIdx : Number.MAX_SAFE_INTEGER,
        endIdx >= 0 ? endIdx : Number.MAX_SAFE_INTEGER
    );
    const hi = Math.max(startIdx, endIdx);

    if (hi < 0 || lo === Number.MAX_SAFE_INTEGER) {
        return { start: 0, end: Math.min(segments.length - 1, AD_SEARCH_AFTER_SEGMENTS) };
    }

    return {
        start: Math.max(0, lo - AD_SEARCH_BEFORE_SEGMENTS),
        end: Math.min(segments.length - 1, hi + AD_SEARCH_AFTER_SEGMENTS),
        approxStartIndex: startIdx,
        approxEndIndex: endIdx,
    };
}

/** 下载候选窗口内的 TS，记录 bytes 和可诊断的 realDuration。 */
async function probeCandidateWindow(segments, refererUrl, signal) {
    const window = buildCandidateWindow(segments);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'danzhu-ts-'));

    try {
        let measured = 0;
        for (let i = window.start; i <= window.end; i++) {
            throwIfAborted(signal);
            const seg = segments[i];
            const filepath = path.join(tmpDir, `${i}_${seg.name || 'seg.ts'}`);
            try {
                const data = await fetchBuffer(seg.url, refererUrl, signal);
                seg.bytes = data.length;
                fs.writeFileSync(filepath, data);
                const dur = getRealDuration(filepath);
                if (dur != null) {
                    seg.realDuration = dur;
                    measured += 1;
                }
            } catch (e) {
                if (e?.name === 'AbortError' || e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || signal?.aborted) {
                    throw e;
                }
                seg.probeError = e.message || String(e);
            }
        }

        const candidates = [];
        for (let i = window.start; i <= window.end; i++) {
            const seg = segments[i];
            candidates.push({
                index: i,
                tsNumber: i + 1,
                duration: seg.duration,
                realDuration: seg.realDuration || null,
                bytes: seg.bytes || null,
                name: seg.name,
                error: seg.probeError || null,
            });
        }

        return { ...window, measured, candidates };
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    }
}

function chooseFirstAdIndex(segments, probe) {
    const candidates = [];
    for (let i = probe.start; i <= probe.end; i++) {
        const seg = segments[i];
        if (seg && Number.isFinite(seg.bytes)) candidates.push({ index: i, seg });
    }

    const exact = candidates.find(({ seg }) => seg.bytes === FIRST_AD_BYTES);
    if (exact) {
        return { index: exact.index, reason: `bytes == ${FIRST_AD_BYTES}` };
    }

    const nearExact = candidates
        .map(({ index, seg }) => ({ index, seg, diff: Math.abs(seg.bytes - FIRST_AD_BYTES) }))
        .filter((item) => item.diff <= FIRST_AD_BYTES_TOLERANCE)
        .sort((a, b) => a.diff - b.diff || a.index - b.index)[0];
    if (nearExact) {
        return { index: nearExact.index, reason: `bytes ~= ${FIRST_AD_BYTES} (diff=${nearExact.diff})` };
    }

    // 兜底：广告片通常 >1MiB。为避免选中更早的正片大分片，从粗估点前 2 片开始找。
    const anchor = Math.max(0, Math.min(
        Number.isFinite(probe.approxStartIndex) && probe.approxStartIndex >= 0 ? probe.approxStartIndex : probe.start,
        Number.isFinite(probe.approxEndIndex) && probe.approxEndIndex >= 0 ? probe.approxEndIndex : probe.end
    ) - 2);
    const big = candidates.find(({ index, seg }) => index >= anchor && seg.bytes > BIG_AD_BYTES);
    if (big) {
        return { index: big.index, reason: `bytes > ${BIG_AD_BYTES} (anchor=${anchor})` };
    }

    const fallback = Number.isFinite(probe.approxEndIndex) && probe.approxEndIndex >= 0
        ? probe.approxEndIndex
        : (Number.isFinite(probe.approxStartIndex) && probe.approxStartIndex >= 0 ? probe.approxStartIndex : probe.start);
    return { index: fallback, reason: 'fallback: EXTINF rough estimate' };
}

/**
 * 从首个广告 TS 起连续取 count 个索引删除。
 * 例：firstIdx=89, count=5 → {89,90,91,92,93}
 */
function buildRemoveSetFromFirst(firstIdx, count, total) {
    const remove = new Set();
    if (firstIdx < 0 || !Number.isFinite(firstIdx)) return remove;
    const n = Math.max(1, Math.floor(count || AD_SEGMENT_COUNT));
    for (let i = 0; i < n; i++) {
        const idx = firstIdx + i;
        if (idx >= 0 && idx < total) remove.add(idx);
    }
    return remove;
}

/**
 * 重建去掉广告片段后的 m3u8。
 * 分片 URI 一律写成绝对地址，便于主程序从本地 playlist 解析。
 * 中间挖掉广告后插入 DISCONTINUITY，避免时间戳跳变。
 */
function buildCleanM3u8(headerLines, segments, removeSet) {
    const out = [];
    const headers = headerLines.length ? [...headerLines] : ['#EXTM3U'];
    if (!headers.some((l) => l.startsWith('#EXTM3U'))) {
        headers.unshift('#EXTM3U');
    }

    // 重新计算 TARGETDURATION
    let maxDur = 0;
    for (let i = 0; i < segments.length; i++) {
        if (removeSet.has(i)) continue;
        maxDur = Math.max(maxDur, segments[i].duration || 0);
    }
    const targetDur = Math.max(1, Math.ceil(maxDur || 1));

    for (const line of headers) {
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            out.push(`#EXT-X-TARGETDURATION:${targetDur}`);
        } else {
            out.push(line);
        }
    }
    if (!headers.some((l) => l.startsWith('#EXT-X-TARGETDURATION:'))) {
        out.push(`#EXT-X-TARGETDURATION:${targetDur}`);
    }

    let removedGap = false;
    let kept = 0;
    for (let i = 0; i < segments.length; i++) {
        if (removeSet.has(i)) {
            removedGap = true;
            continue;
        }
        const seg = segments[i];
        if (removedGap && kept > 0) {
            out.push('#EXT-X-DISCONTINUITY');
        }
        removedGap = false;
        for (const tag of seg.tags || []) {
            // KEY URI 也绝对化
            if (tag.startsWith('#EXT-X-KEY:')) {
                out.push(absolutizeKeyLine(tag, seg.url));
            } else {
                out.push(tag);
            }
        }
        out.push(seg.extinfLine);
        out.push(seg.url);
        kept += 1;
    }

    if (!out.some((l) => l.startsWith('#EXT-X-ENDLIST'))) {
        out.push('#EXT-X-ENDLIST');
    }

    if (kept === 0) {
        throw new Error('剔除广告后 m3u8 无剩余分片');
    }

    return `${out.join('\n')}\n`;
}

function absolutizeKeyLine(keyLine, baseUrl) {
    const m = /URI="([^"]+)"/i.exec(keyLine) || /URI=([^,]+)/i.exec(keyLine);
    if (!m) return keyLine;
    const raw = m[1].trim().replace(/^"|"$/g, '');
    try {
        const abs = resolveSegmentUrl(raw, baseUrl);
        return keyLine.replace(m[0], m[0].includes('"') ? `URI="${abs}"` : `URI=${abs}`);
    } catch (_) {
        return keyLine;
    }
}

/**
 * 定位广告分片 → 写本地 m3u8。
 * 失败时回退：仍写一份「未裁切」的绝对路径 m3u8，保证主流程可下载。
 */
async function buildAdFreeM3u8File(m3u8Url, refererUrl, episodeId, signal) {
    const { content, url: resolvedUrl } = await resolvePlaylist(m3u8Url, refererUrl, signal);
    const { headerLines, segments } = parseM3u8Media(content, resolvedUrl);
    if (!segments.length) {
        throw new Error('m3u8 未解析到任何 TS 分片');
    }

    let removeSet = new Set();
    let probeMeta = { reason: 'skipped' };
    let firstAdIdx = -1;

    try {
        // 1) EXTINF 粗略估计 06:03～06:04 附近，只下载小窗口内的 TS
        const probe = await probeCandidateWindow(segments, refererUrl, signal);
        // 2) 使用已验证的字节特征优先定位广告首片：1796904 bytes > 近似 > 大于 1MiB > EXTINF 兜底
        const choice = chooseFirstAdIndex(segments, probe);
        firstAdIdx = choice.index;
        // 3) 从首片起连续删除 5 个 TS
        removeSet = buildRemoveSetFromFirst(firstAdIdx, AD_SEGMENT_COUNT, segments.length);

        const removedIndexes = [...removeSet].sort((a, b) => a - b);
        const removedTsNumbers = removedIndexes.map((idx) => idx + 1);
        probeMeta = {
            adStartSeconds: AD_START_SECONDS,
            adEndSeconds: AD_END_SECONDS,
            firstAdBytes: FIRST_AD_BYTES,
            bigAdBytes: BIG_AD_BYTES,
            selectionReason: choice.reason,
            approxStartIndex: probe.approxStartIndex,
            approxStartTsNumber: Number.isFinite(probe.approxStartIndex) && probe.approxStartIndex >= 0 ? probe.approxStartIndex + 1 : null,
            approxEndIndex: probe.approxEndIndex,
            approxEndTsNumber: Number.isFinite(probe.approxEndIndex) && probe.approxEndIndex >= 0 ? probe.approxEndIndex + 1 : null,
            firstAdIndex: firstAdIdx,
            firstAdTsNumber: firstAdIdx + 1,
            // 兼容旧字段：firstAdIdx 是 0-based，不是 grep/sed 的行号
            firstAdIdx,
            adSegmentCount: AD_SEGMENT_COUNT,
            measured: probe.measured,
            window: [probe.start, probe.end],
            windowTsNumbers: [probe.start + 1, probe.end + 1],
            candidates: probe.candidates,
            removedIndexes,
            removedTsNumbers,
            // removed 使用 grep/sed 能直接对照的 1-based TS 编号
            removed: removedTsNumbers,
            removedCount: removeSet.size,
        };
    } catch (e) {
        if (e?.name === 'AbortError' || e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || signal?.aborted) {
            throw e;
        }
        probeMeta = { reason: 'probe-failed', error: e.message || String(e) };
        removeSet = new Set();
        firstAdIdx = -1;
    }

    // 探测失败时：仅用 EXTINF 粗估 06:04 所在片，仍连续删 5 个
    if (removeSet.size === 0) {
        firstAdIdx = approxSegmentIndex(segments, AD_END_SECONDS);
        removeSet = buildRemoveSetFromFirst(firstAdIdx, AD_SEGMENT_COUNT, segments.length);
        if (removeSet.size) {
            const removedIndexes = [...removeSet].sort((a, b) => a - b);
            const removedTsNumbers = removedIndexes.map((idx) => idx + 1);
            probeMeta.fallback = 'extinf-only';
            probeMeta.adStartSeconds = AD_START_SECONDS;
            probeMeta.adEndSeconds = AD_END_SECONDS;
            probeMeta.firstAdIndex = firstAdIdx;
            probeMeta.firstAdTsNumber = firstAdIdx + 1;
            probeMeta.firstAdIdx = firstAdIdx;
            probeMeta.adSegmentCount = AD_SEGMENT_COUNT;
            probeMeta.removedIndexes = removedIndexes;
            probeMeta.removedTsNumbers = removedTsNumbers;
            probeMeta.removed = removedTsNumbers;
            probeMeta.removedCount = removeSet.size;
        }
    }

    const cleanContent = buildCleanM3u8(headerLines, segments, removeSet);
    const safeId = String(episodeId || 'ep').replace(/[^\w.-]+/g, '_');
    const outPath = path.join(os.tmpdir(), `danzhu_${safeId}_${Date.now()}.m3u8`);
    fs.writeFileSync(outPath, cleanContent, 'utf8');

    return {
        localPath: outPath,
        originalUrl: m3u8Url,
        resolvedUrl,
        totalSegments: segments.length,
        removedCount: removeSet.size,
        probeMeta,
    };
}

async function download(input, options = {}) {
    const { id, pageUrl } = normalizeInput(input);
    const signal = options.signal;
    throwIfAborted(signal);

    const pageHtml = await fetchText(pageUrl, SITE + '/', 'text/html,*/*', signal);
    const pageTitle = extractPageTitle(pageHtml);
    const player = parsePlayerAaaa(pageHtml);
    const m3u8Url = extractM3U8Url(player, pageUrl);

    const adFree = await buildAdFreeM3u8File(m3u8Url, pageUrl, id, signal);

    // 返回本地 m3u8 路径；主程序按 m3u8 下载分片（分片仍是远程绝对 URL）
    // 不再返回 cutRanges —— 广告已在 playlist 层剔除
    return {
        url: adFree.localPath,
        pageUrl,
        pageTitle,
        episodeId: id,
        originalM3u8: m3u8Url,
        adCut: {
            removedCount: adFree.removedCount,
            totalSegments: adFree.totalSegments,
            localM3u8: adFree.localPath,
            ...adFree.probeMeta,
        },
    };
}

module.exports = {
    download,
    normalizeInput,
    AD_START_SECONDS,
    AD_SEGMENT_COUNT,
    buildAdFreeM3u8File,
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
