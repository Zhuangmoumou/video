/**
 * mgnacg.com 视频直链解析
 *
 * 路径格式: {vodId}-{sid}-{nid}
 *   sid 线路:
 *     2 -> 云端线路   (from=2_  -> cloudplay/?url=)
 *     3 -> 船新线路   (from=5_  -> cloudplay/yp2.php?url=)
 *     5 -> Mahoo      (from=6_  -> cloudplay/yp3.php?url=)
 *     4 -> 存储线路   (from=4_  -> cloudplay/ccxl.php?url=)
 *     1 -> 本地线路(已下线)
 *   nid: 集数
 *
 * 用法:
 *   const { download } = require('./mod/mgnacg');
 *   const url = await download('1619-3-2');
 */

const crypto = require('crypto');
const axios = require('axios');
const { parseSafeObjectLiteral } = require('../src/utils/objectLiteral');

const SITE = 'https://mgnacg.com';
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 线路 sid -> 说明（与站点选集中间数字一致） */
const SID_LINE = {
    '1': { name: '本地线路（已下线）', from: '1_' },
    '2': { name: '云端线路', from: '2_' },
    '3': { name: '船新线路', from: '5_' },
    '4': { name: '存储线路', from: '4_' },
    '5': { name: 'Mahoo', from: '6_' },
};

/**
 * player from 代码 -> 解析接口
 * 与 /static/js/playerconfig.js 保持一致
 */
const FROM_PARSE = {
    '2_': 'https://play.mknacg.top:8585/cloudplay/?url=',
    '5_': 'https://play.mknacg.top:8585/cloudplay/yp2.php?url=',
    '6_': 'https://play.mknacg.top:8585/cloudplay/yp3.php?url=',
    '4_': 'https://play.mknacg.top:8585/cloudplay/ccxl.php?url=',
    '3_': 'https://play.mknacg.top:8585/muiplayer/?url=',
    '1_': null, // 本地已下线
};

const AES_SALT = 'Mknacg123321';

const http = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    validateStatus: (s) => s >= 200 && s < 400,
});

function normalizeEpisodeId(input) {
    if (input == null) throw new Error('episode id 不能为空');
    let id = String(input).trim();
    // 允许传入完整路径/URL
    id = id.replace(/^https?:\/\/[^/]+/i, '');
    id = id.replace(/^\/?(bangumi\/)?/i, '');
    id = id.replace(/\/+$/, '');
    if (!/^\d+-\d+-\d+$/.test(id)) {
        throw new Error(`非法 episode id: ${input}，期望形如 1619-3-2`);
    }
    return id;
}

function parseEpisodeId(id) {
    const [vodId, sid, nid] = id.split('-');
    return { vodId, sid, nid, line: SID_LINE[sid] || null };
}

/**
 * 从播放页 HTML 提取 player_aaaa
 */
function extractPlayerAaaa(html) {
    const m = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?})\s*;?\s*<\/script>/i);
    if (!m) throw new Error('页面中未找到 player_aaaa，可能被拦截或页面结构变更');
    try {
        return JSON.parse(m[1]);
    } catch (e) {
        try {
            return parseSafeObjectLiteral(m[1]);
        } catch (e2) {
            throw new Error('player_aaaa 解析失败: ' + e2.message);
        }
    }
}

function extractPageTitle(html) {
    if (!html) return null;
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (og && og[1]) return og[1].trim();

    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag && titleTag[1]) {
        return titleTag[1].replace(/\s+/g, ' ').trim();
    }
    return null;
}

/**
 * MacCMS encrypt 字段处理
 * encrypt=1: unescape
 * encrypt=2: 站点前端已注释解密，密文原样给解析接口；这里也按「不解密」处理
 */
function resolvePlayUrl(player) {
    let url = player.url || '';
    const enc = String(player.encrypt ?? '');
    if (enc === '1') {
        try {
            url = unescape(url);
        } catch (_) {}
    }
    // enc === '2'：保持原样（URL 编码的 base64 类密文）
    return url;
}

/**
 * 从解析页 meta id 还原 AES key 材料
 * charset id: now_9753218604
 * viewport id: now_9zVHFWUESu
 * 按 charset 数字排序后拼接 viewport 对应字符 => key_material
 * md5(key_material + 'Mknacg123321')
 * key = md5[16..32] (utf8), iv = md5[0..16] (utf8)
 */
