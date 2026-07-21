const express = require('express');
const { getOriginConfig } = require('../config');

module.exports = function createUiRouter({ auth, taskManager, taskService, modLoader, logStore }) {
    const router = express.Router();
    const { requireUiAuth } = auth;
    const { state } = taskManager;

    // These compatibility resources intentionally remain public.
    router.get('/mod', (req, res) => res.json(['none', ...modLoader.mods.keys()]));
    router.get('/log', (req, res) => {
        const content = [
            '=== 系统状态 ===',
            `时间: ${new Date().toLocaleString()}`,
            `状态: ${state.isBusy ? '忙碌' : '空闲'}`,
            `任务: ${state.currentTask || '无'}`,
            `进度: ${state.progressStr || '无'}`,
            `锁: ${taskManager.lockStatus() || '无'}`,
            `队列: ${taskManager.queueStatus() || '无'}`,
            '\n=== 最近日志 ===',
            ...logStore.list()
        ].join('\n');
        res.type('text/plain; charset=utf-8').send(content);
    });
    router.get('/api/ui/bootstrap', requireUiAuth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            ...taskService.buildUiState(),
            origins: await getOriginConfig(),
            files: await taskService.getDownloadEntries()
        });
    });
    router.get('/config.json', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).type('text/plain; charset=utf-8').send('Not found');
    });
    router.get('/api/ui/state', requireUiAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(taskService.buildUiState());
    });
    router.get('/api/ui/files', requireUiAuth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await taskService.getDownloadEntries());
    });
    router.post('/api/ui/log/clear', requireUiAuth, auth.requireSameOrigin, (req, res) => {
        logStore.clear();
        res.status(204).end();
    });
    return router;
};
