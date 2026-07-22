const memoryChunks = []; // Deprecated: Only used as temporary buffer if needed, but we use IDB now.
// However, existing code might reference it. Let's remove its usage from transmuxer completely.

// Global variables for cleanup
let currentFileHandle = null;
let currentWritable = null;
let currentDownloadVideoId = null; // Track which video we are downloading
let currentDownloadPath = null;
let isDownloading = false;
let isStreamDownloading = false;
let streamDownloadState = {
    active: false,
    abortController: null,
    fileHandle: null,
    writable: null,
    downloadedBytes: 0,
    downloadedDurationSec: 0,
    downloadedSegments: new Set(),
    startedAt: 0,
    lastPlaylistUrl: '',
    lastSegmentAt: 0,
    idleCycles: 0,
    cancelAction: null
};
let cancelRequested = false;
let cancelInProgress = false;
let cancelCleanupDone = false;
let cancelUiRecovered = false;
let cancelForceTimer = null;
let currentDownloadAbort = null;
let currentDownloadButton = null;
let originalPageTitle = '';
let isFirefoxBackgroundDownload = false;
let backgroundDownloadProgress = 0;
const originalMediaStates = new Map();

const MAX_CONCURRENT_CONNECTIONS = 128;
const MIN_CONCURRENT_CONNECTIONS = 2;

const I18N = (() => {
    const supported = ['en', 'es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ru', 'ar', 'hi', 'ko', 'tr'];
    const defaultLang = 'en';
    const cache = {};
    let currentLang = null;
    let validated = false;
    const listeners = new Set();

    const getBrowserLang = () => {
        const navLang = navigator.language || navigator.userLanguage || defaultLang;
        const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navLang]);
        const raw = (langs[0] || defaultLang).toLowerCase();
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

    const setText = (el, key, vars, attr) => {
        if (!el) return;
        if (attr) el.setAttribute(attr, t(key, vars));
        else el.textContent = t(key, vars);
        el.dataset.kvdI18n = key;
        if (vars) el.dataset.kvdI18nVars = JSON.stringify(vars);
        if (attr) el.dataset.kvdI18nAttr = attr;
    };

    const updateAll = (root = document) => {
        const nodes = root.querySelectorAll('[data-kvd-i18n]');
        nodes.forEach((el) => {
            const key = el.dataset.kvdI18n;
            const vars = el.dataset.kvdI18nVars ? JSON.parse(el.dataset.kvdI18nVars) : undefined;
            const attr = el.dataset.kvdI18nAttr;
            if (attr) el.setAttribute(attr, t(key, vars));
            else el.textContent = t(key, vars);
        });
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

    ensure().then(() => updateAll()).catch(() => {});
    watch();

    return { t, ensure, setText, updateAll, onChange, getBrowserLang };
})();

const t = (key, vars) => I18N.t(key, vars);
const setI18nText = (el, key, vars, attr) => I18N.setText(el, key, vars, attr);
const updateI18nAll = (root) => I18N.updateAll(root);

I18N.onChange(() => updateI18nAll());

// --- Wake Lock / Inactivity Prevention ---
// Keeps the tab active during critical operations (Download / SR monitoring)
let wakeLockAudioContext = null;
let wakeLockOscillator = null;
let wakeLockCount = 0;

function preventTabInactivity() {
    wakeLockCount++;
    // console.log(`[WakeLock] Acquired. Count: ${wakeLockCount}`);
    
    if (wakeLockAudioContext) return; // Already active

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        wakeLockAudioContext = new AudioContext();
        wakeLockOscillator = wakeLockAudioContext.createOscillator();
        // Set frequency to 19.5kHz (near inaudible) to avoid annoyance
        wakeLockOscillator.frequency.value = 19500;
        
        const gainNode = wakeLockAudioContext.createGain();
        
        // Ultra-low volume (effectively silent) but keeps audio thread active
        gainNode.gain.value = 0.001; 
        
        wakeLockOscillator.connect(gainNode);
        gainNode.connect(wakeLockAudioContext.destination);
        wakeLockOscillator.start();
        
        // console.log('[WakeLock] Audio Context Started (Inactivity Prevention)');
    } catch (e) {
        console.error('[WakeLock] Failed to start:', e);
    }
}

function allowTabInactivity() {
    if (wakeLockCount > 0) wakeLockCount--;
    // console.log(`[WakeLock] Released. Count: ${wakeLockCount}`);

    if (wakeLockCount === 0 && wakeLockAudioContext) {
        try {
            if (wakeLockOscillator) {
                wakeLockOscillator.stop();
                wakeLockOscillator.disconnect();
            }
            wakeLockAudioContext.close();
        } catch (e) {
            console.error('[WakeLock] Cleanup error:', e);
        }
        wakeLockAudioContext = null;
        wakeLockOscillator = null;
        // console.log('[WakeLock] Audio Context Stopped');
    }
}
// -----------------------------------------

function mutePageAudio() {
    const media = document.querySelectorAll('video, audio');
    media.forEach(el => {
        if (!originalMediaStates.has(el)) {
            originalMediaStates.set(el, { muted: el.muted, volume: el.volume, paused: el.paused });
        }
        try {
            el.muted = true;
            el.volume = 0;
            if (typeof el.pause === 'function') el.pause();
        } catch (_) {}
    });
}

function restorePageAudio() {
    originalMediaStates.forEach((state, el) => {
        try {
            el.muted = state.muted;
            el.volume = state.volume;
            if (!state.paused && typeof el.play === 'function') {
                el.play().catch(() => {});
            }
        } catch (_) {}
    });
    originalMediaStates.clear();
}

const followButtonIconPaths = [
    'M23.2975 6.5L26.5 9.7025V14.6112L16 24.455L5.5 14.6112V9.7025L8.7025 6.5H10.4L16 10.98L21.6 6.5H23.2975ZM24.75 3H20.375L16 6.5L11.625 3H7.25L2 8.25V16.125L16 29.25L30 16.125V8.25L24.75 3Z',
    'M12.375 1.5H10.1875L8 3.25L5.8125 1.5H3.625L1 4.125V8.0625L8 14.625L15 8.0625V4.125L12.375 1.5Z'
];
let followAnimLockUntil = 0;
let unfollowAnimLockUntil = 0;
let followListenerAttached = false;
let ampAudioContext = null;
let ampGainNode = null;
let ampSourceNode = null;
let ampMediaEl = null;
let ampHideTimer = null;
let ampGainDb = 0;

function isFollowButton(btn) {
    if (!btn) return false;
    const path = btn.querySelector('svg path');
    if (!path) return false;
    return followButtonIconPaths.includes(path.getAttribute('d') || '');
}

function isUnfollowButton(btn) {
    if (!btn || !btn.classList) return false;
    if (!btn.classList.contains('bg-negative-base')) return false;
    if (!btn.classList.contains('text-negative-onNegative')) return false;
    if (!btn.classList.contains('state-layer-surface')) return false;
    return true;
}

function triggerFollowHearts(button) {
    const now = Date.now();
    if (now < followAnimLockUntil) return;
    followAnimLockUntil = now + 600;

    const rect = button.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;

    const container = document.createElement('div');
    container.className = 'kvd-follow-hearts';
    container.style.left = `${originX}px`;
    container.style.top = `${originY}px`;
    document.body.appendChild(container);

    const count = 36;
    for (let i = 0; i < count; i++) {
        const heart = document.createElement('div');
        heart.className = 'kvd-follow-heart';
        const x = (Math.random() * 2 - 1) * 420;
        const y = -(Math.random() * 520 + 140);
        const s = (Math.random() * 0.6 + 0.6).toFixed(2);
        const d = (Math.random() * 1.2 + 1.4).toFixed(2);
        const delay = (Math.random() * 0.2).toFixed(2);
        heart.style.setProperty('--x', `${x}px`);
        heart.style.setProperty('--y', `${y}px`);
        heart.style.setProperty('--s', s);
        heart.style.setProperty('--d', `${d}s`);
        heart.style.animationDelay = `${delay}s`;
        container.appendChild(heart);
    }

    setTimeout(() => {
        if (container.parentNode) container.remove();
    }, 3000);
}

function triggerUnfollowShatter() {
    const now = Date.now();
    if (now < unfollowAnimLockUntil) return;
    unfollowAnimLockUntil = now + 1500;
    if (document.body.dataset.kvdUnfollowAnimating === 'true') return;
    document.body.dataset.kvdUnfollowAnimating = 'true';
    const overlay = document.createElement('div');
    overlay.className = 'kvd-unfollow-broken-hearts';

    const heartCount = 28;
    for (let i = 0; i < heartCount; i++) {
        const heart = document.createElement('div');
        heart.className = 'kvd-broken-heart';
        const x = Math.random() * 100;
        const y = Math.random() * 100;
        const s = (Math.random() * 0.6 + 0.5).toFixed(2);
        const r = (Math.random() * 2 - 1) * 25;
        const d = 7;
        const delay = (Math.random() * 0.3).toFixed(2);
        heart.style.left = `${x}vw`;
        heart.style.top = `${y}vh`;
        heart.style.setProperty('--s', s);
        heart.style.setProperty('--r', `${r}deg`);
        heart.style.setProperty('--d', `${d}s`);
        heart.style.animationDelay = `${delay}s`;
        overlay.appendChild(heart);
    }

    document.body.appendChild(overlay);

    setTimeout(() => {
        if (overlay.parentNode) overlay.remove();
        delete document.body.dataset.kvdUnfollowAnimating;
    }, 7000);
}

function attachFollowAnimations() {
    if (followListenerAttached) return;
    followListenerAttached = true;
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (isFollowButton(btn)) {
            triggerFollowHearts(btn);
            return;
        }
        if (isUnfollowButton(btn)) {
            triggerUnfollowShatter();
        }
    }, true);
}

attachFollowAnimations();

function ensureAmpNodes(videoEl) {
    if (!videoEl) return;
    if (!ampAudioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        ampAudioContext = new AudioContext();
    }
    if (ampMediaEl !== videoEl) {
        if (ampSourceNode) ampSourceNode.disconnect();
        if (ampGainNode) ampGainNode.disconnect();
        ampMediaEl = videoEl;
        ampSourceNode = ampAudioContext.createMediaElementSource(videoEl);
        ampGainNode = ampAudioContext.createGain();
        ampGainNode.gain.value = Math.pow(10, ampGainDb / 20);
        ampSourceNode.connect(ampGainNode);
        ampGainNode.connect(ampAudioContext.destination);
    }
}

function injectAudioAmplifier() {
    if (document.getElementById('kvd-amp-container')) return;
    const controlBar = document.querySelector('.vjs-control-bar');
    if (!controlBar) return;

    const container = document.createElement('div');
    container.id = 'kvd-amp-container';
    container.className = 'kvd-amp-container';

    const icon = document.createElement('img');
    icon.className = 'kvd-amp-icon';
    icon.src = chrome.runtime.getURL('assets/amplifier.png');
    icon.alt = 'Amplifier';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '48';
    slider.step = '1';
    slider.value = '0';
    slider.className = 'kvd-amp-slider';

    slider.addEventListener('input', () => {
        const videoEl = document.querySelector('video');
        if (!videoEl) return;
        ensureAmpNodes(videoEl);
        if (!ampAudioContext || !ampGainNode) return;
        if (ampAudioContext.state === 'suspended') {
            ampAudioContext.resume().catch(() => {});
        }
        const db = parseFloat(slider.value);
        const gain = Math.pow(10, db / 20);
        ampGainDb = db;
        ampGainNode.gain.value = gain;
    });

    container.addEventListener('pointerenter', () => {
        if (ampHideTimer) clearTimeout(ampHideTimer);
        container.classList.add('kvd-amp-open');
    });

    container.addEventListener('pointerleave', () => {
        if (ampHideTimer) clearTimeout(ampHideTimer);
        ampHideTimer = setTimeout(() => {
            container.classList.remove('kvd-amp-open');
        }, 800);
    });

    container.appendChild(icon);
    container.appendChild(slider);
    controlBar.appendChild(container);
}

// IndexedDB Helper for robust cleanup and temporary storage
const DB_NAME = 'KickDownloaderDB';
const HANDLE_STORE = 'handles';
const CHUNK_STORE = 'chunks';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 2); // Version 2
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(HANDLE_STORE)) {
                db.createObjectStore(HANDLE_STORE);
            }
            if (!db.objectStoreNames.contains(CHUNK_STORE)) {
                db.createObjectStore(CHUNK_STORE, { autoIncrement: true });
            }
        };
    });
}

async function saveHandleToDB(handle) {
    try {
        const db = await openDB();
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put(handle, 'interrupted_download');
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error('DB Save Handle Error', e); }
}

async function clearHandleFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).delete('interrupted_download');
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error('DB Clear Handle Error', e); }
}

async function loadHandleFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        return new Promise((resolve, reject) => {
            const req = tx.objectStore(HANDLE_STORE).get('interrupted_download');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) { return null; }
}
async function saveChunkToDB(chunk) {
    try {
        const db = await openDB();
        const tx = db.transaction(CHUNK_STORE, 'readwrite');
        tx.objectStore(CHUNK_STORE).add(chunk);
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { 
        console.error('DB Save Chunk Error', e);
        throw e; // Critical error
    }
}

async function clearChunksFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(CHUNK_STORE, 'readwrite');
        tx.objectStore(CHUNK_STORE).clear();
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error('DB Clear Chunks Error', e); }
}

async function getAllChunksFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(CHUNK_STORE, 'readonly');
        const store = tx.objectStore(CHUNK_STORE);
        const request = store.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('DB Get All Chunks Error', e);
        return [];
    }
}

async function checkAndCleanup() {
    try {
        const db = await openDB();
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const request = tx.objectStore(HANDLE_STORE).get('interrupted_download');
        
        request.onsuccess = async () => {
            const handle = request.result;
            if (handle) {
                console.log('Found interrupted download handle');
                // Check permission without prompting
                try {
                    const perm = await handle.queryPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        if (handle.remove) {
                            await handle.remove();
                            console.log('Successfully removed interrupted file');
                        }
                    } else {
                        console.log('Permission not granted to remove file, skipping cleanup to avoid prompt');
                    }
                } catch(e) { console.log('Error checking permission', e); }
                // Clear from DB regardless
                clearHandleFromDB();
            }
        };
        
        // Also clear chunks on startup/cleanup
        clearChunksFromDB();
        
    } catch (e) { console.error('Cleanup Check Error', e); }
}

function showFirstKickVisitAlert() {
    if (location.hostname.startsWith('dashboard.')) return;
    chrome.storage.local.get(['kvd_badge_alert_shown'], async (result) => {
        if (result.kvd_badge_alert_shown) return;
        await I18N.ensure();
        alert(t('badge_alert.message'));
        chrome.storage.local.set({ kvd_badge_alert_shown: true });
    });
}

// Run cleanup check on load
checkAndCleanup();
showFirstKickVisitAlert();

// Cleanup on page reload/close
const handleUnload = () => {
    // Only delete file if we are in the middle of a download
    if (isDownloading && currentFileHandle) {
        // Prioritize removing the file directly.
        // We do NOT call writable.abort() here because it might lock the file 
        // or delay the removal process in the short window we have.
        // The browser will clean up the open handle/stream automatically on process exit,
        // but we need to ensure the file entry is removed from disk.
        if (currentFileHandle.remove) {
             currentFileHandle.remove().catch(e => console.error('Remove on unload failed', e));
        }
    }
    if (isStreamDownloading && streamDownloadState.fileHandle) {
        if (streamDownloadState.fileHandle.remove) {
            streamDownloadState.fileHandle.remove().catch(e => console.error('Stream remove on unload failed', e));
        }
    }
    if (isFirefoxBackgroundDownload && isDownloading) {
        try {
            chrome.runtime.sendMessage({ type: 'CANCEL_VOD_DOWNLOAD' }).catch(() => {});
        } catch (e) {}
    }
    if (isStreamerModeEnabled) {
        autoDlCleanup('page unload');
    }
};

window.addEventListener('beforeunload', handleUnload);
window.addEventListener('pagehide', handleUnload);

// Listen for messages from background script (Navigation detection) and Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // --- POPUP: Admin Check ---
    if (request.type === 'CHECK_ADMIN') {
        sendResponse({ isAdmin: isModerator() });
        return false;
    }
    
    // --- POPUP: Get Channel Slug ---
    if (request.type === 'GET_CHANNEL_SLUG') {
        sendResponse({ slug: getChannelSlug() });
        return false;
    }
    
    // --- POPUP: Send Chat ---
    if (request.type === 'SEND_CHAT') {
        sendChatMessage(request.message);
        sendResponse({ ok: true });
        return false;
    }

    if (request.type === 'SET_AUDIO_GAIN_DB') {
        ampGainDb = parseFloat(request.db);
        const videoEl = document.querySelector('video');
        if (videoEl) {
            ensureAmpNodes(videoEl);
            if (ampAudioContext && ampGainNode) {
                if (ampAudioContext.state === 'suspended') {
                    ampAudioContext.resume().catch(() => {});
                }
                const gain = Math.pow(10, ampGainDb / 20);
                ampGainNode.gain.value = gain;
            }
        }
        sendResponse({ ok: true, db: ampGainDb });
        return false;
    }

    if (request.type === 'GET_AUDIO_GAIN_DB') {
        sendResponse({ ok: true, db: ampGainDb });
        return false;
    }

    if (request.type === 'VOD_PROGRESS') {
        if (typeof request.progress === 'number') {
            backgroundDownloadProgress = request.progress;
            if (currentDownloadButton) {
                updateButton(currentDownloadButton, t('download.button.downloading'), true, request.progress);
            }
            const stageText = request.textKey ? t(request.textKey, request.textVars) : t('download.overlay.title');
            const etaText = request.etaKey ? t(request.etaKey, request.etaVars) : (request.etaText || '');
            const speedWarningText = request.speedWarningKey ? t(request.speedWarningKey, request.speedWarningVars) : (request.speedWarningText || '');
            updateOverlay(request.progress, stageText, etaText, request.currentBytes || 0, request.currentSpeed || 0, speedWarningText);
        }
        return false;
    }

    if (request.type === 'VOD_STAGE') {
        const stageText = request.textKey ? t(request.textKey, request.textVars) : (request.text || t('download.overlay.title'));
        const etaText = request.etaKey ? t(request.etaKey, request.etaVars) : (request.etaText || '');
        const speedWarningText = request.speedWarningKey ? t(request.speedWarningKey, request.speedWarningVars) : (request.speedWarningText || '');
        updateOverlay(backgroundDownloadProgress, stageText, etaText, request.currentBytes || 0, request.currentSpeed || 0, speedWarningText);
        return false;
    }

    if (request.type === 'VOD_GHOST_SEGMENTS') {
        const overlay = document.getElementById('kick-vod-overlay');
        if (overlay) {
            const sizeEl = overlay.querySelector('.size-text');
            if (sizeEl) {
                const ghostMsg = document.createElement('div');
                ghostMsg.style.color = '#00ff00';
                ghostMsg.style.fontSize = '0.8em';
                setI18nText(ghostMsg, 'download.ghost_segments', { count: request.count });
                sizeEl.parentNode.insertBefore(ghostMsg, sizeEl.nextSibling);
            }
        }
        return false;
    }

    if (request.type === 'VOD_DURATION_MISMATCH') {
        window.kickVodDurationMismatch = {
            api: request.api,
            actual: request.actual
        };
        updateOverlay(backgroundDownloadProgress);
        return false;
    }

    if (request.type === 'VOD_DONE') {
        sendNotification(t('download.done_title'), t('download.done_message', { video: getVideoId() || t('download.video_placeholder') }));
        if (currentDownloadButton) {
            updateButton(currentDownloadButton, t('download.button.complete'), false);
        }
        isDownloading = false;
        allowTabInactivity();
        cancelRequested = false;
        currentDownloadVideoId = null;
        currentDownloadPath = null;
        currentFileHandle = null;
        currentWritable = null;
        isFirefoxBackgroundDownload = false;
        backgroundDownloadProgress = 0;
        removeOverlay();
        restorePageAudio();
        setTimeout(() => {
            if (currentDownloadButton) {
                setButtonToDownload(currentDownloadButton);
            }
        }, 4000);
        return false;
    }

    if (request.type === 'VOD_CANCELLED') {
        if (currentDownloadButton) {
            updateButton(currentDownloadButton, t('download.button.cancelled'), false);
        }
        isDownloading = false;
        allowTabInactivity();
        cancelRequested = false;
        cancelInProgress = false;
        isFirefoxBackgroundDownload = false;
        backgroundDownloadProgress = 0;
        removeOverlay();
        restorePageAudio();
        return false;
    }

    if (request.type === 'VOD_ERROR') {
        if (currentDownloadButton) {
            updateButton(currentDownloadButton, t('download.button.error'), false);
        }
        isDownloading = false;
        allowTabInactivity();
        cancelRequested = false;
        cancelInProgress = false;
        isFirefoxBackgroundDownload = false;
        backgroundDownloadProgress = 0;
        removeOverlay();
        restorePageAudio();
        if (request.errorKey) {
            alert(t(request.errorKey, request.errorVars));
        } else {
            alert(t('download.failed', { error: request.error || t('download.unknown_error') }));
        }
        return false;
    }
});

// Function to extract video ID from URL
function getVideoId() {
    // 1. Try to find UUID explicitly (most robust)
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const uuidMatch = window.location.pathname.match(uuidRegex);
    if (uuidMatch) return uuidMatch[0];

    // 2. Fallback for simple alphanumeric IDs in /video/ or /videos/
    const videoMatch = window.location.pathname.match(/\/(?:video|videos)\/([a-zA-Z0-9-]+)/);
    return videoMatch ? videoMatch[1] : null;
}

