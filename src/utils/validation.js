const path = require('path');

function sanitizeModName(name) {
    if (name == null || name === '') return null;
    const normalized = String(name).trim().replace(/\.js$/i, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) throw new Error(`非法 mod 名称: ${name}`);
    return normalized;
}

function sanitizeTaskFileBase(value) {
    const raw = String(value ?? '').trim();
    if (!raw) throw new Error('文件名不能为空');
    if (raw.includes('/') || raw.includes('\\') || raw.includes('\0') || raw === '.' || raw === '..' || raw.includes('..')) {
        throw new Error(`非法文件名: ${value}`);
    }
    const base = raw.replace(/\.mp4$/i, '');
    if (!base || !/^[a-zA-Z0-9._-]+$/.test(base)) throw new Error(`非法文件名: ${value}`);
    return base;
}

function resolveInsideDir(baseDir, fileName) {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(baseDir, fileName);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
        throw new Error(`非法输出路径: ${fileName}`);
    }
    return resolvedTarget;
}

const splitTaskUrls = (value) => String(value).split(',').map((item) => item.trim()).filter(Boolean);
const splitTaskFiles = (value) => value == null || value === '' ? [] : String(value)
    .split(',').map((item) => item.trim()).filter(Boolean).map(sanitizeTaskFileBase);

function parseTaskCode(value) {
    const code = Number(value);
    if (!Number.isSafeInteger(code) || code <= 0) throw new Error('code 必须是正整数');
    return code;
}

module.exports = {
    sanitizeModName, sanitizeTaskFileBase, resolveInsideDir, splitTaskUrls, splitTaskFiles, parseTaskCode
};
