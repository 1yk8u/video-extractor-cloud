const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ===== Helper Functions =====

function extractUrl(text) {
    if (!text) return null;
    const urlMatch = text.match(/https?:\/\/[^\s，。、！？\]）)]+/);
    if (urlMatch) return urlMatch[0];
    const shortMatch = text.match(/(v\.douyin\.com|b23\.tv|xhslink\.com|v\.kuaishou\.com)\/[^\s，。、！？\]）)]*/);
    if (shortMatch) return 'https://' + shortMatch[0];
    return text.trim();
}

function detectPlatform(url) {
    if (url.match(/douyin|iesdouyin|v\.douyin\.com|amemv|snssdk/)) return 'douyin';
    if (url.match(/kuaishou|gifshow|chenzhongtech|yximgs|v\.kuaishou\.com/)) return 'kuaishou';
    if (url.match(/bilibili|b23\.tv|bilivideo/)) return 'bilibili';
    if (url.match(/xiaohongshu|xhslink|xhscdn|rednote/)) return 'xiaohongshu';
    return 'unknown';
}

function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0:00';
    const sec = Math.floor(seconds);
    const mins = Math.floor(sec / 60);
    const secs = sec % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function followRedirect(url, maxRedirects = 5) {
    let currentUrl = url;
    for (let i = 0; i < maxRedirects; i++) {
        try {
            const response = await fetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: { 'User-Agent': MOBILE_UA }
            });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location) {
                    currentUrl = new URL(location, currentUrl).href;
                    continue;
                }
            }
            return { url: currentUrl, response };
        } catch (e) {
            return { url: currentUrl, error: e.message };
        }
    }
    return { url: currentUrl };
}

// ===== Douyin Extractor =====
async function extractDouyin(link) {
    const url = extractUrl(link);
    let videoId = null;
    let isNote = false;

    if (url && url.includes('v.douyin.com')) {
        const { url: finalUrl } = await followRedirect(url);
        const match = finalUrl.match(/\/(video|note)\/(\d+)/);
        if (match) { videoId = match[2]; isNote = match[1] === 'note'; }
    } else if (url) {
        const match = url.match(/\/(video|note)\/(\d+)/);
        if (match) { videoId = match[2]; isNote = match[1] === 'note'; }
        if (!videoId) {
            const m2 = url.match(/\/(\d{15,})/);
            if (m2) videoId = m2[1];
        }
    }

    if (!videoId) return { success: false, error: '无法提取抖音视频ID，请检查链接' };

    const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
    const response = await fetch(shareUrl, { headers: { 'User-Agent': MOBILE_UA } });
    const html = await response.text();

    const routerMatch = html.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (!routerMatch) return { success: false, error: '无法解析抖音页面数据' };

    let routerData;
    try {
        routerData = JSON.parse(routerMatch[1].replace(/;\s*$/, ''));
    } catch (e) {
        return { success: false, error: '解析数据失败' };
    }

    const pageData = routerData.loaderData && routerData.loaderData['video_(id)/page'];
    if (!pageData || !pageData.videoInfoRes) return { success: false, error: '未找到视频信息' };

    const itemList = pageData.videoInfoRes.item_list;
    if (!itemList || itemList.length === 0) return { success: false, error: '视频不存在或已删除' };

    const item = itemList[0];
    const result = {
        success: true,
        platform: '抖音',
        title: item.desc || '抖音视频',
        author: (item.author && item.author.nickname) || '',
        awemeId: item.aweme_id,
        watermark: '无水印'
    };

    // Video
    if (item.video && item.video.play_addr) {
        result.type = 'video';
        result.duration = item.video.duration ? item.video.duration / 1000 : 0;
        result.durationStr = formatDuration(result.duration);
        result.resolution = `${item.video.width || 0}x${item.video.height || 0}`;
        if (item.video.cover && item.video.cover.url_list) {
            result.thumbnail = item.video.cover.url_list[0];
        }

        // Method 1: Use play_addr.uri to construct no-watermark URL
        if (item.video.play_addr.uri) {
            result.videoUrl = `https://www.douyin.com/aweme/v1/play/?video_id=${item.video.play_addr.uri}&ratio=1080p&line=0`;
        }
        // Method 2: Replace playwm with play in url_list
        if (!result.videoUrl && item.video.play_addr.url_list && item.video.play_addr.url_list.length > 0) {
            result.videoUrl = item.video.play_addr.url_list[0].replace('playwm', 'play');
        }
        // Method 3: Use bit_rate field
        if (!result.videoUrl && item.video.bit_rate && item.video.bit_rate.length > 0) {
            const br = item.video.bit_rate[item.video.bit_rate.length - 1];
            if (br.play_addr && br.play_addr.url_list && br.play_addr.url_list.length > 0) {
                result.videoUrl = br.play_addr.url_list[0].replace('playwm', 'play');
            }
        }
    }

    // Image album
    if (item.images && item.images.length > 0) {
        result.type = 'images';
        result.images = item.images.map(img => {
            if (img.url_list && img.url_list.length > 0) return img.url_list[0];
            return null;
        }).filter(Boolean);
    }

    // Music
    if (item.music) {
        result.musicTitle = item.music.title || '';
        result.musicAuthor = item.music.author || '';
    }

    if (!result.videoUrl && !result.images) {
        return { success: false, error: '无法提取视频内容' };
    }

    return result;
}