// Function to fetch video data
async function fetchVideoData(videoId, options = {}) {
    try {
        const response = await fetch(`https://kick.com/api/v1/video/${videoId}`, {
            credentials: 'include',
            signal: options.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        console.log('API Video Data:', data); // Log full API response for debugging
        return data;
    } catch (error) {
        console.error('Error fetching video data:', error);
        return { error: error.message };
    }
}

// Helper to update button state
function updateButton(btn, text, disabled = false, progress = null) {
    btn.disabled = disabled;
    const isThumb = btn.classList.contains('kvd-thumb-btn');

    if (progress !== null) {
        btn.textContent = isThumb ? `${progress}%` : `${text} (${progress}%)`;
        btn.style.background = `linear-gradient(to right, #53fc18 ${progress}%, #333 ${progress}%)`;
        btn.style.color = progress > 50 ? '#000' : '#fff';
    } else {
        btn.textContent = text;
        btn.style.background = '';
        btn.style.color = '';
    }
}

function createDownloadSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("fill", "none");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke", "currentColor");
    
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", "M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 9.75l-3 3m0 0l3 3m-3-3h7.5M8.25 12H12");
    
    svg.appendChild(path);
    return svg;
}

function setButtonToDownload(btn) {
    btn.textContent = '';
    
    if (btn.classList.contains('kvd-thumb-btn')) {
        btn.innerHTML = '<span>⬇</span>';
        setI18nText(btn, 'download.button.label', undefined, 'title');
    } else {
        btn.appendChild(createDownloadSvg());
        const label = document.createElement('span');
        label.className = 'kvd-btn-text';
        setI18nText(label, 'download.button.label');
        btn.appendChild(label);
    }
    
    btn.style.background = '';
    btn.disabled = false;
}

// Helper to format bytes
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return t('units.zero_bytes');
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = t('units.bytes_sizes').split('|');
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function normalizeTitleText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function getMetaContent(name) {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    return el ? el.getAttribute('content') : '';
}

function getPageTitleClean() {
    const metaTitle = getMetaContent('og:title');
    const h1 = document.querySelector('h1');
    const raw = normalizeTitleText(metaTitle || (h1 && h1.textContent) || document.title || '');
    // Kick's VOD pages use a document.title template like
    // "{channel} - Watch the VOD on Kick", which doesn't match the generic
    // " - Kick..." suffix pattern below (the hyphen isn't right before
    // "Kick"). Strip that specific template first, then fall back to the
    // generic patterns for other page types.
    return raw
        .replace(/\s*-\s*Watch the VOD on Kick.*$/i, '')
        .replace(/\s*\|\s*Kick.*$/i, '')
        .replace(/\s*-\s*Kick.*$/i, '')
        .trim();
}

function getVodTitle() {
    // Kick reuses the same [data-testid="livestream-title"] element for the
    // VOD page's title bar (confirmed from live DOM), so use it the same
    // way getStreamTitle() does for live streams, before falling back to
    // parsing document.title (which is just a generic "{channel} - Watch
    // the VOD on Kick" template and doesn't contain the real title).
    const titleEl = document.querySelector('[data-testid="livestream-title"]');
    const realTitle = normalizeTitleText(titleEl ? (titleEl.getAttribute('title') || titleEl.textContent) : '');
    if (realTitle) return realTitle;
    return getPageTitleClean();
}

function getStreamTitle() {
    const liveTitleEl = document.querySelector('[data-testid="livestream-title"]');
    const liveTitle = normalizeTitleText(liveTitleEl ? liveTitleEl.textContent : '');
    if (liveTitle) return liveTitle;
    return getPageTitleClean();
}

function getChannelName() {
    const slug = getChannelSlug();
    if (slug) {
        const link = document.querySelector(`a[href="/${slug}"]`);
        const nameFromLink = link ? normalizeTitleText(link.textContent) : '';
        if (nameFromLink) return nameFromLink;
        return slug;
    }
    return '';
}

function sanitizeFileNamePart(input) {
    let name = normalizeTitleText(input);
    name = name.replace(/[\\/:*?"<>|]/g, '');
    name = name.replace(/[\x00-\x1f\x80-\x9f]/g, '');
    name = name.replace(/[. ]+$/g, '').trim();
    return name;
}

function buildFileName(base, ext) {
    const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
    let name = sanitizeFileNamePart(base);
    if (!name) name = 'kick-vod';
    const maxLen = 255;
    const maxBase = Math.max(1, maxLen - safeExt.length);
    if (name.length > maxBase) name = name.slice(0, maxBase).trim();
    name = name.replace(/[. ]+$/g, '').trim();
    if (!name) name = 'kick-vod';
    return `${name}${safeExt}`;
}

function buildAutoDlFileName() {
    const title = getStreamTitle();
    const channel = getChannelName();
    const base = ['BETTERKICK', title, channel].filter(Boolean).join(' - ');
    return buildFileName(base || 'BETTERKICK - kick-vod', '.mp4');
}

function buildVodFileName(title, ext) {
    const channel = getChannelName();
    const resolvedTitle = title || getVodTitle() || 'kick-vod';
    const base = ['BETTERKICK', resolvedTitle, channel].filter(Boolean).join(' - ');
    return buildFileName(base || 'BETTERKICK - kick-vod', ext);
}

// Helper to create and update overlay
function updateOverlay(progress, text = t('download.overlay.title'), etaText = '', currentBytes = 0, currentSpeed = 0, speedWarningText = '') {
    if (cancelInProgress || cancelRequested) return;
    let overlay = document.getElementById('kick-vod-overlay');
    
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'kick-vod-overlay';
        // Create overlay elements safely
        
        const h2 = document.createElement('h2');
        setI18nText(h2, 'download.overlay.title');
        overlay.appendChild(h2);

        const p = document.createElement('p');
        p.className = 'kvd-overlay-warning';
        setI18nText(p, 'download.overlay.warning');
        overlay.appendChild(p);

        const container = document.createElement('div');
        container.className = 'progress-bar-container';
        
        const fill = document.createElement('div');
        fill.className = 'progress-bar-fill';
        container.appendChild(fill);
        overlay.appendChild(container);

        const progressText = document.createElement('div');
        progressText.className = 'progress-text';
        setI18nText(progressText, 'download.progress', { progress: 0 });
        overlay.appendChild(progressText);

        const sizeText = document.createElement('div');
        sizeText.className = 'size-text';
        sizeText.style.fontSize = '0.9em';
        sizeText.style.color = '#fff';
        sizeText.style.marginTop = '5px';
        sizeText.style.fontWeight = 'bold';
        setI18nText(sizeText, 'download.size', { size: '0 MB' });
        overlay.appendChild(sizeText);

        const etaTextDiv = document.createElement('div');
        etaTextDiv.className = 'eta-text';
        etaTextDiv.style.marginTop = '10px';
        etaTextDiv.style.fontSize = '0.9em';
        etaTextDiv.style.color = '#ccc';
        overlay.appendChild(etaTextDiv);

        const speedWarning = document.createElement('div');
        speedWarning.className = 'kvd-speed-warning';
        speedWarning.style.marginTop = '6px';
        speedWarning.style.fontSize = '0.85em';
        speedWarning.style.color = '#ff6666';
        speedWarning.style.fontWeight = 'bold';
        speedWarning.style.display = 'none';
        overlay.appendChild(speedWarning);

        const disclaimer = document.createElement('div');
        disclaimer.className = 'disclaimer-text';
        disclaimer.style.marginTop = '15px';
        disclaimer.style.fontSize = '0.75em';
        disclaimer.style.color = '#ffcc00';
        disclaimer.style.maxWidth = 'none';
        disclaimer.style.lineHeight = '1.4';
        disclaimer.style.border = '1px solid #555';
        disclaimer.style.background = 'rgba(0,0,0,0.3)';
        disclaimer.style.padding = '10px';
        disclaimer.style.borderRadius = '5px';
        
        const strong1 = document.createElement('strong');
        setI18nText(strong1, 'download.disclaimer_note_label');
        disclaimer.appendChild(strong1);
        const noteText = document.createElement('span');
        setI18nText(noteText, 'download.disclaimer_note_text');
        disclaimer.appendChild(noteText);
        disclaimer.appendChild(document.createElement('br'));
        
        const strong2 = document.createElement('strong');
        setI18nText(strong2, 'download.disclaimer_note_label_secondary');
        disclaimer.appendChild(strong2);
        const noteTextSecondary = document.createElement('span');
        setI18nText(noteTextSecondary, 'download.disclaimer_note_text_secondary');
        disclaimer.appendChild(noteTextSecondary);
        disclaimer.appendChild(document.createElement('br'));

        const em = document.createElement('em');
        setI18nText(em, 'download.disclaimer_streamers_note');
        disclaimer.appendChild(em);
        
        disclaimer.style.whiteSpace = 'pre-wrap';
        overlay.appendChild(disclaimer);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'kvd-btn-cancel-overlay';
        setI18nText(cancelBtn, 'download.cancel_button');
        overlay.appendChild(cancelBtn);
        document.body.appendChild(overlay);
        enableDraggablePanel(overlay, 'download-overlay');

        mutePageAudio();

        // Bind cancel button
        overlay.querySelector('.kvd-btn-cancel-overlay').addEventListener('click', async () => {
             if (confirm(t('download.cancel_confirm'))) {
                 requestCancelDownload('user');
             }
        });
    }

    if (progress !== null) {
        overlay.querySelector('.progress-bar-fill').style.width = `${progress}%`;
        overlay.querySelector('.progress-text').textContent = t('download.progress', { progress });
        
        if (currentBytes > 0) {
            const sizeEl = overlay.querySelector('.size-text');
            if (sizeEl) {
                let sizeStr = t('download.size', { size: formatBytes(currentBytes) });
                if (currentSpeed > 0) {
                    const speedMb = (currentSpeed / 1024 / 1024).toFixed(1);
                    sizeStr += t('download.speed', { speed: speedMb });
                }
                sizeEl.textContent = sizeStr;
            }
        }
        
        const etaEl = overlay.querySelector('.eta-text');
        if (etaEl) etaEl.textContent = etaText;

        const speedWarningEl = overlay.querySelector('.kvd-speed-warning');
        if (speedWarningEl) {
            if (speedWarningText) {
                speedWarningEl.textContent = speedWarningText;
                speedWarningEl.style.display = 'block';
            } else {
                speedWarningEl.textContent = '';
                speedWarningEl.style.display = 'none';
            }
        }

        // Warn about duration mismatch if present
        const warningEl = overlay.querySelector('.duration-warning');
        if (!warningEl && window.kickVodDurationMismatch) {
             const warningDiv = document.createElement('div');
             warningDiv.className = 'duration-warning';
             warningDiv.style.color = '#ffaa00';
             warningDiv.style.fontSize = '0.85em';
             warningDiv.style.marginTop = '8px';
             warningDiv.style.fontWeight = 'bold';
             warningDiv.textContent = t('download.duration_warning', { api: window.kickVodDurationMismatch.api, actual: window.kickVodDurationMismatch.actual });
             warningDiv.style.whiteSpace = 'pre-wrap';
             
             // Insert after size text
             const sizeEl = overlay.querySelector('.size-text');
             if (sizeEl) sizeEl.parentNode.insertBefore(warningDiv, sizeEl.nextSibling);
        }

        // Send progress to background script for badge update
        try {
            chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', progress: progress }).catch(() => {});
        } catch (e) { /* ignore */ }
        
        // Update page title
        if (originalPageTitle && progress !== 100) {
             document.title = `[${progress}%] ${originalPageTitle}`;
        }
    }
    
    // Update main text if provided (e.g. "Finalizing...")
    if (text) {
         const h2 = overlay.querySelector('h2');
        if (h2) h2.textContent = text;
    }
}

function removeOverlay() {
    const overlay = document.getElementById('kick-vod-overlay');
    if (overlay) {
        // Clear badge
        try {
            chrome.runtime.sendMessage({ type: 'UPDATE_PROGRESS', progress: null }).catch(() => {});
        } catch (e) { /* ignore */ }

        // Restore title
        if (originalPageTitle) {
            document.title = originalPageTitle;
            originalPageTitle = '';
        }

        restorePageAudio();
        overlay.remove();
        document.body.style.overflow = ''; // Restore scroll
    }
}

function requestCancelDownload(reason, extra) {
    if (cancelInProgress) return;
    cancelInProgress = true;
    cancelRequested = true;
    cancelUiRecovered = false;
    console.log('[KVD Cancel] start', { reason, extra });

    const overlay = document.getElementById('kick-vod-overlay');
    if (overlay) {
        const h2 = overlay.querySelector('h2');
        if (h2) h2.textContent = t('download.cancelling');
    }

    if (currentDownloadAbort && !currentDownloadAbort.signal.aborted) {
        currentDownloadAbort.abort();
    }
    if (isFirefoxBackgroundDownload) {
        try {
            chrome.runtime.sendMessage({ type: 'CANCEL_VOD_DOWNLOAD' }).catch(() => {});
        } catch (e) {}
    }

    if (cancelForceTimer) clearTimeout(cancelForceTimer);
    cancelForceTimer = setTimeout(() => {
        forceCancelUiRecovery('timeout');
    }, 3000);

    finalizeCancelCleanup('request');
}

function forceCancelUiRecovery(reason, error) {
    if (cancelUiRecovered) return;
    cancelUiRecovered = true;
    console.log('[KVD Cancel] ui recovery', { reason, error });
    allowTabInactivity();
    cancelInProgress = false;
    isDownloading = false;
    if (currentDownloadButton) {
        currentDownloadButton.disabled = false;
        setButtonToDownload(currentDownloadButton);
    }
    removeOverlay();
    restorePageAudio();
}

async function finalizeCancelCleanup(reason, error) {
    if (cancelCleanupDone) return;
    cancelCleanupDone = true;
    console.log('[KVD Cancel] cleanup', { reason, error });
    forceCancelUiRecovery('cleanup', error);
    if (cancelForceTimer) {
        clearTimeout(cancelForceTimer);
        cancelForceTimer = null;
    }
    try {
        if (currentWritable) await currentWritable.abort().catch(() => {});
        if (currentFileHandle && currentFileHandle.remove) {
            await currentFileHandle.remove().catch(() => {});
        }
    } catch (e) {
        console.log('[KVD Cancel] cleanup error', e);
    }

    currentFileHandle = null;
    currentWritable = null;
    currentDownloadVideoId = null;
    currentDownloadPath = null;
    currentDownloadAbort = null;
    isFirefoxBackgroundDownload = false;
    backgroundDownloadProgress = 0;
    clearHandleFromDB();
    clearChunksFromDB();
    allowTabInactivity();
    cancelInProgress = false;
    isDownloading = false;
}

// Helper to patch MP4 headers (mvhd, tkhd, mdhd)
function patchMp4Header(initSegment, durationMs, avgBitrate = 0) {
    try {
        const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
        
        // Helper to read box
        const readBox = (pos) => {
            if (pos + 8 > view.byteLength) return null;
            const size = view.getUint32(pos);
            const type = String.fromCharCode(
                view.getUint8(pos + 4), view.getUint8(pos + 5),
                view.getUint8(pos + 6), view.getUint8(pos + 7)
            );
            return { size, type, offset: pos };
        };

        // Recursive box searcher
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

        // 0. Check for btrt injection (Windows Bitrate Fix)
        const moovCheck = findBox(0, view.byteLength, 'moov');
        if (moovCheck) {
            let trakPos = moovCheck.offset + 8;
            while (trakPos < moovCheck.offset + moovCheck.size) {
                const trak = readBox(trakPos);
                if (trak && trak.type === 'trak') {
                    const mdia = findBox(trak.offset + 8, trak.offset + trak.size, 'mdia');
                    if (mdia) {
                        const minf = findBox(mdia.offset + 8, mdia.offset + mdia.size, 'minf');
                        if (minf) {
                            const stbl = findBox(minf.offset + 8, minf.offset + minf.size, 'stbl');
                            if (stbl) {
                                const stsd = findBox(stbl.offset + 8, stbl.offset + stbl.size, 'stsd');
                                if (stsd) {
                                    const avc1 = findBox(stsd.offset + 12, stsd.offset + stsd.size, 'avc1');
                                    if (avc1) {
                                        const childrenStart = avc1.offset + 8 + 78;
                                        const btrt = findBox(childrenStart, avc1.offset + avc1.size, 'btrt');
                                        
                                        if (!btrt) {
                                            console.log('[Patch] btrt atom missing, injecting for Windows compatibility...');
                                            const newSize = initSegment.byteLength + 20;
                                            const newInit = new Uint8Array(newSize);
                                            const newView = new DataView(newInit.buffer);
                                            
                                            // Insert at end of avc1
                                            const insertPos = avc1.offset + avc1.size;
                                            
                                            // Copy before
                                            newInit.set(initSegment.subarray(0, insertPos), 0);
                                            
                                            // btrt (20 bytes)
                                            newView.setUint32(insertPos, 20);
                                            newView.setUint8(insertPos + 4, 0x62); // b
                                            newView.setUint8(insertPos + 5, 0x74); // t
                                            newView.setUint8(insertPos + 6, 0x72); // r
                                            newView.setUint8(insertPos + 7, 0x74); // t
                                            // Data will be filled in recursive call
                                            
                                            // Copy after
                                            newInit.set(initSegment.subarray(insertPos), insertPos + 20);
                                            
                                            // Update sizes of ancestors
                                            const ancestors = [moovCheck, trak, mdia, minf, stbl, stsd, avc1];
                                            ancestors.forEach(box => {
                                                const oldSize = view.getUint32(box.offset);
                                                newView.setUint32(box.offset, oldSize + 20);
                                            });
                                            
                                            return patchMp4Header(newInit, durationMs, avgBitrate);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                trakPos += trak.size;
            }
        }

        // 1. Find moov
        const moov = findBox(0, view.byteLength, 'moov');
        if (!moov) return initSegment;

        // 2. Patch mvhd (Movie Header)
        const mvhd = findBox(moov.offset + 8, moov.offset + moov.size, 'mvhd');
        let globalTimescale = 90000; // Default fallback
        
        if (mvhd) {
            const version = view.getUint8(mvhd.offset + 8);
            const timescaleOffset = mvhd.offset + 8 + (version === 0 ? 12 : 20);
            const durationOffset = timescaleOffset + 4;
            
            globalTimescale = view.getUint32(timescaleOffset);
            const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
            
            if (version === 0) {
                view.setUint32(durationOffset, durationUnits);
            } else {
                 view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                 view.setUint32(durationOffset + 4, durationUnits % 4294967296);
            }
        }

        // 3. Patch trak -> tkhd (Track Header) and mdia -> mdhd (Media Header)
        let trakPos = moov.offset + 8;
        while (trakPos < moov.offset + moov.size) {
            const box = readBox(trakPos);
            if (!box) break;
            if (box.type === 'trak') {
                // Patch tkhd
                const tkhd = findBox(box.offset + 8, box.offset + box.size, 'tkhd');
                if (tkhd) {
                    const version = view.getUint8(tkhd.offset + 8);
                    const durationOffset = tkhd.offset + 8 + (version === 0 ? 20 : 28);
                    
                    const durationUnits = Math.round((durationMs / 1000) * globalTimescale);

                    if (version === 0) {
                        view.setUint32(durationOffset, durationUnits);
                    } else {
                        view.setUint32(durationOffset, Math.floor(durationUnits / 4294967296));
                        view.setUint32(durationOffset + 4, durationUnits % 4294967296);
                    }
                }

                // Patch mdia -> mdhd
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

                    // Attempt to patch bitrate in minf -> stbl -> stsd -> avc1 -> btrt
                    const minf = findBox(mdia.offset + 8, mdia.offset + mdia.size, 'minf');
                    if (minf) {
                        const stbl = findBox(minf.offset + 8, minf.offset + minf.size, 'stbl');
                        if (stbl) {
                            const stsd = findBox(stbl.offset + 8, stbl.offset + stbl.size, 'stsd');
                            if (stsd) {
                                const avc1 = findBox(stsd.offset + 12, stsd.offset + stsd.size, 'avc1');
                                if (avc1) {
                                    const childrenStart = avc1.offset + 8 + 78;
                                    const btrt = findBox(childrenStart, avc1.offset + avc1.size, 'btrt');
                                    if (btrt) {
                                        const maxBitrateOffset = btrt.offset + 12;
                                        const avgBitrateOffset = btrt.offset + 16;
                                        
                                        const finalAvgBitrate = avgBitrate > 0 ? avgBitrate : 8000000;
                                        const finalMaxBitrate = Math.max(Math.round(finalAvgBitrate * 1.5), 12000000);
                                        
                                        view.setUint32(maxBitrateOffset, finalMaxBitrate);
                                        view.setUint32(avgBitrateOffset, finalAvgBitrate);
                                        console.log(`Patching btrt: Max=${finalMaxBitrate}, Avg=${finalAvgBitrate} (Source: ${avgBitrate > 0 ? 'Calculated' : 'Default'})`);
                                    }
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
}

function patchMp4DurationInPlace(initSegment, durationMs) {
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
        let globalTimescale = 90000;
        if (mvhd) {
            const version = view.getUint8(mvhd.offset + 8);
            const timescaleOffset = mvhd.offset + 8 + (version === 0 ? 12 : 20);
            const durationOffset = timescaleOffset + 4;
            globalTimescale = view.getUint32(timescaleOffset);
            const durationUnits = Math.round((durationMs / 1000) * globalTimescale);
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
}

// Helper to send desktop notifications (only if tab is hidden)
function sendNotification(title, message) {
    if (document.hidden) {
        chrome.runtime.sendMessage({
            type: 'SHOW_NOTIFICATION',
            title: title,
            message: message
        }).catch(e => console.log('Notification failed:', e));
    }
}

async function downloadSegments(streamUrl, btn, videoDurationMs, startSeconds = 0, endSeconds = -1, preOpenedHandle = null, forceMemory = false, explicitVideoId = null, explicitTitle = null, appendMode = false) {
    try {
        // Check for Audio Only mode (passed via URL hash)
        let isAudioOnly = false;
        if (streamUrl.endsWith('#audio_only')) {
            isAudioOnly = true;
            streamUrl = streamUrl.replace('#audio_only', '');
            console.log('Audio Only Mode Detected (M4A/AAC)');
        }
        const ext = isAudioOnly ? 'm4a' : 'mp4';
        if (isFirefoxBrowser() && typeof window.showSaveFilePicker !== 'function') {
            isDownloading = true;
            preventTabInactivity();
            cancelRequested = false;
            cancelInProgress = false;
            cancelCleanupDone = false;
            cancelUiRecovered = false;
            if (cancelForceTimer) {
                clearTimeout(cancelForceTimer);
                cancelForceTimer = null;
            }
            currentDownloadAbort = null;
            currentDownloadButton = btn;
            currentDownloadVideoId = explicitVideoId || getVideoId();
            if (!originalPageTitle) {
                originalPageTitle = document.title;
            }
            updateOverlay(0, t('download.overlay.title'), '', 0, 0, '');
            const fileName = buildVodFileName(explicitTitle || getVodTitle(), ext);
            isFirefoxBackgroundDownload = true;
            backgroundDownloadProgress = 0;
            chrome.runtime.sendMessage({
                type: 'START_VOD_DOWNLOAD',
                payload: {
                    streamUrl: streamUrl + (isAudioOnly ? '#audio_only' : ''),
                    videoDurationMs,
                    startSeconds,
                    endSeconds,
                    explicitVideoId,
                    explicitTitle: explicitTitle || getVodTitle(),
                    appendMode,
                    fileName,
                    channel: getChannelSlug()
                }
            }).catch(() => {});
            return;
        }

        isDownloading = true;
        preventTabInactivity();
        cancelRequested = false;
        cancelInProgress = false;
        cancelCleanupDone = false;
        cancelUiRecovered = false;
        if (cancelForceTimer) {
            clearTimeout(cancelForceTimer);
            cancelForceTimer = null;
        }
        currentDownloadAbort = new AbortController();
        currentDownloadButton = btn;
        currentDownloadVideoId = explicitVideoId || getVideoId();

        // Save original title only if not already saved (prevents recursion issues)
        if (!originalPageTitle) {
            originalPageTitle = document.title;
        }

        let handle = preOpenedHandle || currentFileHandle || await loadHandleFromDB();
        
        if (!forceMemory && !handle && typeof window.showSaveFilePicker === 'function') {
             try {
                const desc = isAudioOnly ? t('download.save_picker.m4a') : t('download.save_picker.mp4');
                 const mime = isAudioOnly ? { 'audio/mp4': ['.m4a'] } : { 'video/mp4': ['.mp4'] };
                 const suggestedName = buildVodFileName(explicitTitle || getVodTitle(), ext);
                 
                 handle = await window.showSaveFilePicker({
                    suggestedName: suggestedName,
                    types: [{
                        description: desc,
                        accept: mime,
                    }],
                });
                
                // Store globally immediately
                currentFileHandle = handle; 
                saveHandleToDB(handle); 
                
                // Show overlay AFTER picker to avoid visual glitch if user cancels picker
                updateOverlay(0, t('download.overlay.title'), '', 0, 0, '');
                
             } catch (pickerError) {
                 // User cancelled or error
                 console.log('User cancelled save picker or error:', pickerError);
                 isDownloading = false;
                 allowTabInactivity();
                 setButtonToDownload(btn);
                 return; // Stop execution
             }
        } else if (!handle) {
            // No API support or fallback needed later
            updateOverlay(0, t('download.overlay.title'), '', 0, 0, '');
        } else {
            // We have a handle (recursive call), just show overlay
             updateOverlay(0, t('download.overlay.title'), '', 0, 0, '');
        }
        // ------------------------------------------------------------------

        // Try to get duration from DOM if API failed (common in fresh VODs)
        if (!videoDurationMs || videoDurationMs === 0) {
            const videoEl = document.querySelector('video');
            if (videoEl && !isNaN(videoEl.duration) && videoEl.duration > 0) {
                videoDurationMs = Math.round(videoEl.duration * 1000);
                console.log(`Using DOM Video Duration as fallback: ${videoDurationMs}ms`);
            }
        }

        // 1. Fetch playlist with Cache Buster to avoid stale CDNs
        const fetchUrl = streamUrl + (streamUrl.includes('?') ? '&' : '?') + `time=${Date.now()}`;
        console.log(`Fetching playlist: ${fetchUrl}`);
        
        const response = await fetch(fetchUrl, { cache: 'no-store' });
        const playlistText = await response.text();
        
        // Simple parser for m3u8 to find segments
        const lines = playlistText.split('\n');
        let segments = [];
        let baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);

        console.log(`M3U8 URL: ${streamUrl}`);
        
        // Check for endlist tag
        const hasEndList = playlistText.includes('#EXT-X-ENDLIST');
        console.log(`Playlist has ENDLIST tag: ${hasEndList}`);

        // Parse Master Playlist to find best variant
        if (playlistText.includes('EXT-X-STREAM-INF')) {
            console.log('Master Playlist detected. Analyzing variants for best duration/quality...');
            const variants = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('EXT-X-STREAM-INF')) {
                    // Try to parse bandwidth
                    const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;
                    
                    // Try to parse resolution
                    const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                    const resolution = resMatch ? resMatch[1] : 'unknown';

                    // The URL is usually on the next line
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
                // Check durations of all variants to find the most complete one
                updateButton(btn, 'Analyzing qualities...', true);
                console.log(`Found ${variants.length} variants. Checking durations...`);
                
                const variantAnalysis = await Promise.all(variants.map(async (v) => {
                    try {
                        const vUrl = v.url + (v.url.includes('?') ? '&' : '?') + `time=${Date.now()}`;
                        const res = await fetch(vUrl, { cache: 'no-store' });
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
                        console.error(`Error checking variant ${v.resolution}:`, e);
                        return { ...v, duration: 0, segments: 0 };
                    }
                }));

                // Sort by Duration DESC, then Bandwidth DESC
                variantAnalysis.sort((a, b) => {
                    // Give a 5-second tolerance for duration differences
                    if (Math.abs(b.duration - a.duration) > 5) {
                        return b.duration - a.duration; // Prefer longer video
                    }
                    return b.bandwidth - a.bandwidth; // Then prefer higher quality
                });

                const bestVariant = variantAnalysis[0];
                console.log('Variant Analysis Results:', variantAnalysis);
                console.log(`Selected Best Variant: ${bestVariant.resolution} (${bestVariant.bandwidth}bps) - Duration: ${bestVariant.duration}s`);

                let targetUrl = bestVariant.url;
                if (isAudioOnly) targetUrl += '#audio_only';

                return downloadSegments(targetUrl, btn, videoDurationMs, startSeconds, endSeconds, handle, forceMemory, explicitVideoId, explicitTitle, appendMode);
            }
            
            // Fallback to simple search if parsing failed
            const m3u8Match = lines.find(l => l.endsWith('.m3u8') && !l.startsWith('#'));
            if (m3u8Match) {
                let newUrl = m3u8Match.startsWith('http') ? m3u8Match : baseUrl + m3u8Match;
                console.log(`Fallback: Found .m3u8 link, redirecting to: ${newUrl}`);
                if (isAudioOnly) newUrl += '#audio_only';
                return downloadSegments(newUrl, btn, videoDurationMs, startSeconds, endSeconds, handle, forceMemory, explicitVideoId, explicitTitle, appendMode);
            }
        }

        // Parse segments and calculate duration if needed
        let calculatedDuration = 0;
        let segmentDurations = [];
        let totalPlaylistDuration = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                const durationStr = line.substring(8).split(',')[0];
                const d = parseFloat(durationStr);
                
                if (!isNaN(d)) {
                    // Check if we should include this segment based on start/end time
                    // The segment starts at totalPlaylistDuration and ends at totalPlaylistDuration + d
                    const segStart = totalPlaylistDuration;
                    const segEnd = totalPlaylistDuration + d;
                    totalPlaylistDuration += d;
                    
                    let shouldInclude = true;
                    
                    if (segEnd <= startSeconds) shouldInclude = false; // Completely before start
                    if (endSeconds !== -1 && segStart >= endSeconds) shouldInclude = false; // Completely after end
                    
                    if (shouldInclude) {
                        calculatedDuration += d;
                        segmentDurations.push(d);
                        // Mark that we want the next URL
                        lines[i] = '#INCLUDE_NEXT'; 
                    } else {
                        lines[i] = '#SKIP_NEXT';
                    }
                }
            }

            if (line && !line.startsWith('#') && !line.startsWith('http') && !line.includes('/')) {
                 // Might be a weird line, but usually URL
            }
            
            // If the line is a URL (not starting with #), check if we marked it
            if (line && !line.startsWith('#')) {
                // We need to look back at the previous EXTINF to see if we marked it
                // But we modified lines[i] in the previous block if it was EXTINF.
                // The URL is usually at i+1 relative to EXTINF.
                // But here we are iterating i.
                
                // Let's look at the PREVIOUS line(s) to find the decision.
                // Since we modify the EXTINF line to #INCLUDE_NEXT or #SKIP_NEXT, we can check that.
                
                let prevDecision = '#INCLUDE_NEXT'; // Default to include if no EXTINF found (unlikely)
                for (let j = i - 1; j >= 0; j--) {
                    const prevLineRaw = lines[j];
                    const prevLineTrimmed = prevLineRaw.trim();
                    
                    if (!prevLineTrimmed) continue; // Skip empty lines
                    
                    if (prevLineRaw === '#INCLUDE_NEXT') {
                        prevDecision = '#INCLUDE_NEXT';
                        break;
                    }
                    if (prevLineRaw === '#SKIP_NEXT') {
                        prevDecision = '#SKIP_NEXT';
                        break;
                    }
                    if (prevLineTrimmed.startsWith('#')) continue; // Skip other comments
                    break; // Found another URL or empty line, stop
                }

                if (prevDecision === '#INCLUDE_NEXT') {
                     segments.push(line.startsWith('http') ? line : baseUrl + line);
                }
            }
        }
        
        console.log(`Parsed ${segments.length} segments. Total Calculated Duration: ${calculatedDuration}s. Trim Request: ${startSeconds}-${endSeconds}`);

        // --- GHOST SEGMENT DISCOVERY ---
        // Attempt to find hidden segments not listed in the M3U8 (common issue with Kick VODs)
        // Only run if we are NOT trimming (downloading full VOD)
        if (segments.length > 0 && endSeconds === -1) {
            const lastSegmentUrl = segments[segments.length - 1];
            const lastSlashIdx = lastSegmentUrl.lastIndexOf('/');
            
            if (lastSlashIdx !== -1) {
                const baseUrlForSeg = lastSegmentUrl.substring(0, lastSlashIdx + 1);
                const fileName = lastSegmentUrl.substring(lastSlashIdx + 1);
                
                // Match number in filename (e.g. segment-59.ts or 59.ts)
                const match = fileName.match(/^(.*?)(\d+)(\.[^.?]+)(\?.*)?$/);
                if (match) {
                    const prefix = match[1];
                    let currentNum = parseInt(match[2], 10);
                    const suffix = match[3];
                    const query = match[4] || '';
                    
                    const MAX_GHOST_SEGMENTS = 50; // Try up to 50 extra segments (approx 8 mins)
                    let ghostCount = 0;

                    console.log(`Attempting to discover ghost segments starting from ${currentNum + 1}...`);
                    updateButton(btn, t('download.checking_hidden_segments'), true);

                    const MAX_CONSECUTIVE_ERRORS = 5;
                    const GHOST_BATCH_SIZE = 5;

                    // Probe a batch of consecutive segment numbers in parallel instead of
                    // one at a time, and use a Range request for just the first byte
                    // instead of a full GET, since we only need to confirm the segment
                    // exists (not download its whole body). This was previously making
                    // up to ~55 sequential full-segment downloads on every VOD download,
                    // adding real latency (and wasted bandwidth) before the progress bar
                    // even started moving.
                    let consecutiveErrors = 0;
                    outer:
                    while (ghostCount < MAX_GHOST_SEGMENTS && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
                        const batchNums = [];
                        for (let i = 0; i < GHOST_BATCH_SIZE && (ghostCount + batchNums.length) < MAX_GHOST_SEGMENTS; i++) {
                            batchNums.push(++currentNum);
                        }
                        if (batchNums.length === 0) break;

                        const batchResults = await Promise.all(batchNums.map(async (num) => {
                            const nextSegName = `${prefix}${num}${suffix}${query}`;
                            const nextSegUrl = `${baseUrlForSeg}${nextSegName}`;
                            try {
                                const checkRes = await fetch(nextSegUrl, { method: 'GET', headers: { 'Range': 'bytes=0-0' } });
                                // A CDN that ignores Range still returns 200 with the full
                                // body, which is fine — 206/200 both confirm existence.
                                return { num, url: nextSegUrl, ok: checkRes.ok };
                            } catch (e) {
                                console.log(`Ghost segment search error at ${num}:`, e);
                                return { num, url: nextSegUrl, ok: false };
                            }
                        }));

                        // Preserve original ordering/semantics: walk results in ascending
                        // segment order so we stop at the first gap, same as before.
                        batchResults.sort((a, b) => a.num - b.num);
                        for (const result of batchResults) {
                            if (result.ok) {
                                console.log(`Found ghost segment: ${result.url}`);
                                segments.push(result.url);
                                // Assume 10s duration for ghost segments (standard HLS target)
                                calculatedDuration += 10;
                                ghostCount++;
                                consecutiveErrors = 0;
                            } else {
                                console.log(`Ghost segment check failed at ${result.num}`);
                                consecutiveErrors++;
                                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break outer;
                            }
                        }
                    }
                    
                    if (ghostCount > 0) {
                        console.log(`Added ${ghostCount} ghost segments. New Duration: ${calculatedDuration}s`);
                        // Update UI to show we found extra content
                        const overlay = document.getElementById('kick-vod-overlay');
                        if (overlay) {
                             const sizeEl = overlay.querySelector('.size-text');
                             if (sizeEl) {
                                 const ghostMsg = document.createElement('div');
                                 ghostMsg.style.color = '#00ff00';
                                 ghostMsg.style.fontSize = '0.8em';
                                ghostMsg.textContent = t('download.hidden_segments_found', { count: ghostCount });
                                 sizeEl.parentNode.insertBefore(ghostMsg, sizeEl.nextSibling);
                             }
                        }
                    }
                }
            }
        }
        // --- END GHOST SEGMENT DISCOVERY ---

        // Helper to format duration
        const formatDuration = (ms) => {
            const s = Math.round(ms / 1000);
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return `${m}:${sec.toString().padStart(2, '0')}`;
        };

        // Reset global mismatch variable
        window.kickVodDurationMismatch = null;

        // Use calculated duration if API duration is missing or 0
        // ALWAYS prefer calculated duration from M3U8 if available, as API duration is often inaccurate/stale
        if (calculatedDuration > 0) {
             const diff = Math.abs(videoDurationMs - calculatedDuration * 1000);
             if (diff > 10000) { // If difference is more than 10 seconds
                 console.log(`Duration mismatch! API/DOM: ${videoDurationMs}ms, M3U8: ${calculatedDuration * 1000}ms. Using M3U8 duration.`);
                 
                 // Set global variable for UI warning
                 window.kickVodDurationMismatch = {
                     api: formatDuration(videoDurationMs),
                     actual: formatDuration(calculatedDuration * 1000)
                 };
                 
                 videoDurationMs = calculatedDuration * 1000;
             } else if (!videoDurationMs || videoDurationMs === 0) {
                 videoDurationMs = calculatedDuration * 1000;
                 console.log(`Calculated duration from M3U8: ${videoDurationMs} ms`);
             }
        } else if (videoDurationMs > 0) {
            console.log(`Using API provided duration: ${videoDurationMs} ms`);
        }

        if (segments.length === 0) {
            throw new Error(t('download.no_segments'));
        }

        // 2. Initialize Writable Stream or Fallback
        // (File Picker was already handled at the start of function)
        // Re-use the 'handle' variable from the function scope (argument)
        let writable = null;
        let memoryChunks = [];
        const useMemoryFallback = forceMemory === true;
        
        try {
            if (handle) {
                // We have a handle from the user gesture at start
                currentDownloadVideoId = getVideoId(); // Track video ID for navigation detection
                writable = await handle.createWritable();
            } else {
                console.warn('File System Access API not supported or Handle missing. Using IDB fallback.');
                // Update overlay to warn user about memory usage
                const overlayH2 = document.querySelector('#kick-vod-overlay h2');
                if (overlayH2 && !overlayH2.dataset.fallbackMode) {
                     overlayH2.textContent += useMemoryFallback ? ` (${t('download.fallback.memory_mode')})` : ` (${t('download.fallback.cache_mode')})`;
                     overlayH2.dataset.fallbackMode = '1';
                }
                
                // Add permanent warning about Fallback usage
                const progressBarContainer = document.querySelector('.progress-bar-container');
                if (progressBarContainer && !document.querySelector('.kvd-fallback-warning')) {
                    const ramWarning = document.createElement('div');
                    ramWarning.className = 'kvd-fallback-warning'; // Add class to prevent duplicates
                    ramWarning.style.color = '#ffaa00'; // Orange warning
                    ramWarning.style.fontWeight = 'bold';
                    ramWarning.style.marginTop = '10px';
                    ramWarning.style.padding = '10px';
                    ramWarning.style.border = '1px solid #ffaa00';
                    ramWarning.style.backgroundColor = 'rgba(255, 170, 0, 0.1)';
                    ramWarning.textContent = useMemoryFallback
                        ? t('download.fallback.memory_info')
                        : t('download.fallback.cache_info');
                    ramWarning.style.whiteSpace = 'pre-wrap';
                    
                    progressBarContainer.parentNode.insertBefore(ramWarning, progressBarContainer.nextSibling);
                }
            }
        } catch (pickerError) {
             // User cancelled picker or other error
             isDownloading = false;
             removeOverlay();
             throw pickerError;
        }
        
        // 3. Initialize Transmuxer
        // We set keepOriginalTimestamps to false (default) to ensure the video starts at 0
        // instead of the original stream timestamp (which could be hours into the recording).
        // If Audio Only, set remux: false to separate streams and we will only capture audio
        const transmuxer = new muxjs.mp4.Transmuxer({
            keepOriginalTimestamps: false,
            remux: !isAudioOnly // If isAudioOnly is true, remux is false (separate streams)
        });

        let initSegmentWritten = appendMode === true;
        // Capture first segment duration for bitrate calculation
        const firstSegmentDuration = segmentDurations.length > 0 ? segmentDurations[0] : 0;
        
        // Track IDB write promises to prevent race condition at the end
        const writePromises = [];
        // Track File System writes sequentially to prevent race conditions in Edge/Chrome
        let fileWriteChain = Promise.resolve();
        const writeBuffer = [];
        let writeBufferBytes = 0;
        const writeFlushThreshold = 4 * 1024 * 1024;
        const writePerf = { flushCount: 0, flushBytes: 0, maxBufferBytes: 0 };
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
            writePerf.flushCount += 1;
            writePerf.flushBytes += combined.byteLength;
            writeBufferBytes = 0;
            if (writable) {
                fileWriteChain = fileWriteChain.then(() => writable.write(combined));
            } else if (useMemoryFallback) {
                memoryChunks.push(combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength));
            } else {
                writePromises.push(saveChunkToDB(combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength)));
            }
        };
        const enqueueWrite = (buffer) => {
            writeBuffer.push(buffer);
            writeBufferBytes += buffer.byteLength;
            writePerf.maxBufferBytes = Math.max(writePerf.maxBufferBytes, writeBufferBytes);
            if (writeBufferBytes >= writeFlushThreshold) {
                flushWriteBuffer();
            }
        };

        transmuxer.on('data', async (segment) => {
            // Filter: If Audio Only, ignore non-audio segments
            if (isAudioOnly) {
                if (segment.type !== 'audio') return;
                console.log('Writing Audio-Only Segment:', segment);
            }

            // Write init segment (ftyp + moov) only once
            if (!initSegmentWritten) {
                 let initSeg = new Uint8Array(segment.initSegment);
                 
                 // Calculate estimated bitrate from first segment
                 let estimatedBitrate = 0;
                 if (segment.data && segment.data.byteLength > 0 && firstSegmentDuration > 0) {
                     // Bitrate = bits / seconds
                     estimatedBitrate = Math.round((segment.data.byteLength * 8) / firstSegmentDuration);
                     console.log(`Calculated Bitrate: ${estimatedBitrate} bps (Size: ${segment.data.byteLength} bytes, Dur: ${firstSegmentDuration}s)`);
                 }

                 // Use calculated duration (from trimming logic) if available, otherwise fallback to provided
                 const targetDurationMs = (calculatedDuration > 0) ? calculatedDuration * 1000 : videoDurationMs;
                 
                 if (targetDurationMs > 0) {
                     initSeg = patchMp4Header(initSeg, targetDurationMs, estimatedBitrate);
                 } else {
                     console.warn('Invalid video duration, skipping header patch');
                 }
                 
                enqueueWrite(initSeg);
                 initSegmentWritten = true;
            }
            // Write media segment (moof + mdat)
            const mediaSeg = new Uint8Array(segment.data);
            enqueueWrite(mediaSeg);
        });

        // 4. Download and process segments
        updateButton(btn, t('download.button.downloading'), true, 0);
        
        console.log(`Video Data Duration: ${videoDurationMs} ms`);

        const startTime = Date.now();
        let lastProgress = 0;
        let totalBytes = 0;
        
        // Speed calculation variables
        let currentSpeed = 0;
        let lastSpeedTime = Date.now();
        let lastSpeedBytes = 0;
        let lastUiUpdate = 0;

        // Helper to format time (seconds) to MM:SS or HH:MM:SS
        const formatTime = (seconds) => {
            if (!isFinite(seconds) || seconds < 0) return '--:--';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        let maxConnections = MAX_CONCURRENT_CONNECTIONS;
        const minConnections = MIN_CONCURRENT_CONNECTIONS;
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
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
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
                const signal = currentDownloadAbort && currentDownloadAbort.signal;
                if (signal && signal.aborted) {
                    reject(new Error('cancelled by user'));
                    return;
                }
                const id = setTimeout(resolve, ms);
                if (signal) {
                    signal.addEventListener('abort', () => {
                        clearTimeout(id);
                        reject(new Error('cancelled by user'));
                    }, { once: true });
                }
            });
        };

        const ensureActive = () => {
            if (cancelRequested || (currentDownloadAbort && currentDownloadAbort.signal.aborted)) {
                throw new Error('cancelled by user');
            }
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
                updateButton(btn, t('download.button.downloading'), true, progress);
                updateOverlay(progress, t('download.overlay.title'), etaText, totalBytes, currentSpeed, speedLimitMessage);
            }
        };

        // How many segments to accumulate before flushing the transmuxer.
        // Flushing after every single segment forces mux.js to close a
        // separate MP4 fragment per .ts file; when segments have irregular
        // durations (common when the streamer's connection was unstable),
        // the audio/video timestamp rounding at each fragment boundary adds
        // up and produces a growing A/V desync over the length of the VOD.
        // Batching segments before flushing lets mux.js keep a single
        // continuous timeline across them, eliminating that drift.
        const TRANSMUX_FLUSH_BATCH_SIZE = 15;
        let segmentsSinceFlush = 0;

        const tryProcess = () => {
            while (results.has(processingIndex)) {
                const segData = results.get(processingIndex);
                results.delete(processingIndex);
                if (segData) {
                    const sourceBytes = new Uint8Array(segData);
                    transmuxer.push(sourceBytes);
                    segmentsSinceFlush++;
                    if (segmentsSinceFlush >= TRANSMUX_FLUSH_BATCH_SIZE) {
                        transmuxer.flush();
                        segmentsSinceFlush = 0;
                    }
                }
                processingIndex++;
            }
        };

        const fetchSegmentWithRetry = async (index) => {
            let attempt = 0;
            while (attempt < maxRetries) {
                ensureActive();
                try {
                    const signal = currentDownloadAbort ? currentDownloadAbort.signal : undefined;
                    const startFetch = performance.now();
                    const segRes = await fetch(segments[index], { signal });
                    if (!segRes.ok) {
                        const err = new Error(`Failed to fetch segment ${index}, status: ${segRes.status}`);
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
                    console.error(`Segment ${index} error ${attempt}/${maxRetries}:`, err);
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
                    updateOverlay(lastProgress, t('download.connection_issue'), t('download.retrying_segment', { index, total: segments.length, attempt, maxRetries, wait: Math.round(delay / 1000) }), totalBytes, 0, speedLimitMessage);
                    await sleepWithAbort(delay);
                }
            }
            return null;
        };

        const canLaunch = () => {
            const maxBufferSegments = getBufferTarget();
            return pendingQueue.length > 0 && inFlight < desiredConnections && results.size < maxBufferSegments && writeBufferBytes < writeFlushThreshold * 3 && !cancelRequested && !(currentDownloadAbort && currentDownloadAbort.signal.aborted) && Date.now() >= throttleDelayUntil;
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
            console.log(`[KVD Download] throughput ${currentMbps.toFixed(1)} Mbps, ema ${emaMbps ? emaMbps.toFixed(1) : '0.0'} Mbps, jitter ${(jitterRatio * 100).toFixed(0)}%, concurrency ${desiredConnections}/${maxConnections}, inFlight ${inFlight}, buffer ${results.size}/${getBufferTarget()}, io ${Math.round(writeBufferBytes / 1024 / 1024)} MB, failed ${failed}, throttle ${throttleScore}`);
            launch();
        }, 1000);

        launch();
        try {
            await allDone;
        } finally {
            clearInterval(adjustInterval);
        }

        // 100% reached, but still writing/closing
        updateOverlay(100, t('download.finalizing_title'), t('download.please_wait'), totalBytes, 0, '');

        // Flush any segments pushed since the last batch flush (see
        // TRANSMUX_FLUSH_BATCH_SIZE above) so the tail of the VOD isn't lost.
        if (segmentsSinceFlush > 0) {
            transmuxer.flush();
            segmentsSinceFlush = 0;
        }

        flushWriteBuffer();

        if (writable) {
            // Wait for all pending writes to complete
            console.log('Waiting for pending file writes to complete...');
            await fileWriteChain;
            
            await writable.close();
        } else {
            // Memory fallback: Create blob and trigger download
            console.log(useMemoryFallback ? 'Finalizing memory download... assembling from RAM' : 'Finalizing memory download... reading from IDB');
            updateOverlay(100, t('download.assembling_title'), t('download.assembling_wait'), totalBytes, 0, '');
            
            // Add spinner
            const overlay = document.getElementById('kick-vod-overlay');
            if (overlay) {
                let spinner = overlay.querySelector('.kvd-spinner');
                if (!spinner) {
                    spinner = document.createElement('div');
                    spinner.className = 'kvd-spinner';
                    // Insert before text
                    const etaEl = overlay.querySelector('.eta-text');
                    if (etaEl) etaEl.parentNode.insertBefore(spinner, etaEl);
                }
            }

            // Wait for all IDB writes to complete
            if (!useMemoryFallback && writePromises.length > 0) {
                console.log(`Waiting for ${writePromises.length} pending writes...`);
                await Promise.all(writePromises);
            }
            
            // Read chunks from IDB
            const chunks = useMemoryFallback ? memoryChunks : await getAllChunksFromDB();
            
            if (chunks.length === 0) {
                 console.error('No chunks found in IDB after download!');
                 alert(t('download.empty_error'));
            }
            
            const blobType = isAudioOnly ? 'audio/mp4' : 'video/mp4';
            const blob = new Blob(chunks, { type: blobType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            const fallbackName = buildVodFileName(explicitTitle || getVodTitle(), ext);
            a.download = fallbackName;
            document.body.appendChild(a);
            a.click();

            // Removed manual alert and reload as requested
            // alert("When the download finishes, reload the page or close the tab.\n\nCuando la descarga finalice, recarga la página o cierra la pestaña.");
            
            // Cleanup after a delay
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                clearChunksFromDB(); // Free disk space
                
                // No auto-reload
                // window.location.reload();
            }, 30000); // Increased timeout to give time for large file assembly/download start
        }
        
        const totalSeconds = (Date.now() - startTime) / 1000;
        const avgFlushBytes = writePerf.flushCount ? (writePerf.flushBytes / writePerf.flushCount) : 0;
        console.log(`[KVD Perf] time ${totalSeconds.toFixed(1)}s, avgFlush ${formatBytes(avgFlushBytes)}, maxWriteBuffer ${formatBytes(writePerf.maxBufferBytes)}, flushes ${writePerf.flushCount}`);

        sendNotification(t('download.done_title'), t('download.done_message', { video: getVideoId() || t('download.video_placeholder') }));
        chrome.runtime.sendMessage({
            type: 'DISCORD_WEBHOOK_NOTIFY',
            event: 'vod_complete',
            data: {
                channel: getChannelSlug() || '',
                title: explicitTitle || getVodTitle() || '',
                duration: formatDuration(videoDurationMs),
                size: formatBytes(totalBytes),
                url: window.location.href
            }
        }).catch(() => {});
        updateButton(btn, t('download.button.complete'), false);
        isDownloading = false;
        allowTabInactivity();
        cancelRequested = false;
        currentDownloadVideoId = null;
        currentDownloadPath = null;
        currentFileHandle = null; // Prevent deletion on reload
        currentWritable = null;
        clearHandleFromDB();
        removeOverlay(); // Remove overlay on success
        
        // Restore audio after successful download (before reload)
        restorePageAudio();

        setTimeout(async () => {
             setButtonToDownload(btn);
             // Force reload to clear memory/state and prevent bugs
             try {
                 await clearChunksFromDB(); 
             } catch (e) { console.error(e); }
             window.location.reload();
        }, 4000);

    } catch (error) {
        console.error('Download failed:', error);

        if (error && (error.name === 'AbortError' || (error.message && error.message.includes('cancelled by user')))) {
            updateButton(btn, t('download.button.cancelled'), false);
            await finalizeCancelCleanup('cancel', error);
            return;
        }

        if (currentWritable) await currentWritable.abort().catch(() => {});
        if (currentFileHandle && currentFileHandle.remove) {
            await currentFileHandle.remove().catch(() => {});
        }
        currentFileHandle = null;
        currentWritable = null;
        currentDownloadVideoId = null;
        currentDownloadPath = null;
        clearHandleFromDB();
        restorePageAudio();

        sendNotification(t('download.failed_title'), t('download.failed_message', { error: error.message || t('download.unknown_error') }));
        alert(t('download.failed', { error: error.message || t('download.unknown_error') }));
        updateButton(btn, t('download.button.error'), false);
        isDownloading = false;
        allowTabInactivity();
        cancelRequested = false;
        cancelInProgress = false;
        removeOverlay();
    }
}

// Function to create and show the download options modal
function createDownloadOptionsModal(videoId, durationMs, btn) {
    // Remove existing modal if any
    const existingModal = document.querySelector('.kvd-modal-overlay');
    if (existingModal) existingModal.remove();

    // Mute video to prevent audio interference while deciding
    mutePageAudio();

    const durationSeconds = Math.floor(durationMs / 1000);
    
    // Helper to format seconds to HH:MM:SS
    const formatTime = (totalSeconds) => {
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = Math.floor(totalSeconds % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    const modal = document.createElement('div');
    modal.className = 'kvd-modal-overlay';
    
    const content = document.createElement('div');
    content.className = 'kvd-modal-content';
    modal.appendChild(content);

    const title = document.createElement('div');
    title.className = 'kvd-modal-title';
    setI18nText(title, 'download.options_title');
    content.appendChild(title);

    // --- Quality Selector ---
    const qualityContainer = document.createElement('div');
    qualityContainer.style.cssText = 'margin-bottom: 15px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 5px;';
    
    const qualityLabel = document.createElement('label');
    setI18nText(qualityLabel, 'download.quality.label');
    qualityLabel.style.cssText = 'color: #ccc; font-size: 14px; font-weight: bold;';
    qualityContainer.appendChild(qualityLabel);

    const qualitySelect = document.createElement('select');
    qualitySelect.id = 'kvd-quality-select';
    qualitySelect.style.cssText = 'background: #222; color: #fff; border: 1px solid #444; padding: 8px; border-radius: 4px; font-size: 14px; width: 80%; cursor: pointer; outline: none;';
    const initialOption = document.createElement('option');
    initialOption.value = '';
    setI18nText(initialOption, 'download.quality.loading');
    qualitySelect.appendChild(initialOption);
    qualitySelect.disabled = true;
    qualityContainer.appendChild(qualitySelect);

    content.appendChild(qualityContainer);

    // State for selected URL
    let selectedVariantUrl = null;
    let masterPlaylistUrl = null;

    // Fetch Qualities Logic
    (async () => {
        try {
            // Check if we already have data from the button click? 
            // We don't have it passed here, so we fetch. It's cached usually.
            const data = await fetchVideoData(videoId);
            if (!data || !data.source) {
                qualitySelect.innerHTML = '';
                const noSourceOption = document.createElement('option');
                noSourceOption.value = '';
                setI18nText(noSourceOption, 'download.quality.no_source');
                qualitySelect.appendChild(noSourceOption);
                return;
            }
            masterPlaylistUrl = data.source;

            // Fetch Playlist
            const response = await fetch(masterPlaylistUrl);
            const text = await response.text();
            const lines = text.split('\n');

            const variants = [];
            
            // Robust Base URL calculation
            let baseUrl;
            try {
                baseUrl = new URL('.', masterPlaylistUrl).href;
            } catch (e) {
                baseUrl = masterPlaylistUrl.substring(0, masterPlaylistUrl.lastIndexOf('/') + 1);
            }

            if (text.includes('EXT-X-STREAM-INF')) {
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('EXT-X-STREAM-INF')) {
                        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                        const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                        const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                        const res = resMatch ? resMatch[1] : t('download.quality.audio_only');
                        
                        let j = i + 1;
                        while (j < lines.length && lines[j].startsWith('#')) j++;
                        if (j < lines.length && lines[j].trim().length > 0) {
                            let url = lines[j].trim();
                            // Robust URL resolution
                            if (!url.startsWith('http')) {
                                try {
                                    url = new URL(url, baseUrl).href;
                                } catch (e) {
                                    url = baseUrl + url;
                                }
                            }
                            variants.push({ bandwidth: bw, resolution: res, url: url });
                        }
                    }
                }
            }

            if (variants.length > 0) {
                // Sort: High Bandwidth first
                variants.sort((a, b) => b.bandwidth - a.bandwidth);

                qualitySelect.innerHTML = '';
                
                // Add variants
                variants.forEach((v, index) => {
                    const opt = document.createElement('option');
                    
                    const kbps = Math.round(v.bandwidth / 1000);
                    opt.textContent = t('download.quality.option', { resolution: v.resolution, kbps });
                    
                    if (index === 0) {
                        opt.textContent += ` (${t('download.quality.best')})`;
                        opt.selected = true;
                        // Use Master Playlist for "Best" to allow smart selection/fallback in downloadSegments
                        opt.value = masterPlaylistUrl; 
                        selectedVariantUrl = masterPlaylistUrl;
                    } else {
                        opt.value = v.url;
                    }
                    
                    qualitySelect.appendChild(opt);
                });
                
                // Add "Solo Audio (M4A)" option (User Request)
                // Uses 360p or lowest quality variant as source, strips video track
                const audioCandidate = variants.find(v => v.resolution && v.resolution.includes('360')) || variants[variants.length - 1];
                if (audioCandidate) {
                    const opt = document.createElement('option');
                    setI18nText(opt, 'download.quality.audio_only_option');
                    opt.value = audioCandidate.url + '#audio_only';
                    opt.style.color = '#53fc18'; // Highlight
                    qualitySelect.appendChild(opt);
                }
                
                qualitySelect.disabled = false;
                
                // Update selected on change
                qualitySelect.onchange = () => {
                    selectedVariantUrl = qualitySelect.value;
                };

            } else {
                // No variants (single stream?)
                qualitySelect.innerHTML = '';
                const defaultOption = document.createElement('option');
                defaultOption.value = '';
                setI18nText(defaultOption, 'download.quality.default_single');
                qualitySelect.appendChild(defaultOption);
                selectedVariantUrl = masterPlaylistUrl; // Fallback to master
            }

        } catch (e) {
            console.error('Error fetching qualities:', e);
            qualitySelect.innerHTML = '';
            const autoOption = document.createElement('option');
            autoOption.value = '';
            setI18nText(autoOption, 'download.quality.auto_default');
            qualitySelect.appendChild(autoOption);
            selectedVariantUrl = null; 
        }
    })();
    
    // Main Options
    const mainOptions = document.createElement('div');
    mainOptions.id = 'kvd-main-options';
    mainOptions.className = 'kvd-modal-options';
    content.appendChild(mainOptions);

    const downloadAllBtn = document.createElement('button');
    downloadAllBtn.className = 'kvd-option-btn primary';
    downloadAllBtn.id = 'kvd-download-all';
    // SVG Download
    const svgDownload = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgDownload.setAttribute('width', '24');
    svgDownload.setAttribute('height', '24');
    svgDownload.setAttribute('fill', 'none');
    svgDownload.setAttribute('viewBox', '0 0 24 24');
    svgDownload.setAttribute('stroke', 'currentColor');
    const pathDownload = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathDownload.setAttribute('stroke-linecap', 'round');
    pathDownload.setAttribute('stroke-linejoin', 'round');
    pathDownload.setAttribute('stroke-width', '2');
    pathDownload.setAttribute('d', 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4');
    svgDownload.appendChild(pathDownload);
    downloadAllBtn.appendChild(svgDownload);
    downloadAllBtn.appendChild(document.createTextNode(' '));
    const downloadAllLabel = document.createElement('span');
    downloadAllLabel.className = 'kvd-btn-text';
    setI18nText(downloadAllLabel, 'download.option.full_vod');
    downloadAllBtn.appendChild(downloadAllLabel);
    mainOptions.appendChild(downloadAllBtn);

    const trimOptionBtn = document.createElement('button');
    trimOptionBtn.className = 'kvd-option-btn';
    trimOptionBtn.id = 'kvd-trim-option';
    // SVG Trim
    const svgTrim = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgTrim.setAttribute('width', '24');
    svgTrim.setAttribute('height', '24');
    svgTrim.setAttribute('fill', 'none');
    svgTrim.setAttribute('viewBox', '0 0 24 24');
    svgTrim.setAttribute('stroke', 'currentColor');
    const pathTrim = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathTrim.setAttribute('stroke-linecap', 'round');
    pathTrim.setAttribute('stroke-linejoin', 'round');
    pathTrim.setAttribute('stroke-width', '2');
    pathTrim.setAttribute('d', 'M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm8.486-8.486a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243z');
    svgTrim.appendChild(pathTrim);
    trimOptionBtn.appendChild(svgTrim);
    trimOptionBtn.appendChild(document.createTextNode(' '));
    const trimLabel = document.createElement('span');
    trimLabel.className = 'kvd-btn-text';
    setI18nText(trimLabel, 'download.option.trim');
    trimOptionBtn.appendChild(trimLabel);
    mainOptions.appendChild(trimOptionBtn);

    // Trim UI
    const trimUI = document.createElement('div');
    trimUI.id = 'kvd-trim-ui';
    trimUI.className = 'kvd-trim-container';
    content.appendChild(trimUI);

    const timeInputs = document.createElement('div');
    timeInputs.className = 'kvd-time-inputs';
    trimUI.appendChild(timeInputs);

    // Start Group
    const startGroup = document.createElement('div');
    startGroup.className = 'kvd-time-group';
    timeInputs.appendChild(startGroup);
    
    const startLabel = document.createElement('span');
    startLabel.className = 'kvd-time-label';
    setI18nText(startLabel, 'download.trim.start_label');
    startGroup.appendChild(startLabel);

    const startTimeInput = document.createElement('input');
    startTimeInput.type = 'text';
    startTimeInput.className = 'kvd-time-input';
    startTimeInput.id = 'kvd-start-time';
    startTimeInput.value = '00:00:00';
    setI18nText(startTimeInput, 'download.trim.placeholder', undefined, 'placeholder');
    startGroup.appendChild(startTimeInput);

    const startSlider = document.createElement('input');
    startSlider.type = 'range';
    startSlider.id = 'kvd-start-slider';
    startSlider.className = 'kvd-range-slider';
    startSlider.min = '0';
    startSlider.max = durationSeconds;
    startSlider.value = '0';
    startSlider.step = '10';
    startGroup.appendChild(startSlider);

    // End Group
    const endGroup = document.createElement('div');
    endGroup.className = 'kvd-time-group';
    timeInputs.appendChild(endGroup);

    const endLabel = document.createElement('span');
    endLabel.className = 'kvd-time-label';
    setI18nText(endLabel, 'download.trim.end_label', { max: formatTime(durationSeconds) });
    endGroup.appendChild(endLabel);

    const endTimeInput = document.createElement('input');
    endTimeInput.type = 'text';
    endTimeInput.className = 'kvd-time-input';
    endTimeInput.id = 'kvd-end-time';
    endTimeInput.value = formatTime(durationSeconds);
    setI18nText(endTimeInput, 'download.trim.placeholder', undefined, 'placeholder');
    endGroup.appendChild(endTimeInput);

    const endSlider = document.createElement('input');
    endSlider.type = 'range';
    endSlider.id = 'kvd-end-slider';
    endSlider.className = 'kvd-range-slider';
    endSlider.min = '0';
    endSlider.max = durationSeconds;
    endSlider.value = durationSeconds;
    endSlider.step = '10';
    endGroup.appendChild(endSlider);

    // Hint
    const hint = document.createElement('div');
    hint.className = 'kvd-hint';
    hint.style.cssText = 'font-size: 0.8em; color: #888; margin-top: -10px; margin-bottom: 15px; text-align: center;';
    setI18nText(hint, 'download.trim.hint');
    trimUI.appendChild(hint);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'kvd-actions';
    trimUI.appendChild(actions);

    const backBtn = document.createElement('button');
    backBtn.className = 'kvd-btn-small kvd-btn-cancel';
    backBtn.id = 'kvd-back-btn';
    setI18nText(backBtn, 'download.trim.back');
    actions.appendChild(backBtn);

    const startTrimBtn = document.createElement('button');
    startTrimBtn.className = 'kvd-btn-small kvd-btn-confirm';
    startTrimBtn.id = 'kvd-start-trim';
    setI18nText(startTrimBtn, 'download.trim.download');
    actions.appendChild(startTrimBtn);

    // Close Modal Button
    const closeModalBtn = document.createElement('button');
    closeModalBtn.className = 'kvd-btn-small kvd-btn-cancel';
    closeModalBtn.id = 'kvd-close-modal';
    closeModalBtn.style.marginTop = '10px';
    setI18nText(closeModalBtn, 'download.trim.cancel');
    content.appendChild(closeModalBtn);

    document.body.appendChild(modal);

    // Helper to parse HH:MM:SS to seconds
    const parseTime = (timeStr) => {
        const parts = timeStr.split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return 0;
    };

    // Sync Logic
    const syncInputToSlider = (input, slider) => {
        const seconds = parseTime(input.value);
        if (!isNaN(seconds)) {
             // Snap to nearest 10
             const snapped = Math.round(seconds / 10) * 10;
             slider.value = snapped;
        }
    };

    const syncSliderToInput = (slider, input) => {
        const seconds = parseInt(slider.value, 10);
        input.value = formatTime(seconds);
    };

    // Listeners for Sliders
    startSlider.addEventListener('input', () => {
        if (parseInt(startSlider.value) >= parseInt(endSlider.value)) {
             startSlider.value = parseInt(endSlider.value) - 10;
        }
        syncSliderToInput(startSlider, startTimeInput);
    });

    endSlider.addEventListener('input', () => {
        if (parseInt(endSlider.value) <= parseInt(startSlider.value)) {
             endSlider.value = parseInt(startSlider.value) + 10;
        }
        syncSliderToInput(endSlider, endTimeInput);
    });

    // Listeners for Text Inputs (Blur to snap)
    startTimeInput.addEventListener('change', () => syncInputToSlider(startTimeInput, startSlider));
    endTimeInput.addEventListener('change', () => syncInputToSlider(endTimeInput, endSlider));
    startTimeInput.addEventListener('blur', () => {
         syncInputToSlider(startTimeInput, startSlider);
         syncSliderToInput(startSlider, startTimeInput); // Update text to snapped value
    });
    endTimeInput.addEventListener('blur', () => {
         syncInputToSlider(endTimeInput, endSlider);
         syncSliderToInput(endSlider, endTimeInput); // Update text to snapped value
    });

    // Close Modal
    const close = () => {
        modal.remove();
        btn.disabled = false;
        btn.textContent = t('download.button.label');
        setButtonToDownload(btn); // Re-apply SVG and correct structure
        
        // Restore audio if download NOT started
        restorePageAudio();
    };

    closeModalBtn.onclick = close;
    modal.onclick = (e) => {
        if (e.target === modal) close();
    };

    // Download All
    downloadAllBtn.onclick = async () => {
        modal.remove();
        // Do NOT restore audio here, downloadSegments handles it after download finishes
        
        let sourceUrl = selectedVariantUrl;
        
        if (!sourceUrl) {
            // Fallback if selector failed or logic didn't run
            const videoData = await fetchVideoData(videoId);
            if (videoData) sourceUrl = videoData.source;
        }

        if (sourceUrl) {
             await downloadSegments(sourceUrl, btn, durationMs, 0, -1, null, false, videoId);
        } else {
             alert(t('download.no_source'));
             btn.disabled = false;
             restorePageAudio(); // Restore if error
        }
    };

    // Show Trim UI
    trimOptionBtn.onclick = () => {
        mainOptions.style.display = 'none';
        trimUI.style.display = 'block';
        closeModalBtn.style.display = 'none'; // Hide main cancel, use back/cancel in trim UI
    };

    // Back to Main Options
    backBtn.onclick = () => {
        trimUI.style.display = 'none';
        mainOptions.style.display = 'flex';
        closeModalBtn.style.display = 'inline-block';
    };

    // Start Trim Download
    startTrimBtn.onclick = async () => {
        const startStr = modal.querySelector('#kvd-start-time').value;
        const endStr = modal.querySelector('#kvd-end-time').value;
        
        const startSeconds = parseTime(startStr);
        const endSeconds = parseTime(endStr);

        if (startSeconds >= endSeconds) {
            alert(t('download.trim.start_before_end'));
            return;
        }

        if (endSeconds > durationSeconds + 120) { // Allow some buffer
            alert(t('download.trim.end_exceeds'));
            return;
        }

        modal.remove();
        
        let sourceUrl = selectedVariantUrl;
        
        if (!sourceUrl) {
            const videoData = await fetchVideoData(videoId);
            if (videoData) sourceUrl = videoData.source;
        }
        
        if (sourceUrl) {
             // Pass start/end in seconds
             await downloadSegments(sourceUrl, btn, durationMs, startSeconds, endSeconds, null, false, videoId);
        } else {
             alert(t('download.no_source'));
             btn.disabled = false;
             restorePageAudio(); // Restore if error
        }
    };
}

// --- STREAMER MODE (AUTO-DOWNLOAD) ---
let isStreamerModeEnabled = false;
let streamEndDetected = false;
let autoDlState = {
    active: false,
    abortController: null,
    timers: new Set(),
    reason: ''
};

function autoDlLog(message, extra) {
    if (extra !== undefined) {
        console.log(`[SR] ${message}`, extra);
    } else {
        console.log(`[SR] ${message}`);
    }
}

function ensureAutoDlController() {
    if (!autoDlState.abortController || autoDlState.abortController.signal.aborted) {
        autoDlState.abortController = new AbortController();
    }
    return autoDlState.abortController;
}

function autoDlDelay(ms) {
    const controller = ensureAutoDlController();
    return new Promise((resolve, reject) => {
        if (controller.signal.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const id = setTimeout(() => {
            autoDlState.timers.delete(id);
            resolve();
        }, ms);
        autoDlState.timers.add(id);
        controller.signal.addEventListener('abort', () => {
            clearTimeout(id);
            autoDlState.timers.delete(id);
            reject(new Error('aborted'));
        }, { once: true });
    });
}

function autoDlCleanup(reason) {
    if (autoDlState.active) {
        autoDlLog(`cleanup: ${reason}`);
    }
    autoDlState.reason = reason;
    if (autoDlState.abortController && !autoDlState.abortController.signal.aborted) {
        autoDlState.abortController.abort();
    }
    autoDlState.timers.forEach((id) => clearTimeout(id));
    autoDlState.timers.clear();
    autoDlState.active = false;
    const statusDiv = document.getElementById('kvd-sr-status');
    if (statusDiv) statusDiv.remove();
}

function formatStreamDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function calculateStreamRecordingDurationMs(state, now) {
    const segmentMs = Math.round((state.downloadedDurationSec || 0) * 1000);
    const elapsedMs = state.startedAt ? Math.max(0, now - state.startedAt) : 0;
    if (segmentMs > 0 && elapsedMs > 0) return Math.max(segmentMs, elapsedMs);
    return Math.max(segmentMs, elapsedMs);
}

function updateStreamTooltip(btn) {
    const tooltip = btn.querySelector('.kvd-stream-tooltip');
    if (!tooltip) return;
    const sizeText = formatBytes(streamDownloadState.downloadedBytes || 0);
    const timeText = formatStreamDuration(streamDownloadState.downloadedDurationSec || 0);
    tooltip.textContent = t('stream.tooltip', { size: sizeText, time: timeText });
}

function setStreamCancelButtonState(isActive) {
    const cancelBtn = document.querySelector('.kvd-stream-cancel-btn');
    if (!cancelBtn) return;
    cancelBtn.disabled = !isActive;
}

function setStreamButtonState(btn, state) {
    btn.classList.remove('kvd-stream-active');
    const label = btn.querySelector('.kvd-stream-label');
    if (state === 'downloading') {
        if (label) label.textContent = t('stream.state.recording');
        else btn.textContent = t('stream.state.recording');
        btn.classList.add('kvd-stream-active');
        btn.disabled = false;
    } else if (state === 'completed') {
        if (label) label.textContent = t('stream.state.saved');
        else btn.textContent = t('stream.state.saved');
        btn.disabled = false;
    } else if (state === 'error') {
        if (label) label.textContent = t('stream.state.error');
        else btn.textContent = t('stream.state.error');
        btn.disabled = false;
    } else if (state === 'offline') {
        if (label) label.textContent = t('stream.state.offline');
        else btn.textContent = t('stream.state.offline');
        btn.disabled = true;
    } else {
        if (label) label.textContent = t('stream.state.idle');
        else btn.textContent = t('stream.state.idle');
        btn.disabled = false;
    }
    updateStreamTooltip(btn);
    setStreamCancelButtonState(state === 'downloading');
}

function handleStreamDownloadExit(e) {
    if (isStreamDownloading) {
        e.preventDefault();
        e.returnValue = t('stream.leave_warning');
        return e.returnValue;
    }
}

function showStreamCancelDialog() {
    return new Promise((resolve) => {
        const existing = document.querySelector('.kvd-stream-cancel-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'kvd-modal-overlay kvd-stream-cancel-modal';

        const content = document.createElement('div');
        content.className = 'kvd-modal-content';

        const title = document.createElement('div');
        title.className = 'kvd-modal-title';
        setI18nText(title, 'stream.cancel.title');
        content.appendChild(title);

        const desc = document.createElement('div');
        desc.style.marginBottom = '15px';
        desc.style.lineHeight = '1.5';
        setI18nText(desc, 'stream.cancel.description');
        content.appendChild(desc);

        const actions = document.createElement('div');
        actions.className = 'kvd-modal-options';

        const keepBtn = document.createElement('button');
        keepBtn.className = 'kvd-option-btn primary';
        setI18nText(keepBtn, 'stream.cancel.keep');

        const discardBtn = document.createElement('button');
        discardBtn.className = 'kvd-option-btn danger';
        setI18nText(discardBtn, 'stream.cancel.discard');

        actions.appendChild(keepBtn);
        actions.appendChild(discardBtn);
        content.appendChild(actions);
        overlay.appendChild(content);
        document.body.appendChild(overlay);

        const cleanup = (value) => {
            overlay.remove();
            resolve(value);
        };

        keepBtn.onclick = () => cleanup('keep');
        discardBtn.onclick = () => cleanup('discard');
        overlay.onclick = (e) => {
            if (e.target === overlay) cleanup(null);
        };
    });
}

async function getLiveStreamSource() {
    const videoEl = document.querySelector('video');
    if (videoEl) {
        const current = videoEl.currentSrc || videoEl.src || '';
        if (current.includes('.m3u8')) return current;
        const sourceEl = videoEl.querySelector('source');
        if (sourceEl && sourceEl.src && sourceEl.src.includes('.m3u8')) return sourceEl.src;
    }
    const slug = getChannelSlug();
    if (!slug) return null;
    try {
        const response = await fetch(`https://kick.com/api/v1/channels/${slug}`, { credentials: 'include' });
        if (!response.ok) return null;
        const data = await response.json();
        const live = data.livestream || data.live_stream || data.stream || {};
        const candidates = [
            live.playback_url,
            live.source,
            live.url,
            data.playback_url,
            data.source
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.includes('.m3u8')) {
                return candidate;
            }
        }
    } catch (e) {
        console.error('[SR Stream] live source error', e);
    }
    return null;
}

async function selectBestVariantUrl(masterUrl, signal) {
    try {
        const response = await fetch(masterUrl, { cache: 'no-store', signal });
        if (!response.ok) return masterUrl;
        const text = await response.text();
        if (!text.includes('EXT-X-STREAM-INF')) return masterUrl;
        const lines = text.split('\n');
        let baseUrl = masterUrl;
        try {
            baseUrl = new URL('.', masterUrl).href;
        } catch (e) {
            baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
        }
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('EXT-X-STREAM-INF')) {
                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
                const next = (lines[i + 1] || '').trim();
                if (next && !next.startsWith('#')) {
                    const url = next.startsWith('http') ? next : `${baseUrl}${next}`;
                    variants.push({ bw, url });
                }
            }
        }
        if (variants.length === 0) return masterUrl;
        variants.sort((a, b) => b.bw - a.bw);
        return variants[0].url;
    } catch (e) {
        if (signal && signal.aborted) throw e;
        console.error('[SR Stream] variant select error', e);
        return masterUrl;
    }
}

function parsePlaylistSegments(text, playlistUrl) {
    const lines = text.split('\n');
    const segments = [];
    let endList = false;
    let baseUrl = playlistUrl;
    try {
        baseUrl = new URL('.', playlistUrl).href;
    } catch (e) {
        baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-ENDLIST')) {
            endList = true;
        }
        if (line.startsWith('#EXTINF:')) {
            const durationStr = line.substring(8).split(',')[0];
            const duration = parseFloat(durationStr);
            const next = (lines[i + 1] || '').trim();
            if (next && !next.startsWith('#')) {
                const url = next.startsWith('http') ? next : `${baseUrl}${next}`;
                segments.push({ url, duration: isFinite(duration) ? duration : 0 });
            }
        }
    }
    return { segments, endList };
}

async function cancelStreamDownload(reason, action) {
    if (!isStreamDownloading) return;
    const defaultAction = isFirefoxBrowser() ? 'keep' : 'discard';
    const finalAction = action || defaultAction;
    console.log('[SR Stream] cancel', { reason, action: finalAction });
    streamDownloadState.cancelAction = finalAction;
    if (streamDownloadState.abortController && !streamDownloadState.abortController.signal.aborted) {
        streamDownloadState.abortController.abort();
    }
}

function isFirefoxBrowser() {
    const ua = navigator.userAgent || '';
    return /firefox|fxios/i.test(ua);
}

async function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

async function startStreamDownload(btn) {
    if (!isModerator()) {
        alert(t('stream.moderator_only'));
        return;
    }
    if (isStreamDownloading) {
        return;
    }
    if (isOfflineVisible()) {
        setStreamButtonState(btn, 'offline');
        return;
    }
    const suggested = buildAutoDlFileName();
    let handle = null;
    let writable = null;
    const firefoxMode = isFirefoxBrowser() || (typeof window.showSaveFilePicker !== 'function');
    if (!firefoxMode) {
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: suggested,
                types: [{
                    description: t('stream.save_picker.mp4'),
                    accept: { 'video/mp4': ['.mp4'] }
                }]
            });
        } catch (e) {
            return;
        }
        try {
            writable = await handle.createWritable();
        } catch (e) {
            alert(t('stream.file_open_error'));
            return;
        }
    }
    const controller = new AbortController();
    streamDownloadState.abortController = controller;
    streamDownloadState.fileHandle = handle;
    streamDownloadState.writable = writable;
    streamDownloadState.downloadedBytes = 0;
    streamDownloadState.downloadedDurationSec = 0;
    streamDownloadState.downloadedSegments.clear();
    streamDownloadState.startedAt = Date.now();
    streamDownloadState.lastSegmentAt = Date.now();
    streamDownloadState.idleCycles = 0;
    streamDownloadState.active = true;
    streamDownloadState.cancelAction = null;
    isStreamDownloading = true;
    chrome.runtime.sendMessage({
        type: 'DISCORD_WEBHOOK_NOTIFY',
        event: 'live_start',
        data: { channel: getChannelSlug() || '', url: getChannelSlug() ? `https://kick.com/${getChannelSlug()}` : '' }
    }).catch(() => {});
    preventTabInactivity();
    window.addEventListener('beforeunload', handleStreamDownloadExit);
    setStreamButtonState(btn, 'downloading');
    updateStreamTooltip(btn);
    console.log('[SR Stream] start', { suggested });

    let fileWriteChain = Promise.resolve();
    const writeBuffer = [];
    let writeBufferBytes = 0;
    const srFirefoxChunks = [];
    const writeFlushThreshold = 4 * 1024 * 1024;
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
        if (writable) {
            fileWriteChain = fileWriteChain.then(() => writable.write(combined));
        } else if (firefoxMode) {
            try {
                chrome.runtime.sendMessage({ type: 'SR_STREAM_APPEND', chunk: combined.buffer, filename: suggested }).catch(() => {});
            } catch (_) {}
            srFirefoxChunks.push(combined);
        }
    };
    const enqueueWrite = (buffer) => {
        writeBuffer.push(buffer);
        writeBufferBytes += buffer.byteLength;
        if (writeBufferBytes >= writeFlushThreshold) {
            flushWriteBuffer();
        }
    };

    const transmuxer = new muxjs.mp4.Transmuxer({
        keepOriginalTimestamps: false,
        remux: true
    });
    let initSegmentWritten = false;
    let initSegmentBytes = null;
    // Live recording polls every ~2s, so a small batch keeps the on-disk
    // file reasonably current while still avoiding a flush per single
    // segment (see the VOD download fix above for why that causes drift).
    const STREAM_FLUSH_BATCH_SIZE = 5;
    let segmentsSinceFlush = 0;
    transmuxer.on('data', (segment) => {
        if (!initSegmentWritten) {
            const initSeg = new Uint8Array(segment.initSegment);
            initSegmentBytes = initSeg.slice();
            enqueueWrite(initSeg);
            initSegmentWritten = true;
            if (!writable && firefoxMode) {
                // defer sending init to background until finalize (with patched duration)
            }
        }
        const mediaSeg = new Uint8Array(segment.data);
        enqueueWrite(mediaSeg);
    });

    const fetchSegment = async (url, attempt = 0) => {
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        try {
            if (firefoxMode) {
                const result = await chrome.runtime.sendMessage({ type: 'SR_FETCH_SEGMENT', url });
                if (!result || result.ok !== true || !result.buffer) {
                    const msg = result && result.error ? result.error : 'segment fetch failed';
                    throw new Error(msg);
                }
                return result.buffer;
            } else {
                const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const buffer = await response.arrayBuffer();
                return buffer;
            }
        } catch (e) {
            if (controller.signal.aborted) throw e;
            if (attempt < 4) {
                await delay(600 + attempt * 400);
                return fetchSegment(url, attempt + 1);
            }
            throw e;
        }
    };

    const pollDelay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let playlistUrl = await getLiveStreamSource();
    if (!playlistUrl) {
        streamDownloadState.cancelAction = 'discard';
        throw new Error('no source');
    }
    playlistUrl = await selectBestVariantUrl(playlistUrl, controller.signal);
    streamDownloadState.lastPlaylistUrl = playlistUrl;
    if (firefoxMode) {
        try {
            chrome.runtime.sendMessage({ type: 'SR_STREAM_INIT', filename: suggested }).catch(() => {});
        } catch (_) {}
    }

    let hadError = false;
    try {
        while (!controller.signal.aborted) {
            let playlistText = '';
            try {
                const playlistResponse = await fetch(`${playlistUrl}${playlistUrl.includes('?') ? '&' : '?'}time=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
                if (!playlistResponse.ok) throw new Error(`HTTP ${playlistResponse.status}`);
                playlistText = await playlistResponse.text();
            } catch (e) {
                if (controller.signal.aborted) throw e;
                console.log('[SR Stream] playlist error', e.message);
                await pollDelay(2000);
                continue;
            }
            if (playlistText.includes('EXT-X-STREAM-INF')) {
                const nextUrl = await selectBestVariantUrl(playlistUrl, controller.signal);
                if (nextUrl !== playlistUrl) {
                    playlistUrl = nextUrl;
                    streamDownloadState.lastPlaylistUrl = playlistUrl;
                    continue;
                }
            }
            const parsed = parsePlaylistSegments(playlistText, playlistUrl);
            const freshSegments = parsed.segments.filter(s => !streamDownloadState.downloadedSegments.has(s.url));
            if (freshSegments.length > 0) {
                streamDownloadState.idleCycles = 0;
                for (const seg of freshSegments) {
                    if (controller.signal.aborted) break;
                    try {
                        const buffer = await fetchSegment(seg.url);
                        if (controller.signal.aborted) break;
                        const data = new Uint8Array(buffer);
                        transmuxer.push(data);
                        segmentsSinceFlush++;
                        // Same fix as VOD download: don't flush the transmuxer
                        // per segment, or per-fragment timestamp rounding will
                        // drift audio vs video over a long recording,
                        // especially when segments arrive irregularly.
                        if (segmentsSinceFlush >= STREAM_FLUSH_BATCH_SIZE) {
                            transmuxer.flush();
                            segmentsSinceFlush = 0;
                        }
                        streamDownloadState.downloadedBytes += data.byteLength;
                        streamDownloadState.downloadedDurationSec += seg.duration || 0;
                        streamDownloadState.downloadedSegments.add(seg.url);
                        streamDownloadState.lastSegmentAt = Date.now();
                        updateStreamTooltip(btn);
                    } catch (e) {
                        console.log('[SR Stream] segment error', { url: seg.url, error: e.message });
                    }
                }
            } else {
                streamDownloadState.idleCycles += 1;
            }
            if (parsed.endList && freshSegments.length === 0 && Date.now() - streamDownloadState.lastSegmentAt > 10000) {
                break;
            }
            if (freshSegments.length === 0 && isOfflineVisible() && Date.now() - streamDownloadState.lastSegmentAt > 10000) {
                break;
            }
            await pollDelay(2000);
        }
    } catch (e) {
        if (!controller.signal.aborted) {
            hadError = true;
            console.error('[SR Stream] fatal', e);
            setStreamButtonState(btn, 'error');
        }
    } finally {
        const cancelAction = streamDownloadState.cancelAction;
        // Flush whatever's left in the batch (see STREAM_FLUSH_BATCH_SIZE
        // above) so the last few seconds of the recording aren't dropped.
        if (segmentsSinceFlush > 0) {
            transmuxer.flush();
            segmentsSinceFlush = 0;
        }
        flushWriteBuffer();
        if (writable) {
            await fileWriteChain;
        }
        const durationMs = calculateStreamRecordingDurationMs(streamDownloadState, Date.now());
        if (cancelAction !== 'discard' && initSegmentBytes) {
            const patchedInit = patchMp4DurationInPlace(initSegmentBytes.slice(), durationMs);
            if (writable) {
                fileWriteChain = fileWriteChain.then(() => streamDownloadState.writable.write({
                    type: 'write',
                    position: 0,
                    data: patchedInit
                }));
                await fileWriteChain;
            } else if (firefoxMode) {
                srFirefoxChunks.unshift(patchedInit);
            }
        }
        if (streamDownloadState.writable) {
            try {
                await streamDownloadState.writable.close();
            } catch (e) {}
        }
        if (firefoxMode) {
            if (cancelAction !== 'discard') {
                try {
                    const patchedInitToSend = initSegmentBytes ? patchMp4DurationInPlace(initSegmentBytes.slice(), durationMs) : null;
                    chrome.runtime.sendMessage({ type: 'SR_STREAM_FINALIZE', action: 'keep', filename: suggested, init: patchedInitToSend ? patchedInitToSend.buffer : null }).catch(() => {});
                    setStreamButtonState(btn, 'completed');
                } catch (_) {
                    setStreamButtonState(btn, 'error');
                }
            } else {
                try {
                    chrome.runtime.sendMessage({ type: 'SR_STREAM_ABORT' }).catch(() => {});
                } catch (_) {}
                setStreamButtonState(btn, 'idle');
            }
        } else {
            if (cancelAction === 'keep') {
                setStreamButtonState(btn, 'completed');
            }
            if (cancelAction === 'discard') {
                streamDownloadState.downloadedBytes = 0;
                streamDownloadState.downloadedDurationSec = 0;
                streamDownloadState.downloadedSegments.clear();
                streamDownloadState.startedAt = 0;
                streamDownloadState.lastPlaylistUrl = '';
                streamDownloadState.lastSegmentAt = 0;
                streamDownloadState.idleCycles = 0;
                setStreamButtonState(btn, 'idle');
            }
        }
        if (!firefoxMode && cancelAction === 'discard' && streamDownloadState.fileHandle && streamDownloadState.fileHandle.remove) {
            try {
                await streamDownloadState.fileHandle.remove();
            } catch (e) {}
        }
        streamDownloadState.fileHandle = null;
        streamDownloadState.writable = null;
        streamDownloadState.active = false;
        isStreamDownloading = false;
        {
            const durationMs = streamDownloadState.startedAt ? (Date.now() - streamDownloadState.startedAt) : 0;
            const channelSlug = getChannelSlug() || '';
            chrome.runtime.sendMessage({
                type: 'DISCORD_WEBHOOK_NOTIFY',
                event: cancelAction === 'discard' ? 'live_cancelled' : 'live_end',
                data: {
                    channel: channelSlug,
                    duration: formatStreamDuration(Math.round(durationMs / 1000)),
                    url: channelSlug ? `https://kick.com/${channelSlug}` : ''
                }
            }).catch(() => {});
        }
        allowTabInactivity();
        window.removeEventListener('beforeunload', handleStreamDownloadExit);
        streamDownloadState.cancelAction = null;
    }
    if (!controller.signal.aborted && !hadError && !firefoxMode) {
        setStreamButtonState(btn, 'completed');
        setTimeout(() => {
            if (!isStreamDownloading) setStreamButtonState(btn, 'idle');
        }, 4000);
        console.log('[SR Stream] completed');
    }
}

function createStreamDownloadButton() {
    if (document.querySelector('.kvd-stream-download-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'kick-vod-download-btn kvd-stream-download-btn';
    const label = document.createElement('span');
    label.className = 'kvd-stream-label';
    setI18nText(label, 'stream.state.idle');
    btn.appendChild(label);
    const tooltip = document.createElement('div');
    tooltip.className = 'kvd-stream-tooltip';
    btn.appendChild(tooltip);
    btn.addEventListener('click', async () => {
        await startStreamDownload(btn);
    });
    return btn;
}

function createStreamCancelButton() {
    if (document.querySelector('.kvd-stream-cancel-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'kvd-stream-cancel-btn';
    setI18nText(btn, 'stream.cancel.stop');
    btn.disabled = true;
    btn.addEventListener('click', async () => {
        if (!isStreamDownloading) return;
        const action = await showStreamCancelDialog();
        if (!action) return;
        await cancelStreamDownload('user', action);
    });
    return btn;
}

function getDashboardStreamTarget() {
    const navbar = document.querySelector('nav.sticky.top-0');
    if (navbar) return navbar;
    const header = document.querySelector('header');
    if (header) return header;
    const videoEl = document.querySelector('video');
    if (videoEl) {
        const container = videoEl.closest('div');
        if (container) return container;
        return videoEl.parentElement || videoEl;
    }
    const main = document.querySelector('main');
    if (main) return main;
    return document.body;
}

// Generic draggable-panel helper: makes `wrapper` draggable by pointer, and
// remembers its position across sessions in chrome.storage.local, keyed by
// `panelId` so different panels (download overlay, stream dashboard
// actions, streamer mode status, etc.) each keep their own spot.
const PANEL_POSITION_PREFIX = 'kvd_panel_pos_';

function applySavedPanelPosition(wrapper, panelId) {
    chrome.storage.local.get([PANEL_POSITION_PREFIX + panelId], (result) => {
        const pos = result[PANEL_POSITION_PREFIX + panelId];
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
        // Clamp to the current viewport in case the window was resized
        // (or a different monitor) since the position was saved.
        const rect = wrapper.getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - (rect.width || 0));
        const maxTop = Math.max(0, window.innerHeight - (rect.height || 0));
        const left = Math.min(maxLeft, Math.max(0, pos.left));
        const top = Math.min(maxTop, Math.max(0, pos.top));
        wrapper.style.position = 'fixed';
        wrapper.style.left = `${Math.round(left)}px`;
        wrapper.style.top = `${Math.round(top)}px`;
        wrapper.style.right = 'auto';
        wrapper.style.bottom = 'auto';
        wrapper.style.transform = 'none';
        wrapper.dataset.kvdManualPosition = 'true';
    });
}

function savePanelPosition(panelId, left, top) {
    chrome.storage.local.set({ [PANEL_POSITION_PREFIX + panelId]: { left, top } });
}

function enableDraggablePanel(wrapper, panelId) {
    if (!wrapper || wrapper.dataset.kvdDraggable === 'true') return;
    wrapper.dataset.kvdDraggable = 'true';

    if (panelId) applySavedPanelPosition(wrapper, panelId);

    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let width = 0;
    let height = 0;
    let dragging = false;
    let moved = false;
    let wasDragged = false;
    let finalLeft = 0;
    let finalTop = 0;

    const onPointerDown = (e) => {
        if (e.button !== 0) return;
        // Don't capture if clicking on a button inside the wrapper
        if (e.target.closest('button')) return;
        const rect = wrapper.getBoundingClientRect();
        wrapper.style.position = 'fixed';
        wrapper.style.left = `${Math.round(rect.left)}px`;
        wrapper.style.top = `${Math.round(rect.top)}px`;
        wrapper.style.right = 'auto';
        wrapper.style.bottom = 'auto';
        wrapper.style.transform = 'none';
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        width = rect.width;
        height = rect.height;
        dragging = true;
        moved = false;
        wasDragged = false;
        try {
            wrapper.setPointerCapture(e.pointerId);
        } catch (_) {}
    };

    const onPointerMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        wasDragged = true;
        const maxLeft = Math.max(0, window.innerWidth - width);
        const maxTop = Math.max(0, window.innerHeight - height);
        const nextLeft = Math.min(maxLeft, Math.max(0, startLeft + dx));
        const nextTop = Math.min(maxTop, Math.max(0, startTop + dy));
        wrapper.style.left = `${Math.round(nextLeft)}px`;
        wrapper.style.top = `${Math.round(nextTop)}px`;
        wrapper.style.right = 'auto';
        wrapper.style.bottom = 'auto';
        wrapper.style.transform = 'none';
        wrapper.dataset.kvdManualPosition = 'true';
        finalLeft = nextLeft;
        finalTop = nextTop;
    };

    const onPointerUp = (e) => {
        if (!dragging) return;
        dragging = false;
        try {
            wrapper.releasePointerCapture(e.pointerId);
        } catch (_) {}
        if (moved && panelId) {
            savePanelPosition(panelId, finalLeft, finalTop);
        }
    };

    wrapper.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    // Only block clicks if we actually dragged — buttons inside wrapper always work
    wrapper.addEventListener('click', (e) => {
        if (wasDragged) {
            e.preventDefault();
            e.stopPropagation();
            wasDragged = false;
        }
    }, true);
}

function injectStreamDownloadButton() {
    if (!isModerator()) return;
    if (document.querySelector('.kvd-stream-download-btn')) return;
    if (window.location.pathname.includes('/video') || window.location.pathname.includes('/videos')) return;
    if (window.location.hostname === 'dashboard.kick.com') {
        const target = getDashboardStreamTarget();
        if (!target) return;
        const btn = createStreamDownloadButton();
        const cancelBtn = createStreamCancelButton();
        if (!btn) return;
        let wrapper = document.getElementById('kvd-stream-dashboard-actions');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = 'kvd-stream-dashboard-actions';
            wrapper.className = 'kvd-stream-dashboard-actions';
            wrapper.style.display = 'flex';
            wrapper.style.gap = '6px';
            wrapper.style.zIndex = '9999';
        }
        btn.classList.add('kvd-stream-dashboard');
        const useFixed = target === document.body || target === document.documentElement;
        wrapper.style.cursor = 'move';
        wrapper.style.touchAction = 'none';
        enableDraggablePanel(wrapper, 'stream-dashboard-actions');
        if (useFixed) {
            wrapper.style.position = 'fixed';
            if (wrapper.dataset.kvdManualPosition !== 'true') {
                wrapper.style.left = '16px';
                wrapper.style.bottom = '16px';
                wrapper.style.top = 'auto';
                wrapper.style.right = 'auto';
                wrapper.style.transform = 'none';
            }
        } else {
            const style = window.getComputedStyle(target);
            if (style.position === 'static') {
                target.style.position = 'relative';
            }
            if (wrapper.dataset.kvdManualPosition !== 'true') {
                wrapper.style.position = 'absolute';
                wrapper.style.left = '50%';
                wrapper.style.top = '50%';
                wrapper.style.right = 'auto';
                wrapper.style.bottom = 'auto';
                wrapper.style.transform = 'translate(-50%, -50%)';
            }
        }
        if (!wrapper.contains(btn)) wrapper.appendChild(btn);
        if (cancelBtn && !wrapper.contains(cancelBtn)) wrapper.appendChild(cancelBtn);
        if (!wrapper.parentNode) target.appendChild(wrapper);
        if (isOfflineVisible()) {
            setStreamButtonState(btn, 'offline');
        } else {
            setStreamButtonState(btn, 'idle');
        }
        console.log('[SR Stream] button injected');
        return;
    }
    const shareBtn = Array.from(document.querySelectorAll('button')).find(b =>
        (b.textContent && (b.textContent.includes('Share') || b.textContent.includes('Compartir'))) ||
        (b.getAttribute('aria-label') && (b.getAttribute('aria-label').includes('Share') || b.getAttribute('aria-label').includes('Compartir')))
    );
    if (!shareBtn || !shareBtn.parentNode) return;
    const btn = createStreamDownloadButton();
    const cancelBtn = createStreamCancelButton();
    if (!btn) return;
    if (shareBtn.nextSibling) {
        shareBtn.parentNode.insertBefore(btn, shareBtn.nextSibling);
    } else {
        shareBtn.parentNode.appendChild(btn);
    }
    if (cancelBtn) {
        if (btn.nextSibling) {
            shareBtn.parentNode.insertBefore(cancelBtn, btn.nextSibling);
        } else {
            shareBtn.parentNode.appendChild(cancelBtn);
        }
    }
    if (isOfflineVisible()) {
        setStreamButtonState(btn, 'offline');
    } else {
        setStreamButtonState(btn, 'idle');
    }
    console.log('[SR Stream] button injected');
}

function isModerator() {
    // Dashboard: Always true (Access restricted to mods/streamers anyway)
    if (window.location.hostname === 'dashboard.kick.com') {
        return true;
    }
    const slug = getChannelSlug();
    const adminChannels = JSON.parse(localStorage.getItem('kvd_admin_channels') || '[]');
    return !!document.querySelector('a[href*="/moderator"]') || adminChannels.includes(slug);
}

let cachedDashboardSlug = null;

function getDashboardChannelSlug() {
    if (cachedDashboardSlug) return cachedDashboardSlug;
    const match = window.location.pathname.match(/\/moderator\/([^\/]+)/);
    if (match) {
        cachedDashboardSlug = match[1];
        return cachedDashboardSlug;
    }
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;
        let url;
        try {
            url = new URL(href, window.location.origin);
        } catch (_) {
            continue;
        }
        if (url.hostname !== 'kick.com' && url.hostname !== 'www.kick.com') continue;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) continue;
        const slug = parts[0];
        if (slug === 'video' || slug === 'videos') continue;
        cachedDashboardSlug = slug;
        return cachedDashboardSlug;
    }
    const nextData = document.getElementById('__NEXT_DATA__');
    if (nextData && nextData.textContent) {
        try {
            const data = JSON.parse(nextData.textContent);
            const candidates = [
                data && data.props && data.props.pageProps && data.props.pageProps.channel && data.props.pageProps.channel.slug,
                data && data.props && data.props.pageProps && data.props.pageProps.channelSlug,
                data && data.props && data.props.pageProps && data.props.pageProps.slug,
                data && data.props && data.props.pageProps && data.props.pageProps.user && data.props.pageProps.user.slug,
                data && data.props && data.props.pageProps && data.props.pageProps.profile && data.props.pageProps.profile.slug
            ];
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && candidate.trim()) {
                    cachedDashboardSlug = candidate.trim();
                    return cachedDashboardSlug;
                }
            }
        } catch (_) {}
    }
    return null;
}

