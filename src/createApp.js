const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { PUBLIC_DIR, OUT_DIR, API_DEFAULT_RESOLUTION, RESOLUTION_PRESETS, getCompressionProfile, getOriginConfig } = require('./config');
const { createLogStore, installConsoleCapture } = require('./logStore');
const { createModLoader } = require('./modLoader');
const { createAuthService } = require('./auth');
const { createTaskManager } = require('./taskManager');
const { createMediaResolver } = require('./mediaResolver');
const { createTaskService } = require('./taskService');
const { splitTaskUrls, splitTaskFiles, sanitizeModName } = require('./utils/validation');
const createAuthRouter = require('./routes/auth');
const createUiRouter = require('./routes/ui');
const createTaskRouter = require('./routes/tasks');
const createLegacyRouter = require('./routes/legacy');

function createApp() {
    const app = express();
    app.disable('x-powered-by');

    const logStore = createLogStore();
    const restoreConsole = installConsoleCapture(logStore);
    const modLoader = createModLoader();
    const auth = createAuthService();
    const taskManager = createTaskManager(logStore);
    const mediaResolver = createMediaResolver({ serverState: taskManager.state, modLoader });
    const taskService = createTaskService({ taskManager, modLoader, logStore, mediaResolver });

    app.use((req, res, next) => {
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
        next();
    });
    app.use(express.json({ limit: '256kb' }));
    app.use(express.text({ type: '*/*', limit: '256kb' }));
    app.use(express.urlencoded({ extended: true, limit: '256kb' }));

    const publicAssets = new Set(['login.js', 'styles.css']);
    app.use('/ui', async (req, res, next) => {
        const base = path.basename(req.path || '');
        if (publicAssets.has(base)) return next();
        if (base.endsWith('.js')) return auth.requireUiAuth(req, res, next);
        next();
    }, express.static(PUBLIC_DIR));

    // Output files intentionally remain public for legacy clients and LAN use.
    app.use('/dl', express.static(OUT_DIR, {
        setHeaders(res) { res.setHeader('Cache-Control', 'private, no-store'); }
    }));

    app.use(createAuthRouter(auth));
    app.use(createUiRouter({ auth, taskManager, taskService, modLoader, logStore }));

    app.use('/api', createTaskRouter({
        requireUiAuth: auth.requireUiAuth,
        requireSameOrigin: auth.requireSameOrigin,
        processTask: taskService.processTask,
        processTaskQueue: taskService.processTaskQueue,
        killAndReset: taskManager.stopAndWait,
        forceCleanFiles: taskService.forceCleanFiles,
        taskManager,
        serverState: taskManager.state,
        videoTaskLock: taskManager.lock,
        mods: modLoader.mods,
        logStore,
        splitTaskUrls,
        splitTaskFiles,
        sanitizeModName,
        getCompressionProfile,
        getQueueStatusLine: taskManager.queueStatus,
        getVideoTaskLockStatusLine: taskManager.lockStatus,
        getDownloadEntries: taskService.getDownloadEntries,
        shortenText: taskManager.shortenText,
        RESOLUTION_PRESETS,
        API_DEFAULT_RESOLUTION,
        OUT_DIR,
        fs,
        path
    }));

    app.use(createLegacyRouter({
        requireBearerAuth: auth.requireBearerAuth,
        taskManager,
        taskService,
        modLoader,
        logStore,
        splitTaskUrls,
        splitTaskFiles,
        sanitizeModName,
        getOriginConfig,
        getCompressionProfile,
        RESOLUTION_PRESETS,
        API_DEFAULT_RESOLUTION,
        OUT_DIR,
        fs,
        path
    }));

    modLoader.load();
    return { app, taskManager, taskService, modLoader, logStore, restoreConsole };
}

module.exports = { createApp };
