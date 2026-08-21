const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { createProgressLimiter, createSpeedAverager } = require('../utils/progress');

const proxyDomain = (process.env.PROXY_DOMAIN || '').trim();

// 新增：启动时打印代理配置，用于诊断
console.log(`[Proxy] 启动时读取到的 PROXY_DOMAIN: ${proxyDomain || '未设置或为空'}`);
console.log(`[Proxy] 下载代理 DOWNLOAD_PROXY/VIDEO_PROXY: ${(process.env.DOWNLOAD_PROXY || process.env.VIDEO_PROXY) ? '已设置' : '未设置'}`);

const getDownloadProxy = () => (process.env.DOWNLOAD_PROXY || process.env.VIDEO_PROXY || '').trim();

function getAxiosProxyConfig() {
    const raw = getDownloadProxy();
    if (!raw) return undefined;
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error('DOWNLOAD_PROXY 只支持 http/https 代理，例如 http://user:pass@host:port');
    }
    const cfg = {
        protocol: u.protocol.slice(0, -1),
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    };
    if (u.username || u.password) {
        cfg.auth = {
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password)
        };
    }
    return cfg;
}

function isLocalMediaPath(url) {
    if (typeof url !== 'string') return false;
    const text = url.trim();
    if (!text || /^https?:\/\//i.test(text) || text.startsWith('//')) return false;
    // 插件可返回本地改写后的 m3u8（如 /tmp/danzhu_xxx.m3u8）
    return path.isAbsolute(text);
}

function applyProxy(originalUrl) {
    // 两个代理都允许为空：都为空则直连。
    // DOWNLOAD_PROXY 是真正 HTTP 代理，优先级最高；设置后不再使用 PROXY_DOMAIN 改写 URL，避免双代理冲突。
    if (getDownloadProxy() || !proxyDomain || !originalUrl) {
        return originalUrl;
    }
    // 本地 playlist 不走域名改写
    if (isLocalMediaPath(originalUrl)) {
        return originalUrl;
    }
    const prefix = proxyDomain.replace(/\/+$/, '') + '/';
    return prefix + originalUrl.replace('://', '/');
}

function formatAxiosError(error, context = '') {
    const lines = [];
    const add = (label, value) => {
        if (value !== undefined && value !== null && value !== '') lines.push(`${label}: ${value}`);
    };

    if (context) lines.push(context);
    add('name', error?.name);
    add('message', error?.message);
    add('code', error?.code);
    add('method', error?.config?.method?.toUpperCase());
    add('url', error?.config?.url);
    add('timeout', error?.config?.timeout);
    add('status', error?.response?.status);
    add('statusText', error?.response?.statusText);
    const body = error?.response?.data;
    if (body != null && body !== '') {
        add('body', (Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 200));
    }

    const cause = error?.cause;
    if (cause) {
        add('cause', `${cause.name || 'Error'}: ${cause.message || String(cause)}`);
        add('cause.code', cause.code);
        if (Array.isArray(cause.errors)) {
            cause.errors.forEach((inner, index) => {
                add(`cause.errors[${index}]`, `${inner.name || 'Error'}: ${inner.message || String(inner)}`);
                add(`cause.errors[${index}].code`, inner.code);
                add(`cause.errors[${index}].address`, inner.address);
                add(`cause.errors[${index}].port`, inner.port);
            });
        }
    }

    return lines.join('\n');
}

function formatSpeed(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0B/s';
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)}MB/s`;
    if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)}KB/s`;
    return `${Math.round(bytesPerSec)}B/s`;
}

function parseAttrList(text) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("(?:\\.|[^"])*"|[^,]*)/gi;
    let match;
    while ((match = re.exec(String(text || '')))) {
        let value = match[2].trim();
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }
        attrs[match[1].toUpperCase()] = value;
    }
    return attrs;
}

function mediaSequenceToIv(sequence) {
    const iv = Buffer.alloc(16);
    // HLS 默认 IV = 媒体序列号的 128-bit 大端表示
    iv.writeUInt32BE(0, 0);
    iv.writeUInt32BE(0, 4);
    iv.writeUInt32BE(Math.floor(sequence / 2 ** 32), 8);
    iv.writeUInt32BE(sequence >>> 0, 12);
    return iv;
}

function parseIv(value, sequence) {
    if (!value) return mediaSequenceToIv(sequence);
    let hex = String(value).trim();
    if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error(`无法解析 EXT-X-KEY IV: ${value}`);
    }
    if (hex.length < 32) hex = hex.padStart(32, '0');
    if (hex.length > 32) hex = hex.slice(-32);
    return Buffer.from(hex, 'hex');
}

/**
 * 解析 playlist 内 URI。
 * 本地 m3u8 路径（/tmp/xxx.m3u8）不能直接当 new URL 的 base，
 * 否则即便分片已是 https 绝对地址也会抛 Invalid URL。
 */