function getChannelSlug() {
    // Dashboard support: /moderator/slug
    if (window.location.hostname === 'dashboard.kick.com') {
        return getDashboardChannelSlug();
    }

    // Previously this only matched the channel homepage (exactly one path
    // segment), so any deeper page — VOD pages (/channel/videos/uuid),
    // clips, etc. — always returned null. The channel slug is always the
    // first path segment unless that segment is itself one of Kick's
    // reserved non-channel top-level routes.
    const RESERVED_TOP_LEVEL = new Set([
        'video', 'videos', 'browse', 'category', 'categories', 'search',
        'following', 'subscriptions', 'wallet', 'settings', 'notifications',
        'messages', 'clips', 'leaderboards', 'events', 'moderator', 'dashboard'
    ]);
    const parts = window.location.pathname.split('/').filter(p => p);
    if (parts.length >= 1 && !RESERVED_TOP_LEVEL.has(parts[0].toLowerCase())) {
        return parts[0];
    }
    return null;
}

async function runAutoDownloadFlow(slug) {
    if (!slug) {
        autoDlLog('flow stop: missing slug');
        autoDlCleanup('missing slug');
        return;
    }
    if (document.getElementById('kvd-sr-status')) return;
    const controller = ensureAutoDlController();
    autoDlState.active = true;
    autoDlLog('flow start', { slug, reason: autoDlState.reason || 'unknown' });

    const statusDiv = document.createElement('div');
    statusDiv.id = 'kvd-sr-status';
    statusDiv.style.cssText = 'position: fixed; top: 80px; right: 20px; background: rgba(0,0,0,0.9); color: #53fc18; padding: 20px; border-radius: 8px; z-index: 99999; font-family: "Inter", sans-serif; border: 2px solid #53fc18; box-shadow: 0 0 20px rgba(83, 252, 24, 0.3); font-size: 14px; max-width: 300px;';
    statusDiv.innerHTML = t('sr.status.waiting_initial');
    document.body.appendChild(statusDiv);
    enableDraggablePanel(statusDiv, 'streamer-mode-status');

    try {
        let secondsLeft = 120;
        while (secondsLeft > 0) {
            await autoDlDelay(1000);
            secondsLeft--;
            statusDiv.innerHTML = t('sr.status.waiting_countdown', { seconds: secondsLeft });
        }
    } catch (e) {
        autoDlLog('flow aborted during VOD wait', e.message);
        return;
    }

    statusDiv.innerHTML = t('sr.status.searching');

    try {
        const response = await fetch(`https://kick.com/api/v1/channels/${slug}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Channel API failed');
        
        const data = await response.json();
        const previousStreams = data.previous_livestreams;
        
        if (previousStreams && previousStreams.length > 0) {
            const latestStream = previousStreams[0];
            const videoId = latestStream.video.uuid;
            
            statusDiv.innerHTML = t('sr.status.found', { videoId });
            
            const videoData = await fetchVideoData(videoId, { signal: controller.signal });
            if (videoData && videoData.source) {
                statusDiv.innerHTML = t('sr.status.starting');
                
                const dummyBtn = document.createElement('button');
                dummyBtn.style.display = 'none';
                document.body.appendChild(dummyBtn);

                const vodTitle = videoData.title || videoData.session_title || videoData.stream_title || '';
                await downloadSegments(videoData.source, dummyBtn, videoData.duration, 0, -1, null, false, videoId, vodTitle);
                
                statusDiv.innerHTML = t('sr.status.started');
                setTimeout(() => statusDiv.remove(), 10000);
            } else {
                throw new Error('Video source not found');
            }
        } else {
            throw new Error('No VODs found in API');
        }
    } catch (e) {
        if (controller.signal.aborted || e.message === 'aborted') {
            autoDlLog('flow aborted', e.message);
        } else {
            console.error('[Streamer Mode] Error:', e);
            statusDiv.innerHTML = t('sr.status.error', { error: e.message || t('download.unknown_error') });
            statusDiv.style.color = '#ff4444';
            statusDiv.style.borderColor = '#ff4444';
        }
    } finally {
        if (!controller.signal.aborted) {
            autoDlState.active = false;
            autoDlLog('flow end');
        }
    }
}

async function checkAutoDownloadPending() {
    if (localStorage.getItem('kvd_sr_pending') === 'true') {
        localStorage.removeItem('kvd_sr_pending');
        const slug = localStorage.getItem('kvd_channel_slug') || getChannelSlug();
        autoDlCleanup('pending start');
        autoDlState.reason = 'pending';
        ensureAutoDlController();
        autoDlState.active = true;
        autoDlLog('pending flow start', { slug });
        await runAutoDownloadFlow(slug);
    }
}

checkAutoDownloadPending();

// Protection against accidental navigation/host redirects
function handleStreamerModeExit(e) {
    if (isStreamerModeEnabled && !streamEndDetected) {
        e.preventDefault();
        e.returnValue = t('sr.leave_warning');
        return e.returnValue;
    }
}

// Inject Host Protection Script (SPA Navigation Blocker)
function injectHostProtectionScript() {
    if (document.getElementById('kvd-host-protection-script')) return;

    const script = document.createElement('script');
    script.id = 'kvd-host-protection-script';
    script.textContent = `
        (function() {
            const originalPush = history.pushState;
            const originalReplace = history.replaceState;

            function shouldBlock() {
                return document.body.getAttribute('data-kvd-sr') === 'true';
            }

            history.pushState = function(...args) {
                if (shouldBlock()) {
                    console.log('[KVD Protection] Blocked history.pushState navigation (Host/Redirect prevented)');
                    return; // Block navigation
                }
                return originalPush.apply(this, args);
            };

            history.replaceState = function(...args) {
                if (shouldBlock()) {
                    console.log('[KVD Protection] Blocked history.replaceState navigation (Host/Redirect prevented)');
                    return; // Block navigation
                }
                return originalReplace.apply(this, args);
            };
            
            console.log('[KVD] Host Protection Script Injected');
        })();
    `;
    (document.head || document.documentElement).appendChild(script);
}

function injectStreamerModeUI() {
    return;
    // Inject Protection Script immediately
    injectHostProtectionScript();

    // Check if already injected
    if (document.getElementById('kvd-streamer-container')) return;

    let target = null;
    let insertPosition = 'after'; // 'after' or 'before' or 'append'

    // Strategy 1: Dashboard Injection (Navbar)
    if (window.location.hostname === 'dashboard.kick.com') {
        // Look for the sticky navbar
        const navbar = document.querySelector('nav.sticky.top-0');
        if (navbar) {
            // Center in navbar using absolute positioning
            target = navbar;
            insertPosition = 'append';

            // --- VOD Button Injection (Dashboard Only) ---
            if (!document.getElementById('kvd-dashboard-vod-btn') && navbar.children.length > 0) {
                // Find right container (usually the last child)
                const rightContainer = navbar.children[navbar.children.length - 1];
                
                if (rightContainer) {
                     // Try to find the profile button (usually the last button or contains an image)
                     const profileBtn = Array.from(rightContainer.querySelectorAll('button')).find(btn => btn.querySelector('img'));
                     
                     if (profileBtn) {
                         const slug = getChannelSlug();
                         if (slug) {
                             const vodBtn = document.createElement('a');
                             vodBtn.id = 'kvd-dashboard-vod-btn';
                             vodBtn.href = `https://kick.com/${slug}/videos`;
                             vodBtn.target = '_blank';
                            setI18nText(vodBtn, 'dashboard.vods_link', undefined, 'title');
                             // Classes from Roadmap Line 26 + hover
                             vodBtn.className = 'group relative box-border flex shrink-0 grow-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded font-semibold ring-0 transition-all focus-visible:outline-none active:scale-[0.95] disabled:pointer-events-none [&_svg]:size-[1em] state-layer-surface bg-transparent text-white [&_svg]:fill-current hover:bg-surface-hover size-10 text-base leading-none';
                             vodBtn.style.cssText = 'margin-right: 5px; text-decoration: none;';
                             
                             // Video Icon
                             vodBtn.innerHTML = `
                                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                     <path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
                                 </svg>
                             `;
                             
                             rightContainer.insertBefore(vodBtn, profileBtn);
                         }
                     }
                }
            }
        }
    } 
    // Strategy 2: Channel Page Injection (Search Bar)
    else {
        // Find Target: Search Bar Container (Top Nav)
        // Strategy: Find input with placeholder 'Search' or 'Buscar'
        const inputs = Array.from(document.querySelectorAll('input'));
        const searchInput = inputs.find(i => 
            i.placeholder && (i.placeholder.includes('Search') || i.placeholder.includes('Buscar'))
        );

        if (searchInput) {
            // Go up to find the main flex container of the search bar
            let parent = searchInput.parentElement;
            // Try to find a parent that is likely the container (e.g., div with flex)
            // Usually Kick's search is wrapped in a relative div, then a flex container
            if (parent && parent.parentElement) {
                target = parent.parentElement;
                insertPosition = 'after';
            }
        }
    }

    if (!target) return; // Retry later if not found

    // console.log('[Streamer Mode] Injecting UI next to search bar...');

    const container = document.createElement('div');
    container.id = 'kvd-streamer-container';
    
    // Style logic based on location
    if (window.location.hostname === 'dashboard.kick.com') {
         // Absolute centering for Dashboard
         container.style.cssText = 'display: none; position: absolute; left: 50%; transform: translateX(-50%); align-items: center; gap: 8px; z-index: 50;';
    } else {
         // Flex flow for Channel Page
         container.style.cssText = 'display: none; align-items: center; margin-left: 15px; margin-right: 15px; gap: 8px; z-index: 50;';
    }
    
    // Toggle Switch
    const toggle = document.createElement('div');
    toggle.id = 'kvd-streamer-toggle';
    setI18nText(toggle, 'sr.toggle.title', undefined, 'title');
    toggle.style.cssText = 'width: 44px; height: 24px; background: #1a1a1a; border-radius: 12px; position: relative; cursor: pointer; border: 2px solid #555; transition: all 0.3s ease; box-shadow: 0 2px 5px rgba(0,0,0,0.5);';
    
    const knob = document.createElement('div');
    knob.id = 'kvd-streamer-knob';
    knob.style.cssText = 'width: 16px; height: 16px; background: #fff; border-radius: 50%; position: absolute; top: 2px; left: 2px; transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);';
    
    toggle.appendChild(knob);
    
    // Label
    const label = document.createElement('span');
    setI18nText(label, 'sr.toggle.label');
    label.style.cssText = 'font-size: 13px; font-weight: 700; color: #ccc; user-select: none;';
    
    container.appendChild(toggle);
    container.appendChild(label);
    
    // Insert based on position strategy
    if (insertPosition === 'before') {
        target.parentNode.insertBefore(container, target);
    } else if (insertPosition === 'after') {
        if (target.nextSibling) {
            target.parentNode.insertBefore(container, target.nextSibling);
        } else {
            target.parentNode.appendChild(container);
        }
    } else { // append
        target.appendChild(container);
    }
    
    // Event
    const enableAutoDL = () => {
        isStreamerModeEnabled = true;
        preventTabInactivity(); // Prevent tab sleep
        autoDlState.reason = 'enabled';
        ensureAutoDlController();
        autoDlLog('enabled');
        
        // Enable Host Protection (Standard)
        window.addEventListener('beforeunload', handleStreamerModeExit);
        
        // Enable Host Protection (SPA - History API Patch)
        document.body.setAttribute('data-kvd-sr', 'true');
        
        toggle.style.background = 'rgba(83, 252, 24, 0.2)';
        toggle.style.borderColor = '#53fc18';
        toggle.style.boxShadow = '0 0 10px rgba(83, 252, 24, 0.4)';
        toggle.classList.add('kvd-pulse-active');
        
        knob.style.transform = 'translateX(20px)';
        knob.style.background = '#53fc18';
        label.style.color = '#53fc18';
        
        streamEndDetected = false;
        
        (async () => {
            try {
                if (!currentFileHandle) {
                    const existingHandle = await loadHandleFromDB();
                    if (existingHandle) {
                        currentFileHandle = existingHandle;
                        return;
                    }
                }
                if (typeof window.showSaveFilePicker === 'function' && !currentFileHandle) {
                    const suggestedName = buildAutoDlFileName();
                    const handle = await window.showSaveFilePicker({
                        suggestedName,
                        types: [{
                            description: t('download.save_picker.mp4'),
                            accept: { 'video/mp4': ['.mp4'] },
                        }],
                    });
                    currentFileHandle = handle;
                    saveHandleToDB(handle);
                }
            } catch (e) {}
        })();
    };

    const disableAutoDL = () => {
        isStreamerModeEnabled = false;
        allowTabInactivity();
        autoDlCleanup('disabled');
        
        // Disable Host Protection
        window.removeEventListener('beforeunload', handleStreamerModeExit);
        document.body.removeAttribute('data-kvd-sr');
        
        toggle.style.background = '#1a1a1a';
        toggle.style.borderColor = '#555';
        toggle.style.boxShadow = 'none';
        toggle.classList.remove('kvd-pulse-active');
        
        knob.style.transform = 'translateX(0)';
        knob.style.background = '#fff';
        label.style.color = '#ccc';
        
        streamEndDetected = false;
    };

    toggle.onclick = () => {
        if (!isStreamerModeEnabled) {
            // Check if we are on Dashboard
            if (window.location.hostname === 'dashboard.kick.com') {
                const slug = getChannelSlug();
                if (slug) {
                    if (confirm(t('sr.confirm.activate_redirect'))) {
                        localStorage.setItem('kvd_sr_carry_over', 'true');
                        window.location.href = `https://kick.com/${slug}`;
                    }
                } else {
                    alert(t('sr.error.missing_slug'));
                }
                return;
            }

            // Normal Channel Page Activation
            if (confirm(t('sr.confirm.enable'))) {
                enableAutoDL();
            }
        } else {
            disableAutoDL();
        }
    };

    // Check for Carry-Over State (Redirected from Dashboard)
    if (localStorage.getItem('kvd_sr_carry_over') === 'true') {
        localStorage.removeItem('kvd_sr_carry_over');
        // Activate immediately without confirm
        enableAutoDL();
        console.log('[Streamer Mode] SR enabled via Dashboard redirect.');
    }
}

