if (typeof importScripts === 'function') {
    importScripts('mux.min.js');
}

console.log('BetterKick: Background service worker loaded.');

const activeDownloads = new Map();
const downloadUrls = new Map();
const srStreams = new Map();
const I18N = (() => {
    const supported = ['en', 'es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ru', 'ar', 'hi', 'ko', 'tr'];
    const defaultLang = 'en';
    const cache = {};
    let currentLang = '';
    let validated = false;
    const listeners = new Set();
    const getBrowserLang = () => {
        const chromeLang = chrome && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function' ? chrome.i18n.getUILanguage() : '';
        const navLang = (self.navigator && (self.navigator.language || self.navigator.userLanguage)) || '';
        const raw = (chromeLang || navLang || defaultLang).toLowerCase();
        const code = raw.split('-')[0];
        return supported.includes(code) ? code : defaultLang;
    };
    const loadLocale = async (lang) => {
        if (cache[lang]) return cache[lang];
        const url = chrome.runtime.getURL(`locales/${lang}.json`);
        console.log(`[i18n] loading locale ${lang}`, url);
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('load');
            const data = await res.json();
            cache[lang] = data || {};
            console.log(`[i18n] loaded locale ${lang} (${Object.keys(cache[lang]).length} keys)`);
        } catch (e) {
            cache[lang] = {};
            console.warn(`[i18n] failed to load locale ${lang}`, e);
        }
        return cache[lang];
    };
    const validateLocales = () => {
        if (validated) return;
        const en = cache.en || {};
        const enKeys = Object.keys(en);
        Object.keys(cache).forEach((lang) => {
            const dict = cache[lang] || {};
            const dictKeys = Object.keys(dict);
            const missingInLang = enKeys.filter((k) => !(k in dict));
            const missingInEn = dictKeys.filter((k) => !(k in en));
            if (missingInLang.length) {
                console.warn(`[i18n] missing keys in ${lang}: ${missingInLang.join(', ')}`);
            }
            if (missingInEn.length) {
                console.warn(`[i18n] extra keys in ${lang}: ${missingInEn.join(', ')}`);
            }
        });
        validated = true;
    };
    const ensure = async () => {
        const lang = getBrowserLang();
        if (!currentLang) currentLang = lang;
        if (lang !== currentLang) currentLang = lang;
        await Promise.all([loadLocale('en'), currentLang === 'en' ? Promise.resolve() : loadLocale(currentLang)]);
        validateLocales();
        return currentLang;
    };
    const t = (key, vars) => {
        const lang = currentLang || getBrowserLang();
        const dict = cache[lang] || {};
        const en = cache.en || {};
        let str = dict[key] ?? en[key];
        if (!str) {
            console.warn(`[i18n] missing key: ${key}`);
            return 'Text unavailable';
        }
        if (vars) {
            Object.keys(vars).forEach((k) => {
                str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), vars[k]);
            });
        }
        return str;
    };
    const onChange = (cb) => listeners.add(cb);
    const notify = () => listeners.forEach((cb) => cb());
    const watch = () => {
        let last = getBrowserLang();
        setInterval(async () => {
            const lang = getBrowserLang();
            if (lang !== last) {
                last = lang;
                await ensure();
                notify();
            }
        }, 1500);
    };
    ensure().catch(() => {});
    watch();
    return { t, ensure, onChange, getBrowserLang };
})();

const t = (key, vars) => I18N.t(key, vars);

const setBadgeProgress = (progress) => {
    if (progress !== null && progress !== undefined) {
        chrome.action.setBadgeText({ text: `${progress}%` });
        chrome.action.setBadgeBackgroundColor({ color: '#53fc18' });
    } else {
        chrome.action.setBadgeText({ text: '' });
    }
};

const sendToTab = (tabId, payload) => {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, payload).catch(() => {});
};

const removeOpfsEntry = async (name) => {
    if (!name || !navigator.storage || !navigator.storage.getDirectory) return;
    try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(name);
    } catch (e) {}
};

