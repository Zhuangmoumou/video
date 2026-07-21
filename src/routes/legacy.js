const express = require('express');

module.exports = function createLegacyRouter(deps) {
    const {
        requireBearerAuth, taskManager, taskService, modLoader, logStore,
        splitTaskUrls, splitTaskFiles, sanitizeModName, getCompressionProfile,
        RESOLUTION_PRESETS, API_DEFAULT_RESOLUTION, OUT_DIR, fs, path
    } = deps;
    const router = express.Router();
    const state = taskManager.state;
    const videoTaskLock = taskManager.lock;
    const mods = modLoader.mods;
    const getQueueStatusLine = taskManager.queueStatus;
    const getVideoTaskLockStatusLine = taskManager.lockStatus;
    const killAndReset = taskManager.stopAndWait;
    const { processTask, processTaskQueue, forceCleanFiles } = taskService;
router.post('/', requireBearerAuth, async (req, res) => {
    // 1. 安全获取 body，防止 undefined 导致崩溃
    const body = req.body || {};
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 2. 统一判断逻辑 (兼容字符串和对象)
    const isStr = typeof body === 'string';
    
    // 日志查询
    if (body === 'log' || body.log) {
        const queueStatus = getQueueStatusLine();
        const lockStatus = getVideoTaskLockStatusLine();
        const logContent = [
            `=== 系统状态 ===`,
            `时间: ${new Date().toLocaleString()}`,
            `状态: ${state.isBusy ? '忙碌' : '空闲'}`,
            `任务: ${state.currentTask || '无'}`,
            `进度: ${state.progressStr || '无'}`,
            `锁: ${lockStatus || '无'}`,
            `队列: ${queueStatus || '无'}`,
            `\n=== 最近日志 ===`,
            ...logStore.list()
        ].join('\n');
        await fs.writeFile(path.join(OUT_DIR, 'log.txt'), logContent);
        res.write(JSON.stringify({ "type": "log", "log": `https://${req.headers.host}/dl/log.txt` }) + '\n');
        res.end(); return;
    }

    // 列表查询
    if (body === 'ls' || body.ls) {
        const files = await fs.readdir(OUT_DIR);
        res.write(JSON.stringify({ "type": "ls", "ls": files }) + '\n');
        res.end(); return;
    }

    // 停止或清理
    if (body === 'rm' || body.rm || body === 'stop' || body.stop) {
        const queueStatus = getQueueStatusLine();
        const lockStatus = getVideoTaskLockStatusLine();
        const activeTaskLock = videoTaskLock.getState();
        const info = state.isBusy || activeTaskLock
            ? {
                code: state.currentCode || activeTaskLock?.code,
                task: state.currentTask,
                lock: lockStatus || undefined,
                queue: queueStatus || undefined
            }
            : "无任务";
        await killAndReset();
        if (body === 'rm' || body.rm) {
            const deleted = await forceCleanFiles();
            res.write(JSON.stringify({ "type": "rm", "stop": info, "del": deleted }) + '\n');
        } else {
            res.write(JSON.stringify({ "type": "stop", "stop": info }) + '\n');
        }
        res.end(); return;
    }

    // 中止指定任务
    if (body.del) {
        const delCode = Number(body.del);
        if (state.isBusy && state.currentCode === delCode) {
            await killAndReset();
            res.write(JSON.stringify({ type: "msg", content: `任务 ${delCode} 已中止` }) + '\n');
        } else if (state.isBusy && state.currentCode != delCode) {
            const queueStatus = getQueueStatusLine();
            const lockStatus = getVideoTaskLockStatusLine();
            const extraInfo = [
                state.currentTask ? `任务: ${state.currentTask}` : null,
                state.progressStr ? `进度: ${state.progressStr}` : null,
                lockStatus ? `锁: ${lockStatus}` : null,
                queueStatus ? queueStatus : null
            ].filter(Boolean).join('\n\n');

            const errorMsg = extraInfo
                ? `这不是你的任务：${state.currentCode}，无法终止\n\n${extraInfo}`
                : `这不是你的任务：${state.currentCode}，无法终止`;

            res.write(JSON.stringify({ type: "error", error: errorMsg }) + '\n');
        } else {
            res.write(JSON.stringify({ "type": "error",  error: "无任务运行" }) + '\n');
        }
        res.end(); return;
    }

    // 新建任务
    if (body.url && body.code) {
        const activeTaskLock = videoTaskLock.getState();
        if (state.isBusy || activeTaskLock) {
            const queueStatus = getQueueStatusLine();
            const lockStatus = getVideoTaskLockStatusLine();
            const busyCode = state.currentCode || activeTaskLock?.code;
            const extraInfo = [
                state.currentTask ? `任务: ${state.currentTask}` : null,
                state.progressStr ? `进度: ${state.progressStr}` : null,
                lockStatus ? `锁: ${lockStatus}` : null,
                queueStatus ? queueStatus : null
            ].filter(Boolean).join('\n\n');

            const errorMsg = extraInfo
                ? `忙碌中: ${busyCode}\n\n${extraInfo}`
                : `忙碌中: ${busyCode}`;

            res.write(JSON.stringify({
                "type": "error",
                "error": errorMsg
            }) + '\n');
            res.end(); return;
        }
        const taskUrls = splitTaskUrls(body.url);
        if (!taskUrls.length) {
            res.write(JSON.stringify({ type: "error", error: "url 字段不能为空" }) + '\n');
            res.end(); return;
        }
        const taskFiles = splitTaskFiles(body.file);
        // 可选 mod：插件文件名（不含 .js）；指定后 url 会原样传给插件 download()
        let modField = null;
        let compressionProfile = RESOLUTION_PRESETS[API_DEFAULT_RESOLUTION];
        const reportCompressionProfile = body.resolution != null && String(body.resolution).trim() !== '';
        try {
            modField = body.mod ? sanitizeModName(body.mod) : null;
            compressionProfile = getCompressionProfile(body.resolution, API_DEFAULT_RESOLUTION);
        } catch (e) {
            res.write(JSON.stringify({ type: "error", error: e.message || String(e) }) + '\n');
            res.end(); return;
        }
        if (modField && !mods.has(modField)) {
            res.write(JSON.stringify({
                type: "error",
                error: `未找到插件: ${modField}（已加载: ${[...mods.keys()].join(', ') || '无'}）`
            }) + '\n');
            res.end(); return;
        }

        const taskCode = Number(body.code);
        const taskLockToken = videoTaskLock.tryAcquire(taskCode);
        if (!taskLockToken) {
            const lockStatus = getVideoTaskLockStatusLine();
            res.write(JSON.stringify({
                type: "error",
                error: lockStatus ? `视频任务锁定中\n\n${lockStatus}` : "视频任务锁定中"
            }) + '\n');
            res.end(); return;
        }

        state.taskLockToken = taskLockToken;
        state.isBusy = true;
        state.currentCode = taskCode;
        res.setTimeout(0); // 禁用响应超时，避免长任务中断
        const runTask = async () => {
            try {
                if (taskUrls.length > 1) {
                    await processTaskQueue(taskUrls, taskFiles, taskCode, res, modField, {
                        compressionProfile,
                        reportCompressionProfile
                    });
                } else {
                    await processTask(taskUrls[0], taskFiles[0] || null, taskCode, res, modField, {
                        compressionProfile,
                        reportCompressionProfile
                    });
                }
            } catch (e) {
                console.error('[Task Runner Error]', e?.stack || e?.message || e);
            } finally {
                // taskManager releases the lock when the tracked task settles.
            }
        };
        taskManager.launch(taskLockToken, runTask).catch((error) => {
            console.error('[Legacy Task Runner Error]', error?.stack || error);
        });
        return;
    }

    res.write(JSON.stringify({ "type": "error", "error": "无效请求参数" }) + '\n');
    res.end();
});
    return router;
};