function isOfflineVisible() {
    const offlineOverlay = document.querySelector('div.z-player.absolute.inset-0.cursor-pointer[aria-hidden="true"]');
    if (offlineOverlay) {
        return true;
    }
    const offlineBadge = document.querySelector('.bg-surfaceInverse-base');
    if (offlineBadge && (offlineBadge.textContent.includes('Desconectado') || offlineBadge.textContent.includes('Offline'))) {
        return true;
    }
    const h2s = document.querySelectorAll('h2');
    for (const h of h2s) {
        if (h.textContent.includes('está fuera de línea') || h.textContent.includes('is offline')) {
            return true;
        }
    }
    return false;
}

function checkStreamStatus() {
    if (!isStreamerModeEnabled || streamEndDetected) return;

    if (isOfflineVisible()) {
        streamEndDetected = true;
        autoDlLog('stream offline detected');
        
        // Hide UI immediately
        const container = document.getElementById('kvd-streamer-container');
        if (container) container.style.display = 'none';

        autoDlCleanup('offline detected');
        ensureAutoDlController();
        autoDlState.active = true;
        waitForVodBadgeAndRedirect().catch((e) => {
            autoDlLog('waitForVodBadgeAndRedirect error', e.message);
        });
    }
}

function findVodBadgeElement() {
    const nodes = Array.from(document.querySelectorAll('div'));
    return nodes.find(el => {
        const c = el.className || '';
        return c.includes('z-controls') &&
               c.includes('state-layer-surface') &&
               c.includes('bg-surface-lowest') &&
               c.includes('tv:text-xs') &&
               c.includes('absolute') &&
               c.includes('rounded') &&
               c.includes('px-1') &&
               c.includes('text-sm') &&
               c.includes('font-semibold') &&
               c.includes('top-1.5') &&
               c.includes('left-1.5') &&
               el.textContent && el.textContent.trim().length > 0;
    }) || null;
}