// ===== Kuaishou Extractor =====
async function extractKuaishou(link) {
    const url = extractUrl(link);
    const { url: finalUrl } = await followRedirect(url);

    const response = await fetch(finalUrl, {
        headers: { 'User-Agent': PC_UA, 'Referer': 'https://www.kuaishou.com/' }
    });
    const html = await response.text();

    let videoUrl = null, title = null, thumbnail = null;

    // Try multiple patterns for video URL
    const patterns = [
        /"srcNoMark"\s*:\s*"([^"]+)"/,
        /"photoUrl"\s*:\s*"([^"]+)"/,
        /"manifestH265"\s*:\s*"([^"]+)"/,
        /"manifest"\s*:\s*"([^"]+)"/,
        /"url"\s*:\s*"(https?:\/\/[^"]*\.mp4[^"]*)"/,
        /"photoH265Url"\s*:\s*"([^"]+)"/,
        /"coverUrl"\s*:\s*"([^"]*\.mp4[^"]*)"/
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
            videoUrl = match[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
            break;
        }
    }

    // Try __INITIAL_STATE__ as fallback
    if (!videoUrl) {
        const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
        if (stateMatch) {
            try {
                const stateData = JSON.parse(stateMatch[1]);
                const photoData = stateData?.vision?.photo;
                if (photoData?.photoUrl) videoUrl = photoData.photoUrl;
                else if (photoData?.mainMvUrls?.length > 0) videoUrl = photoData.mainMvUrls[0].url;
            } catch (e) { /* ignore parse error */ }
        }
    }

    const capMatch = html.match(/"caption"\s*:\s*"([^"]*)"/);
    if (capMatch) title = capMatch[1];
    else if (html.match(/<title>([^<]+)<\/title>/)) title = html.match(/<title>([^<]+)<\/title>/)[1];
    if (!title) title = '快手视频';

    const coverMatch = html.match(/"coverUrl"\s*:\s*"([^"]+)"/);
    if (coverMatch) thumbnail = coverMatch[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');

    if (!videoUrl) return { success: false, error: '无法提取快手视频，请确认链接有效' };

    return {
        success: true, platform: '快手', type: 'video',
        title, videoUrl, thumbnail, watermark: '无水印', resolution: '高清'
    };
}