function resolvePlaylistUri(uri, playlistUrl) {
    const text = String(uri || '').trim();
    if (!text) throw new Error('playlist URI 为空');

    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith('//')) return `https:${text}`;

    const base = String(playlistUrl || '').trim();
    if (!base) throw new Error(`无法解析相对 URI（缺少 playlist base）: ${text}`);

    // 本地文件路径 → file:// base；http(s)/file playlist 原样
    let baseUrl = base;
    if (isLocalMediaPath(base)) {
        baseUrl = path.isAbsolute(base)
            ? `file://${base}`
            : `file://${path.resolve(base)}`;
    }

    try {
        return new URL(text, baseUrl).href;
    } catch (e) {
        throw new Error(`无法解析 playlist URI: ${text} (base=${base})`);
    }
}

function parseMediaPlaylist(content, playlistUrl) {
    const lines = String(content || '').split(/\r?\n/);
    let mediaSequence = 0;
    let currentKey = null;
    const segments = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            const n = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
            if (Number.isFinite(n) && n >= 0) mediaSequence = Math.floor(n);
            continue;
        }

        if (line.startsWith('#EXT-X-KEY:')) {
            const attrs = parseAttrList(line.slice('#EXT-X-KEY:'.length));
            const method = String(attrs.METHOD || 'NONE').toUpperCase();
            if (method === 'NONE') {
                currentKey = null;
            } else if (method === 'AES-128') {
                if (!attrs.URI) throw new Error('EXT-X-KEY 缺少 URI');
                currentKey = {
                    method,
                    uri: resolvePlaylistUri(attrs.URI, playlistUrl),
                    ivAttr: attrs.IV || null,
                };
            } else {
                throw new Error(`不支持的 HLS 加密方式: ${method}`);
            }
            continue;
        }

        if (line.startsWith('#')) continue;

        const sequence = mediaSequence + segments.length;
        segments.push({
            url: resolvePlaylistUri(line, playlistUrl),
            sequence,
            key: currentKey
                ? {
                    method: currentKey.method,
                    uri: currentKey.uri,
                    iv: parseIv(currentKey.ivAttr, sequence),
                }
                : null,
        });
    }

    return segments;
}