async function waitForVodBadgeAndRedirect() {
    const start = Date.now();
    let badge = findVodBadgeElement();
    const controller = ensureAutoDlController();
    autoDlLog('waiting for VOD badge');
    while (!badge && Date.now() - start < 180000) {
        if (controller.signal.aborted) throw new Error('aborted');
        await autoDlDelay(2000);
        badge = findVodBadgeElement();
    }
    if (badge) {
        const anchor = badge.closest('a[href*="/video/"], a[href*="/videos/"]') || badge.parentElement.closest('a[href*="/video/"], a[href*="/videos/"]');
        if (anchor) {
            const href = anchor.getAttribute('href');
            const match = href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            const vid = match ? match[0] : null;
            if (vid) {
                autoDlLog('VOD badge found', { vid });
                sessionStorage.setItem('kvd_auto_download', 'true');
                sessionStorage.setItem('kvd_auto_download_id', vid);
                autoDlCleanup('redirect to VOD');
                window.location.href = href;
                return;
            }
        }
    }
    const slug = getChannelSlug();
    const statusDiv = document.getElementById('kvd-sr-status');
    if (!statusDiv) {
        if (controller.signal.aborted) throw new Error('aborted');
        autoDlLog('VOD badge not found, fallback to API', { slug });
        await runAutoDownloadFlow(slug);
    }
}

