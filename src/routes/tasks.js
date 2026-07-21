/**
 * apiRouter.js — 带鉴权的 /api/task/* 端点
 *
 * 前端 console.js 通过此路由器间接操作下载任务，不再直接暴露 POST / 的协议。
 * POST / 保持为独立兼容协议，供旧客户端和简单 API 对接使用。
 */

const express = require('express');

/**
 * @param {Object} deps 从 app.js 注入的依赖
 * @returns {express.Router}
 */
module.exports = function createApiRouter(deps) {
    const {
        // ── 中间件 ──
        requireUiAuth,
        requireSameOrigin,

        // ── 核心任务函数 ──
        processTask,
        processTaskQueue,
        killAndReset,
        forceCleanFiles,
        taskManager,

        // ── 共享状态（对象/Map/数组 引用传递） ──
        serverState,
        videoTaskLock,
        mods,
        logStore,

        // ── 辅助函数 ──
        splitTaskUrls,
        splitTaskFiles,
        sanitizeModName,
        getCompressionProfile,
        getQueueStatusLine,
        getVideoTaskLockStatusLine,
        getDownloadEntries,
        shortenText,

        // ── 常量 ──
        RESOLUTION_PRESETS,
        API_DEFAULT_RESOLUTION,
        OUT_DIR,

        // ── 模块 ──
        fs,
        path
    } = deps;

    const router = express.Router();

    // ──────────────────────────────────────────────
    // 所有 /api/task/* 路由统一鉴权
    // ──────────────────────────────────────────────

    router.use(requireUiAuth);

    router.use(requireSameOrigin);

    // ──────────────────────────────────────────────
    // POST /api/task — 提交下载任务（流式 JSON lines）
    // ──────────────────────────────────────────────
    router.post('/task', async (req, res) => {
        const body = req.body || {};

        // 设置流式响应头（与 POST / 一致）
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // ── 参数校验 ──
        if (!body.url || !body.code) {
            res.write(JSON.stringify({ type: 'error', error: '缺少必需参数 url 或 code' }) + '\n');
            res.end();
            return;
        }

        const activeTaskLock = videoTaskLock.getState();
        if (serverState.isBusy || activeTaskLock) {
            const queueStatus = getQueueStatusLine();
            const lockStatus = getVideoTaskLockStatusLine();
            const busyCode = serverState.currentCode || activeTaskLock?.code;
            const extraInfo = [
                serverState.currentTask ? `任务: ${serverState.currentTask}` : null,
                serverState.progressStr ? `进度: ${serverState.progressStr}` : null,
                lockStatus ? `锁: ${lockStatus}` : null,
                queueStatus || null
            ].filter(Boolean).join('\n\n');

            const errorMsg = extraInfo
                ? `忙碌中: ${busyCode}\n\n${extraInfo}`
                : `忙碌中: ${busyCode}`;

            res.write(JSON.stringify({ type: 'error', error: errorMsg }) + '\n');
            res.end();
            return;
        }

        const taskUrls = splitTaskUrls(body.url);
        if (!taskUrls.length) {
            res.write(JSON.stringify({ type: 'error', error: 'url 字段不能为空' }) + '\n');
            res.end();
            return;
        }

        // ── 解析 file / mod / resolution ──
        let taskFiles = [];
        let modField = null;
        let compressionProfile = RESOLUTION_PRESETS[API_DEFAULT_RESOLUTION];
        try {
            taskFiles = splitTaskFiles(body.file);
            modField = body.mod ? sanitizeModName(body.mod) : null;
            compressionProfile = getCompressionProfile(body.resolution, API_DEFAULT_RESOLUTION);
        } catch (e) {
            res.write(JSON.stringify({ type: 'error', error: e.message || String(e) }) + '\n');
            res.end();
            return;
        }

        if (modField && !mods.has(modField)) {
            res.write(JSON.stringify({
                type: 'error',
                error: `未找到插件: ${modField}（已加载: ${[...mods.keys()].join(', ') || '无'}）`
            }) + '\n');
            res.end();
            return;
        }

        // ── 获取任务锁 ──
        const taskCode = Number(body.code);
        const taskLockToken = videoTaskLock.tryAcquire(taskCode);
        if (!taskLockToken) {
            const lockStatus = getVideoTaskLockStatusLine();
            res.write(JSON.stringify({
                type: 'error',
                error: lockStatus ? `视频任务锁定中\n\n${lockStatus}` : '视频任务锁定中'
            }) + '\n');
            res.end();
            return;
        }

        // ── 设置全局状态 ──
        serverState.taskLockToken = taskLockToken;
        serverState.isBusy = true;
        serverState.currentCode = taskCode;
        res.setTimeout(0); // 禁用超时（长任务）

        const reportCompressionProfile = body.resolution != null && String(body.resolution).trim() !== '';

        // ── 执行任务 ──
        const runTask = async () => {
            try {
                const options = {
                    compressionProfile,
                    reportCompressionProfile
                };

                if (taskUrls.length > 1) {
                    await processTaskQueue(taskUrls, taskFiles, taskCode, res, modField, options);
                } else {
                    await processTask(taskUrls[0], taskFiles[0] || null, taskCode, res, modField, options);
                }
            } catch (e) {
                console.error('[ApiRouter Task Error]', e?.stack || e?.message || e);
            } finally {
                // taskManager owns lock release after the complete task promise settles.
            }
        };
        taskManager.launch(taskLockToken, runTask).catch((error) => {
            console.error('[ApiRouter Task Runner Error]', error?.stack || error);
        });
    });

    // ──────────────────────────────────────────────
    // POST /api/task/stop — 停止当前任务
    // ──────────────────────────────────────────────
    router.post('/task/stop', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const queueStatus = getQueueStatusLine();
        const lockStatus = getVideoTaskLockStatusLine();
        const activeTaskLock = videoTaskLock.getState();
        const info = serverState.isBusy || activeTaskLock
            ? {
                code: serverState.currentCode || activeTaskLock?.code,
                task: serverState.currentTask,
                lock: lockStatus || undefined,
                queue: queueStatus || undefined
            }
            : '无任务';

        await killAndReset();
        res.json({ type: 'stop', stop: info });
    });

    // ──────────────────────────────────────────────
    // POST /api/task/clean — 停止任务并清理所有文件
    // ──────────────────────────────────────────────
    router.post('/task/clean', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const queueStatus = getQueueStatusLine();
        const lockStatus = getVideoTaskLockStatusLine();
        const activeTaskLock = videoTaskLock.getState();
        const info = serverState.isBusy || activeTaskLock
            ? {
                code: serverState.currentCode || activeTaskLock?.code,
                task: serverState.currentTask,
                lock: lockStatus || undefined,
                queue: queueStatus || undefined
            }
            : '无任务';

        await killAndReset();
        const deleted = await forceCleanFiles();
        res.json({ type: 'rm', stop: info, del: deleted });
    });

    // ──────────────────────────────────────────────
    // GET /api/task/log — 导出日志文件
    // ──────────────────────────────────────────────
    router.get('/task/log', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const queueStatus = getQueueStatusLine();
        const lockStatus = getVideoTaskLockStatusLine();
        const logContent = [
            '=== 系统状态 ===',
            `时间: ${new Date().toLocaleString()}`,
            `状态: ${serverState.isBusy ? '忙碌' : '空闲'}`,
            `任务: ${serverState.currentTask || '无'}`,
            `进度: ${serverState.progressStr || '无'}`,
            `锁: ${lockStatus || '无'}`,
            `队列: ${queueStatus || '无'}`,
            '\n=== 最近日志 ===',
            ...logStore.list()
        ].join('\n');

        await fs.writeFile(path.join(OUT_DIR, 'log.txt'), logContent);
        res.json({ type: 'log', log: `https://${req.headers.host}/dl/log.txt` });
    });

    return router;
};
