const express = require('express');
const { getOriginConfig } = require('../config');
const { sanitizeModName } = require('../utils/validation');

module.exports = function createUiRouter({ auth, taskManager, taskService, modLoader, logStore }) {
    const router = express.Router();
    const { requireUiAuth } = auth;
    const { state } = taskManager;

    // These compatibility resources intentionally remain public.
    router.get('/mod', (req, res) => res.json(['none', ...modLoader.mods.keys()]));
    router.post('/mod', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const action = String(body.action || body.operation || 'search').trim().toLowerCase();
        const provider = String(body.mod ?? body.provider ?? body.source ?? body.engine ?? '').trim();
        const controller = new AbortController();
        let providerFailuresLogged = false;
        const timeout = setTimeout(() => controller.abort(new Error('搜索请求超时')), 120000);
        const onClose = () => {
            if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
        };
        req.on('aborted', onClose);
        res.on('close', onClose);

        try {
            if (action === 'search') {
                const keyword = [body.keyword, body.query, body.q, body.wd, body.search, body.url]
                    .find((value) => typeof value === 'string' && value.trim())?.trim();
                if (!keyword) return res.status(400).json({ error: '缺少搜索关键词（keyword/query/q/wd）' });
                if (keyword.length > 100) return res.status(400).json({ error: '搜索关键词不能超过 100 个字符' });

                const rawLimit = body.limit == null ? 20 : Number(body.limit);
                if (!Number.isInteger(rawLimit) || rawLimit < 1) {
                    return res.status(400).json({ error: 'limit 必须是正整数' });
                }
                const limit = Math.min(rawLimit, 50);
                const providers = provider
                    ? [modLoader.getSearch(sanitizeModName(provider))]
                    : [...modLoader.searchMods.values()];
                if (!providers.length) return res.status(503).json({ error: '当前没有可用的搜索能力' });

                const settled = await Promise.allSettled(providers.map(async (mod) => {
                    const results = await mod.search(keyword, { limit, signal: controller.signal });
                    if (!Array.isArray(results)) throw new Error(`${mod.name} 搜索结果必须是数组`);
                    return results.map((result) => ({ ...result, mod: mod.name }));
                }));
                const results = [];
                const errors = [];
                settled.forEach((result, index) => {
                    if (result.status === 'fulfilled') results.push(...result.value);
                    else {
                        const reason = result.reason;
                        const message = reason?.message || String(reason);
                        errors.push(`${providers[index].name}: ${message}`);
                        console.error(`[Mod API] action=search provider=${providers[index].name} failed:`, reason?.stack || message);
                        providerFailuresLogged = true;
                    }
                });
                if (!results.length && errors.length) throw new Error(errors.join('; '));
                return res.json(results);
            }

            if (action === 'episodes' || action === 'episode-list' || action === 'list-episodes') {
                const provider = String(body.mod ?? body.provider ?? body.source ?? body.engine ?? '').trim();
                if (!provider) return res.status(400).json({ error: '解析分集时必须提供 mod（mgnacg 或 sorani）' });
                const mod = modLoader.getSearch(sanitizeModName(provider));
                if (typeof mod.episodes !== 'function') {
                    return res.status(501).json({ error: `插件 ${mod.name} 未提供分集编号解析能力` });
                }
                const input = body.series ?? body.id ?? body.seriesId ?? body.videoId ?? body.url;
                if (input == null || input === '') return res.status(400).json({ error: '缺少作品编号或作品 URL' });
                const maxEpisodes = body.maxEpisodes == null ? 300 : Number(body.maxEpisodes);
                if (!Number.isInteger(maxEpisodes) || maxEpisodes < 1 || maxEpisodes > 500) {
                    return res.status(400).json({ error: 'maxEpisodes 必须是 1 到 500 之间的整数' });
                }
                return res.json(await mod.episodes(input, { signal: controller.signal, maxEpisodes }));
            }

            return res.status(400).json({ error: 'action 仅支持 search 或 episodes' });
        } catch (error) {
            const status = controller.signal.aborted
                ? 504
                : /非法 mod 名称|未找到搜索插件/.test(error?.message || '')
                    ? 404
                    : /关键词|limit|编号|输入|URL/.test(error?.message || '')
                        ? 400
                        : 502;
            const clientDisconnected = controller.signal.reason?.message === '客户端已断开';
            if (status >= 500 && !clientDisconnected && !providerFailuresLogged) {
                const providerLabel = provider ? ` provider=${provider}` : '';
                console.error(`[Mod API] action=${action}${providerLabel} failed:`, error?.stack || error?.message || error);
            }
            if (res.destroyed || res.writableEnded) return;
            return res.status(status).json({ error: error?.message || String(error) });
        } finally {
            clearTimeout(timeout);
            req.removeListener('aborted', onClose);
            res.removeListener('close', onClose);
        }
    });
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
