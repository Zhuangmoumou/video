const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream/promises');
const { ROOT_DIR, OUT_DIR, API_DEFAULT_RESOLUTION, FRONTEND_DEFAULT_RESOLUTION, RESOLUTION_PRESETS, getUiResolutionOptions } = require('./config');
const { sanitizeModName, sanitizeTaskFileBase, resolveInsideDir, splitTaskFiles } = require('./utils/validation');
const { createProgressLimiter, createSpeedAverager } = require('./utils/progress');
const { isAbortError, throwIfAborted } = require('./utils/abort');
const { downloadM3U8 } = require('./download/m3u8');
const { downloadMp4WithRedirects, getAxiosProxyConfig, formatSpeed } = require('./download/mp4');
const { compressVideo, formatCutRange } = require('./videoProcessor');

const formatChinaTime = (date) => {
    const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    return [
        chinaTime.getUTCFullYear(),
        pad(chinaTime.getUTCMonth() + 1),
        pad(chinaTime.getUTCDate())
    ].join('-') + ' ' + [
        pad(chinaTime.getUTCHours()),
        pad(chinaTime.getUTCMinutes()),
        pad(chinaTime.getUTCSeconds())
    ].join(':');
};

function createTaskService({ taskManager, modLoader, logStore, mediaResolver }) {
    const state = taskManager.state;
    const { resolveByMod, resolveMediaByBrowser, buildBasicHeaders, isMgnacgUrl } = mediaResolver;
    const { mods } = modLoader;
    const getQueueStatusLine = taskManager.queueStatus;
    const getVideoTaskLockStatusLine = taskManager.lockStatus;
    const shortenText = taskManager.shortenText;

    const getQueueFileName = (files, index, total) => {
        const names = Array.isArray(files) ? files : splitTaskFiles(files);
        if (!names.length) return null;
        if (names.length > 1) return names[index] || null;
        const file = names[0];
        if (!file || total <= 1) return file || null;
        return `${file}_${index + 1}`;
    };
const formatBytes = (bytes) => {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '0 B';
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${Math.round(value)} B`;
};

const getDownloadEntries = async () => {
    const files = await fs.readdir(OUT_DIR).catch(() => []);
    const entries = await Promise.all(files.map(async (file) => {
        if (file === 'log.txt') return null;
        const filePath = path.join(OUT_DIR, file);
        try {
            const stat = await fs.stat(filePath);
            if (!stat.isFile()) return null;
            return {
                name: file,
                href: `/dl/${encodeURIComponent(file)}`,
                bytes: stat.size,
                sizeText: formatBytes(stat.size),
                modifiedAt: stat.mtime.toISOString(),
                modifiedAtText: formatChinaTime(stat.mtime)
            };
        } catch (e) {
            return null;
        }
    }));

    return entries
        .filter(Boolean)
        .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
};

const buildUiState = () => {
    const activeTaskLock = taskManager.lock.getState();
    return {
        busy: state.isBusy || Boolean(activeTaskLock),
        code: state.currentCode || activeTaskLock?.code || null,
        task: state.currentTask || null,
        progress: state.progressStr || null,
        queue: state.queue || null,
        lock: getVideoTaskLockStatusLine(),
        queueStatus: getQueueStatusLine(),
        logs: logStore.recent(18),
        mods: ['none', ...mods.keys()],
        resolutions: getUiResolutionOptions(),
        defaults: {
            apiResolution: API_DEFAULT_RESOLUTION,
            frontendResolution: FRONTEND_DEFAULT_RESOLUTION
        }
    };
};
const forceCleanFiles = async () => {
    const deletedFiles = [];
    try {
        const rootFiles = await fs.readdir(ROOT_DIR);
        for (const file of rootFiles) {
            const filePath = path.join(ROOT_DIR, file);
            if ((await fs.stat(filePath)).isFile()) { await fs.remove(filePath); deletedFiles.push(file); }
        }
        const outFiles = await fs.readdir(OUT_DIR);
        for (const file of outFiles) {
            const filePath = path.join(OUT_DIR, file);
            await fs.remove(filePath); deletedFiles.push(`out/${file}`);
        }
    } catch (e) {}
    return deletedFiles;
};
const processTask = async (urlFragment, file = null, code, res, modName = null, options = {}) => {
    const isHttpUrl = typeof urlFragment === 'string' && /^https?:\/\//i.test(urlFragment);
    const requestedMod = modName ? sanitizeModName(modName) : null;
    const useDefaultMgnacg = !requestedMod && (!isHttpUrl || isMgnacgUrl(urlFragment));
    const queueMode = Boolean(options.queueMode);
    const queueLabel = options.total > 1 ? ` [${options.index + 1}/${options.total}]` : '';
    const compressionProfile = options.compressionProfile || RESOLUTION_PRESETS[API_DEFAULT_RESOLUTION];

    // 默认 mgnacg 编号路径 / mgnacg 完整 URL / 显式插件 / 直接打开页面
    let fullUrl;
    if (isHttpUrl) {
        fullUrl = urlFragment;
    } else if (!requestedMod) {
        fullUrl = `https://www.mgnacg.com/bangumi/${urlFragment}`;
    } else {
        fullUrl = null; // 用户指定插件时，url 可能不是 http
    }

    let fileName;
    if (!file) {
        if (isHttpUrl) {
            try {
                const urlObj = new URL(urlFragment);
                const pathName = urlObj.pathname.split('/').pop() || 'video';
                fileName = `${code}_${pathName.replace(/[^a-z0-9]/gi, '_')}.mp4`;
            } catch (e) {
                fileName = `${code}_video.mp4`;
            }
        } else {
            const safe = String(urlFragment).replace(/[^a-z0-9._-]/gi, '_').replace(/\.\.+/g, '_');
            fileName = `${safe || code}.mp4`;
        }
    } else {
        fileName = `${sanitizeTaskFileBase(file)}.mp4`;
    }

    const downloadPath = resolveInsideDir(ROOT_DIR, fileName);
    const outPath = resolveInsideDir(OUT_DIR, fileName);
    state.res = res;
    if (options.attachResponseClose !== false) res.on('close', () => {
        if (state.res === res) {
            console.log(`[T ${code}] 客户端连接已断开，任务继续执行`);
            state.res = null; // 客户端断开后不再写入
        }
    });
    let logHistory = [];

    const updateStatus = (newLogMsg, dynamicStatus = "") => {
        if (newLogMsg) {
            logHistory.push(newLogMsg);
            console.log(`[T ${code}] ${newLogMsg}`);
        }
        if (dynamicStatus) {
            state.progressStr = dynamicStatus;
            console.log(`[进程] ${dynamicStatus}`);
        }
        if (state.res && !state.res.writableEnded && !state.res.destroyed) {
            const fullContent = logHistory.join('\n\n') + (dynamicStatus ? `\n\n ${dynamicStatus}` : '');
            state.res.write(JSON.stringify({ type: "msg", content: fullContent }) + '\n');
        }
    };

    try {
        updateStatus(`🚀 任务开始 (${code})${queueLabel}: ${urlFragment}`);
        if (requestedMod) {
            updateStatus(`🔌 任务指定插件: ${requestedMod}`);
        }

        let mediaUrl = null;
        let downloadHeaders = null;
        let refererUrl = fullUrl;
        let pageTitle = null;
        let cutRanges = [];

        // 1) 用户显式指定插件：只走插件，失败不回退浏览器
        if (requestedMod) {
            state.currentTask = `插件:${requestedMod}`;
            try {
                throwIfAborted(state.abortController?.signal);
                const resolved = await resolveByMod(requestedMod, urlFragment, updateStatus);
                mediaUrl = resolved.mediaUrl;
                refererUrl = resolved.refererUrl || refererUrl;
                pageTitle = resolved.pageTitle || pageTitle;
                cutRanges = resolved.cutRanges || [];
                downloadHeaders = buildBasicHeaders(refererUrl);
            } catch (e) {
                if (isAbortError(e) || state.abortController?.signal?.aborted) throw e;
                updateStatus(`❌ 插件 ${requestedMod} 解析失败: ${e.message || e}`);
                throw e;
            }
        } else if (useDefaultMgnacg) {
            // 2) 默认 mgnacg 任务：编号或 mgnacg.com URL 都优先插件，失败再浏览器
            state.currentTask = '插件:mgnacg';
            if (mods.has('mgnacg')) {
                try {
                    throwIfAborted(state.abortController?.signal);
                    updateStatus('🔌 mgnacg 任务优先使用插件快速解析');
                    const resolved = await resolveByMod('mgnacg', urlFragment, updateStatus);
                    mediaUrl = resolved.mediaUrl;
                    refererUrl = resolved.refererUrl || fullUrl;
                    pageTitle = resolved.pageTitle || pageTitle;
                    cutRanges = resolved.cutRanges || [];
                    downloadHeaders = buildBasicHeaders(refererUrl);
                } catch (e) {
                    if (isAbortError(e) || state.abortController?.signal?.aborted) throw e;
                    updateStatus(`⚠️ 插件 mgnacg 解析失败，回退浏览器抓取: ${e.message || e}`);
                    mediaUrl = null;
                }
            } else {
                updateStatus('⚠️ 未加载 mgnacg 插件，直接使用浏览器抓取');
            }

            if (!mediaUrl) {
                const browserResolved = await resolveMediaByBrowser(fullUrl, updateStatus);
                mediaUrl = browserResolved.mediaUrl;
                downloadHeaders = browserResolved.downloadHeaders;
                refererUrl = browserResolved.refererUrl || fullUrl;
                pageTitle = browserResolved.pageTitle || pageTitle;
            }
        } else {
            // 3) 其他 http 页面链接：浏览器抓取
            const browserResolved = await resolveMediaByBrowser(fullUrl, updateStatus);
            mediaUrl = browserResolved.mediaUrl;
            downloadHeaders = browserResolved.downloadHeaders;
            refererUrl = browserResolved.refererUrl || fullUrl;
            pageTitle = browserResolved.pageTitle || pageTitle;
        }

        if (!mediaUrl) {
            throw new Error("无法通过任何方式找到有效的视频链接。");
        }

        // 插件可返回本地改写后的 m3u8（绝对路径，如 /tmp/danzhu_xxx.m3u8）；其余仍要求 http(s)
        const isLocalM3u8 = (() => {
            const text = String(mediaUrl || '').trim();
            if (!text || /^https?:\/\//i.test(text)) return false;
            if (!path.isAbsolute(text)) return false;
            if (!text.toLowerCase().includes('.m3u8')) return false;
            return true;
        })();

        if (!/^https?:\/\//i.test(mediaUrl) && !isLocalM3u8) {
            throw new Error(`解析结果不是 http(s) 链接或本地 m3u8: ${String(mediaUrl).slice(0, 120)}`);
        }

        if (isLocalM3u8) {
            if (!await fs.pathExists(mediaUrl)) {
                throw new Error(`本地 m3u8 不存在: ${mediaUrl}`);
            }
            updateStatus(`📄 使用本地 m3u8: ${mediaUrl}`);
        }

        const headers = downloadHeaders || buildBasicHeaders(refererUrl);
        if (options.reportCompressionProfile || compressionProfile.id !== API_DEFAULT_RESOLUTION) {
            updateStatus(`🎚 输出规格: ${compressionProfile.label}`);
        }

        const isM3U8 = mediaUrl.toLowerCase().includes('.m3u8');
        state.currentTask = isM3U8 ? 'M3U8下载' : 'MP4下载';
        state.abortController ||= new AbortController();
        throwIfAborted(state.abortController.signal);

        if (isM3U8) {
            updateStatus(`📦 M3U8 模式...`);
            await downloadM3U8(
                mediaUrl,
                downloadPath,
                (p, s, seg, speed) => {
                    const speedText = speed ? ` ${speed}` : '';
                    updateStatus(null, `📥 下载: ${p}% (${s}) [分片:${seg}]${speedText}`);
                },
                state,
                refererUrl || fullUrl,
                headers
            );
        } else {
            const { response, finalUrl, hops } = await downloadMp4WithRedirects(
                mediaUrl,
                headers,
                state.abortController.signal,
                getAxiosProxyConfig()
            );
            if (hops.length) {
                updateStatus(`🔀 跟随重定向 ${hops.length} 次: ${finalUrl.substring(0, 80)}...`);
            }

            const total = parseInt(response.headers['content-length'] || '0', 10);
            const totalMB = (total / 1024 / 1024).toFixed(2);

            let curr = 0;
            const downloadSpeed = createSpeedAverager();
            downloadSpeed.sample(0);
            const shouldReportDownloadProgress = createProgressLimiter();
            response.data.on('data', (c) => {
                curr += c.length;
                const now = Date.now();
                downloadSpeed.sample(curr, now);
                const p = total ? Math.floor((curr / total) * 100) : 0;
                if (!shouldReportDownloadProgress({ percent: p })) return;

                const speed = downloadSpeed.getSpeed();
                const speedText = speed > 0 ? ` ${formatSpeed(speed)}` : '';
                const currMB = (curr / 1024 / 1024).toFixed(2);
                updateStatus(null, `📥 下载: ${p}% (${currMB}/${totalMB}MB)${speedText}`);
            });

            await pipeline(response.data, fs.createWriteStream(downloadPath));
        }

        state.currentTask = 'FFmpeg压缩';
        if (cutRanges.length) {
            updateStatus(`✂️ 压缩时删除片段: ${cutRanges.map(formatCutRange).join(', ')}`);
        }
        updateStatus(null, `📦 压缩中...`);
        await compressVideo(downloadPath, outPath, cutRanges, compressionProfile, state, updateStatus);

        if (pageTitle) {
            updateStatus(`✅ 任务完成: ${pageTitle}\n\n`);
        } else {
            updateStatus("✅ 任务完成\n\n");
        }
        if (!res.writableEnded && !res.destroyed) {
            const payload = {
                type: "url",
                url: `https://${res.req.headers.host}/dl/${fileName}`
            };
            if (pageTitle) payload.title = pageTitle;
            res.write(JSON.stringify(payload) + '\n');
        }
    } catch (error) {
        const taskWasStopped = Boolean(state.abortController?.signal.aborted) || isAbortError(error);
        if (taskWasStopped) {
            console.log(`[T ${code}] 任务已停止`);
            return false;
        }
        if (res && !res.writableEnded && !res.destroyed) {
            res.write(JSON.stringify({ type: "error", error: error.toString() }) + '\n');
        }
        console.error('[Task Error]', error?.stack || error?.message || error);
        return false;
    } finally {
        if (queueMode) {
            await taskManager.releaseResources();
        } else {
            await taskManager.reset();
        }
    }
    return true;
};

const processTaskQueue = async (urls, file = null, code, res, modName = null, options = {}) => {
    const total = urls.length;
    state.queue = { items: urls, currentIndex: 0 };
    state.res = res;
    res.on('close', () => {
        if (state.res === res) {
            console.log(`[T ${code}] 客户端连接已断开，队列继续执行`);
            state.res = null;
        }
    });

    const writeQueueMessage = (content) => {
        console.log(`[T ${code}] ${content}`);
        if (state.res && !state.res.writableEnded && !state.res.destroyed) {
            state.res.write(JSON.stringify({ type: "msg", content }) + '\n');
        }
    };

    writeQueueMessage(`📋 队列已创建: ${total} 个任务\n${urls.map((url, i) => `${i + 1}. ${url}`).join('\n')}`);

    try {
        for (let i = 0; i < total; i++) {
            if (!state.isBusy || state.currentCode !== code) break;

            state.queue.currentIndex = i;
            state.currentTask = `队列 ${i + 1}/${total}`;
            state.progressStr = `等待执行: ${shortenText(urls[i])}`;
            writeQueueMessage(`📋 队列进度 ${i + 1}/${total}，开始执行: ${urls[i]}`);

            await processTask(
                urls[i],
                getQueueFileName(file, i, total),
                code,
                res,
                modName,
                {
                    ...options,
                    queueMode: true,
                    index: i,
                    total,
                    attachResponseClose: false
                }
            );
        }

        if (state.isBusy && state.currentCode === code) {
            writeQueueMessage(`✅ 队列完成: ${total} 个任务已处理`);
        }
    } finally {
        if (state.currentCode === code) {
            await taskManager.reset();
        }
    }
};
    return { processTask, processTaskQueue, forceCleanFiles, getDownloadEntries, buildUiState };
}

module.exports = { createTaskService, formatChinaTime };
