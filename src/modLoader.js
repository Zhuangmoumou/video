const fs = require('fs-extra');
const { MOD_DIR } = require('./config');
const { sanitizeModName } = require('./utils/validation');

function parseTimeToSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value ?? '').trim();
    if (!text) return NaN;
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    const parts = text.split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

function normalizeCutRanges(value) {
    if (!value) return [];
    const isPair = Array.isArray(value) && value.length === 2
        && (typeof value[0] !== 'object' || value[0] == null)
        && (typeof value[1] !== 'object' || value[1] == null);
    const items = Array.isArray(value) && !isPair ? value : [value];
    const ranges = [];
    for (const item of items) {
        let start;
        let end;
        if (Array.isArray(item)) [start, end] = item;
        else if (item && typeof item === 'object') {
            start = item.start ?? item.from;
            end = item.end ?? item.to;
        } else continue;
        const s = parseTimeToSeconds(start);
        const e = parseTimeToSeconds(end);
        if (Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s) ranges.push({ start: s, end: e });
    }
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
    }
    return merged;
}

function normalizeModResult(result) {
    if (result == null) throw new Error('插件返回空结果');
    if (typeof result === 'string') {
        const mediaUrl = result.trim();
        if (!mediaUrl) throw new Error('插件返回空 URL');
        return { mediaUrl, refererUrl: null, pageTitle: null, cutRanges: [], meta: null };
    }
    if (typeof result !== 'object') throw new Error(`插件返回了不支持的类型: ${typeof result}`);
    const mediaUrl = String(result.url || result.mediaUrl || '').trim();
    if (!mediaUrl) throw new Error('插件返回对象中缺少 url/mediaUrl');
    const refererUrl = result.pageUrl || result.referer || result.refererUrl || null;
    const pageTitle = String(result.pageTitle || result.title || result.vod_name || '').trim() || null;
    const cutRanges = normalizeCutRanges(result.cutRanges || result.ffmpegCutRanges || result.cuts || result.cut);
    return { mediaUrl, refererUrl, pageTitle, cutRanges, meta: result };
}

function createModLoader() {
    const mods = new Map();
    const load = () => {
        mods.clear();
        const files = fs.existsSync(MOD_DIR) ? fs.readdirSync(MOD_DIR).filter((file) => file.endsWith('.js')) : [];
        for (const file of files) {
            const name = file.replace(/\.js$/i, '');
            const fullPath = require('path').join(MOD_DIR, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const mod = require(fullPath);
                if (typeof mod?.download !== 'function') {
                    console.error(`[Mod] 跳过 ${file}: 未导出 download 函数`);
                    continue;
                }
                mods.set(name, { name, file, download: mod.download.bind(mod) });
                console.log(`[Mod] 已加载插件: ${name} (${file})`);
            } catch (error) {
                console.error(`[Mod] 加载失败 ${file}:`, error?.message || error);
            }
        }
        console.log(`[Mod] 共加载 ${mods.size} 个插件: ${[...mods.keys()].join(', ') || '无'}`);
    };
    const get = (name) => {
        const normalized = sanitizeModName(name);
        if (!normalized) return null;
        const mod = mods.get(normalized);
        if (!mod) throw new Error(`未找到插件: ${normalized}（已加载: ${[...mods.keys()].join(', ') || '无'}）`);
        return mod;
    };
    return { mods, load, get };
}

module.exports = { createModLoader, normalizeModResult, normalizeCutRanges, parseTimeToSeconds };