// ===== Bilibili Extractor =====
async function extractBilibili(link) {
    const url = extractUrl(link);
    let bvid = null;

    if (url.match(/BV([a-zA-Z0-9]+)/)) {
        bvid = url.match(/BV([a-zA-Z0-9]+)/)[0];
    } else if (url.includes('b23.tv')) {
        const { url: finalUrl } = await followRedirect(url);
        if (finalUrl.match(/BV([a-zA-Z0-9]+)/)) bvid = finalUrl.match(/BV([a-zA-Z0-9]+)/)[0];
    } else if (url.match(/av(\d+)/)) {
        const avid = url.match(/av(\d+)/)[1];
        const viewResp = await fetch(`https://api.bilibili.com/x/web-interface/view?aid=${avid}`, {
            headers: { 'User-Agent': PC_UA, 'Referer': 'https://www.bilibili.com/' }
        });
        const viewData = await viewResp.json();
        if (viewData.code === 0) bvid = viewData.data.bvid;
    }

    if (!bvid) return { success: false, error: '无法提取B站视频ID' };

    const viewResp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: { 'User-Agent': PC_UA, 'Referer': 'https://www.bilibili.com/' }
    });
    const viewData = await viewResp.json();
    if (viewData.code !== 0) return { success: false, error: 'B站API错误: ' + viewData.message };

    const videoData = viewData.data;
    const cid = videoData.cid;

    const playResp = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&fourk=1`, {
        headers: { 'User-Agent': PC_UA, 'Referer': 'https://www.bilibili.com/' }
    });
    const playData = await playResp.json();
    if (playData.code !== 0) return { success: false, error: '获取播放地址失败' };

    let videoUrl = null, resolution = '高清';

    if (playData.data.durl && playData.data.durl.length > 0) {
        videoUrl = playData.data.durl[0].url;
        const q = playData.data.quality;
        if (q === 80) resolution = '1080P';
        else if (q === 64) resolution = '720P';
        else if (q === 32) resolution = '480P';
    }

    if (!videoUrl && playData.data.dash && playData.data.dash.video) {
        const v = playData.data.dash.video;
        if (v.length > 0) videoUrl = v[0].baseUrl || v[0].base_url;
    }

    if (!videoUrl) return { success: false, error: '无法获取视频下载地址' };

    return {
        success: true, platform: '哔哩哔哩', type: 'video',
        title: videoData.title, author: (videoData.owner && videoData.owner.name) || '',
        videoUrl, thumbnail: videoData.pic,
        duration: videoData.duration, durationStr: formatDuration(videoData.duration),
        watermark: '无水印', resolution
    };
}

// ===== Xiaohongshu Extractor =====
async function extractXiaohongshu(link) {
    const url = extractUrl(link);
    let finalUrl = url;

    if (url && url.includes('xhslink.com')) {
        const { url: redirected } = await followRedirect(url);
        finalUrl = redirected;
    }

    let noteId = null;
    let xsecToken = null;

    // Extract xsec_token from URL
    const tokenMatch = finalUrl.match(/xsec_token=([^&]+)/);
    if (tokenMatch) xsecToken = tokenMatch[1];

    const m1 = finalUrl.match(/\/explore\/([a-zA-Z0-9]+)/);
    if (m1) noteId = m1[1];
    if (!noteId) { const m2 = finalUrl.match(/\/discovery\/item\/([a-zA-Z0-9]+)/); if (m2) noteId = m2[1]; }
    if (!noteId) { const m3 = finalUrl.match(/\/note\/([a-zA-Z0-9]+)/); if (m3) noteId = m3[1]; }
    if (!noteId) { const m4 = finalUrl.match(/\/([a-f0-9]{24})/); if (m4) noteId = m4[1]; }

    if (!noteId) {
        const resp = await fetch(finalUrl, { headers: { 'User-Agent': MOBILE_UA } });
        const html = await resp.text();
        const m = html.match(/"noteId"\s*:\s*"([^"]+)"/);
        if (m) noteId = m[1];
    }

    if (!noteId) return { success: false, error: '无法提取小红书笔记ID' };

    // Build note URL with xsec_token if available
    let noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
    if (xsecToken) noteUrl += `?xsec_token=${xsecToken}&xsec_source=pc_feed`;

    const response = await fetch(noteUrl, {
        headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.xiaohongshu.com/' }
    });
    const html = await response.text();

    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);

    if (!stateMatch) {
        // Fallback: parse meta tags
        let ogImage = null, ogVideo = null, ogTitle = null;
        const imgM = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
        if (imgM) ogImage = imgM[1];
        const vidM = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/);
        if (vidM) ogVideo = vidM[1];
        const titleM = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
        if (titleM) ogTitle = titleM[1];

        if (ogImage || ogVideo) {
            const result = { success: true, platform: '小红书', title: ogTitle || '小红书笔记', watermark: '无水印' };
            if (ogVideo) { result.type = 'video'; result.videoUrl = ogVideo; result.thumbnail = ogImage; }
            else { result.type = 'images'; result.images = [ogImage]; }
            return result;
        }
        return { success: false, error: '无法解析小红书页面数据' };
    }

    let stateData;
    try {
        stateData = JSON.parse(stateMatch[1].replace(/;\s*$/, '').replace(/undefined/g, 'null'));
    } catch (e) {
        return { success: false, error: '解析数据失败' };
    }

    const noteDetail = stateData.note && stateData.note.noteDetailMap && stateData.note.noteDetailMap[noteId];
    if (!noteDetail || !noteDetail.note) return { success: false, error: '未找到笔记数据' };

    const note = noteDetail.note;
    const result = {
        success: true, platform: '小红书',
        title: note.title || note.desc || '小红书笔记',
        author: (note.user && note.user.nickname) || '',
        watermark: '无水印'
    };

    if (note.type === 'video' && note.video) {
        result.type = 'video';
        if (note.video.media && note.video.media.stream && note.video.media.stream.h264) {
            const h264 = note.video.media.stream.h264;
            if (h264.length > 0) result.videoUrl = h264[0].masterUrl || (h264[0].backupUrls && h264[0].backupUrls[0]);
        }
        if (!result.videoUrl && note.video.consumer && note.video.consumer.originVideoKey) {
            result.videoUrl = `https://sns-video-bd.xhscdn.com/${note.video.consumer.originVideoKey}`;
        }
        if (note.video.image && note.video.image.firstFrame) result.thumbnail = note.video.image.firstFrame;
    }

    if (note.imageList && note.imageList.length > 0) {
        result.type = 'images';
        result.images = note.imageList.map(img => {
            if (img.urlDefault) return img.urlDefault;
            if (img.urlPre) return img.urlPre;
            if (img.infoList && img.infoList.length > 0) return img.infoList[0].url;
            return null;
        }).filter(Boolean);
    }

    if (!result.videoUrl && !result.images) return { success: false, error: '无法提取媒体内容' };
    return result;
}

