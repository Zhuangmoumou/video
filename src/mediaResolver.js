const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { normalizeModResult } = require('./modLoader');
const { parseSafeObjectLiteral } = require('./utils/objectLiteral');
const { DEFAULT_UA, getPlaywrightProxyConfig } = require('./download/mp4');
chromium.use(StealthPlugin());

function createMediaResolver({ serverState, modLoader }) {
const isMgnacgUrl = (value) => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === 'mgnacg.com' || host.endsWith('.mgnacg.com');
    } catch (e) {
        return false;
    }
};
const buildBasicHeaders = (refererUrl) => {
    const headers = {
        'User-Agent': DEFAULT_UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    if (refererUrl && /^https?:\/\//i.test(refererUrl)) {
        headers.Referer = refererUrl;
        try { headers.Origin = new URL(refererUrl).origin; } catch (e) {}
    }
    return headers;
};

const resolveByMod = async (modName, input, updateStatus) => {
    const mod = modLoader.get(modName);
    updateStatus(`🔌 使用插件解析: ${mod.name}`);
    updateStatus(null, `🔌 插件 ${mod.name} 解析中...`);
    console.log(`[Mod] 调用 ${mod.name}.download(${JSON.stringify(String(input).slice(0, 120))})`);
    const raw = await mod.download(input, { meta: true });
    const parsed = normalizeModResult(raw);
    if (parsed.pageTitle) {
        updateStatus(`📄 页面标题: ${parsed.pageTitle}`);
    }
    updateStatus(`🔌 插件 ${mod.name} 解析成功: ${parsed.mediaUrl.substring(0, 80)}...`);
    return parsed;
};
const buildDownloadHeaders = async (context, refererUrl, mediaUrl) => {
    let cookieHeader = '';
    try {
        const urls = [refererUrl, mediaUrl].filter(Boolean);
        const cookies = await context.cookies(urls);
        cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch (e) {}

    const headers = {
        'User-Agent': DEFAULT_UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': refererUrl,
        'Origin': new URL(refererUrl).origin
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
};
const isMediaResponse = (response) => {
    const url = response.url();
    const contentType = (response.headers()['content-type'] || '').toLowerCase();
    const resourceType = response.request().resourceType();
    const pathOnly = url.split('?')[0];
    return (
        resourceType === 'media' ||
        pathOnly.endsWith('.m3u8') ||
        pathOnly.endsWith('.mp4') ||
        contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('mpegurl') ||
        contentType.includes('video/mp4') ||
        contentType.includes('media')
    );
};

const resolveMediaByBrowser = async (fullUrl, updateStatus) => {
    serverState.currentTask = '浏览器解析';
    updateStatus(null, "🌏 等待浏览器启动");
    const taskSignal = serverState.abortController?.signal;
    if (taskSignal?.aborted) throw new Error('任务被中止');

    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars'
        ]
    };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    const browserProxy = getPlaywrightProxyConfig();
    if (browserProxy) {
        launchOptions.proxy = browserProxy;
        updateStatus(null, '🛡 已启用下载代理，浏览器和下载使用同一出口IP');
    }

    const browser = await chromium.launch(launchOptions);
    if (taskSignal?.aborted) {
        await browser.close().catch(() => {});
        throw new Error('任务被中止');
    }
    serverState.browser = browser;

    let mediaUrl = null;
    let downloadHeaders = null;
    let pageTitle = '未知标题';

    try {
        const UA = DEFAULT_UA;

        const context = await browser.newContext({
            userAgent: UA,
            viewport: { width: 1366, height: 768 },
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            deviceScaleFactor: 1,
            hasTouch: false,
            javaScriptEnabled: true,
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = window.chrome || { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        const page = await context.newPage();

        updateStatus(`🔗 打开页面: ${fullUrl}`);
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2500);

        pageTitle = await page.title().catch(() => '未知标题');
        updateStatus(`📄 页面标题: ${pageTitle}`);

        // 1) 先快速 HTML 解析；只有失败后才启动网络嗅探
        updateStatus('尝试直接解析HTML以快速获取链接...');
        let objectString = null;
        try {
            const htmlContent = await page.content();
            const regex = new RegExp("var player_aaaa\\s*=\\s*({[\\s\\S]*?})\\s*<\\/script>");
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                objectString = match[1];
                const playerData = parseSafeObjectLiteral(objectString);
                const url = playerData.url;

                if (url && url.startsWith('http') && (url.includes('.m3u8') || url.includes('.mp4'))) {
                    mediaUrl = url;
                    updateStatus(`🎯 快速命中: ${url.substring(0, 50)}...`);
                } else {
                    updateStatus('❕ 解析成功，但URL格式无效，继续等待网络嗅探。');
                }
            } else {
                updateStatus(null, '❕ 页面中未找到player_aaaa对象，继续等待网络嗅探。');
            }
        } catch (e) {
            let diagnosticMessage = `❕ 直接解析时出错: ${e.name}: ${e.message}`;
            if (objectString) {
                diagnosticMessage += `\n\n[调试信息] 解析失败片段(前200字符):\n${objectString.substring(0, 200)}`;
            } else {
                diagnosticMessage += `\n\n[调试信息] 正则未匹配到player_aaaa对象。`;
            }
            diagnosticMessage += "\n\n将继续网络监听。";
            updateStatus(diagnosticMessage);
        }

        // 2) 快速解析失败后，才挂监听并刷新页面以捕获媒体请求
        //    （首轮未监听，媒体可能已发出，所以必须 reload 再嗅探）
        if (!mediaUrl) {
            updateStatus('📡 快速命中失败，启动网络嗅探...');
            let foundBySniff = false;
            let resolveSniff = null;
            const findMediaPromise = new Promise((resolve) => {
                resolveSniff = resolve;
            });
            const onResponse = (response) => {
                if (foundBySniff) return;
                if (!isMediaResponse(response)) return;
                foundBySniff = true;
                const url = response.url();
                updateStatus(`🎯 嗅探命中: ${url.substring(0, 50)}...`);
                if (resolveSniff) resolveSniff(url);
            };
            page.on('response', onResponse);

            try {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
                const reloadedTitle = await page.title().catch(() => pageTitle);
                if (reloadedTitle) {
                    pageTitle = reloadedTitle;
                    updateStatus(`📄 页面标题: ${pageTitle}`);
                }

                // 轻触播放器，尽量触发媒体请求
                await page.evaluate(() => {
                    const video = document.querySelector('video');
                    if (video) {
                        try { video.muted = true; video.play().catch(() => {}); } catch (e) {}
                    }
                    const playBtn = document.querySelector('.dplayer-play-icon, .vjs-big-play-button, .plyr__control--overlaid, button[aria-label*="播放"], .play');
                    if (playBtn) {
                        try { playBtn.click(); } catch (e) {}
                    }
                }).catch(() => {});

                mediaUrl = await Promise.race([
                    findMediaPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('嗅探超时')), 30000))
                ]);
            } finally {
                page.off('response', onResponse);
            }
        }

        downloadHeaders = await buildDownloadHeaders(context, fullUrl, mediaUrl);
        updateStatus(`🧩 下载指纹已同步: ${downloadHeaders.Cookie ? '含Cookie' : '无Cookie'}`);
        return { mediaUrl, downloadHeaders, refererUrl: fullUrl, pageTitle };
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
        serverState.browser = null;
    }
};
    return { resolveByMod, resolveMediaByBrowser, buildBasicHeaders, isMgnacgUrl };
}

module.exports = { createMediaResolver };