// Function to create the download button

function createDownloadButton() {
    if (document.querySelector('.kick-vod-download-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'kick-vod-download-btn';
    setButtonToDownload(btn);

    btn.addEventListener('click', async () => {
        if (isDownloading) {
            alert(t('download.in_progress'));
            return;
        }

        const videoId = getVideoId();
        if (!videoId) {
            alert(t('download.no_video_id'));
            return;
        }

        btn.disabled = true;
        btn.textContent = t('download.loading_options');

        // Fetch basic info for duration (needed for Trim UI)
        // We do a quick fetch here just to get metadata. The actual download fetch happens later.
        const data = await fetchVideoData(videoId);
        
        let durationMs = 0;
        if (data && data.duration) {
            durationMs = data.duration;
        } else {
            // Fallback: Try to get duration from DOM video element
            const videoEl = document.querySelector('video');
            if (videoEl && !isNaN(videoEl.duration) && videoEl.duration > 0) {
                durationMs = Math.round(videoEl.duration * 1000);
                console.log('Using DOM duration for modal:', durationMs);
            }
        }
        
        if (durationMs > 0) {
            createDownloadOptionsModal(videoId, durationMs, btn);
        } else {
            // Fallback to direct download if metadata fails (rare)
            if (data && data.source) {
                await downloadSegments(data.source, btn, 0, 0, -1);
            } else {
                alert(t('download.no_source'));
                btn.disabled = false;
                setButtonToDownload(btn);
            }
        }
    });

    return btn;
}

// Function to inject download buttons into VOD thumbnails
function injectThumbnailButtons() {
    // Find all anchor tags that might be VODs
    // Exclude existing buttons to avoid double injection
    const links = document.querySelectorAll('a[href*="/video/"]:not(.kvd-processed), a[href*="/videos/"]:not(.kvd-processed)');
    
    links.forEach(link => {
        const href = link.getAttribute('href');
        // Extract ID
        // Regex for UUID
        const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const match = href.match(uuidRegex);
        
        if (match) {
            const videoId = match[0];
            
            // Check if it's really a thumbnail (contains an image or video preview)
            // This prevents adding buttons to text links
            // Also check if we already injected a button manually (double check)
            if ((link.querySelector('img') || link.querySelector('video') || link.querySelector('.bg-gray-900')) && !link.querySelector('.kvd-thumb-btn')) {
                
                link.classList.add('kvd-processed');
                // Ensure relative positioning for absolute child
                if (getComputedStyle(link).position === 'static') {
                     link.style.position = 'relative';
                }
                
                const btn = document.createElement('button');
                btn.className = 'kvd-thumb-btn';
                // Inner HTML structure with separate text span for hover effect
                btn.innerHTML = '<span>⬇</span>';
                const thumbText = document.createElement('span');
                thumbText.className = 'kvd-btn-text';
                setI18nText(thumbText, 'download.button.label');
                btn.appendChild(thumbText);
                setI18nText(btn, 'download.button.label', undefined, 'title');
                
                // Navigate to video page and trigger download
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (isDownloading) {
                        alert(t('download.in_progress'));
                        return;
                    }

                    // Use sessionStorage to pass the auto-download flag
                    // This is cleaner than URL parameters and survives the navigation
                    sessionStorage.setItem('kvd_auto_download', 'true');
                    sessionStorage.setItem('kvd_auto_download_id', videoId);
                    
                    // Navigate to the video
                    window.location.href = href;
                });
                
                link.appendChild(btn);
            }
        }
    });
}