// ===== API Routes =====

app.post('/api/extract', async (req, res) => {
    const { link } = req.body;
    if (!link) return res.json({ success: false, error: '请提供链接' });

    const url = extractUrl(link);
    if (!url) return res.json({ success: false, error: '无法识别链接' });

    const platform = detectPlatform(url);
    console.log(`[${new Date().toISOString()}] Extract: platform=${platform} url=${url.substring(0, 80)}...`);

    try {
        let result;
        switch (platform) {
            case 'douyin': result = await extractDouyin(link); break;
            case 'kuaishou': result = await extractKuaishou(link); break;
            case 'bilibili': result = await extractBilibili(link); break;
            case 'xiaohongshu': result = await extractXiaohongshu(link); break;
            default: return res.json({ success: false, error: '不支持的平台，请发送抖音/快手/B站/小红书链接' });
        }
        res.json(result);
    } catch (error) {
        console.error('Extract error:', error);
        res.json({ success: false, error: '服务器错误: ' + error.message });
    }
});

app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url parameter');

    try {
        let referer = 'https://www.douyin.com/';
        let ua = PC_UA;
        if (targetUrl.match(/bilibili|bilivideo|hdslb|akamaized/)) {
            referer = 'https://www.bilibili.com/';
        } else if (targetUrl.match(/kuaishou|yximgs|chenzhongtech|gifshow|txkfkl/)) {
            referer = 'https://www.kuaishou.com/';
        } else if (targetUrl.match(/xiaohongshu|xhscdn|xhslink|sns-video/)) {
            referer = 'https://www.xiaohongshu.com/';
        } else if (targetUrl.match(/douyin|iesdouyin|douyinvod|douyinpic|bytecdn|byteimg|amemv/)) {
            referer = 'https://www.douyin.com/';
            ua = MOBILE_UA;
        }

        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': ua, 'Referer': referer }
        });

        let contentType = response.headers.get('content-type') || '';
        if (!contentType || contentType === 'application/octet-stream') {
            if (targetUrl.match(/\.mp4/)) contentType = 'video/mp4';
            else if (targetUrl.match(/\.jpg|\.jpeg/)) contentType = 'image/jpeg';
            else if (targetUrl.match(/\.png/)) contentType = 'image/png';
            else if (targetUrl.match(/\.webp/)) contentType = 'image/webp';
            else contentType = 'application/octet-stream';
        }

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Access-Control-Allow-Origin', '*');

        // Stream the response instead of buffering
        const reader = response.body.getReader();
        const push = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.writableEnded) res.write(Buffer.from(value));
            }
            res.end();
        };
        push().catch(() => {
            if (!res.writableEnded) res.end();
        });
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(502).send('Proxy failed');
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

const PORT = process.env.PORT || 3000;

// Only start listening when run directly (not when imported as a module)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Video Extractor Cloud running on port ${PORT}`);
    });
}

module.exports = app;
