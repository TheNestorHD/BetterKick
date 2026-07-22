const I18N = (() => {
    const cache = {};
    let currentLang = '';
    const listeners = new Set();
    const getBrowserLang = () => {
        const chromeLang = chrome && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function' ? chrome.i18n.getUILanguage() : '';
        const navLang = (self.navigator && self.navigator.language) || '';
        const raw = chromeLang || navLang || 'en';
        return raw.split('-')[0].toLowerCase();
    };
    const loadLocale = async (lang) => {
        if (cache[lang]) return cache[lang];
        try {
            const url = chrome.runtime.getURL(`locales/${lang}.json`);
            const res = await fetch(url);
            const data = await res.json();
            cache[lang] = data || {};
        } catch (_) {
            cache[lang] = {};
        }
        return cache[lang];
    };
    const ensure = async () => {
        const lang = getBrowserLang();
        if (!currentLang) currentLang = lang;
        if (lang !== currentLang) currentLang = lang;
        await Promise.all([loadLocale('en'), loadLocale(currentLang)]);
        return currentLang;
    };
    const t = (key, vars) => {
        const lang = currentLang || getBrowserLang();
        const dict = cache[lang] || {};
        const en = cache.en || {};
        let str = dict[key] ?? en[key];
        if (!str) return `[${key}]`;
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
    ensure().catch(() => {});
    watch();
    return { t, ensure, setText, updateAll, onChange, getBrowserLang };
})();

const t = (key, vars) => I18N.t(key, vars);
const setI18nText = (el, key, vars, attr) => I18N.setText(el, key, vars, attr);
const updateI18nAll = (root) => I18N.updateAll(root);

I18N.onChange(() => updateI18nAll());

document.addEventListener('DOMContentLoaded', async () => {
    await I18N.ensure();
    updateI18nAll();
    document.title = t('popup.title');
    // Donate button listener - Always enable this first
    const donateBtn = document.getElementById('donate-btn');
    if (donateBtn) {
        donateBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://ceneka.net/TheNestorHD' });
        });
    }

    initPanelPositionsUI();

    // Check if we are on a Kick tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Initial check: is it a kick url?
    if (!tab || !tab.url || !tab.url.includes('kick.com')) {
        // Not a kick tab, just show default info (library hidden)
        return;
    }

    const ampSection = document.getElementById('amp-section');
    const ampSlider = document.getElementById('amp-slider');
    const ampValue = document.getElementById('amp-value');
    if (ampSection && ampSlider && ampValue) {
        ampSection.style.display = 'block';
        chrome.tabs.sendMessage(tab.id, { type: 'GET_AUDIO_GAIN_DB' }, (response) => {
            if (chrome.runtime.lastError) {
                return;
            }
            const db = response && typeof response.db === 'number' ? response.db : 0;
            const clamped = Math.max(0, Math.min(48, Math.round(db)));
            ampSlider.value = String(clamped);
            ampValue.textContent = t('popup.amp.value', { db: clamped });
        });
        ampSlider.addEventListener('input', () => {
            const db = parseInt(ampSlider.value, 10);
            ampValue.textContent = t('popup.amp.value', { db });
            chrome.tabs.sendMessage(tab.id, { type: 'SET_AUDIO_GAIN_DB', db });
        });
    }

    // Check Admin status
    chrome.tabs.sendMessage(tab.id, { type: 'CHECK_ADMIN' }, (response) => {
        // Handle connection errors (content script not ready, etc)
        if (chrome.runtime.lastError) {
            console.log('Error checking admin:', chrome.runtime.lastError);
            return;
        }

        if (response && response.isAdmin) {
            // Get channel slug from tab URL
            const urlParts = tab.url.split('/');
            // kick.com/slug or kick.com/video/id -> we need the channel slug
            // If it's a video page, we might need to ask content script for channel slug
            // But usually we are on channel page or VOD page. 
            // Let's ask content script for the slug to be safe.
            chrome.tabs.sendMessage(tab.id, { type: 'GET_CHANNEL_SLUG' }, (slugResponse) => {
                const currentSlug = slugResponse ? slugResponse.slug : null;
                initLibraryUI(currentSlug);
            });
        }
    });
});

function initLibraryUI(currentSlug) {
    const container = document.getElementById('library-section');
    if (container) container.style.display = 'block';
    
    loadLibrary(currentSlug);
    initHighlightUI();
    initWebhookUI();
    
    const addBtn = document.getElementById('add-btn');
    if (addBtn) {
        const newBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newBtn, addBtn);
        
        newBtn.addEventListener('click', () => {
            const labelInput = document.getElementById('new-label');
            const msgInput = document.getElementById('new-msg');
            const scopeInput = document.querySelector('input[name="scope"]:checked');
            
            const label = labelInput.value.trim();
            const msg = msgInput.value.trim();
            const scope = scopeInput ? scopeInput.value : 'global';
            
            if (label && msg) {
                const targetSlug = (scope === 'channel' && currentSlug) ? currentSlug : null;
                
                addToLibrary(label, msg, targetSlug, currentSlug);
                labelInput.value = '';
                msgInput.value = '';
            }
        });
    }
}

function initPanelPositionsUI() {
    const btn = document.getElementById('reset-panel-positions-btn');
    const statusEl = document.getElementById('panel-positions-status');
    if (!btn || !statusEl) return;
    btn.addEventListener('click', () => {
        chrome.storage.local.get(null, (all) => {
            const keys = Object.keys(all).filter((k) => k.startsWith('kvd_panel_pos_'));
            if (keys.length === 0) {
                statusEl.textContent = t('popup.panels.nothing_to_reset');
                statusEl.style.color = '#ccc';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
                return;
            }
            chrome.storage.local.remove(keys, () => {
                statusEl.textContent = t('popup.panels.reset_done');
                statusEl.style.color = '#53fc18';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            });
        });
    });
}