// Function to inject the button into the DOM
function injectButton() {
    if (document.querySelector('.kick-vod-download-btn')) return;

    let target = null;
    let floatingMode = false;

    console.log('BetterKick: Attempting injection...');

    // 1. Estrategia Preferida: Botón Share/Compartir
    const shareBtn = Array.from(document.querySelectorAll('button')).find(b => 
        (b.textContent && (b.textContent.includes('Share') || b.textContent.includes('Compartir'))) ||
        (b.getAttribute('aria-label') && (b.getAttribute('aria-label').includes('Share') || b.getAttribute('aria-label').includes('Compartir')))
    );

    if (shareBtn) {
        target = shareBtn.parentNode;
        console.log('BetterKick: Found Share button container');
    }

    // 2. Estrategia Secundaria: Títulos o selectores específicos
    if (!target) {
        const selectors = [
            'h1', // Título del video suele ser h1
            '.stream-username', 
            '.vjs-control-bar', // Barra de controles del video (arriesgado pero útil)
            'div[class*="actions"]'
        ];

        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                target = el.parentNode;
                console.log(`BetterKick: Found selector ${sel}`);
                break;
            }
        }
    }

    // 3. Estrategia Fallback: Modo Flotante
    // Si no encontramos dónde ponerlo "bonito", lo ponemos flotante
    if (!target) {
        console.log('BetterKick: No target found, using FLOATING mode');
        target = document.body;
        floatingMode = true;
    }

    if (target) {
        const btn = createDownloadButton();
        if (floatingMode) {
            btn.classList.add('floating-mode');
            document.body.appendChild(btn);
        } else {
            // Intentar insertar después del botón de share si es posible, si no al final
            if (shareBtn && shareBtn.nextSibling) {
                target.insertBefore(btn, shareBtn.nextSibling);
            } else {
                target.appendChild(btn);
            }
        }
        console.log('BetterKick: Button injected successfully');
    }
}

// Check if we need to auto-trigger download from thumbnail click
let autoDownloadStableBtn = null;
let autoDownloadStableSince = 0;

function checkAutoDownloadTrigger() {
    const autoDl = sessionStorage.getItem('kvd_auto_download');
    if (!autoDl) return;

    const targetId = sessionStorage.getItem('kvd_auto_download_id');
    const currentId = getVideoId();

    if (currentId && targetId && targetId.toLowerCase() !== currentId.toLowerCase() && !sessionStorage.getItem('kvd_auto_download_mismatch_logged')) {
        console.warn('BetterKick: Auto-download ID mismatch — thumbnail ID vs current page ID:', targetId, currentId);
        sessionStorage.setItem('kvd_auto_download_mismatch_logged', '1');
    }

    // Case-insensitive comparison: if the UUID casing ever differs between
    // where it was read (thumbnail href) and where it's read again (VOD
    // page URL), a strict === here would never match, leaving the flag
    // stuck in sessionStorage forever and silently failing every time.
    if (currentId && targetId && targetId.toLowerCase() === currentId.toLowerCase()) {
        // Give up after a bounded window instead of retrying silently
        // forever if the download button never shows up (e.g. Kick changed
        // its page layout and none of injectButton()'s selectors match).
        let deadline = parseInt(sessionStorage.getItem('kvd_auto_download_deadline'), 10);
        if (!deadline) {
            deadline = Date.now() + 20000;
            sessionStorage.setItem('kvd_auto_download_deadline', String(deadline));
        }

        // Don't just wait for the 3-second polling cycle to inject the
        // button — try immediately every time we get here (every 1s) so we
        // don't lose time to the slower injection cadence.
        if (!document.querySelector('.kick-vod-download-btn')) {
            injectButton();
        }

        const btn = document.querySelector('.kick-vod-download-btn');
        if (btn && !btn.disabled) {
            // Kick keeps re-rendering/hydrating the page for a bit after
            // our button first shows up; clicking immediately can land on
            // a button instance that's about to get replaced/reset by that
            // re-render, silently swallowing the click. Require the button
            // to stay present+enabled across a couple of checks (~1.2s)
            // before we trust it's settled enough to click.
            if (!autoDownloadStableBtn || autoDownloadStableBtn !== btn) {
                autoDownloadStableBtn = btn;
                autoDownloadStableSince = Date.now();
                return;
            }
            if (Date.now() - autoDownloadStableSince < 1200) {
                return;
            }

            console.log('BetterKick: Auto-triggering download for ID:', currentId);
            sessionStorage.removeItem('kvd_auto_download');
            sessionStorage.removeItem('kvd_auto_download_id');
            sessionStorage.removeItem('kvd_auto_download_deadline');
            sessionStorage.removeItem('kvd_auto_download_mismatch_logged');
            btn.click();
        } else if (Date.now() > deadline) {
            console.warn('BetterKick: Auto-download trigger timed out waiting for the download button.');
            sessionStorage.removeItem('kvd_auto_download');
            sessionStorage.removeItem('kvd_auto_download_id');
            sessionStorage.removeItem('kvd_auto_download_deadline');
            sessionStorage.removeItem('kvd_auto_download_mismatch_logged');
        }
    }
}

// --- HOST REJECTION LOGIC (SR) ---
let lastHostRejection = 0;

function findHostRejectButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const textMatches = (text) => {
        const cleaned = text.toLowerCase();
        return cleaned.includes('rechazar') || cleaned.includes('reject') || cleaned.includes('decline');
    };

    return candidates.find(btn => {
        const label = btn.getAttribute('aria-label') || '';
        const title = btn.getAttribute('title') || '';
        const text = btn.textContent || '';
        return textMatches(label) || textMatches(title) || textMatches(text);
    });
}

function attemptRejectHost() {
    if (!isStreamerModeEnabled) return;
    const now = Date.now();
    // We only want to click at most once every 2 seconds to avoid spamming
    if (now - lastHostRejection < 2000) return;
    
    const rejectBtn = findHostRejectButton();
    if (rejectBtn && !rejectBtn.disabled) {
        rejectBtn.click();
        lastHostRejection = now;
        console.log('[KVD] Host rejected while SR active.');
        
        // Show a small toast/notification
        const toast = document.createElement('div');
        setI18nText(toast, 'sr.host_rejected');
        toast.style.cssText = 'position: fixed; top: 10px; left: 50%; transform: translateX(-50%); background: rgba(255, 50, 50, 0.9); color: white; padding: 10px 20px; border-radius: 5px; z-index: 100000; font-weight: bold; pointer-events: none;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
}

let globalCheckCycle = 0;

// Persistencia: Comprobar cada segundo si el botón sigue ahí
// Esto es necesario porque Kick es una SPA agresiva que regenera el DOM
setInterval(() => {
    globalCheckCycle++;
    if (globalCheckCycle > 100) globalCheckCycle = 1; // Reset counter

    const currentId = getVideoId();

    if ((globalCheckCycle % 3 === 0) && currentId && !document.querySelector('.kick-vod-download-btn')) {
        injectButton();
    }
    if (globalCheckCycle % 3 === 0) {
        injectStreamDownloadButton();
        const streamBtn = document.querySelector('.kvd-stream-download-btn');
        const cancelBtn = document.querySelector('.kvd-stream-cancel-btn');
        if (streamBtn && !isStreamDownloading) {
            if (!isModerator()) {
                streamBtn.remove();
                if (cancelBtn) cancelBtn.remove();
                return;
            }
            if (window.location.pathname.includes('/video') || window.location.pathname.includes('/videos')) {
                streamBtn.remove();
                if (cancelBtn) cancelBtn.remove();
            } else if (isOfflineVisible()) {
                setStreamButtonState(streamBtn, 'offline');
            } else {
                setStreamButtonState(streamBtn, 'idle');
            }
        }
    }

    // Check for auto-download trigger from thumbnail (Every 1s - Critical)
    checkAutoDownloadTrigger();

    // Navigation detection (Every 1s - Critical)
    if (currentDownloadVideoId && currentId && currentId !== currentDownloadVideoId) {
        console.log('Navigation detected! Cancelling download...');
        cancelRequested = true;
        handleUnload();
    }

    // --- Streamer Mode (SR) Management ---
    // UI Injection (Every 2 seconds)
    if (globalCheckCycle % 2 === 0) {
        injectStreamerModeUI();
        // Host Reject Check (Every 2 seconds)
        attemptRejectHost();
    }

    const streamerContainer = document.getElementById('kvd-streamer-container');
    if (streamerContainer) {
        // Visibility Logic: Only visible if Moderator AND Stream is Online (Not Offline)
        // Lógica de Visibilidad: Solo visible si es Moderador Y el stream está en vivo (No Offline)
        // Optimization: Cache offline check if possible, or accept 1s check as necessary cost
        const isOffline = isOfflineVisible();
        
        if (isModerator() && !isOffline) {
            if (streamerContainer.style.display === 'none') {
                streamerContainer.style.display = 'flex';
            }
        } else {
            if (streamerContainer.style.display !== 'none') {
                streamerContainer.style.display = 'none';
                
                // Disable if user loses mod status (safety)
                if (isStreamerModeEnabled && !streamEndDetected) {
                    isStreamerModeEnabled = false;
                    allowTabInactivity();
                    const toggle = document.getElementById('kvd-streamer-toggle');
                    if (toggle) {
                        toggle.classList.remove('kvd-pulse-active');
                        toggle.style.background = '#1a1a1a';
                        toggle.style.borderColor = '#555';
                        toggle.style.boxShadow = 'none';
                        const knob = document.getElementById('kvd-streamer-knob');
                        const label = streamerContainer.querySelector('span');
                        if (knob) { 
                            knob.style.transform = 'translateX(0)'; 
                            knob.style.background = '#fff'; 
                        }
                        if (label) { label.style.color = '#ccc'; }
                    }
                }
            }
        }
    }
    
    checkStreamStatus();
    // -------------------------------------------
    
    // Inject thumbnail buttons periodically (Every 5 seconds - Low Priority)
    if (globalCheckCycle % 5 === 0) {
        injectThumbnailButtons();
    }

    // Inject Easter Eggs listener (Every 5 seconds - Low Priority)
    if (globalCheckCycle % 5 === 0) {
        injectEasterEggs();
    }

    updateChatAdminFeatures();

}, 1000);

// Observer (backup) - Throttled to prevent performance issues
let observerTimeout;
const observer = new MutationObserver(() => {
    if (observerTimeout) return;
    
    observerTimeout = setTimeout(() => {
        if (getVideoId() && !document.querySelector('.kick-vod-download-btn')) {
            injectButton(); 
        }
        // Also check for thumbnails
        injectThumbnailButtons();
        // Easter eggs
        injectEasterEggs();
        observerTimeout = null;
    }, 1500); // Check at most every 1.5 seconds
});

observer.observe(document.body, { childList: true, subtree: true });

const chatHighlightDefaults = {
    highlightFirstMessage: true,
    highlightKeywords: true,
    keywords: []
};
let chatHighlightConfig = { ...chatHighlightDefaults };
let chatHighlightKeywords = [];
let chatFirstSeenUsers = new Set();
let chatFirstSeenSlug = null;
let chatFirstSeenSaveTimer = null;
let chatHighlightObserver = null;
let chatConfigLoaded = false;
let pinTimerState = {
    endAt: 0,
    lastSignature: '',
    pendingDurationMs: null,
    mode: 'fixed',
    pendingCancel: false
};
let pinDurationListenerAttached = false;

function normalizeKeywordList(input) {
    if (Array.isArray(input)) {
        return Array.from(new Set(input.map(k => String(k).trim()).filter(Boolean)));
    }
    if (typeof input === 'string') {
        return Array.from(new Set(input.split(/[,|\n]/).map(k => k.trim()).filter(Boolean)));
    }
    return [];
}

function applyChatHighlightConfig(config) {
    chatHighlightConfig = { ...chatHighlightDefaults, ...(config || {}) };
    chatHighlightKeywords = normalizeKeywordList(chatHighlightConfig.keywords).map(k => k.toLowerCase());
}

function loadChatHighlightConfig() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['kvd_chat_highlight_config'], (result) => {
        applyChatHighlightConfig(result.kvd_chat_highlight_config || {});
    });
}

if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.kvd_chat_highlight_config) {
            applyChatHighlightConfig(changes.kvd_chat_highlight_config.newValue || {});
        }
    });
}

function loadFirstSeenUsers(slug) {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    const key = `kvd_chat_first_seen_${slug}`;
    chrome.storage.local.get([key], (result) => {
        const list = result[key] || [];
        chatFirstSeenUsers = new Set(Array.isArray(list) ? list : []);
    });
}

function saveFirstSeenUsers() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    if (!chatFirstSeenSlug) return;
    const key = `kvd_chat_first_seen_${chatFirstSeenSlug}`;
    const list = Array.from(chatFirstSeenUsers);
    const capped = list.length > 5000 ? list.slice(list.length - 5000) : list;
    chrome.storage.local.set({ [key]: capped });
}

function scheduleSaveFirstSeenUsers() {
    if (chatFirstSeenSaveTimer) clearTimeout(chatFirstSeenSaveTimer);
    chatFirstSeenSaveTimer = setTimeout(() => {
        chatFirstSeenSaveTimer = null;
        saveFirstSeenUsers();
    }, 1000);
}

function extractChatMessageBlocks(root) {
    const blocks = [];
    if (root.nodeType !== 1) return blocks;
    if (root.matches && root.matches('div.break-words')) {
        blocks.push(root);
    }
    root.querySelectorAll && root.querySelectorAll('div.break-words').forEach(el => blocks.push(el));
    return blocks;
}

function getChatMessageText(block) {
    const msgSpan = block.querySelector('span.font-normal');
    const text = msgSpan ? msgSpan.textContent : block.textContent;
    return normalizeTitleText(text || '');
}

function getChatMessageUser(block) {
    const userBtn = block.querySelector('button[title], button.inline.font-bold');
    const name = userBtn ? (userBtn.getAttribute('title') || userBtn.textContent) : '';
    return normalizeTitleText(name || '');
}

function processChatMessageBlock(block) {
    if (!block || block.dataset.kvdChatProcessed === 'true') return;
    block.dataset.kvdChatProcessed = 'true';
    const user = getChatMessageUser(block);
    const text = getChatMessageText(block);
    if (chatHighlightConfig.highlightFirstMessage && user) {
        const key = user.toLowerCase();
        if (!chatFirstSeenUsers.has(key)) {
            chatFirstSeenUsers.add(key);
            block.classList.add('kvd-chat-highlight-first');
            scheduleSaveFirstSeenUsers();
        }
    }
    if (chatHighlightConfig.highlightKeywords && chatHighlightKeywords.length > 0 && text) {
        const lower = text.toLowerCase();
        const matched = chatHighlightKeywords.some(k => lower.includes(k));
        if (matched) {
            block.classList.add('kvd-chat-highlight-keyword');
        }
    }
}

function ensureChatHighlightObserver() {
    if (chatHighlightObserver) return;
    const container = document.getElementById('chatroom-messages');
    if (!container) return;
    chatHighlightObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                const blocks = extractChatMessageBlocks(node);
                blocks.forEach(processChatMessageBlock);
            });
        });
    });
    chatHighlightObserver.observe(container, { childList: true, subtree: true });
    extractChatMessageBlocks(container).forEach(processChatMessageBlock);
}

function stopChatHighlightObserver() {
    if (chatHighlightObserver) {
        chatHighlightObserver.disconnect();
        chatHighlightObserver = null;
    }
}

function findUnpinButton() {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find(btn => {
        const text = (btn.textContent || '').toLowerCase();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('dejar de fijar') || label.includes('dejar de fijar') || text.includes('unpin') || label.includes('unpin') || text.includes('desanclar') || label.includes('desanclar')) {
            return true;
        }
        return buttonHasUnpinIcon(btn);
    }) || null;
}

function findPinButtonFromTarget(target) {
    if (!target) return null;
    const btn = target.closest ? target.closest('button') : null;
    if (!btn) return null;
    if (isDashboardBackButton(btn)) return null;
    if (isChannelRewardButton(btn)) return null;
    if (isNearRewardContext(btn)) return null;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const text = (btn.textContent || '').toLowerCase();
    if (label.includes('anclar') || label.includes('pin') || text.includes('anclar') || text.includes('pin') || text.includes('fijar')) {
        return btn;
    }
    if (buttonHasPinIcon(btn)) return btn;
    return null;
}

// Reward/redemption rows on Kick can appear in more layout variants than
// isChannelRewardButton() (which only inspects the button's own children)
// can cover. As a safety net, also walk a few levels UP from the clicked
// button looking for reward-context hints, so a layout tweak on Kick's end
// doesn't make the pin-duration dialog pop up on a points redemption again.
function isNearRewardContext(btn) {
    if (!btn) return false;
    const rewardHints = ['pedidos', 'pedido', 'requests', 'request', 'redemptions', 'redemption', 'canjes', 'canje', 'reward', 'rewards'];
    let node = btn;
    for (let depth = 0; depth < 4 && node; depth++) {
        const testId = (node.getAttribute && (node.getAttribute('data-testid') || '')).toLowerCase();
        const className = (typeof node.className === 'string' ? node.className : '').toLowerCase();
        if (rewardHints.some(hint => testId.includes(hint) || className.includes(hint))) {
            return true;
        }
        node = node.parentElement;
    }
    return false;
}