function extractMetaKeyParts(html) {
    const charset =
        html.match(/<meta[^>]*charset=["']?UTF-8["']?[^>]*\sid=["']now_([^"']+)["']/i) ||
        html.match(/<meta[^>]*\sid=["']now_([^"']+)["'][^>]*charset=["']?UTF-8["']/i);
    const viewport =
        html.match(/<meta[^>]*name=["']viewport["'][^>]*\sid=["']now_([^"']+)["']/i) ||
        html.match(/<meta[^>]*\sid=["']now_([^"']+)["'][^>]*name=["']viewport["']/i);

    if (!charset || !viewport) {
        throw new Error('解析页缺少 charset/viewport meta id，无法生成 AES 密钥');
    }

    const charsetId = charset[1];
    const viewportId = viewport[1];
    if (charsetId.length !== viewportId.length) {
        throw new Error(`meta id 长度不一致: charset=${charsetId.length}, viewport=${viewportId.length}`);
    }

    const pairs = [];
    for (let i = 0; i < charsetId.length; i++) {
        pairs.push({ id: charsetId[i], text: viewportId[i] });
    }
    pairs.sort((a, b) => Number(a.id) - Number(b.id));
    return pairs.map((p) => p.text).join('');
}

function extractConfigCipher(html) {
    // var config = { "url": "...", ... }
    const m =
        html.match(/"url"\s*:\s*"([A-Za-z0-9+/=]{32,})"/) ||
        html.match(/url\s*:\s*["']([A-Za-z0-9+/=]{32,})["']/);
    if (!m) throw new Error('解析页未找到 AES 密文 url 字段');
    return m[1];
}

function aesDecryptPlayUrl(cipherB64, keyMaterial) {
    const md5 = crypto.createHash('md5').update(keyMaterial + AES_SALT, 'utf8').digest('hex');
    const key = Buffer.from(md5.substring(16), 'utf8'); // 16 bytes
    const iv = Buffer.from(md5.substring(0, 16), 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([
        decipher.update(Buffer.from(cipherB64, 'base64')),
        decipher.final(),
    ]).toString('utf8');
    return plain.trim();
}

function pickParseBase(player) {
    const from = player.from || '';
    if (FROM_PARSE[from] !== undefined) {
        if (!FROM_PARSE[from]) {
            throw new Error(`线路 ${from} 已下线或不可用`);
        }
        return FROM_PARSE[from];
    }
    throw new Error(`未知线路 from=${from}，请更新 FROM_PARSE 映射`);
}

/**
 * 解析并返回原始下载链接（不跟随 302）
 * @param {string} episodeId 如 '1619-3-2' / 'bangumi/1619-3-2' / 完整 URL
 * @param {object} [options]
 * @param {string} [options.site] 站点根，默认 https://mgnacg.com
 * @param {boolean} [options.meta] 为 true 时返回详情对象，否则只返回 url 字符串
 * @returns {Promise<string|object>}
 */
async function download(episodeId, options = {}) {
    const id = normalizeEpisodeId(episodeId);
    const info = parseEpisodeId(id);
    const site = (options.site || SITE).replace(/\/+$/, '');
    const pageUrl = `${site}/bangumi/${id}`;

    // 1) 拉播放页
    const pageRes = await http.get(pageUrl, {
        headers: { Referer: site + '/' },
    });
    const pageHtml = typeof pageRes.data === 'string' ? pageRes.data : String(pageRes.data);
    const pageTitle = extractPageTitle(pageHtml);
    const player = extractPlayerAaaa(pageHtml);
    const playUrl = resolvePlayUrl(player);
    if (!playUrl) throw new Error('player_aaaa.url 为空');

    const parseBase = pickParseBase(player);
    const parseUrl = parseBase + playUrl;

    // 2) 拉线路解析页
    const parseRes = await http.get(parseUrl, {
        headers: {
            Referer: pageUrl,
            Origin: site,
        },
    });
    const parseHtml = typeof parseRes.data === 'string' ? parseRes.data : String(parseRes.data);

    // 3) AES 解密真实直链
    const keyMaterial = extractMetaKeyParts(parseHtml);
    const cipher = extractConfigCipher(parseHtml);
    const mediaUrl = aesDecryptPlayUrl(cipher, keyMaterial);

    if (!/^https?:\/\//i.test(mediaUrl)) {
        throw new Error('解密结果不是合法 URL: ' + mediaUrl.slice(0, 120));
    }

    if (options.meta) {
        return {
            episodeId: id,
            vodId: info.vodId,
            sid: info.sid,
            nid: info.nid,
            lineName: info.line?.name || player.from,
            from: player.from,
            pageUrl,
            pageTitle,
            title: pageTitle,
            parseUrl,
            url: mediaUrl,
            player,
        };
    }
    return mediaUrl;
}

module.exports = {
    download,
    SID_LINE,
    FROM_PARSE,
    normalizeEpisodeId,
    parseEpisodeId,
};

// 直接运行: node mod/mgnacg.js 1619-3-2
if (require.main === module) {
    const arg = process.argv[2] || '1619-3-2';
    download(arg, { meta: true })
        .then((r) => {
            console.log(JSON.stringify(r, null, 2));
        })
        .catch((err) => {
            console.error('[mgnacg] failed:', err.message);
            process.exit(1);
        });
}
