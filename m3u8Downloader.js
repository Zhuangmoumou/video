const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

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

function applyProxy(originalUrl) {
    // 两个代理都允许为空：都为空则直连。
    // DOWNLOAD_PROXY 是真正 HTTP 代理，优先级最高；设置后不再使用 PROXY_DOMAIN 改写 URL，避免双代理冲突。
    if (getDownloadProxy() || !proxyDomain || !originalUrl) {
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

const PROGRESS_DEBOUNCE_MS = 5000;

function formatSpeed(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0B/s';
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)}MB/s`;
    if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)}KB/s`;
    return `${Math.round(bytesPerSec)}B/s`;
}

/**
 * M3U8 下载模块
 * (其余代码保持不变)
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

        const tsLines = content.split('\n').filter(line => line && !line.startsWith('#'));
        const tsUrls = tsLines.map(line => applyProxy(new URL(line, currentUrl).href));
        const totalSegments = tsUrls.length;
        if (totalSegments === 0) throw new Error("未找到有效的 TS 分片");

        let downloadedCount = 0;
        let totalBytes = 0;
        let lastBytes = 0;
        let lastSpeedTime = Date.now();
        let lastUpdateTime = 0;
        const CONCURRENCY = 8; 
        const ffmpegList = [];

        const reportProgress = (force = false) => {
            const now = Date.now();
            if (!force && now - lastUpdateTime < PROGRESS_DEBOUNCE_MS) return;

            const elapsed = Math.max(now - lastSpeedTime, 1);
            const speed = formatSpeed((totalBytes - lastBytes) * 1000 / elapsed);
            lastBytes = totalBytes;
            lastSpeedTime = now;
            lastUpdateTime = now;

            const percent = Math.floor((downloadedCount / totalSegments) * 100);
            const currMB = (totalBytes / 1024 / 1024).toFixed(2);
            const segProgress = `${downloadedCount}/${totalSegments}`;
            onProgress(percent, `${currMB}MB`, segProgress, speed);
        };

        for (let i = 0; i < tsUrls.length; i += CONCURRENCY) {
            if (serverState.abortController?.signal.aborted) throw new Error("任务被中止");
            
            const chunk = tsUrls.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (url, index) => {
                const realIndex = i + index;
                const tsFileName = `seg_${String(realIndex).padStart(5, '0')}.ts`;
                const tsPath = path.join(tempDir, tsFileName);
                
                let response;
                try {
                    response = await axios({
                        url,
                        responseType: 'arraybuffer',
                        headers,
                        timeout: 30000,
                        signal: serverState.abortController?.signal,
                        proxy: axiosProxy
                    });
                } catch (error) {
                    console.error('[Axios Error] TS分片请求失败\n' + formatAxiosError(error, `segment=${realIndex + 1}/${totalSegments}`));
                    throw error;
                }
                await fs.writeFile(tsPath, response.data);
                
                totalBytes += response.data.length;
                downloadedCount++;
                ffmpegList[realIndex] = `file '${tsFileName}'`;
                reportProgress(false);
            }));
        }
        reportProgress(true);

        const fileListPath = path.join(tempDir, 'list.txt');
        await fs.writeFile(fileListPath, ffmpegList.join('\n'));
        
        const ffmpegPromise = new Promise((resolve, reject) => {
            const cmd = `ffmpeg -y -f concat -safe 0 -i "list.txt" -c copy -bsf:a aac_adtstoasc "${outputPath}"`;
            const proc = exec(cmd, { cwd: tempDir }, (err, stdout, stderr) => {
                if (err) {
                    err.message += `\n${stderr}`;
                    reject(err);
                } else {
                    resolve();
                }
            });
            serverState.ffmpegCommand = proc; 
        });

        await ffmpegPromise;

    } finally {
        await fs.remove(tempDir).catch(() => {});
    }
}

module.exports = { downloadM3U8 };