function isChannelRewardButton(btn) {
    if (!btn) return false;
    if (isDashboardRewardButton(btn)) return true;
    if (btn.querySelector('div.min-h-\\[87px\\]') && btn.querySelector('div.min-w-10') && btn.querySelector('p.line-clamp-2')) return true;
    if (btn.querySelector('span[title]') && btn.querySelector('p[title]') && btn.querySelector('div.rounded-md')) return true;
    return false;
}

function isDashboardRewardButton(btn) {
    if (!btn || window.location.hostname !== 'dashboard.kick.com') return false;
    if (!btn.hasAttribute('data-active')) return false;
    const hasColorBox = !!btn.querySelector('div.rounded-md');
    const hasTitle = !!btn.querySelector('[title]');
    if (!hasColorBox || !hasTitle) return false;
    const text = (btn.textContent || '').toLowerCase();
    const rewardHints = ['pedidos', 'pedido', 'requests', 'request', 'redemptions', 'redemption', 'canjes', 'canje'];
    return rewardHints.some(hint => text.includes(hint));
}

function isDashboardBackButton(btn) {
    if (!btn || window.location.hostname !== 'dashboard.kick.com') return false;
    const sig = getButtonSvgSignature(btn);
    if (!sig) return false;
    return sig.includes('M26 28.46L13.2467 16L26 3.54L22.3767 0L6 16L6.02047 16.02L22.3767 32L26 28.46');
}

function getButtonSvgSignature(btn) {
    const svg = btn.querySelector('svg');
    if (!svg) return '';
    return Array.from(svg.querySelectorAll('path'))
        .map(p => p.getAttribute('d') || '')
        .join('|');
}

function buttonHasPinIcon(btn) {
    const sig = getButtonSvgSignature(btn);
    if (!sig) return false;
    return sig.includes('M25 17C24.997') || sig.includes('21.042 11.363L21 11.35V3.85');
}

function buttonHasUnpinIcon(btn) {
    const sig = getButtonSvgSignature(btn);
    if (!sig) return false;
    return sig.includes('M20.01 4.0025H22.3515')
        || sig.includes('M30.8368 6.82427L28.015')
        || sig.includes('M26 20c0-4.1-2.48-7.62-6-9.16V4h4V0H8v4h4v6.84C8.48 12.38 6 15.9 6 20v2h8v8l2 2 2-2v-8h8z');
}

function showPinDurationDialog() {
    return new Promise((resolve) => {
        const existing = document.querySelector('.kvd-pin-duration-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'kvd-modal-overlay kvd-pin-duration-modal';

        const content = document.createElement('div');
        content.className = 'kvd-modal-content';

        const title = document.createElement('div');
        title.className = 'kvd-modal-title';
        setI18nText(title, 'pin.duration.title');
        content.appendChild(title);

        const desc = document.createElement('div');
        desc.style.marginBottom = '15px';
        desc.style.lineHeight = '1.5';
        setI18nText(desc, 'pin.duration.description');
        content.appendChild(desc);

        const options = document.createElement('div');
        options.className = 'kvd-modal-options';

        const makeOption = (label, ms, mode = 'fixed') => {
            const btn = document.createElement('button');
            btn.className = 'kvd-option-btn secondary';
            btn.textContent = label;
            btn.addEventListener('click', () => {
                overlay.remove();
                resolve({ ms, mode });
            });
            return btn;
        };

        options.appendChild(makeOption(t('pin.option.minutes', { count: 1 }), 60 * 1000));
        options.appendChild(makeOption(t('pin.option.minutes', { count: 2 }), 2 * 60 * 1000));
        options.appendChild(makeOption(t('pin.option.minutes', { count: 5 }), 5 * 60 * 1000));
        options.appendChild(makeOption(t('pin.option.minutes', { count: 10 }), 10 * 60 * 1000));
        options.appendChild(makeOption(t('pin.option.until_end'), 0, 'stream'));

        const inputWrap = document.createElement('div');
        inputWrap.className = 'kvd-input-group';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = '1440';
        setI18nText(input, 'pin.option.minutes_placeholder', undefined, 'placeholder');
        inputWrap.appendChild(input);

        const confirmCustom = document.createElement('button');
        confirmCustom.className = 'kvd-option-btn primary';
        setI18nText(confirmCustom, 'pin.option.use_custom');
        confirmCustom.addEventListener('click', () => {
            const minutes = parseInt(input.value, 10);
            if (!isFinite(minutes) || minutes <= 0) return;
            const clamped = Math.min(minutes, 1440);
            overlay.remove();
            resolve({ ms: clamped * 60 * 1000, mode: 'fixed' });
        });

        const cancel = document.createElement('button');
        cancel.className = 'kvd-option-btn secondary';
        setI18nText(cancel, 'common.cancel');
        cancel.addEventListener('click', () => {
            overlay.remove();
            resolve(null);
        });

        content.appendChild(options);
        content.appendChild(inputWrap);
        const actions = document.createElement('div');
        actions.className = 'kvd-pin-actions';
        actions.appendChild(confirmCustom);
        actions.appendChild(cancel);
        content.appendChild(actions);
        overlay.appendChild(content);
        document.body.appendChild(overlay);
    });
}

function attachPinDurationListener() {
    if (pinDurationListenerAttached) return;
    pinDurationListenerAttached = true;
    document.addEventListener('click', async (e) => {
        if (!isModerator()) return;
        const pinBtn = findPinButtonFromTarget(e.target);
        if (!pinBtn) return;
        const selection = await showPinDurationDialog();
        if (!selection) {
            pinTimerState.pendingCancel = true;
            pinTimerState.pendingDurationMs = null;
            pinTimerState.mode = 'fixed';
            return;
        }
        pinTimerState.pendingCancel = false;
        pinTimerState.pendingDurationMs = selection.ms;
        pinTimerState.mode = selection.mode;
        pinTimerState.lastSignature = '';
        pinTimerState.endAt = 0;
    }, true);
}

function updatePinnedMessageTimer() {
    if (!isModerator()) return;
    const unpinButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
        const text = (btn.textContent || '').toLowerCase();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('dejar de fijar') || label.includes('dejar de fijar') || text.includes('unpin') || label.includes('unpin') || text.includes('desanclar') || label.includes('desanclar')) {
            return true;
        }
        return buttonHasUnpinIcon(btn);
    });
    if (!unpinButtons.length) {
        const existingTimers = document.querySelectorAll('.kvd-pin-timer');
        existingTimers.forEach(timer => timer.remove());
        pinTimerState.endAt = 0;
        pinTimerState.lastSignature = '';
        pinTimerState.pendingCancel = false;
        return;
    }
    if (pinTimerState.pendingCancel) {
        pinTimerState.pendingCancel = false;
        unpinButtons[0].click();
        const existingTimers = document.querySelectorAll('.kvd-pin-timer');
        existingTimers.forEach(timer => timer.remove());
        pinTimerState.endAt = 0;
        pinTimerState.lastSignature = '';
        return;
    }
    const containerEntries = unpinButtons.map(btn => {
        let pinContainer = btn.closest('[data-testid*="pin"], [class*="pin"], [class*="pinned"], .group.relative');
        if (!pinContainer) pinContainer = btn.parentElement || btn.closest('div');
        return pinContainer ? { pinContainer, btn } : null;
    }).filter(Boolean);
    if (!containerEntries.length) return;
    const signatureContainer = containerEntries[0].pinContainer;
    const pinTextEl = signatureContainer.querySelector('span.font-normal:not(.kvd-pin-timer)') || signatureContainer.querySelector('span:not(.kvd-pin-timer)');
    const signature = normalizeTitleText(pinTextEl ? pinTextEl.textContent : signatureContainer.textContent);
    if (pinTimerState.pendingDurationMs !== null && !pinTimerState.endAt) {
        if (pinTimerState.mode === 'stream') {
            pinTimerState.endAt = Infinity;
        } else {
            pinTimerState.endAt = Date.now() + pinTimerState.pendingDurationMs;
        }
        pinTimerState.pendingDurationMs = null;
    }
    if (signature && signature !== pinTimerState.lastSignature) {
        pinTimerState.lastSignature = signature;
        if (!pinTimerState.endAt) {
            pinTimerState.endAt = Date.now() + 120000;
        }
    }
    if (!pinTimerState.endAt) return;
    if (pinTimerState.endAt === Infinity) {
        const activeContainers = new Set(containerEntries.map(entry => entry.pinContainer));
        const existingTimers = Array.from(document.querySelectorAll('.kvd-pin-timer'));
        existingTimers.forEach(timer => {
            if (!activeContainers.has(timer.parentElement)) timer.remove();
        });
        containerEntries.forEach(({ pinContainer, btn }) => {
            let timers = Array.from(pinContainer.querySelectorAll('.kvd-pin-timer'));
            let timerEl = timers.shift();
            timers.forEach(timer => timer.remove());
            if (!timerEl) {
                timerEl = document.createElement('span');
                timerEl.className = 'kvd-pin-timer';
                btn.insertAdjacentElement('beforebegin', timerEl);
            }
            timerEl.textContent = t('pin.live');
        });
        if (isOfflineVisible()) {
            unpinButtons[0].click();
            const existingTimers = document.querySelectorAll('.kvd-pin-timer');
            existingTimers.forEach(timer => timer.remove());
            pinTimerState.endAt = 0;
            pinTimerState.lastSignature = '';
        }
        return;
    }
    const remainingMs = pinTimerState.endAt - Date.now();
    const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const timerText = `${mins}:${secs.toString().padStart(2, '0')}`;
    const activeContainers = new Set(containerEntries.map(entry => entry.pinContainer));
    const existingTimers = Array.from(document.querySelectorAll('.kvd-pin-timer'));
    existingTimers.forEach(timer => {
        if (!activeContainers.has(timer.parentElement)) timer.remove();
    });
    containerEntries.forEach(({ pinContainer, btn }) => {
        let timers = Array.from(pinContainer.querySelectorAll('.kvd-pin-timer'));
        let timerEl = timers.shift();
        timers.forEach(timer => timer.remove());
        if (!timerEl) {
            timerEl = document.createElement('span');
            timerEl.className = 'kvd-pin-timer';
            btn.insertAdjacentElement('beforebegin', timerEl);
        }
        timerEl.textContent = timerText;
    });
    if (remainingSec <= 0) {
        unpinButtons[0].click();
        const existingTimers = document.querySelectorAll('.kvd-pin-timer');
        existingTimers.forEach(timer => timer.remove());
        pinTimerState.endAt = 0;
        pinTimerState.lastSignature = '';
    }
}

function updateChatAdminFeatures() {
    if (!isModerator()) {
        stopChatHighlightObserver();
        const existingTimer = document.querySelector('.kvd-pin-timer');
        if (existingTimer) existingTimer.remove();
        pinTimerState.endAt = 0;
        pinTimerState.lastSignature = '';
        return;
    }
    if (!chatConfigLoaded) {
        loadChatHighlightConfig();
        chatConfigLoaded = true;
    }
    const slug = getChannelSlug();
    if (slug && slug !== chatFirstSeenSlug) {
        chatFirstSeenSlug = slug;
        loadFirstSeenUsers(slug);
    }
    attachPinDurationListener();
    ensureChatHighlightObserver();
    updatePinnedMessageTimer();
}

// --- Helper: Robust Chat Sending ---
function sendChatMessage(message) {
    const chatInput = document.querySelector('div[data-testid="chat-input"][contenteditable="true"], div[data-input="true"][contenteditable="true"].editor-input');
    if (!chatInput) return;

    chatInput.focus();
    
    // 1. Clear existing content safely
    // Selecting all allows insertText to replace, which is cleaner than innerHTML = ''
    document.execCommand('selectAll', false, null);
    
    // 2. Try execCommand 'insertText' (Native browser behavior)
    // This automatically triggers 'input', 'change', etc., and updates the undo stack.
    // Most modern editors (ProseMirror, Slate, Lexical) handle this correctly.
    const success = document.execCommand('insertText', false, message);
    
    if (!success) {
        // 3. Fallback: Manual DOM construction
        console.log('KVD: execCommand failed, using DOM fallback');
        chatInput.innerHTML = ''; // Force clear
        const p = document.createElement('p');
        p.className = 'editor-paragraph';
        const span = document.createElement('span');
        span.textContent = message; // textContent handles escaping automatically
        p.appendChild(span);
        chatInput.appendChild(p);
        
        // Dispatch input event to wake up the framework
        chatInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }

    // 4. Trigger Send (Enter Key or Button)
    setTimeout(() => {
        const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label="Enviar mensaje"], button.chat-input-send-button');
        
        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
        } else {
            // Fallback to Enter key event
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true, view: window
            });
            chatInput.dispatchEvent(enterEvent);
        }
    }, 50); // Short delay to allow React to process the input update
}

// --- Easter Eggs (Roadmap #28 & #29) & Custom Commands ---
function injectEasterEggs() {
    // Selector based on Roadmap line 30 & 41
    const chatInput = document.querySelector('div[data-testid="chat-input"][contenteditable="true"], div[data-input="true"][contenteditable="true"].editor-input');
    
    if (chatInput && !chatInput.dataset.kvdEggAttached) {
        chatInput.dataset.kvdEggAttached = "true";
        
        chatInput.addEventListener('input', (e) => {
            // STOP INFINITE LOOPS: Ignore events generated by our own code
            if (!e.isTrusted) return;

            // Robust text extraction
            const rawText = e.target.innerText || e.target.textContent || "";
            // Normalize: remove zero-width spaces, turn all whitespace to single space, lowercase
            const cleanText = rawText.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            
            // Helper to clear chat input visually immediately
            const clearChat = () => {
                e.target.textContent = '';
                e.target.innerHTML = '<p class="editor-paragraph"><br></p>';
                // Dispatch input to sync empty state
                e.target.dispatchEvent(new Event('input', { bubbles: true }));
            };

            // --- Custom Commands ---
            if (cleanText === '!redes') {
                clearChat();
                // Default social message - User can customize this later via settings (Todo)
                // Mensaje por defecto
                sendChatMessage("Mis redes: Twitter: @KickStreaming | IG: @KickStreaming (Ejemplo - Configurar en extensión)");
                return;
            }

            // --- Easter Eggs ---

            // Roadmap #28: "Imaginate un cubo"
            if (cleanText === 'imaginate un cubo') {
                clearChat();
                triggerCubeEasterEgg();
                return; 
            }

            // "Contexto: No te imaginaste un cubo"
            if (cleanText === 'contexto: no te imaginaste un cubo') {
                clearChat();
                triggerCubeContextEasterEgg();
                return;
            }

            // "Aguante Pavle"
            if (cleanText === 'aguante pavle') {
                clearChat();
                triggerPavleEasterEgg();
                return;
            }

            // "Mondongo"
            if (cleanText === 'mondongo') {
                clearChat();
                triggerMondongoEasterEgg();
                return;
            }

            // "Mambo"
            if (cleanText === 'mambo') {
                clearChat();
                triggerMamboEasterEgg();
                return;
            }

            // "Una maroma!" (Barrel Roll)
            if (cleanText === 'una maroma!') {
                clearChat();
                document.body.classList.add('kvd-barrel-roll');
                setTimeout(() => document.body.classList.remove('kvd-barrel-roll'), 1000);
                return;
            }

            // "me derrito lpm" (Melt)
            if (cleanText === 'me derrito lpm') {
                clearChat();
                document.body.classList.add('kvd-melt-effect');
                // Wait for animation (4s) + a brief "empty" moment (1s)
                setTimeout(() => document.body.classList.remove('kvd-melt-effect'), 5000);
                return;
            }

            // Roadmap #29: "Si le doy un cabezazo al teclado soy admin"
            const enableAdminTricks = [
                "si le doy un cabezazo al teclado soy admin",
                "si le doy un cabezazo al teclado soy admin."
            ];
            
            // Enable Admin Mode (Per Channel)
            if (enableAdminTricks.includes(cleanText)) {
                const slug = getChannelSlug();
                if (!slug) return;

                const adminChannels = JSON.parse(localStorage.getItem('kvd_admin_channels') || '[]');
                
                if (adminChannels.includes(slug)) {
                     clearChat(); // Already enabled
                     return;
                }

                adminChannels.push(slug);
                localStorage.setItem('kvd_admin_channels', JSON.stringify(adminChannels));
                
                // Cleanup old global flag to avoid confusion
                localStorage.removeItem('kvd_admin_trick_enabled');

                clearChat();
                
                setTimeout(() => {
                    alert(t('admin.unlocked', { slug }));
                    window.location.reload();
                }, 100);
                return;
            }

            // Disable Admin Mode (Global) - "Ser admin me da ansiedad"
            const disableAdminTricks = [
                "ser admin me da ansiedad",
                "ser admin me da ansiedad."
            ];

            if (disableAdminTricks.includes(cleanText)) {
                localStorage.removeItem('kvd_admin_channels');
                localStorage.removeItem('kvd_admin_trick_enabled'); // Ensure global is gone too
                
                clearChat();

                setTimeout(() => {
                    alert(t('admin.disabled_all'));
                    window.location.reload();
                }, 100);
                return;
            }
        });
    }
}

function triggerCubeEasterEgg() {
    // Check if container already exists, remove it to restart cleanly
    let existingContainer = document.getElementById('kvd-cube-container');
    if (existingContainer) {
        existingContainer.remove();
    }
    
    const container = document.createElement('div');
    container.id = 'kvd-cube-container';
    container.className = 'kvd-cube-container active';
    
    container.innerHTML = `
        <div class="kvd-cube">
            <div class="kvd-cube-face front">${t('easter.cube.front')}</div>
            <div class="kvd-cube-face back">${t('easter.cube.back')}</div>
            <div class="kvd-cube-face right">${t('easter.cube.right')}</div>
            <div class="kvd-cube-face left">${t('easter.cube.left')}</div>
            <div class="kvd-cube-face top small-text">${t('easter.cube.top')}</div>
            <div class="kvd-cube-face bottom">${t('easter.cube.bottom')}</div>
        </div>
    `;
    
    document.body.appendChild(container);
    
    // Remove after 10 seconds (animation duration matches CSS)
    setTimeout(() => {
        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
        }
    }, 10000);
}

function triggerCubeContextEasterEgg() {
    // Check if container already exists, remove it
    let existingContainer = document.getElementById('kvd-cube-container');
    if (existingContainer) existingContainer.remove();
    let existingText = document.getElementById('kvd-context-text');
    if (existingText) existingText.remove();

    // Create Cube Container with context-mode class
    const container = document.createElement('div');
    container.id = 'kvd-cube-container';
    container.className = 'kvd-cube-container context-mode';
    
    container.innerHTML = `
        <div class="kvd-cube">
            <div class="kvd-cube-face front">${t('easter.cube.front')}</div>
            <div class="kvd-cube-face back">${t('easter.cube.back')}</div>
            <div class="kvd-cube-face right">${t('easter.cube.right')}</div>
            <div class="kvd-cube-face left">${t('easter.cube.left')}</div>
            <div class="kvd-cube-face top small-text">${t('easter.cube.top')}</div>
            <div class="kvd-cube-face bottom">${t('easter.cube.bottom')}</div>
        </div>
    `;

    // Create Text Element
    const textEl = document.createElement('div');
    textEl.id = 'kvd-context-text';
    textEl.className = 'kvd-context-text';
    setI18nText(textEl, 'easter.cube.context_text');

    document.body.appendChild(container);
    document.body.appendChild(textEl);

    // Remove after 5 seconds
    setTimeout(() => {
        if (container.parentNode) container.parentNode.removeChild(container);
        if (textEl.parentNode) textEl.parentNode.removeChild(textEl);
    }, 5000);
}

function triggerPavleEasterEgg() {
    // Create image element
    const pavleImg = document.createElement('img');
    pavleImg.src = chrome.runtime.getURL('assets/pavle.png');
    pavleImg.alt = t('easter.pavle.alt');
    pavleImg.className = 'kvd-pavle-toasty';
    
    // Create audio element
    const toastyAudio = document.createElement('audio');
    toastyAudio.src = chrome.runtime.getURL('assets/toasty.ogg');
    toastyAudio.volume = 0.7;
    
    // Add to DOM
    document.body.appendChild(pavleImg);
    document.body.appendChild(toastyAudio);
    
    // Play sound
    toastyAudio.play().catch(e => console.error('Error playing toasty sound:', e));
    
    // Animate for 1s
    setTimeout(() => {
        // Remove elements
        if (pavleImg.parentNode) pavleImg.parentNode.removeChild(pavleImg);
        if (toastyAudio.parentNode) toastyAudio.parentNode.removeChild(toastyAudio);
    }, 1000);
}

function triggerMondongoEasterEgg() {
    // Create image element
    const gokuImg = document.createElement('img');
    gokuImg.src = chrome.runtime.getURL('assets/gokupelado.png');
    gokuImg.alt = t('easter.mondongo.alt');
    gokuImg.className = 'kvd-goku-mondongo';
    
    // Create audio element
    const mondongoAudio = document.createElement('audio');
    mondongoAudio.src = chrome.runtime.getURL('assets/mondongo.ogg');
    
    // Add to DOM
    document.body.appendChild(gokuImg);
    document.body.appendChild(mondongoAudio);
    
    // Play sound
    mondongoAudio.play().catch(e => console.error('Error playing mondongo sound:', e));
    
    // Remove after 1s
    setTimeout(() => {
        if (gokuImg.parentNode) gokuImg.parentNode.removeChild(gokuImg);
        if (mondongoAudio.parentNode) mondongoAudio.parentNode.removeChild(mondongoAudio);
    }, 1000);
}

function triggerMamboEasterEgg() {
    // Create image element
    const mamboImg = document.createElement('img');
    mamboImg.src = chrome.runtime.getURL('assets/mambo.png');
    mamboImg.alt = t('easter.mambo.alt');
    mamboImg.className = 'kvd-mambo-img';
    
    // Create audio element
    const mamboAudio = document.createElement('audio');
    mamboAudio.src = chrome.runtime.getURL('assets/mambo.ogg');
    
    // Add to DOM
    document.body.appendChild(mamboImg);
    document.body.appendChild(mamboAudio);
    
    // Play sound
    mamboAudio.play().catch(e => console.error('Error playing mambo sound:', e));
    
    // Remove after 1s
    setTimeout(() => {
        if (mamboImg.parentNode) mamboImg.parentNode.removeChild(mamboImg);
        if (mamboAudio.parentNode) mamboAudio.parentNode.removeChild(mamboAudio);
    }, 1000);
}