const patchMp4Header = (initSegment, durationMs, avgBitrate = 0) => {
    try {
        const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
        const readBox = (pos) => {
            if (pos + 8 > view.byteLength) return null;
            const size = view.getUint32(pos);
            const type = String.fromCharCode(
                view.getUint8(pos + 4), view.getUint8(pos + 5),
                view.getUint8(pos + 6), view.getUint8(pos + 7)
            );
            return { size, type, offset: pos };
        };
        const findBox = (start, end, type) => {
            let pos = start;
            while (pos < end) {
                const box = readBox(pos);
                if (!box) break;
                if (box.type === type) return box;
                pos += box.size;
            }
            return null;
        };
        const moov = findBox(0, view.byteLength, 'moov');
        if (!moov) return initSegment;
        const mvhd = findBox(moov.offset + 8, moov.offset + moov.size, 'mvhd');
        if (mvhd) {
            const version = view.getUint8(mvhd.offset + 8);
            const timescaleOffset = mvhd.offset + 8 + (version === 0 ? 12 : 20);
            const durationOffset = timescaleOffset + 4;
            const timescale = view.getUint32(timescaleOffset);
            const durationUnits = Math.round((durationMs / 1000) * timescale);
            if (version === 0) {
                view.setUint32(durationOffset, durationUnits);
            } else {
                view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                view.setUint32(durationOffset + 4, durationUnits % 4294967296);
            }
        }
        let trakPos = moov.offset + 8;
        while (trakPos < moov.offset + moov.size) {
            const box = readBox(trakPos);
            if (!box) break;
            if (box.type === 'trak') {
                const tkhd = findBox(box.offset + 8, box.offset + box.size, 'tkhd');
                if (tkhd) {
                    const version = view.getUint8(tkhd.offset + 8);
                    const durationOffset = tkhd.offset + 8 + (version === 0 ? 20 : 28);
                    const globalTimescale = 1000;
                    const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
                    if (version === 0) {
                        view.setUint32(durationOffset, durationUnits);
                    } else {
                        view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                        view.setUint32(durationOffset + 4, durationUnits % 4294967296);
                    }
                }
                const mdia = findBox(box.offset + 8, box.offset + box.size, 'mdia');
                if (mdia) {
                    const mdhd = findBox(mdia.offset + 8, mdia.offset + mdia.size, 'mdhd');
                    if (mdhd) {
                        const version = view.getUint8(mdhd.offset + 8);
                        const timescaleOffset = mdhd.offset + 8 + (version === 0 ? 12 : 20);
                        const durationOffset = timescaleOffset + 4;
                        const localTimescale = view.getUint32(timescaleOffset);
                        const durationUnits = Math.round((durationMs / 1000) * localTimescale);
                        if (version === 0) {
                            view.setUint32(durationOffset, durationUnits);
                        } else {
                            view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                            view.setUint32(durationOffset + 4, durationUnits % 4294967296);
                        }
                    }
                }
                const stbl = findBox(box.offset + 8, box.offset + box.size, 'stbl');
                if (stbl) {
                    const stsd = findBox(stbl.offset + 8, stbl.offset + stbl.size, 'stsd');
                    if (stsd) {
                        const entryCount = view.getUint32(stsd.offset + 12);
                        if (entryCount > 0) {
                            const entryOffset = stsd.offset + 16;
                            const avc1 = readBox(entryOffset);
                            if (avc1) {
                                const btrt = findBox(avc1.offset + 8, avc1.offset + avc1.size, 'btrt');
                                if (btrt) {
                                    const bufferSizeOffset = btrt.offset + 8;
                                    const maxBitrateOffset = bufferSizeOffset + 4;
                                    const avgBitrateOffset = maxBitrateOffset + 4;
                                    const safeBitrate = avgBitrate > 0 ? avgBitrate : view.getUint32(avgBitrateOffset);
                                    const bufferSize = Math.min(0xFFFFFFFF, Math.round(safeBitrate));
                                    view.setUint32(bufferSizeOffset, bufferSize);
                                    view.setUint32(maxBitrateOffset, Math.round(safeBitrate * 1.5));
                                    view.setUint32(avgBitrateOffset, safeBitrate);
                                }
                            }
                        }
                    }
                }
            }
            trakPos += box.size;
        }
        return initSegment;
    } catch (e) {
        console.error('Error patching MP4 headers:', e);
        return initSegment;
    }
};

const patchMp4DurationInPlace = (initSegment, durationMs) => {
    try {
        const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
        const readBox = (pos) => {
            if (pos + 8 > view.byteLength) return null;
            const size = view.getUint32(pos);
            const type = String.fromCharCode(
                view.getUint8(pos + 4), view.getUint8(pos + 5),
                view.getUint8(pos + 6), view.getUint8(pos + 7)
            );
            return { size, type, offset: pos };
        };
        const findBox = (start, end, type) => {
            let pos = start;
            while (pos < end) {
                const box = readBox(pos);
                if (!box) break;
                if (box.type === type) return box;
                pos += box.size;
            }
            return null;
        };
        const moov = findBox(0, view.byteLength, 'moov');
        if (!moov) return initSegment;
        const mvhd = findBox(moov.offset + 8, moov.offset + moov.size, 'mvhd');
        if (mvhd) {
            const version = view.getUint8(mvhd.offset + 8);
            const timescaleOffset = mvhd.offset + 8 + (version === 0 ? 12 : 20);
            const durationOffset = timescaleOffset + 4;
            const timescale = view.getUint32(timescaleOffset);
            const durationUnits = Math.round((durationMs / 1000) * timescale);
            if (version === 0) {
                view.setUint32(durationOffset, durationUnits);
            } else {
                view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                view.setUint32(durationOffset + 4, durationUnits % 4294967296);
            }
        }
        let trakPos = moov.offset + 8;
        while (trakPos < moov.offset + moov.size) {
            const box = readBox(trakPos);
            if (!box) break;
            if (box.type === 'trak') {
                const tkhd = findBox(box.offset + 8, box.offset + box.size, 'tkhd');
                if (tkhd) {
                    const version = view.getUint8(tkhd.offset + 8);
                    const durationOffset = tkhd.offset + 8 + (version === 0 ? 20 : 28);
                    const globalTimescale = 1000;
                    const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
                    if (version === 0) {
                        view.setUint32(durationOffset, durationUnits);
                    } else {
                        view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                        view.setUint32(durationOffset + 4, durationUnits % 4294967296);
                    }
                }
                const mdia = findBox(box.offset + 8, box.offset + box.size, 'mdia');
                if (mdia) {
                    const mdhd = findBox(mdia.offset + 8, mdia.offset + mdia.size, 'mdhd');
                    if (mdhd) {
                        const version = view.getUint8(mdhd.offset + 8);
                        const timescaleOffset = mdhd.offset + 8 + (version === 0 ? 12 : 20);
                        const durationOffset = timescaleOffset + 4;
                        const localTimescale = view.getUint32(timescaleOffset);
                        const durationUnits = Math.round((durationMs / 1000) * localTimescale);
                        if (version === 0) {
                            view.setUint32(durationOffset, durationUnits);
                        } else {
                            view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                            view.setUint32(durationOffset + 4, durationUnits % 4294967296);
                        }
                    }
                }
            }
            trakPos += box.size;
        }
        return initSegment;
    } catch (e) {
        console.error('Error patching MP4 duration:', e);
        return initSegment;
    }
};

