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

    // Cargar noticias y logros DESPUÉS de que I18N.ensure() haya cargado
    // las localizaciones, para que los textos se rendericen correctamente.
    cargarNoticias();
    initAchievementsUI();

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
    
    const highlightSection = document.getElementById('highlight-section');
    if (highlightSection) highlightSection.style.display = 'block';
    
    const webhookSection = document.getElementById('webhook-section');
    if (webhookSection) webhookSection.style.display = 'block';
    
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
            if (config.url) {
                chrome.runtime.sendMessage({ type: 'UNLOCK_ACHIEVEMENT', achievementId: 'webhook_master' });
            }
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
            // Desbloquear logro de moderador
            chrome.runtime.sendMessage({ type: 'UNLOCK_ACHIEVEMENT', achievementId: 'moderator' });
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
async function cargarNoticias() {
    const contenedor = document.getElementById('noticias-container');
    if (!contenedor) return;

    const data = await chrome.storage.local.get(['noticias', 'ultima_noticia_vista']);
    contenedor.innerHTML = '';

    if (data.noticias && data.noticias.length > 0) {
        data.noticias.forEach(noticia => {
            const card = document.createElement('div');
            card.className = 'noticia-card';
            const contenidoHTML = noticia.contenido.replace(/\n/g, '<br>');
            card.innerHTML = `<h4>${noticia.titulo}</h4><p>${contenidoHTML}</p>`;
            contenedor.appendChild(card);
        });

        await chrome.storage.local.set({ ultima_noticia_vista: data.noticias[0].id });
        chrome.action.setBadgeText({ text: "" });
    } else {
        contenedor.innerHTML = `<p class="texto-secundario">${t('popup.news.empty')}</p>`;
    }
}

// --- SISTEMA DE LOGROS ---
const ACHIEVEMENTS_DEF = {
    first_download: { id: 'first_download', icon: '🎬' },
    first_sr: { id: 'first_sr', icon: '🔴' },
    marathon: { id: 'marathon', icon: '⏱️' },
    moderator: { id: 'moderator', icon: '🛡️' },
    webhook_master: { id: 'webhook_master', icon: '🔗' }
};

async function initAchievementsUI() {
    await I18N.ensure(); // Asegurar que las localizaciones estén cargadas
    const list = document.getElementById('achievements-list');
    if (!list) return;

    const data = await chrome.storage.local.get(['achievements', 'kvd_discord_webhook_config']);
    const achievements = data.achievements || {};
    const webhookConfig = data.kvd_discord_webhook_config || {};
    const hasWebhook = !!webhookConfig.url;

    list.innerHTML = '';

    for (const [key, def] of Object.entries(ACHIEVEMENTS_DEF)) {
        const isUnlocked = !!achievements[key];
        const card = document.createElement('div');
        card.className = `achievement-card ${isUnlocked ? 'unlocked' : 'locked'}`;
        
        const dateStr = isUnlocked ? new Date(achievements[key].unlockedAt).toLocaleDateString() : '???';
        
        const achTitle = t(`achievement.${key}.title`);
        const achDesc = t(`achievement.${key}.description`);
        
        card.innerHTML = `
            <div class="achievement-icon">${def.icon}</div>
            <div class="achievement-info">
                <div class="achievement-title">${achTitle} ${isUnlocked ? '✅' : '🔒'}</div>
                <div class="achievement-desc">${achDesc}</div>
                ${isUnlocked ? `<div style="font-size:10px; color:var(--kick-text-muted); margin-top:4px;">${t('achievement.unlocked_date', { date: dateStr })}</div>` : ''}
                ${isUnlocked ? `
                    <button class="btn-share-webhook" data-achievement-id="${key}" ${!hasWebhook ? 'disabled' : ''}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                        <span>${t('achievement.share_webhook')}</span>
                    </button>
                ` : ''}
            </div>
        `;
        list.appendChild(card);
    }

    list.querySelectorAll('.btn-share-webhook').forEach(btn => {
        btn.addEventListener('click', async () => {
            const achId = btn.dataset.achievementId;
            const def = ACHIEVEMENTS_DEF[achId];
            const achievementData = {
                ...def,
                title: t(`achievement.${achId}.title`),
                description: t(`achievement.${achId}.description`)
            };
            
            chrome.runtime.sendMessage({ 
                type: 'SHARE_ACHIEVEMENT_WEBHOOK', 
                achievementId: achId,
                achievement: achievementData
            }, (response) => {
                if (response && response.ok) {
                    btn.innerHTML = '✅';
                    setTimeout(() => {
                        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
                    }, 1500);
                }
            });
        });
    });
}

// Escuchar desbloqueos en tiempo real
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ACHIEVEMENT_UNLOCKED') {
        initAchievementsUI(); // Re-renderizar para mostrar el nuevo logro
    }
});

// cargarNoticias() e initAchievementsUI() se llaman dentro del DOMContentLoaded
// (más arriba) después de await I18N.ensure(), para que las localizaciones
// estén cargadas antes de renderizar los textos de logros y noticias.