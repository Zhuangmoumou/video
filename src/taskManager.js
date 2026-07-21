function shortenText(value, max = 80) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function createTaskManager(logStore) {
    const state = {
        isBusy: false,
        currentCode: null,
        currentTask: null,
        progressStr: null,
        queue: null,
        abortController: null,
        ffmpegCommand: null,
        browser: null,
        res: null
    };
    let owner = null;
    let activePromise = null;

    const lock = {
        tryAcquire(code) {
            if (owner) return null;
            owner = { code, startedAt: Date.now(), abortController: new AbortController() };
            return owner;
        },
        release(token) { if (owner === token) owner = null; },
        getState: () => owner
    };

    function lockStatus() {
        if (!owner) return null;
        const elapsedSec = Math.max(0, Math.floor((Date.now() - owner.startedAt) / 1000));
        return `视频任务锁: ${owner.code}，已持有 ${elapsedSec}s`;
    }

    function queueStatus() {
        const queue = state.queue;
        if (!queue || !Array.isArray(queue.items) || queue.items.length <= 1) return null;
        const current = Math.min(queue.currentIndex + 1, queue.items.length);
        const remaining = Math.max(queue.items.length - current, 0);
        return `队列: ${current}/${queue.items.length}，剩余 ${remaining}，当前: ${shortenText(queue.items[queue.currentIndex])}`;
    }

    async function releaseResources({ preserveAbort = false } = {}) {
        const browser = state.browser;
        const controller = state.abortController;
        const ffmpegCommand = state.ffmpegCommand;
        state.browser = null;
        if (!preserveAbort) state.abortController = null;
        state.ffmpegCommand = null;
        if (controller) { try { controller.abort(); } catch (_) {} }
        if (ffmpegCommand) {
            try { if (typeof ffmpegCommand.kill === 'function') ffmpegCommand.kill('SIGKILL'); } catch (_) {}
        }
        if (browser) { try { await browser.close(); } catch (_) {} }
        logStore.clearProgress();
        state.currentTask = null;
        state.progressStr = null;
    }

    async function reset() {
        await releaseResources();
        state.isBusy = false;
        state.currentCode = null;
        state.queue = null;
        const response = state.res;
        state.res = null;
        if (response && !response.writableEnded && !response.destroyed) response.end();
    }

    function launch(token, runner) {
        state.isBusy = true;
        state.currentCode = token.code;
        state.abortController = token.abortController;
        let tracked;
        tracked = Promise.resolve()
            .then(runner)
            .finally(async () => {
                await reset();
                lock.release(token);
                if (activePromise === tracked) activePromise = null;
            });
        activePromise = tracked;
        return tracked;
    }

    async function stopAndWait() {
        const running = activePromise;
        state.isBusy = false;
        state.currentCode = null;
        state.queue = null;
        const response = state.res;
        state.res = null;
        if (response && !response.writableEnded && !response.destroyed) response.end();
        await releaseResources({ preserveAbort: true });
        if (running) await running.catch(() => {});
        await reset();
    }

    return {
        state, lock, lockStatus, queueStatus, releaseResources, reset, launch, stopAndWait,
        getActivePromise: () => activePromise,
        shortenText
    };
}

module.exports = { createTaskManager, shortenText };