function initWebhookUI() {
    const urlInput = document.getElementById('webhook-url');
    const notifyVod = document.getElementById('webhook-notify-vod');
    const notifyLive = document.getElementById('webhook-notify-live');
    const saveBtn = document.getElementById('webhook-save');
    const testBtn = document.getElementById('webhook-test');
    const statusEl = document.getElementById('webhook-status');
    if (!urlInput || !notifyVod || !notifyLive || !saveBtn || !testBtn || !statusEl) return;

    chrome.storage.local.get(['kvd_discord_webhook_config'], (result) => {
        const config = result.kvd_discord_webhook_config || {};
        urlInput.value = config.url || '';
        notifyVod.checked = !!config.notifyVod;
        notifyLive.checked = !!config.notifyLive;
    });

    const setStatus = (text, color) => {
        statusEl.textContent = text;
        statusEl.style.color = color;
    };

    saveBtn.addEventListener('click', () => {
        const config = {
            url: urlInput.value.trim(),
            notifyVod: !!notifyVod.checked,
            notifyLive: !!notifyLive.checked
        };
        chrome.storage.local.set({ kvd_discord_webhook_config: config }, () => {
            setStatus(t('popup.webhook.saved'), '#53fc18');
            setTimeout(() => setStatus('', ''), 3000);
        });
    });

    testBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!url) {
            setStatus(t('popup.webhook.no_url'), '#ff5555');
            return;
        }
        setStatus(t('popup.webhook.sending'), '#ccc');
        chrome.runtime.sendMessage({ type: 'DISCORD_WEBHOOK_TEST', url }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus(t('popup.webhook.failed', { error: chrome.runtime.lastError.message }), '#ff5555');
                return;
            }
            if (response && response.ok) {
                setStatus(t('popup.webhook.sent'), '#53fc18');
            } else {
                setStatus(t('popup.webhook.failed', { error: (response && response.error) || 'Unknown' }), '#ff5555');
            }
            setTimeout(() => setStatus('', ''), 4000);
        });
    });
}

function initHighlightUI() {
    const firstBox = document.getElementById('highlight-first');
    const keywordBox = document.getElementById('highlight-keywords');
    const wordsInput = document.getElementById('highlight-words');
    const saveBtn = document.getElementById('highlight-save');
    if (!firstBox || !keywordBox || !wordsInput || !saveBtn) return;
    chrome.storage.local.get(['kvd_chat_highlight_config'], (result) => {
        const config = result.kvd_chat_highlight_config || {};
        firstBox.checked = config.highlightFirstMessage !== false;
        keywordBox.checked = config.highlightKeywords !== false;
        const list = Array.isArray(config.keywords) ? config.keywords : [];
        wordsInput.value = list.join(', ');
    });
    saveBtn.addEventListener('click', () => {
        const keywords = wordsInput.value
            .split(/[,|\n]/)
            .map(k => k.trim())
            .filter(Boolean);
        const config = {
            highlightFirstMessage: !!firstBox.checked,
            highlightKeywords: !!keywordBox.checked,
            keywords
        };
        chrome.storage.local.set({ kvd_chat_highlight_config: config });
    });
}

function loadLibrary(currentSlug) {
    chrome.storage.local.get(['kvd_chat_library'], (result) => {
        const library = result.kvd_chat_library || [];
        renderLibrary(library, currentSlug);
    });
}

function addToLibrary(label, message, channelSlug, currentSlug) {
    chrome.storage.local.get(['kvd_chat_library'], (result) => {
        const library = result.kvd_chat_library || [];
        library.push({ 
            id: Date.now(), 
            label, 
            message,
            channel: channelSlug // null for global, string for specific channel
        });
        chrome.storage.local.set({ kvd_chat_library: library }, () => {
            renderLibrary(library, currentSlug);
        });
    });
}

function renderLibrary(library, currentSlug) {
    const list = document.getElementById('library-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    // Filter items: Global + Current Channel
    const visibleItems = library.filter(item => {
        return !item.channel || (currentSlug && item.channel.toLowerCase() === currentSlug.toLowerCase());
    });
    
    if (visibleItems.length === 0) {
        list.innerHTML = `<div style="color:#555; font-size:12px; text-align:center; padding:10px;">${t('popup.library.empty')}</div>`;
        return;
    }
    
    visibleItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'lib-item';
        
        const btn = document.createElement('button');
        btn.className = 'lib-btn';
        // Add indicator for channel-specific items
        const scopeIcon = item.channel ? '🔒 ' : '🌐 ';
        btn.textContent = scopeIcon + item.label;
        const scopeText = item.channel ? t('popup.library.scope_channel') : t('popup.library.scope_global');
        btn.title = `${item.message} (${scopeText})`;
        btn.onclick = () => sendToChat(item.message);
        
        const del = document.createElement('button');
        del.className = 'del-btn';
        del.innerHTML = '&times;';
        del.onclick = (e) => {
            e.stopPropagation();
            removeFromLibrary(item.id, currentSlug);
        };
        
        div.appendChild(btn);
        div.appendChild(del);
        list.appendChild(div);
    });
}

function removeFromLibrary(id, currentSlug) {
    chrome.storage.local.get(['kvd_chat_library'], (result) => {
        let library = result.kvd_chat_library || [];
        library = library.filter(item => item.id !== id);
        chrome.storage.local.set({ kvd_chat_library: library }, () => {
            renderLibrary(library, currentSlug);
        });
    });
}

function sendToChat(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'SEND_CHAT', message });
        }
    });
}