function decryptAes128(buffer, key, iv) {
    if (!Buffer.isBuffer(key) || (key.length !== 16 && key.length !== 24 && key.length !== 32)) {
        throw new Error(`AES key 长度非法: ${key?.length}`);
    }
    if (!Buffer.isBuffer(iv) || iv.length !== 16) {
        throw new Error(`AES IV 长度非法: ${iv?.length}`);
    }

    const algo = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
    const decipher = crypto.createDecipheriv(algo, key, iv);
    return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

/**
 * M3U8 下载模块
 * 支持未加密分片，以及 HLS AES-128 加密分片。
 */
async function downloadM3U8(m3u8Url, outputPath, onProgress, serverState, refererUrl, browserHeaders = null) {
    const tempDir = path.join(path.dirname(outputPath), `m3u8_tmp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    try {
        const headers = browserHeaders || {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': refererUrl,
            'Origin': new URL(refererUrl).origin
        };
        const axiosProxy = getAxiosProxyConfig();

        let currentUrl = m3u8Url;
        let content = "";

        while (true) {
            if (isLocalMediaPath(currentUrl)) {
                if (!await fs.pathExists(currentUrl)) {
                    throw new Error(`本地 m3u8 不存在: ${currentUrl}`);
                }
                content = await fs.readFile(currentUrl, 'utf8');
                // 本地文件一般是插件改写后的媒体列表；若仍是 master 则要求子路径为绝对 URL
                if (content.includes('#EXT-X-STREAM-INF')) {
                    const lines = content.split('\n');
                    const subPath = lines.find(l => l && !l.startsWith('#') && l.trim());
                    if (!subPath) throw new Error("在本地M3U8中找不到子播放列表路径");
                    const trimmed = subPath.trim();
                    if (!/^https?:\/\//i.test(trimmed)) {
                        throw new Error(`本地 master m3u8 的子列表必须是绝对 URL: ${trimmed}`);
                    }
                    currentUrl = trimmed;
                    continue;
                }
                break;
            }

            const playlistUrl = applyProxy(currentUrl);
            let res;
            try {
                res = await axios.get(playlistUrl, {
                    headers,
                    timeout: 10000,
                    signal: serverState.abortController?.signal,
                    proxy: axiosProxy
                });
            } catch (error) {
                console.error('[Axios Error] M3U8播放列表请求失败\n' + formatAxiosError(error, `playlist=${currentUrl}`));
                throw error;
            }
            content = res.data;
            if (content.includes('#EXT-X-STREAM-INF')) {
                const lines = content.split('\n');
                const subPath = lines.find(l => l && !l.startsWith('#'));
                if (!subPath) throw new Error("在M3U8中找不到子播放列表路径");
                currentUrl = new URL(subPath, currentUrl).href;
            } else {
                break;
            }
        }

        const segments = parseMediaPlaylist(content, currentUrl);
        const totalSegments = segments.length;
        if (totalSegments === 0) throw new Error("未找到有效的 TS 分片");

        const keyCache = new Map();
        const loadKey = async (keyUrl) => {
            if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
            const proxied = applyProxy(keyUrl);
            let res;
            try {
                res = await axios.get(proxied, {
                    responseType: 'arraybuffer',
                    headers,
                    timeout: 15000,
                    signal: serverState.abortController?.signal,
                    proxy: axiosProxy
                });
            } catch (error) {
                console.error('[Axios Error] HLS key 请求失败\n' + formatAxiosError(error, `key=${keyUrl}`));
                throw error;
            }
            const key = Buffer.from(res.data);
            keyCache.set(keyUrl, key);
            return key;
        };

        let downloadedCount = 0;
        let totalBytes = 0;
        // 已向速度采样器报告过的最大字节数（并发分片乐观累计，保持单调不减，
        // 避免并发下字节数回退触发采样器重置）
        let sampledBytes = 0;
        const downloadSpeed = createSpeedAverager();
        downloadSpeed.sample(0);
        const shouldReportProgress = createProgressLimiter();
        const CONCURRENCY = 8; 
        const ffmpegList = [];

        const reportProgress = (force = false) => {
            const now = Date.now();
            const percent = Math.floor((downloadedCount / totalSegments) * 100);
            if (!shouldReportProgress({ force, percent })) return;

            const speed = downloadSpeed.getSpeed();
            const currMB = (totalBytes / 1024 / 1024).toFixed(2);
            const segProgress = `${downloadedCount}/${totalSegments}`;
            onProgress(percent, `${currMB}MB`, segProgress, speed > 0 ? formatSpeed(speed) : '');
        };

        // 分片卡住（无下载进度）时也周期性上报，速度会随时间衰减到 0，而不是停在旧值
        const speedTimer = setInterval(() => reportProgress(true), 1000);

        try {
            for (let i = 0; i < segments.length; i += CONCURRENCY) {
                if (serverState.abortController?.signal.aborted) throw new Error("任务被中止");

                const chunk = segments.slice(i, i + CONCURRENCY);
                await Promise.all(chunk.map(async (segment, index) => {
                    const realIndex = i + index;
                    const tsFileName = `seg_${String(realIndex).padStart(5, '0')}.ts`;
                    const tsPath = path.join(tempDir, tsFileName);
                    const url = applyProxy(segment.url);
                    const baseBytes = totalBytes;

                    let response;
                    try {
                        response = await axios({
                            url,
                            responseType: 'arraybuffer',
                            headers,
                            timeout: 30000,
                            signal: serverState.abortController?.signal,
                            proxy: axiosProxy,
                            onDownloadProgress: (e) => {
                                // 每片报告"本片起点 + 本片已下载"，取全局最大值保持单调
                                const optimistic = Math.max(totalBytes, baseBytes + (e.loaded || 0));
                                if (optimistic > sampledBytes) {
                                    sampledBytes = optimistic;
                                    downloadSpeed.sample(sampledBytes);
                                }
                            }
                        });
                    } catch (error) {
                        console.error('[Axios Error] TS分片请求失败\n' + formatAxiosError(error, `segment=${realIndex + 1}/${totalSegments}`));
                        throw error;
                    }

                    let data = Buffer.from(response.data);
                    if (segment.key?.method === 'AES-128') {
                        const key = await loadKey(segment.key.uri);
                        data = decryptAes128(data, key, segment.key.iv);
                    }

                    await fs.writeFile(tsPath, data);

                    totalBytes += data.length;
                    if (totalBytes > sampledBytes) {
                        sampledBytes = totalBytes;
                        downloadSpeed.sample(totalBytes);
                    }
                    downloadedCount++;
                    ffmpegList[realIndex] = `file '${tsFileName}'`;
                    reportProgress(false);
                }));
            }
        } finally {
            clearInterval(speedTimer);
        }
        reportProgress(true);

        const fileListPath = path.join(tempDir, 'list.txt');
        await fs.writeFile(fileListPath, ffmpegList.join('\n'));
        
        const ffmpegPromise = new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', 'list.txt',
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                outputPath
            ], { cwd: tempDir });
            let stderr = '';

            proc.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            proc.on('error', reject);
            proc.on('close', (code, signal) => {
                if (serverState.ffmpegCommand === proc) serverState.ffmpegCommand = null;
                if (code === 0) {
                    resolve();
                    return;
                }
                const reason = signal ? `signal=${signal}` : `code=${code}`;
                reject(new Error(`ffmpeg 合并失败 (${reason})\n${stderr}`));
            });

            serverState.ffmpegCommand = proc;
        });

        await ffmpegPromise;

    } finally {
        await fs.remove(tempDir).catch(() => {});
    }
}

module.exports = { downloadM3U8, isLocalMediaPath };