const formatTime = (seconds) => {
    if (!isFinite(seconds) || seconds < 0) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatDuration = (ms) => {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
};

const downloadVodInBackground = async (payload, tabId, controller) => {
    let { streamUrl, videoDurationMs, startSeconds, endSeconds, explicitVideoId, explicitTitle, appendMode, fileName } = payload;
    await I18N.ensure();
    const signal = controller.signal;
    let isAudioOnly = false;
    if (streamUrl.endsWith('#audio_only')) {
        isAudioOnly = true;
        streamUrl = streamUrl.replace('#audio_only', '');
    }
    const ext = isAudioOnly ? 'm4a' : 'mp4';
    if (!fileName || !fileName.includes('.')) {
        fileName = `kick-vod.${ext}`;
    }

    const sendStage = (text, etaText = '', currentBytes = 0, currentSpeed = 0, speedWarningText = '') => {
        sendToTab(tabId, { type: 'VOD_STAGE', text, etaText, currentBytes, currentSpeed, speedWarningText });
    };

    const sendProgress = (progress, etaText, currentBytes, currentSpeed, speedWarningText) => {
        sendToTab(tabId, { type: 'VOD_PROGRESS', progress, etaText, currentBytes, currentSpeed, speedWarningText });
    };

    const ensureActive = () => {
        if (signal.aborted) {
            throw new Error('cancelled by user');
        }
    };

    const fetchUrl = streamUrl + (streamUrl.includes('?') ? '&' : '?') + `time=${Date.now()}`;
    const response = await fetch(fetchUrl, { cache: 'no-store', signal });
    const playlistText = await response.text();
    const lines = playlistText.split('\n');
    let segments = [];
    let baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
    const hasEndList = playlistText.includes('#EXT-X-ENDLIST');

    if (playlistText.includes('EXT-X-STREAM-INF')) {
        sendStage(t('download.analyzing_qualities'), '', 0, 0, '');
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('EXT-X-STREAM-INF')) {
                const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;
                const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                const resolution = resMatch ? resMatch[1] : 'unknown';
                let j = i + 1;
                while (j < lines.length && lines[j].startsWith('#')) {
                    j++;
                }
                if (j < lines.length && lines[j].trim().length > 0) {
                    const url = lines[j].trim();
                    variants.push({ bandwidth, resolution, url: url.startsWith('http') ? url : baseUrl + url });
                }
            }
        }
        if (variants.length > 0) {
            const variantAnalysis = await Promise.all(variants.map(async (v) => {
                try {
                    const vUrl = v.url + (v.url.includes('?') ? '&' : '?') + `time=${Date.now()}`;
                    const res = await fetch(vUrl, { cache: 'no-store', signal });
                    const text = await res.text();
                    const vLines = text.split('\n');
                    let dur = 0;
                    let segCount = 0;
                    for (const line of vLines) {
                        if (line.startsWith('#EXTINF:')) {
                            const d = parseFloat(line.substring(8).split(',')[0]);
                            if (!isNaN(d)) dur += d;
                            segCount++;
                        }
                    }
                    return { ...v, duration: dur, segments: segCount };
                } catch (e) {
                    return { ...v, duration: 0, segments: 0 };
                }
            }));
            variantAnalysis.sort((a, b) => {
                if (Math.abs(b.duration - a.duration) > 5) {
                    return b.duration - a.duration;
                }
                return b.bandwidth - a.bandwidth;
            });
            const bestVariant = variantAnalysis[0];
            let targetUrl = bestVariant.url;
            if (isAudioOnly) targetUrl += '#audio_only';
            return await downloadVodInBackground({ ...payload, streamUrl: targetUrl, fileName }, tabId, controller);
        }
        const m3u8Match = lines.find(l => l.endsWith('.m3u8') && !l.startsWith('#'));
        if (m3u8Match) {
            let newUrl = m3u8Match.startsWith('http') ? m3u8Match : baseUrl + m3u8Match;
            if (isAudioOnly) newUrl += '#audio_only';
            return await downloadVodInBackground({ ...payload, streamUrl: newUrl, fileName }, tabId, controller);
        }
    }

    let calculatedDuration = 0;
    let segmentDurations = [];
    let totalPlaylistDuration = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const durationStr = line.substring(8).split(',')[0];
            const d = parseFloat(durationStr);
            if (!isNaN(d)) {
                const segStart = totalPlaylistDuration;
                const segEnd = totalPlaylistDuration + d;
                totalPlaylistDuration += d;
                let shouldInclude = true;
                if (segEnd <= startSeconds) shouldInclude = false;
                if (endSeconds !== -1 && segStart >= endSeconds) shouldInclude = false;
                if (shouldInclude) {
                    calculatedDuration += d;
                    segmentDurations.push(d);
                    lines[i] = '#INCLUDE_NEXT';
                } else {
                    lines[i] = '#SKIP_NEXT';
                }
            }
        }
        if (line && !line.startsWith('#')) {
            let prevDecision = '#INCLUDE_NEXT';
            for (let j = i - 1; j >= 0; j--) {
                const prevLineRaw = lines[j];
                const prevLineTrimmed = prevLineRaw.trim();
                if (!prevLineTrimmed) continue;
                if (prevLineRaw === '#INCLUDE_NEXT') {
                    prevDecision = '#INCLUDE_NEXT';
                    break;
                }
                if (prevLineRaw === '#SKIP_NEXT') {
                    prevDecision = '#SKIP_NEXT';
                    break;
                }
                if (prevLineTrimmed.startsWith('#')) continue;
                break;
            }
            if (prevDecision === '#INCLUDE_NEXT') {
                segments.push(line.startsWith('http') ? line : baseUrl + line);
            }
        }
    }

    if (segments.length > 0 && endSeconds === -1) {
        const lastSegmentUrl = segments[segments.length - 1];
        const lastSlashIdx = lastSegmentUrl.lastIndexOf('/');
        if (lastSlashIdx !== -1) {
            const baseUrlForSeg = lastSegmentUrl.substring(0, lastSlashIdx + 1);
            const fileSegmentName = lastSegmentUrl.substring(lastSlashIdx + 1);
            const match = fileSegmentName.match(/^(.*?)(\d+)(\.[^.?]+)(\?.*)?$/);
            if (match) {
                const prefix = match[1];
                let currentNum = parseInt(match[2], 10);
                const suffix = match[3];
                const query = match[4] || '';
                const maxGhostSegments = 50;
                let ghostCount = 0;
                let consecutiveErrors = 0;
                const maxConsecutiveErrors = 5;
                sendStage(t('download.checking_hidden_segments'), '', 0, 0, '');
                while (ghostCount < maxGhostSegments && consecutiveErrors < maxConsecutiveErrors) {
                    ensureActive();
                    currentNum++;
                    const nextSegName = `${prefix}${currentNum}${suffix}${query}`;
                    const nextSegUrl = `${baseUrlForSeg}${nextSegName}`;
                    try {
                        const checkRes = await fetch(nextSegUrl, { method: 'GET', signal });
                        if (checkRes.ok) {
                            segments.push(nextSegUrl);
                            calculatedDuration += 10;
                            ghostCount++;
                            consecutiveErrors = 0;
                        } else {
                            consecutiveErrors++;
                        }
                    } catch (e) {
                        consecutiveErrors++;
                    }
                }
                if (ghostCount > 0) {
                    sendToTab(tabId, { type: 'VOD_GHOST_SEGMENTS', count: ghostCount });
                }
            }
        }
    }

    if (calculatedDuration > 0) {
        const diff = Math.abs(videoDurationMs - calculatedDuration * 1000);
        if (diff > 10000) {
            sendToTab(tabId, { type: 'VOD_DURATION_MISMATCH', api: formatDuration(videoDurationMs), actual: formatDuration(calculatedDuration * 1000) });
            videoDurationMs = calculatedDuration * 1000;
        } else if (!videoDurationMs || videoDurationMs === 0) {
            videoDurationMs = calculatedDuration * 1000;
        }
    }

    if (segments.length === 0) {
        throw new Error(t('download.no_segments_found'));
    }

    const transmuxer = new muxjs.mp4.Transmuxer({
        keepOriginalTimestamps: false,
        remux: !isAudioOnly
    });

    let initSegmentWritten = appendMode === true;
    const firstSegmentDuration = segmentDurations.length > 0 ? segmentDurations[0] : 0;
    const writeBuffer = [];
    let writeBufferBytes = 0;
    const writeFlushThreshold = 4 * 1024 * 1024;
    const memoryChunks = [];
    let opfsHandle = null;
    let opfsWritable = null;
    let opfsFileName = '';
    let useOpfs = false;
    let fileWriteChain = Promise.resolve();
    let opfsBytes = 0;
    let cacheLimitBytes = 0;
    let downloadId = null;

    const concatBuffers = (buffers, total) => {
        const out = new Uint8Array(total);
        let offset = 0;
        for (const buf of buffers) {
            out.set(buf, offset);
            offset += buf.byteLength;
        }
        return out;
    };

    const flushWriteBuffer = () => {
        if (writeBufferBytes === 0) return;
        const combined = concatBuffers(writeBuffer, writeBufferBytes);
        writeBuffer.length = 0;
        writeBufferBytes = 0;
        if (useOpfs && opfsWritable) {
            const bytes = combined.byteLength;
            fileWriteChain = fileWriteChain.then(async () => {
                if (cacheLimitBytes && opfsBytes + bytes > cacheLimitBytes) {
                    throw new Error(t('download.cache_limit_exceeded'));
                }
                await opfsWritable.write(combined);
                opfsBytes += bytes;
            });
        } else {
            memoryChunks.push(combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength));
        }
    };

    const enqueueWrite = (buffer) => {
        writeBuffer.push(buffer);
        writeBufferBytes += buffer.byteLength;
        if (writeBufferBytes >= writeFlushThreshold) {
            flushWriteBuffer();
        }
    };

    transmuxer.on('data', (segment) => {
        if (isAudioOnly) {
            if (segment.type !== 'audio') return;
        }
        if (!initSegmentWritten) {
            let initSeg = new Uint8Array(segment.initSegment);
            let estimatedBitrate = 0;
            if (segment.data && segment.data.byteLength > 0 && firstSegmentDuration > 0) {
                estimatedBitrate = Math.round((segment.data.byteLength * 8) / firstSegmentDuration);
            }
            const targetDurationMs = (calculatedDuration > 0) ? calculatedDuration * 1000 : videoDurationMs;
            if (targetDurationMs > 0) {
                initSeg = patchMp4Header(initSeg, targetDurationMs, estimatedBitrate);
            }
            enqueueWrite(initSeg);
            initSegmentWritten = true;
        }
        const mediaSeg = new Uint8Array(segment.data);
        enqueueWrite(mediaSeg);
    });

    if (navigator.storage && navigator.storage.getDirectory) {
        try {
            const defaultLimit = 8 * 1024 * 1024 * 1024;
            cacheLimitBytes = defaultLimit;
            if (navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate();
                if (estimate && estimate.quota) {
                    const available = Math.max(0, estimate.quota - (estimate.usage || 0));
                    const dynamicLimit = Math.max(512 * 1024 * 1024, Math.floor(available * 0.9));
                    cacheLimitBytes = Math.min(defaultLimit, dynamicLimit);
                }
            }
            const root = await navigator.storage.getDirectory();
            opfsFileName = `kvd-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
            opfsHandle = await root.getFileHandle(opfsFileName, { create: true });
            opfsWritable = await opfsHandle.createWritable();
            useOpfs = true;
            sendStage(t('download.disk_cache_mode'), '', 0, 0, '');
        } catch (e) {
            useOpfs = false;
            opfsHandle = null;
            opfsWritable = null;
        }
    }

    try {
    sendProgress(0, '', 0, 0, '');

    const startTime = Date.now();
    let lastProgress = 0;
    let totalBytes = 0;
    let currentSpeed = 0;
    let lastSpeedTime = Date.now();
    let lastSpeedBytes = 0;
    let lastUiUpdate = 0;

    let maxConnections = 128;
    const minConnections = 2;
    let desiredConnections = Math.min(12, maxConnections, segments.length);
    const pendingQueue = Array.from({ length: segments.length }, (_, i) => i);
    let completed = 0;
    let inFlight = 0;
    let failed = 0;
    let processingIndex = 0;
    let errorWindow = 0;
    let successWindow = 0;
    let currentMbps = 0;
    let emaMbps = 0;
    let jitterRatio = 0;
    let segBytesAvg = 0;
    let throttleScore = 0;
    let throttleDelayUntil = 0;
    const speedLimitConfig = {
        dropRatioThreshold: 0.5,
        maxDropRatioThreshold: 0.3,
        stableSeconds: 5,
        movingAverageWindow: 6,
        minBaselineMbps: 5
    };
    const speedLimitText = t('download.speed_limited');
    let speedSamples = [];
    let speedMaxMbps = 0;
    let speedAvgMbps = 0;
    let speedDropSince = null;
    let speedLimitActive = false;
    let speedLimitMessage = '';
    const results = new Map();
    const retryQueue = [];
    const targetMbps = 400;
    const maxRetries = 20;
    const throttleStatuses = [429, 503, 520, 522, 524];

    const getDynamicMaxConnections = () => {
        const connection = self.navigator && (self.navigator.connection || self.navigator.mozConnection || self.navigator.webkitConnection);
        const downlink = connection && isFinite(connection.downlink) ? connection.downlink : null;
        const availableMbps = downlink || Math.max(currentMbps, 10);
        const step = Math.max(1, Math.round(availableMbps / 8));
        return Math.min(maxConnections, Math.max(minConnections, step * 4));
    };

    const getBufferTarget = () => {
        const lowBitrate = segBytesAvg > 0 && segBytesAvg < 500 * 1024;
        const multiplier = lowBitrate ? 12 : 6;
        return Math.max(desiredConnections * multiplier, 128);
    };

    const sleepWithAbort = (ms) => {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error('cancelled by user'));
                return;
            }
            const id = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => {
                clearTimeout(id);
                reject(new Error('cancelled by user'));
            }, { once: true });
        });
    };

    const updateSpeed = () => {
        const now = Date.now();
        const timeDiff = (now - lastSpeedTime) / 1000;
        if (timeDiff >= 1) {
            const bytesDiff = totalBytes - lastSpeedBytes;
            currentSpeed = bytesDiff / timeDiff;
            currentMbps = (currentSpeed * 8) / 1000000;
            lastSpeedTime = now;
            lastSpeedBytes = totalBytes;
        }
    };

    const updateSpeedLimitStatus = (now) => {
        if (!isFinite(currentMbps) || currentMbps <= 0) return;
        speedSamples.push(currentMbps);
        if (speedSamples.length > speedLimitConfig.movingAverageWindow) {
            speedSamples.shift();
        }
        speedAvgMbps = speedSamples.reduce((sum, v) => sum + v, 0) / Math.max(speedSamples.length, 1);
        speedMaxMbps = Math.max(speedMaxMbps, speedAvgMbps);
        const baseline = speedMaxMbps;
        const ratio = baseline > 0 ? speedAvgMbps / baseline : 1;
        const isDrop = ratio <= speedLimitConfig.dropRatioThreshold;
        const isSevereDrop = ratio <= speedLimitConfig.maxDropRatioThreshold;
        const below = (isDrop || isSevereDrop) && baseline >= speedLimitConfig.minBaselineMbps;
        if (below) {
            if (!speedDropSince) speedDropSince = now;
            if (!speedLimitActive && now - speedDropSince >= speedLimitConfig.stableSeconds * 1000) {
                speedLimitActive = true;
            }
        } else {
            speedDropSince = null;
            speedLimitActive = false;
        }
        speedLimitMessage = speedLimitActive ? speedLimitText : '';
    };

    const updateProgressUi = () => {
        const now = Date.now();
        const progress = Math.round((completed / segments.length) * 100);
        if (progress > lastProgress || (now - lastUiUpdate > 1000)) {
            lastProgress = Math.max(lastProgress, progress);
            lastUiUpdate = now;
            const elapsedTime = (Date.now() - startTime) / 1000;
            let etaText = t('download.eta_calculating');
            if (elapsedTime > 2 && completed > 0) {
                const rate = completed / elapsedTime;
                const remainingSegments = segments.length - completed;
                const etaSeconds = remainingSegments / Math.max(rate, 0.0001);
                etaText = t('download.eta_remaining', { time: formatTime(etaSeconds) });
            }
            sendProgress(progress, etaText, totalBytes, currentSpeed, speedLimitMessage);
        }
    };

    const tryProcess = () => {
        while (results.has(processingIndex)) {
            const segData = results.get(processingIndex);
            results.delete(processingIndex);
            if (segData) {
                const sourceBytes = new Uint8Array(segData);
                transmuxer.push(sourceBytes);
                transmuxer.flush();
            }
            processingIndex++;
        }
    };

    const fetchSegmentWithRetry = async (index) => {
        let attempt = 0;
        while (attempt < maxRetries) {
            ensureActive();
            try {
                const startFetch = performance.now();
                const segRes = await fetch(segments[index], { signal });
                if (!segRes.ok) {
                    const err = new Error(t('download.segment_failed', { index, status: segRes.status }));
                    err.status = segRes.status;
                    throw err;
                }
                const data = await segRes.arrayBuffer();
                const timeMs = Math.max(1, performance.now() - startFetch);
                return { data, timeMs, sizeBytes: data.byteLength };
            } catch (err) {
                if (err.name === 'AbortError' || (err.message && err.message.includes('cancelled by user'))) {
                    throw new Error('cancelled by user');
                }
                attempt++;
                if (attempt >= maxRetries) return null;
                const status = err && typeof err.status === 'number' ? err.status : 0;
                const throttled = throttleStatuses.includes(status);
                const backoffBase = throttled ? 2000 : 1000;
                const backoff = Math.min(backoffBase * Math.pow(1.5, attempt), throttled ? 20000 : 15000);
                const jitter = Math.random() * 500;
                const delay = backoff + jitter;
                if (throttled) {
                    throttleScore = Math.min(throttleScore + 2, 10);
                    throttleDelayUntil = Math.max(throttleDelayUntil, Date.now() + delay);
                }
                sendStage(
                    t('download.connection_issue'),
                    t('download.retry_segment', {
                        index,
                        total: segments.length,
                        attempt,
                        max: maxRetries,
                        seconds: Math.round(delay / 1000)
                    }),
                    totalBytes,
                    0,
                    speedLimitMessage
                );
                await sleepWithAbort(delay);
            }
        }
        return null;
    };

    const canLaunch = () => {
        const maxBufferSegments = getBufferTarget();
        return pendingQueue.length > 0 && inFlight < desiredConnections && results.size < maxBufferSegments && writeBufferBytes < writeFlushThreshold * 3 && Date.now() >= throttleDelayUntil;
    };

    let resolveAll;
    let rejectAll;
    const allDone = new Promise((resolve, reject) => {
        resolveAll = resolve;
        rejectAll = reject;
    });

    const launch = () => {
        while (canLaunch()) {
            const index = retryQueue.length > 0 ? retryQueue.shift() : pendingQueue.shift();
            if (index === undefined) break;
            inFlight++;
            fetchSegmentWithRetry(index).then((segData) => {
                if (segData && segData.data) {
                    totalBytes += segData.sizeBytes;
                    successWindow++;
                    segBytesAvg = segBytesAvg ? (segBytesAvg * 0.9 + segData.sizeBytes * 0.1) : segData.sizeBytes;
                } else {
                    failed++;
                    errorWindow++;
                }
                results.set(index, segData ? segData.data : null);
                completed++;
                updateSpeed();
                tryProcess();
                updateProgressUi();
            }).catch((err) => {
                rejectAll(err);
            }).finally(() => {
                inFlight--;
                if (completed >= segments.length || (pendingQueue.length === 0 && inFlight === 0)) {
                    resolveAll();
                } else {
                    launch();
                }
            });
        }
    };

    const adjustInterval = setInterval(() => {
        const errorRate = errorWindow / Math.max(successWindow + errorWindow, 1);
        maxConnections = getDynamicMaxConnections();
        if (desiredConnections > maxConnections) {
            desiredConnections = maxConnections;
        }
        if (currentMbps > 0) {
            emaMbps = emaMbps ? (emaMbps * 0.8 + currentMbps * 0.2) : currentMbps;
            jitterRatio = Math.abs(currentMbps - emaMbps) / Math.max(emaMbps, 1);
        }
        updateSpeedLimitStatus(Date.now());
        if (results.size <= 1 && inFlight >= desiredConnections && currentMbps > 0 && currentMbps < emaMbps * 0.85) {
            throttleScore = Math.min(throttleScore + 1, 10);
        } else {
            throttleScore = Math.max(throttleScore - 1, 0);
        }
        if (throttleScore >= 3) {
            throttleDelayUntil = Math.max(throttleDelayUntil, Date.now() + 400);
            desiredConnections = Math.max(minConnections, desiredConnections - 1);
        }
        if (writeBufferBytes > writeFlushThreshold * 2) {
            desiredConnections = Math.max(minConnections, desiredConnections - 2);
        }
        if (currentMbps < targetMbps * 0.6 && errorRate < 0.1) {
            desiredConnections = Math.min(maxConnections, desiredConnections + 3);
        } else if (currentMbps < targetMbps * 0.85 && errorRate < 0.2) {
            desiredConnections = Math.min(maxConnections, desiredConnections + 2);
        } else if (errorRate > 0.25) {
            desiredConnections = Math.max(minConnections, desiredConnections - 3);
        } else if (currentMbps > targetMbps * 1.05 && errorRate === 0) {
            desiredConnections = Math.max(minConnections, desiredConnections - 1);
        }
        errorWindow = 0;
        successWindow = 0;
        updateProgressUi();
        launch();
    }, 1000);

    launch();
    try {
        await allDone;
    } finally {
        clearInterval(adjustInterval);
    }

    sendStage(t('download.finalizing_write'), t('download.please_wait'), totalBytes, 0, '');

    flushWriteBuffer();

    sendStage(t('download.assembling'), t('download.may_take_minute'), totalBytes, 0, '');

    if (useOpfs && opfsWritable) {
        await fileWriteChain;
        await opfsWritable.close();
        const file = await opfsHandle.getFile();
        const url = URL.createObjectURL(file);
        downloadId = await chrome.downloads.download({
            url,
            filename: fileName,
            saveAs: false
        });
        downloadUrls.set(downloadId, { url, opfsFileName });
    } else {
        const blobType = isAudioOnly ? 'audio/mp4' : 'video/mp4';
        const blob = new Blob(memoryChunks, { type: blobType });
        const url = URL.createObjectURL(blob);
        downloadId = await chrome.downloads.download({
            url,
            filename: fileName,
            saveAs: false
        });
        downloadUrls.set(downloadId, { url });
    }
    const state = activeDownloads.get(tabId);
    if (state) {
        state.downloadId = downloadId;
    }
    } catch (error) {
        if (opfsWritable) {
            try {
                await opfsWritable.abort();
            } catch (e) {}
        }
        if (!downloadId && opfsFileName) {
            await removeOpfsEntry(opfsFileName);
        }
        throw error;
    }
};

chrome.downloads.onChanged.addListener((delta) => {
    if (delta && delta.id && delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        const entry = downloadUrls.get(delta.id);
        if (entry) {
            const url = entry.url || entry;
            if (url) {
                URL.revokeObjectURL(url);
            }
            if (entry.opfsFileName) {
                removeOpfsEntry(entry.opfsFileName);
            }
            downloadUrls.delete(delta.id);
        }
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_PROGRESS') {
        setBadgeProgress(message.progress);
        return;
    }

    if (message.type === 'SHOW_NOTIFICATION') {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: message.title,
            message: message.message,
            priority: 2
        });
        return;
    }

    if (message.type === 'START_VOD_DOWNLOAD') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (!tabId) return;
        if (activeDownloads.has(tabId)) {
            const current = activeDownloads.get(tabId);
            current.controller.abort();
            activeDownloads.delete(tabId);
        }
        const controller = new AbortController();
        activeDownloads.set(tabId, { controller, downloadId: null });
        downloadVodInBackground(message.payload, tabId, controller).then(() => {
            sendToTab(tabId, { type: 'VOD_DONE' });
        }).catch((error) => {
            if (error && (error.name === 'AbortError' || (error.message && error.message.includes('cancelled by user')))) {
                sendToTab(tabId, { type: 'VOD_CANCELLED' });
            } else {
                sendToTab(tabId, { type: 'VOD_ERROR', error: error ? error.message : t('download.unknown_error') });
            }
        }).finally(() => {
            activeDownloads.delete(tabId);
        });
        return;
    }

    if (message.type === 'CANCEL_VOD_DOWNLOAD') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (!tabId) return;
        const current = activeDownloads.get(tabId);
        if (current) {
            if (current.downloadId) {
                chrome.downloads.cancel(current.downloadId).catch(() => {});
            }
            current.controller.abort();
        }
    }

    if (message.type === 'SR_SAVE_DATAURL') {
        const filename = message.filename || 'stream-recording.mp4';
        const dataUrl = message.dataUrl;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return;
        chrome.downloads.download({
            url: dataUrl,
            filename,
            saveAs: true
        }).catch(() => {});
        return;
    }

    if (message.type === 'SR_FETCH_SEGMENT') {
        (async () => {
            try {
                const url = message.url;
                if (typeof url !== 'string' || !url) {
                    throw new Error('invalid url');
                }
                const response = await fetch(url, { cache: 'no-store' });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const buffer = await response.arrayBuffer();
                sendResponse({ ok: true, buffer });
            } catch (e) {
                sendResponse({ ok: false, error: e && e.message ? e.message : 'fetch failed' });
            }
        })();
        return true;
    }

    if (message.type === 'SR_STREAM_INIT') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (!tabId) return;
        const filename = message.filename || 'stream-recording.mp4';
        srStreams.set(tabId, { chunks: [], filename });
        return;
    }

    if (message.type === 'SR_STREAM_APPEND') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (!tabId) return;
        const entry = srStreams.get(tabId) || { chunks: [], filename: message.filename || 'stream-recording.mp4' };
        const chunk = message.chunk;
        if (chunk && (chunk.byteLength || (chunk.buffer && chunk.buffer.byteLength))) {
            entry.chunks.push(new Uint8Array(chunk));
        }
        srStreams.set(tabId, entry);
        return;
    }

    if (message.type === 'SR_STREAM_ABORT') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (!tabId) return;
        srStreams.delete(tabId);
        return;
    }

    if (message.type === 'SR_STREAM_FINALIZE') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (!tabId) return;
        const action = message.action || 'keep';
        const entry = srStreams.get(tabId);
        if (!entry) return;
        const filename = message.filename || entry.filename || 'stream-recording.mp4';
        const initBuf = message.init ? new Uint8Array(message.init) : null;
        const parts = [];
        if (initBuf && initBuf.byteLength > 0) parts.push(initBuf);
        for (const c of entry.chunks) parts.push(c);
        srStreams.delete(tabId);
        if (action === 'keep') {
            const blob = new Blob(parts, { type: 'video/mp4' });
            const objectUrl = URL.createObjectURL(blob);
            chrome.downloads.download({
                url: objectUrl,
                filename,
                saveAs: true
            }).then((id) => {
                downloadUrls.set(id, { url: objectUrl });
            }).catch(() => {
                try { URL.revokeObjectURL(objectUrl); } catch (_) {}
            });
        }
        return;
    }
});
