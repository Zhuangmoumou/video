const fs = require('fs-extra');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 9898;
const ROOT_DIR = path.join(PROJECT_DIR, 'mp4');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const MOD_DIR = path.join(PROJECT_DIR, 'mod');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const PAGE_DIR = path.join(PROJECT_DIR, 'pages');
const CONFIG_FILE = path.join(PROJECT_DIR, 'config.json');

for (const dir of [ROOT_DIR, OUT_DIR, MOD_DIR, PUBLIC_DIR, PAGE_DIR]) {
    fs.ensureDirSync(dir);
}

const API_DEFAULT_RESOLUTION = 'api-default';
const FRONTEND_DEFAULT_RESOLUTION = '720p';
const SCALE_FILTER = 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2';
const buildBoundedScaleFilter = (width, height) =>
    `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

const RESOLUTION_PRESETS = Object.freeze({
    [API_DEFAULT_RESOLUTION]: {
        id: API_DEFAULT_RESOLUTION,
        label: '320x170',
        description: '兼容现有 API 的默认压缩分辨率',
        scaleFilter: SCALE_FILTER,
        passthrough: false,
        ui: false
    },
    source: {
        id: 'source', label: '原画质', description: '保留原始分辨率；无裁剪时直接输出',
        scaleFilter: null, passthrough: true, ui: true
    },
    '1080p': {
        id: '1080p', label: '1080p', description: '最长边压到 1080p 以内，保留比例',
        scaleFilter: buildBoundedScaleFilter(1920, 1080), passthrough: false, ui: true
    },
    '720p': {
        id: '720p', label: '720p', description: '平衡体积与清晰度的常用档位',
        scaleFilter: buildBoundedScaleFilter(1280, 720), passthrough: false, ui: true
    },
    '480p': {
        id: '480p', label: '480p', description: '更小体积，适合快速归档',
        scaleFilter: buildBoundedScaleFilter(854, 480), passthrough: false, ui: true
    },
    '360p': {
        id: '360p', label: '360p', description: '最低档位，优先压缩体积',
        scaleFilter: buildBoundedScaleFilter(640, 360), passthrough: false, ui: true
    }
});

const FRONTEND_RESOLUTION_ORDER = ['source', '1080p', '720p', '480p', '360p'];
const RESOLUTION_ALIASES = Object.freeze({
    default: API_DEFAULT_RESOLUTION, legacy: API_DEFAULT_RESOLUTION, '320x170': API_DEFAULT_RESOLUTION,
    source: 'source', original: 'source', raw: 'source', passthrough: 'source', '原画质': 'source',
    '1080': '1080p', '1080p': '1080p', '720': '720p', '720p': '720p',
    '480': '480p', '480p': '480p', '360': '360p', '360p': '360p'
});

function normalizeResolutionValue(value, fallback = API_DEFAULT_RESOLUTION) {
    if (value == null || value === '') return fallback;
    const raw = String(value).trim();
    const alias = RESOLUTION_ALIASES[raw.toLowerCase()] || RESOLUTION_ALIASES[raw] || raw;
    const preset = RESOLUTION_PRESETS[alias];
    if (!preset) throw new Error(`不支持的分辨率选项: ${raw}`);
    return preset.id;
}

const getCompressionProfile = (value, fallback = API_DEFAULT_RESOLUTION) =>
    RESOLUTION_PRESETS[normalizeResolutionValue(value, fallback)];

const getUiResolutionOptions = () => FRONTEND_RESOLUTION_ORDER.map((id) => {
    const { label, description } = RESOLUTION_PRESETS[id];
    return { id, label, description };
});

async function readRuntimeConfig() {
    try {
        const raw = await fs.readJson(CONFIG_FILE);
        return raw && typeof raw === 'object' ? raw : {};
    } catch (_) {
        return {};
    }
}

async function getOriginConfig() {
    const raw = await readRuntimeConfig();
    const list = Array.isArray(raw?.origin) ? raw.origin : [];
    return list.map((item) => ({
        name: String(item?.name || '').trim(),
        url: String(item?.url || '').trim()
    })).filter((item) => item.name && item.url);
}

module.exports = {
    PROJECT_DIR, PORT, ROOT_DIR, OUT_DIR, MOD_DIR, PUBLIC_DIR, PAGE_DIR, CONFIG_FILE,
    API_DEFAULT_RESOLUTION, FRONTEND_DEFAULT_RESOLUTION, RESOLUTION_PRESETS,
    getCompressionProfile, getUiResolutionOptions, readRuntimeConfig, getOriginConfig
};
