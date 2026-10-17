(function () {
    'use strict';

    const nativeBridge = window.AndroidResourceRadar;
    const MAX_PENDING_REQUESTS = 32;
    const MAX_URL_LENGTH = 4096;
    const MAX_DIRECT_RESOURCES = 80;
    const MAX_URL_HISTORY = 20;
    const URL_HISTORY_KEY = 'resource-radar.url-history.v1';
    const THEME_KEY = 'resource-radar.theme.v1';
    const pendingRequests = new Map();
    let requestSequence = 0;

    const state = {
        url: '',
        mode: 'empty',
        directResources: [],
        selected: new Set(),
        platformResult: null,
        scanInFlight: false,
        activeJob: null,
        jobMode: 'direct',
        destination: 'downloads',
        destinationFolder: '',
        urlHistory: [],
        urlHistoryError: '',
        downloadHistory: [],
        downloadHistoryLoading: true,
        downloadHistoryError: '',
        route: 'home',
        routeHistory: [],
        updateCheckInFlight: false,
        updateManualRequested: false,
        updateDownloadInFlight: false,
        updateStatusInFlight: false,
        updateRelease: null,
        updateStatus: null,
        updatePollTimer: null,
    };

    const $ = (id) => document.getElementById(id);
    const els = {
        form: $('scan-form'), url: $('url-input'), clearUrl: $('clear-url'), scan: $('scan-button'),
        message: $('global-message'), serviceTitle: $('service-title'), serviceMessage: $('service-message'), serviceStatus: $('service-status'),
        homeView: $('home-view'), urlHistoryView: $('url-history-view'), downloadHistoryView: $('download-history-view'), empty: $('empty-state'), direct: $('direct-results'), directCount: $('direct-count'), directPageUrl: $('direct-page-url'), directList: $('direct-list'), directEmpty: $('direct-empty'),
        selectAll: $('select-all'), downloadSelected: $('download-selected'), video: $('video-results'), videoPlatformIcon: $('video-platform-icon'), videoPlatformName: $('video-platform-name'), videoTitle: $('video-title'), videoUploader: $('video-uploader'), videoMeta: $('video-meta'), videoQualitySummary: $('video-quality-summary'), videoResolution: $('video-resolution'), downloadVideo: $('download-video'),
         playlist: $('playlist-results'), playlistTitle: $('playlist-title'), playlistUploader: $('playlist-uploader'), playlistCount: $('playlist-count'), playlistResolution: $('playlist-resolution'), playlistList: $('playlist-list'), playlistFolderNote: $('playlist-folder-note'), downloadPlaylist: $('download-playlist'),
        progress: $('progress-card'), progressTitle: $('progress-title'), progressLabel: $('progress-label'), progressPercent: $('progress-percent'), progressTrack: $('progress-track'), progressFill: $('progress-fill'), progressDetail: $('progress-detail'), progressOpenFolder: $('progress-open-folder'), downloadLog: $('download-log'), cancelDownloads: $('cancel-downloads'), openDownloads: $('open-downloads'),
        menuToggle: $('menu-toggle'), menu: $('app-menu'), menuBackdrop: $('menu-backdrop'), menuClose: $('menu-close'), menuHome: $('menu-home'), menuUrlHistory: $('menu-url-history'), menuDownloadHistory: $('menu-download-history'), menuCheckUpdates: $('menu-check-updates'), menuUpdateStatus: $('menu-update-status'), themeToggle: $('theme-toggle'), themeToggleLabel: $('theme-toggle-label'), about: $('about-button'), aboutPanel: $('about-panel'), aboutClose: $('about-close'), notices: $('notices-copy'),
        urlHistoryList: $('url-history-list'), urlHistoryEmpty: $('url-history-empty'), urlHistoryError: $('url-history-error'), clearUrlHistory: $('clear-url-history'),
        downloadHistoryList: $('download-history-list'), downloadHistoryEmpty: $('download-history-empty'), downloadHistoryError: $('download-history-error'), clearDownloadHistory: $('clear-download-history'),
        urlHistoryBack: $('url-history-back'), urlHistoryHome: $('url-history-home'), downloadHistoryBack: $('download-history-back'), downloadHistoryHome: $('download-history-home'),
        updatePanel: $('update-panel'), updateKicker: $('update-kicker'), updateTitle: $('update-title'), updateMessage: $('update-message'), updateReleaseMeta: $('update-release-meta'), updateBody: $('update-body'), updateDownload: $('update-download'), updateSettings: $('update-settings'), updateRetry: $('update-retry'), updateClose: $('update-close'),
    };

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
    }

    function textValue(value, fallback) {
        return typeof value === 'string' && value.trim() ? value : fallback;
    }

    function playlistPathLabel(folderName) {
        return folderName ? 'Downloads/Playlist/' + folderName : 'Downloads/Playlist';
    }

    function finiteNumber(value) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        const number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : null);
        return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
    }

    function parseNativeResponse(raw, operation) {
        if (raw && typeof raw === 'object') return raw;
        if (typeof raw !== 'string' || !raw.trim()) throw new Error(operation + ' returned an empty native response.');
        try { return JSON.parse(raw); } catch (error) { throw new Error(operation + ' returned an invalid native response.'); }
    }

    function serviceError(result, fallback) {
        const error = new Error(result && result.message ? String(result.message) : fallback);
        error.code = result && result.code ? String(result.code) : '';
        return error;
    }

    function invoke(name, value) {
        if (!nativeBridge || typeof nativeBridge.request !== 'function') {
            return Promise.reject(new Error('The native Resource Radar bridge is unavailable.'));
        }
        if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
            return Promise.reject(new Error('Too many native requests are already in progress.'));
        }
        const requestId = 'rr-' + Date.now().toString(36) + '-' + (++requestSequence).toString(36);
        let payload;
        try {
            payload = JSON.stringify(value === undefined ? null : value);
        } catch (error) {
            return Promise.reject(new Error(name + ' could not encode its request.'));
        }
        return new Promise((resolve, reject) => {
            pendingRequests.set(requestId, { resolve: resolve, reject: reject, operation: name });
            try {
                const acknowledgement = parseNativeResponse(nativeBridge.request(name, requestId, payload), name);
                if (!acknowledgement || acknowledgement.ok !== true || acknowledgement.requestId !== requestId) {
                    pendingRequests.delete(requestId);
                    reject(serviceError(acknowledgement, name + ' could not be queued.'));
                }
            } catch (error) {
                pendingRequests.delete(requestId);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    function receiveNativeResult(requestId, rawResponse) {
        if (typeof requestId !== 'string') return;
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        try {
            const result = parseNativeResponse(rawResponse, pending.operation);
            if (!result || result.ok !== true) pending.reject(serviceError(result, pending.operation + ' failed.'));
            else pending.resolve(result);
        } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }

    let downloadEventHandler = null;
    const api = window.resourceRadar = {
        scanPage: (url) => invoke('scanPage', url),
        inspectPlatform: (url) => invoke('inspectPlatform', url),
        getMediaToolStatus: () => invoke('getMediaToolStatus', null),
        downloadResources: (resources) => invoke('downloadResources', resources),
        downloadPlatformMedia: (request) => invoke('downloadPlatformMedia', request),
        cancelDownloads: (jobId) => invoke('cancelDownloads', jobId),
         openDownloads: (destination) => invoke('openDownloads', destination || 'downloads'),
         getDownloadHistory: () => invoke('getDownloadHistory', null),
         clearDownloadHistory: () => invoke('clearDownloadHistory', null),
         openDownload: (historyId) => invoke('openDownload', historyId),
         checkForUpdates: () => invoke('checkForUpdates', null),
         getUpdateStatus: () => invoke('getUpdateStatus', null),
         downloadUpdate: () => invoke('downloadUpdate', null),
         openUpdateInstallSettings: () => invoke('openUpdateInstallSettings', null),
        onDownloadEvent: (callback) => {
            downloadEventHandler = typeof callback === 'function' ? callback : null;
            let result;
            try {
                if (!nativeBridge || typeof nativeBridge.onDownloadEvent !== 'function') throw new Error('The native event bridge is unavailable.');
                result = parseNativeResponse(nativeBridge.onDownloadEvent('resourceRadar.__receiveDownloadEvent'), 'onDownloadEvent');
                if (!result || result.ok !== true) throw serviceError(result, 'Download events could not be subscribed.');
            } catch (error) {
                downloadEventHandler = null;
                throw error instanceof Error ? error : new Error(String(error));
            }
            return function unsubscribeDownloadEvents() {
                if (downloadEventHandler === callback) downloadEventHandler = null;
            };
        },
        __receiveNativeResult: receiveNativeResult,
        __receiveDownloadEvent: (event) => {
            let parsed = event;
            if (typeof event === 'string') {
                try { parsed = JSON.parse(event); } catch (error) { return; }
            }
            if (downloadEventHandler) downloadEventHandler(parsed);
        },
        __receiveLaunchUrl: (url) => {
            if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !/^https:\/\//i.test(url)) return;
            goHome();
            els.url.value = url;
            els.clearUrl.classList.remove('hidden');
            scanUrl();
        },
        __handleBack: () => handleBack(),
        __resume: () => refreshUpdateStatus(true),
    };

    function showMessage(text, kind) {
        if (!text) {
            els.message.textContent = '';
            els.message.className = 'message hidden';
            return;
        }
        els.message.textContent = text;
        els.message.className = 'message ' + (kind || 'error');
    }

    function clearMessage() {
        showMessage('', '');
    }

    function setVisible(element, visible) {
        element.classList.toggle('hidden', !visible);
    }

    function normalizeRoute(value) {
        return value === 'url-history' || value === 'download-history' ? value : 'home';
    }

    function routeFromLocation() {
        const hash = typeof window.location.hash === 'string' ? window.location.hash.slice(1) : '';
        return normalizeRoute(hash);
    }

    function closeMenu() {
        setVisible(els.menu, false);
        els.menuToggle.setAttribute('aria-expanded', 'false');
    }

    function openMenu() {
        setVisible(els.menu, true);
        els.menuToggle.setAttribute('aria-expanded', 'true');
    }

    function renderRoute(route) {
        state.route = normalizeRoute(route);
        setVisible(els.homeView, state.route === 'home');
        setVisible(els.urlHistoryView, state.route === 'url-history');
        setVisible(els.downloadHistoryView, state.route === 'download-history');
        closeMenu();
        if (state.route === 'download-history') loadDownloadHistory();
        if (state.route === 'url-history') renderUrlHistory();
    }

    function navigate(route, push) {
        const target = normalizeRoute(route);
        if (push && target !== state.route) state.routeHistory.push(state.route);
        if (state.routeHistory.length > 20) state.routeHistory.shift();
        try { window.history.replaceState({ route: target }, '', '#' + target); } catch (error) { /* The local view still works without browser history. */ }
        renderRoute(target);
    }

    function goHome() {
        state.routeHistory.length = 0;
        navigate('home', false);
    }

    function goBackFromPage() {
        navigate(state.routeHistory.pop() || 'home', false);
    }

    function handleBack() {
        if (!els.menu.classList.contains('hidden')) { closeMenu(); return true; }
        if (!els.updatePanel.classList.contains('hidden')) { hideUpdatePanel(); return true; }
        if (!els.aboutPanel.classList.contains('hidden')) { setVisible(els.aboutPanel, false); return true; }
        if (state.route !== 'home') { goBackFromPage(); return true; }
        return false;
    }

    function storageValue(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (error) {
            if (key === URL_HISTORY_KEY) state.urlHistoryError = 'Persistent URL history is unavailable in this WebView.';
            return null;
        }
    }

    function saveStorageValue(key, value) {
        try {
            window.localStorage.setItem(key, value);
            return true;
        } catch (error) {
            if (key === URL_HISTORY_KEY) state.urlHistoryError = 'Persistent URL history could not be saved.';
            if (key === THEME_KEY) showMessage('The theme changed for this session but could not be saved.', 'error');
            return false;
        }
    }

    function isRestorableUrl(value) {
        if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) return false;
        try {
            const parsed = new URL(value.trim());
            return parsed.protocol.toLowerCase() === 'https:' && !parsed.username && !parsed.password && Boolean(parsed.hostname);
        } catch (error) {
            return false;
        }
    }

    function renderUrlHistory() {
        const entries = Array.isArray(state.urlHistory) ? state.urlHistory : [];
        els.urlHistoryList.innerHTML = entries.map((url, index) => '<button type="button" class="history-item" data-history-index="' + index + '" aria-label="Restore ' + escapeHtml(url) + '"><span class="history-item-icon" aria-hidden="true">↗</span><span class="history-item-copy"><strong>' + escapeHtml(url) + '</strong><small>Tap to restore this URL</small></span><span class="history-item-status ready">Restore</span></button>').join('');
        setVisible(els.urlHistoryEmpty, entries.length === 0 && !state.urlHistoryError);
        setVisible(els.urlHistoryError, Boolean(state.urlHistoryError));
        els.urlHistoryError.textContent = state.urlHistoryError || '';
        els.clearUrlHistory.disabled = entries.length === 0;
    }

    function loadUrlHistory() {
        const raw = storageValue(URL_HISTORY_KEY);
        if (raw === null) {
            renderUrlHistory();
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            state.urlHistory = Array.isArray(parsed) ? parsed.filter(isRestorableUrl).map((url) => url.trim()).slice(0, MAX_URL_HISTORY) : [];
        } catch (error) {
            state.urlHistory = [];
            state.urlHistoryError = 'Saved URL history could not be read.';
        }
        renderUrlHistory();
    }

    function rememberUrl(url) {
        if (!isRestorableUrl(url)) return;
        const normalized = url.trim();
        state.urlHistory = [normalized].concat(state.urlHistory.filter((entry) => entry !== normalized)).slice(0, MAX_URL_HISTORY);
        saveStorageValue(URL_HISTORY_KEY, JSON.stringify(state.urlHistory));
        renderUrlHistory();
    }

    function clearUrlHistory() {
        state.urlHistory = [];
        state.urlHistoryError = '';
        if (saveStorageValue(URL_HISTORY_KEY, '[]')) {
            renderUrlHistory();
            showMessage('URL history cleared.', 'info');
        } else {
            renderUrlHistory();
        }
    }

    function applyTheme(dark) {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        els.themeToggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
        els.themeToggle.querySelector('.menu-link-icon').textContent = dark ? '☀' : '☾';
        els.themeToggleLabel.textContent = dark ? 'Light mode' : 'Dark mode';
    }

    function loadTheme() {
        applyTheme(storageValue(THEME_KEY) === 'dark');
    }

    function toggleTheme() {
        const dark = document.documentElement.dataset.theme !== 'dark';
        applyTheme(dark);
        saveStorageValue(THEME_KEY, dark ? 'dark' : 'light');
    }

    function formatHistoryDate(value) {
        const timestamp = finiteNumber(value);
        if (timestamp === null || timestamp <= 0) return 'Completed download';
        try {
            return new Date(timestamp).toLocaleString();
        } catch (error) {
            return 'Completed download';
        }
    }

    function renderDownloadHistory() {
        const entries = Array.isArray(state.downloadHistory) ? state.downloadHistory : [];
        els.downloadHistoryList.innerHTML = entries.map((entry) => {
            const id = textValue(entry && entry.id, '');
            const name = textValue(entry && entry.displayName, 'Downloaded file');
            const folder = textValue(entry && entry.relativePath, 'Downloads/').replace(/^Download\//i, 'Downloads/');
            const available = entry && entry.available !== false;
            return '<button type="button" class="history-item" data-download-history-id="' + escapeHtml(id) + '" aria-label="Open ' + escapeHtml(name) + '"><span class="history-item-icon" aria-hidden="true">↓</span><span class="history-item-copy"><strong>' + escapeHtml(name) + '</strong><small>' + escapeHtml(folder) + ' · ' + escapeHtml(formatBytes(entry && entry.size)) + ' · ' + escapeHtml(formatHistoryDate(entry && entry.completedAt)) + '</small></span><span class="history-item-status ' + (available ? 'ready' : 'missing') + '">' + (available ? 'Open' : 'Missing') + '</span></button>';
        }).join('');
        const loading = state.downloadHistoryLoading;
        setVisible(els.downloadHistoryEmpty, loading || (entries.length === 0 && !state.downloadHistoryError));
        els.downloadHistoryEmpty.textContent = loading ? 'Loading completed downloads…' : 'Completed MediaStore downloads will appear here.';
        setVisible(els.downloadHistoryError, Boolean(state.downloadHistoryError));
        els.downloadHistoryError.textContent = state.downloadHistoryError || '';
        els.clearDownloadHistory.disabled = loading || entries.length === 0;
    }

    async function loadDownloadHistory() {
        state.downloadHistoryLoading = true;
        state.downloadHistoryError = '';
        renderDownloadHistory();
        try {
            const result = await api.getDownloadHistory();
            if (!result || result.ok !== true || !Array.isArray(result.downloads)) throw serviceError(result, 'Completed download history could not be loaded.');
            state.downloadHistory = result.downloads;
        } catch (error) {
            state.downloadHistory = [];
            state.downloadHistoryError = error && error.message ? error.message : 'Completed download history could not be loaded.';
        } finally {
            state.downloadHistoryLoading = false;
            renderDownloadHistory();
        }
    }

    async function clearDownloadHistory() {
        if (state.downloadHistoryLoading || !state.downloadHistory.length) return;
        try {
            const result = await api.clearDownloadHistory();
            if (!result || result.ok !== true) throw serviceError(result, 'Download history could not be cleared.');
            state.downloadHistory = [];
            state.downloadHistoryError = '';
            renderDownloadHistory();
            showMessage(textValue(result.message, 'Download history cleared. Saved files remain in Android Downloads.'), 'info');
        } catch (error) {
            state.downloadHistoryError = error && error.message ? error.message : 'Download history could not be cleared.';
            renderDownloadHistory();
            showMessage(state.downloadHistoryError, 'error');
        }
    }

    async function openDownloadHistory(historyId) {
        if (typeof historyId !== 'string' || !historyId.trim()) return;
        try {
            const result = await api.openDownload(historyId);
            if (!result || result.ok !== true) throw serviceError(result, 'The downloaded file could not be opened.');
            showMessage(textValue(result.message, 'The downloaded file was opened.'), 'success');
        } catch (error) {
            showMessage(error && error.message ? error.message : 'The downloaded file could not be opened.', 'error');
            loadDownloadHistory();
        }
    }

    function updateStatusLabel(status) {
        const value = status && typeof status.state === 'string' ? status.state : 'idle';
        if (value === 'queued') return 'Update queued';
        if (value === 'downloading') return status && status.percent !== null && status.percent !== undefined
            ? 'Downloading update · ' + Math.round(Number(status.percent)) + '%'
            : 'Downloading update';
        if (value === 'installer_opened') return 'Installer opened';
        if (value === 'ready') return 'Update ready to install';
        if (value === 'verifying') return 'Verifying update APK';
        if (value === 'blocked') return 'Install permission needed';
        if (value === 'error') return 'Update download needs attention';
        return 'Check Resource Radar releases';
    }

    function setUpdateMenuStatus(status, fallback) {
        if (!els.menuUpdateStatus) return;
        els.menuUpdateStatus.textContent = fallback || updateStatusLabel(status);
    }

    function releaseMeta(release) {
        if (!release || typeof release !== 'object') return '';
        const tag = textValue(release.tagName, 'New release');
        const title = textValue(release.title, '');
        const asset = textValue(release.assetName, 'Android APK');
        const size = finiteNumber(release.assetSize);
        return tag + (title && title !== tag ? ' · ' + title : '') + ' · ' + asset + (size === null ? '' : ' · ' + formatBytes(size));
    }

    function showUpdatePanel() {
        closeMenu();
        setVisible(els.updatePanel, true);
    }

    function hideUpdatePanel() {
        setVisible(els.updatePanel, false);
    }

    function renderUpdatePanel(result, mode) {
        const release = result && result.release ? result.release : state.updateRelease;
        const hasRelease = (result && Object.prototype.hasOwnProperty.call(result, 'hasUpdate'))
            ? result.hasUpdate === true : Boolean(state.updateRelease);
        const hasUpdate = (result && Object.prototype.hasOwnProperty.call(result, 'downloadable'))
            ? result.downloadable === true : hasRelease;
        const status = result && typeof result.state === 'string' ? result.state : '';
        const message = result && typeof result.message === 'string' ? result.message : '';
        els.updateReleaseMeta.textContent = release ? releaseMeta(release) : '';
        els.updateBody.textContent = release ? textValue(release.body, 'No changelog was provided for this release.') : '';
        els.updateRetry.classList.toggle('hidden', mode === 'download');
        els.updateDownload.classList.toggle('hidden', !hasUpdate);
        els.updateSettings.classList.toggle('hidden', status !== 'blocked');
        els.updateDownload.disabled = false;
        els.updateDownload.textContent = 'Download';
        if (mode === 'error') {
            els.updateKicker.textContent = 'UPDATE CHECK';
            els.updateTitle.textContent = 'Update check unavailable';
            els.updateMessage.textContent = message || 'GitHub could not be reached safely. Try again later.';
            els.updateBody.textContent = '';
            els.updateDownload.classList.add('hidden');
            els.updateSettings.classList.add('hidden');
            els.updateRetry.classList.remove('hidden');
            return;
        }
        if (mode === 'checking') {
            els.updateKicker.textContent = 'UPDATE CHECK';
            els.updateTitle.textContent = 'Checking for updates';
            els.updateMessage.textContent = message || 'GitHub is checking the latest eligible public release.';
            els.updateBody.textContent = '';
            els.updateDownload.classList.add('hidden');
            els.updateSettings.classList.add('hidden');
            els.updateRetry.classList.add('hidden');
            return;
        }
        if (!hasRelease) {
            els.updateKicker.textContent = 'UPDATE CHECK';
            els.updateTitle.textContent = result && result.code === 'NO_RELEASE' ? 'No stable release yet' : 'You’re up to date';
            els.updateMessage.textContent = message || 'This Android app is using the latest eligible public release.';
            els.updateReleaseMeta.textContent = '';
            els.updateBody.textContent = '';
            els.updateRetry.classList.remove('hidden');
            return;
        }
        if (!hasUpdate) {
            els.updateKicker.textContent = 'UPDATE AVAILABLE';
            els.updateTitle.textContent = textValue(release && release.title, 'New Resource Radar release');
            els.updateMessage.textContent = textValue(message, 'A newer release exists, but it does not include a supported Android APK.');
            els.updateDownload.classList.add('hidden');
            els.updateSettings.classList.add('hidden');
            els.updateRetry.classList.remove('hidden');
            return;
        }
        els.updateKicker.textContent = 'UPDATE AVAILABLE';
        els.updateTitle.textContent = textValue(release.title, 'New Resource Radar release');
        if (status === 'queued' || status === 'downloading' || status === 'verifying') {
            els.updateDownload.disabled = true;
            els.updateDownload.textContent = status === 'queued' ? 'Queued…' : status === 'verifying' ? 'Verifying…' : 'Downloading…';
            els.updateMessage.textContent = textValue(message, 'Android is downloading the update in the background.');
            const percent = finiteNumber(result && result.percent);
            if (percent !== null) els.updateMessage.textContent += '\n' + Math.round(percent) + '% · ' + formatBytes(result.downloadedBytes) + ' / ' + formatBytes(result.totalBytes);
        } else if (status === 'installer_opened') {
            els.updateDownload.textContent = 'Install again';
            els.updateMessage.textContent = textValue(message, 'Android’s package installer is ready to continue.');
        } else if (status === 'ready') {
            els.updateDownload.textContent = 'Install';
            els.updateMessage.textContent = textValue(message, 'The update APK is verified and ready to install.');
        } else if (status === 'blocked') {
            els.updateMessage.textContent = textValue(message, 'Allow Resource Radar to install unknown apps in Android Settings, then try Install again.');
            els.updateDownload.textContent = 'Try install again';
        } else if (status === 'error') {
            els.updateMessage.textContent = textValue(message, 'The update download needs attention.');
            els.updateDownload.textContent = 'Try download again';
        } else {
            els.updateMessage.textContent = message || 'Download the verified Android APK from the public release.';
        }
    }

    function stopUpdatePolling() {
        if (state.updatePollTimer) {
            window.clearInterval(state.updatePollTimer);
            state.updatePollTimer = null;
        }
    }

    async function refreshUpdateStatus(showPanel) {
        if (state.updateStatusInFlight) return null;
        state.updateStatusInFlight = true;
        try {
            const result = await api.getUpdateStatus();
            const previousState = state.updateStatus && state.updateStatus.state;
            state.updateStatus = result;
            if (result && result.release) state.updateRelease = result.release;
            setUpdateMenuStatus(result);
            if (showPanel && result && result.state !== previousState
                    && ['ready', 'blocked', 'error'].includes(result.state)) showUpdatePanel();
            if (showPanel && result && result.state !== 'idle' && !els.updatePanel.classList.contains('hidden')) renderUpdatePanel(result, 'download');
            const active = result && ['queued', 'downloading', 'verifying', 'ready'].includes(result.state);
            if (active) {
                if (!state.updatePollTimer) {
                    state.updatePollTimer = window.setInterval(() => refreshUpdateStatus(true), 1200);
                }
            } else {
                stopUpdatePolling();
            }
            return result;
        } catch (error) {
            setUpdateMenuStatus(null, 'Update status unavailable');
            stopUpdatePolling();
            return null;
        } finally {
            state.updateStatusInFlight = false;
        }
    }

    async function checkForUpdates(manual) {
        // Reopen an approved transfer without a network check, including when offline.
        if (manual && state.updateStatus
                && ['queued', 'downloading', 'verifying', 'ready', 'blocked', 'installer_opened'].includes(state.updateStatus.state)) {
            showUpdatePanel();
            renderUpdatePanel(state.updateStatus, 'download');
            refreshUpdateStatus(true);
            return;
        }
        if (manual) {
            closeMenu();
            state.updateManualRequested = true;
            showUpdatePanel();
            renderUpdatePanel({ hasUpdate: false, message: 'Checking GitHub for the latest eligible release…' }, 'checking');
        }
        if (state.updateCheckInFlight) return;
        state.updateCheckInFlight = true;
        setUpdateMenuStatus(null, 'Checking for updates…');
        try {
            const result = await api.checkForUpdates();
            state.updateRelease = result && result.hasUpdate === true && result.release ? result.release : null;
            setUpdateMenuStatus(result, result.hasUpdate === true ? 'Update available' : 'You’re up to date');
            if (state.updateStatus && state.updateStatus.state !== 'idle' && state.updateStatus.release) {
                state.updateRelease = state.updateStatus.release;
                setUpdateMenuStatus(state.updateStatus);
                if (state.updateManualRequested || ['ready', 'blocked'].includes(state.updateStatus.state)) {
                    showUpdatePanel();
                    renderUpdatePanel(state.updateStatus, 'download');
                }
            } else if (result && result.hasUpdate === true) {
                showUpdatePanel();
                renderUpdatePanel(result, 'check');
            } else if (state.updateManualRequested) {
                showUpdatePanel();
                renderUpdatePanel(result, 'check');
            }
        } catch (error) {
            const message = error && error.message ? error.message : 'GitHub could not be reached safely.';
            setUpdateMenuStatus(null, 'Update check unavailable');
            if (state.updateManualRequested) {
                showUpdatePanel();
                renderUpdatePanel({ message: message }, 'error');
            }
        } finally {
            state.updateCheckInFlight = false;
            state.updateManualRequested = false;
        }
    }

    async function downloadUpdate() {
        if (!state.updateRelease || state.updateDownloadInFlight) return;
        state.updateDownloadInFlight = true;
        els.updateDownload.disabled = true;
        try {
            const result = await api.downloadUpdate();
            state.updateStatus = result;
            if (result && result.release) state.updateRelease = result.release;
            setUpdateMenuStatus(result);
            showUpdatePanel();
            renderUpdatePanel(result, 'download');
            if (result && result.state && result.state !== 'idle') {
                if (!state.updatePollTimer) state.updatePollTimer = window.setInterval(() => refreshUpdateStatus(true), 1200);
            }
            if (result && (result.state === 'ready' || result.state === 'blocked' || result.state === 'installer_opened')) {
                window.setTimeout(() => refreshUpdateStatus(true), 400);
            }
        } catch (error) {
            const message = error && error.message ? error.message : 'The Android update download could not be started.';
            state.updateStatus = { state: 'error', message: message, release: state.updateRelease };
            setUpdateMenuStatus(state.updateStatus);
            showUpdatePanel();
            renderUpdatePanel(state.updateStatus, 'download');
        } finally {
            state.updateDownloadInFlight = false;
        }
    }

    async function openUpdateInstallSettings() {
        try {
            const result = await api.openUpdateInstallSettings();
            if (result && result.message) showMessage(result.message, 'info');
        } catch (error) {
            showMessage(error && error.message ? error.message : 'Android install settings could not be opened.', 'error');
        }
    }

    function isDownloadActive() {
        return Boolean(state.activeJob && (state.activeJob.pending || state.activeJob.id));
    }

    function updateControls() {
        const downloadActive = isDownloadActive();
        const scanDisabled = state.scanInFlight || downloadActive;
        els.scan.disabled = scanDisabled;
        els.scan.innerHTML = state.scanInFlight ? '<span class="button-icon">◌</span> Checking…' : '<span class="button-icon">⌕</span> Scan page';
        const selectedCount = state.selected.size;
        els.selectAll.disabled = downloadActive || !state.directResources.length;
        els.downloadSelected.disabled = downloadActive || selectedCount === 0;
        els.downloadSelected.textContent = selectedCount ? 'Download selected (' + selectedCount + ')' : 'Download selected';
        els.selectAll.textContent = selectedCount === state.directResources.length && selectedCount ? 'Clear all' : 'Select all';
        els.downloadVideo.disabled = downloadActive;
        els.downloadPlaylist.disabled = downloadActive;
        els.videoResolution.disabled = downloadActive;
        els.playlistResolution.disabled = downloadActive;
        els.cancelDownloads.disabled = !state.activeJob || !state.activeJob.id || state.activeJob.cancelPending;
    }

    function formatBytes(value) {
        const bytes = finiteNumber(value);
        if (bytes === null) return '—';
        if (bytes < 1024) return Math.round(bytes) + ' B';
        const units = ['KB', 'MB', 'GB', 'TB'];
        let amount = bytes;
        let unit = 'B';
        for (let index = 0; index < units.length; index++) {
            amount /= 1024;
            unit = units[index];
            if (amount < 1024 || index === units.length - 1) break;
        }
        return amount.toFixed(amount >= 10 ? 0 : 1) + ' ' + unit;
    }

    function formatDuration(value) {
        const seconds = finiteNumber(value);
        if (seconds === null) return '—';
        const total = Math.round(seconds);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
    }

    function platformLabel(platform) {
        return ({ youtube: 'YouTube', dailymotion: 'Dailymotion', linkedin: 'LinkedIn', instagram: 'Instagram' }[platform]) || 'Platform video';
    }

    function platformIcon(platform) {
        return ({ youtube: '▶', dailymotion: 'D', linkedin: 'in', instagram: '◎' }[platform]) || '▶';
    }

    function formatDate(value) {
        const text = typeof value === 'string' ? value : '';
        return /^\d{8}$/.test(text) ? text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8) : 'Date unavailable';
    }

    function resetResults() {
        setVisible(els.empty, false);
        setVisible(els.direct, false);
        setVisible(els.video, false);
        setVisible(els.playlist, false);
        state.directResources = [];
        state.selected.clear();
        state.platformResult = null;
        updateControls();
    }

    function showEmpty(title, detail) {
        resetResults();
        els.empty.querySelector('h3').textContent = title || 'Paste a public URL to begin';
        els.empty.querySelector('p:last-child').textContent = detail || 'Discovered videos and documents appear here before anything is saved.';
        setVisible(els.empty, true);
        state.mode = 'empty';
    }

    function setServiceState(status) {
        if (!status || status.loading) {
            els.serviceTitle.textContent = 'Checking native services';
            els.serviceMessage.textContent = 'Initializing the bundled scanner and media runtime.';
            els.serviceStatus.textContent = 'CHECKING';
            els.serviceStatus.style.color = '#765c29';
            els.serviceStatus.style.background = '#fff2e8';
            return;
        }
        const runtimeFailed = status.runtimeReady === false || status.runtimeAvailable === false || status.initializationFailed === true;
        const ready = status.ok === true && status.ready === true && status.available !== false && !runtimeFailed;
        els.serviceTitle.textContent = ready ? 'Native services ready' : 'Native services unavailable';
        els.serviceMessage.textContent = textValue(status.message, ready ? 'Scanning and native downloads are ready.' : 'The bundled native runtime could not be initialized.');
        els.serviceStatus.textContent = ready ? 'READY' : 'UNAVAILABLE';
        els.serviceStatus.style.color = ready ? '#277f69' : '#a44257';
        els.serviceStatus.style.background = ready ? '#e8faf4' : '#fff0f3';
    }

    function addResolutionOptions(select, resolutions) {
        const seen = new Set();
        const values = Array.isArray(resolutions) ? resolutions.map(finiteNumber).filter((value) => value !== null && value > 0).map((value) => Math.round(value)).filter((value) => {
            if (seen.has(value)) return false;
            seen.add(value);
            return true;
        }) : [];
        select.innerHTML = '<option value="">Highest available</option>' + values.map((height) => '<option value="' + height + '">Up to ' + height + 'p</option>').join('');
    }

    function renderDirectResults(result) {
        resetResults();
        state.mode = 'direct';
        state.directResources = Array.isArray(result.resources) ? result.resources.filter((resource) => resource && typeof resource === 'object') : [];
        els.directCount.textContent = String(state.directResources.length);
        els.directPageUrl.textContent = textValue(result.pageUrl, state.url);
        els.directList.innerHTML = state.directResources.map((resource, index) => {
            const label = textValue(resource.label, textValue(resource.title, textValue(resource.url, 'Resource')));
            const resourceUrl = textValue(resource.url, '');
            const kind = textValue(resource.kind, 'file');
            const source = textValue(resource.source, 'link');
            return '<label class="resource-row"><input type="checkbox" data-resource-index="' + index + '" aria-label="Select ' + escapeHtml(label) + '"><span class="resource-icon">' + (kind === 'video' ? '▶' : '▤') + '</span><span class="resource-copy"><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(resourceUrl) + '</span></span><span class="resource-badges"><span class="type-pill ' + (kind === 'video' ? 'video' : 'document') + '">' + escapeHtml(kind) + '</span><span class="source-pill">' + escapeHtml(source) + '</span></span></label>';
        }).join('');
        setVisible(els.direct, true);
        setVisible(els.directEmpty, state.directResources.length === 0);
        updateControls();
    }

    function renderVideoResults(media) {
        resetResults();
        state.mode = 'video';
        state.platformResult = { mode: 'video', media: media };
        els.videoPlatformIcon.textContent = platformIcon(media.platform);
        els.videoPlatformName.textContent = platformLabel(media.platform);
        els.videoTitle.textContent = textValue(media.title, 'Untitled video');
        els.videoUploader.textContent = media.uploader ? 'By ' + String(media.uploader) : 'Public video URL';
        const metadata = [];
        const duration = finiteNumber(media.duration);
        if (duration !== null) metadata.push('<span>' + escapeHtml(formatDuration(duration)) + '</span>');
        if (media.uploadDate) metadata.push('<span>Published ' + escapeHtml(formatDate(media.uploadDate)) + '</span>');
        if (Array.isArray(media.formats) && media.formats.length) metadata.push('<span>' + media.formats.length + ' formats</span>');
        els.videoMeta.innerHTML = metadata.join('<span>•</span>') || '<span>Metadata available</span>';
        const resolutions = Array.isArray(media.resolutions) ? media.resolutions.map(finiteNumber).filter((value) => value !== null && value > 0) : [];
        els.videoQualitySummary.textContent = resolutions.length ? 'Up to ' + Math.round(resolutions[0]) + 'p' : 'Automatic';
        addResolutionOptions(els.videoResolution, resolutions);
        setVisible(els.video, true);
        updateControls();
    }

    function renderPlaylistResults(playlist) {
        resetResults();
        state.mode = 'playlist';
        state.platformResult = { mode: 'playlist', playlist: playlist };
        els.playlistTitle.textContent = textValue(playlist.title, 'YouTube playlist');
        els.playlistUploader.textContent = playlist.uploader ? 'By ' + String(playlist.uploader) : 'Sorted oldest first by upload date';
        const entries = Array.isArray(playlist.entries) ? playlist.entries.filter((entry) => entry && typeof entry === 'object') : [];
        const availableCount = finiteNumber(playlist.availableCount);
        els.playlistCount.textContent = String(availableCount === null ? entries.filter((entry) => entry.available === true).length : availableCount);
        addResolutionOptions(els.playlistResolution, playlist.resolutions || []);
        const folderName = textValue(playlist.folderName, 'playlist-specific folder');
        els.playlistFolderNote.textContent = 'Saved sequentially with clean numbered names in ' + playlistPathLabel(folderName) + '.';
        els.playlistList.innerHTML = entries.map((entry, index) => {
            const order = finiteNumber(entry.order);
            const number = order === null ? index + 1 : Math.round(order);
            const title = textValue(entry.title, 'Untitled video');
            const id = textValue(entry.id, textValue(entry.url, ''));
            const available = entry.available === true;
            return '<div class="playlist-entry"><span class="order-number">' + number + '.</span><span class="playlist-video-title"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(id) + '</small></span><span>' + escapeHtml(formatDate(entry.uploadDate)) + '</span><span class="' + (available ? 'status-ok' : 'status-skip') + '">' + (available ? 'Ready' : 'Skipped') + '</span></div>';
        }).join('');
        setVisible(els.playlist, true);
        updateControls();
    }

    async function scanUrl() {
        if (state.scanInFlight || isDownloadActive()) return;
        const rawUrl = els.url.value.trim();
        if (!rawUrl) {
            showMessage('Enter a public HTTPS URL first.', 'error');
            els.url.focus();
            return;
        }
        if (rawUrl.length > MAX_URL_LENGTH) {
            showMessage('That URL is too long to scan.', 'error');
            return;
        }
        clearMessage();
        state.url = rawUrl;
        state.scanInFlight = true;
        updateControls();
        showEmpty('Checking native services…', 'Inspecting the public URL. Nothing is saved until you start a download.');
        try {
            let platformResult;
            try {
                platformResult = await api.inspectPlatform(rawUrl);
            } catch (error) {
                // Ordinary HTTPS pages are expected to be rejected by the platform
                // inspector; they continue through the direct-resource scanner.
                if (!error || error.code !== 'UNSUPPORTED_PLATFORM') throw error;
                platformResult = { ok: true, mode: 'page', url: rawUrl };
            }
            if (!platformResult || platformResult.ok !== true) throw serviceError(platformResult, 'Platform inspection failed.');
            if (platformResult.mode === 'video') {
                renderVideoResults(platformResult.media || {});
                showMessage('Video formats are ready. Choose a maximum resolution.', 'success');
            } else if (platformResult.mode === 'playlist') {
                renderPlaylistResults(platformResult);
                showMessage('Playlist sorted oldest first. Downloads will be numbered sequentially.', 'success');
            } else {
                const result = await api.scanPage(platformResult.url || rawUrl);
                if (!result || result.ok !== true) throw serviceError(result, 'The page scan failed.');
                renderDirectResults(result);
                showMessage('Resources are ready to review. Up to three downloads can run at once.', 'success');
            }
            rememberUrl(rawUrl);
            setVisible(els.empty, false);
        } catch (error) {
            showEmpty('Nothing saved yet', 'Check the URL and try again.');
            showMessage(error && error.message ? error.message : 'The scan failed.', 'error');
        } finally {
            state.scanInFlight = false;
            updateControls();
        }
    }

    function selectedDirectResources() {
        return Array.from(state.selected).map((index) => state.directResources[index]).filter(Boolean).map((resource) => ({
            url: resource.url,
            kind: resource.kind,
            label: textValue(resource.label, textValue(resource.title, resource.url)),
        }));
    }

    function showProgress(title, total, mode, destination) {
        state.jobMode = mode;
        state.destination = destination;
        state.activeJob = {
            id: '',
            pending: true,
            total: finiteNumber(total),
            destination: destination,
            destinationFolder: '',
            items: new Map(),
            titles: new Map(),
            preStartEvents: [],
            cancelPending: false,
        };
        els.progressTitle.textContent = title;
        els.progressLabel.textContent = state.activeJob.total ? 'Preparing 0 of ' + state.activeJob.total : 'Preparing…';
        els.progressDetail.textContent = destination === 'playlist' ? 'Saving sequentially to a playlist-specific Downloads folder.' : 'Saving to Android Downloads.';
        els.progressOpenFolder.classList.add('hidden');
        els.cancelDownloads.classList.remove('hidden');
        els.downloadLog.innerHTML = '';
        setAggregateIndeterminate(true);
        setVisible(els.progress, true);
        updateControls();
    }

    function setAggregateIndeterminate(indeterminate) {
        if (indeterminate) {
            els.progressPercent.textContent = 'Live';
            els.progressFill.classList.add('indeterminate');
            els.progressFill.style.width = '36%';
            els.progressTrack.removeAttribute('aria-valuenow');
            return;
        }
        els.progressFill.classList.remove('indeterminate');
    }

    function setAggregateProgress(fraction) {
        const safeFraction = finiteNumber(fraction);
        if (safeFraction === null) {
            setAggregateIndeterminate(true);
            return;
        }
        const safe = Math.max(0, Math.min(1, safeFraction));
        setAggregateIndeterminate(false);
        els.progressPercent.textContent = Math.round(safe * 100) + '%';
        els.progressFill.style.width = (safe * 100) + '%';
        els.progressTrack.setAttribute('aria-valuenow', String(Math.round(safe * 100)));
    }

    function eventNumber(event, keys) {
        for (let index = 0; index < keys.length; index++) {
            if (Object.prototype.hasOwnProperty.call(event, keys[index])) {
                const value = finiteNumber(event[keys[index]]);
                if (value !== null) return value;
            }
        }
        return null;
    }

    function ensureItem(itemId, event) {
        if (!state.activeJob || typeof itemId !== 'string' || !itemId.trim()) return null;
        let item = state.activeJob.items.get(itemId);
        if (!item) {
            const knownTitle = state.activeJob.titles.get(itemId);
            item = { id: itemId, title: textValue(event && event.title, textValue(knownTitle, textValue(event && event.url, itemId))), status: 'active', phase: 'downloading', percent: null, downloaded: null, total: null, speed: null, eta: null, index: null, historySaved: true, line: null };
            state.activeJob.items.set(itemId, item);
        }
        return item;
    }

    function itemLine(item) {
        if (item.line) return item.line;
        const line = document.createElement('div');
        line.className = 'log-line';
        line.dataset.itemId = item.id;
        const title = document.createElement('span');
        title.className = 'log-title';
        const details = document.createElement('span');
        details.className = 'log-progress';
        line.appendChild(title);
        line.appendChild(details);
        els.downloadLog.appendChild(line);
        item.line = line;
        return line;
    }

    function itemMetricText(item) {
        const metrics = [];
        if (item.percent !== null) metrics.push(Math.round(item.percent) + '%');
        if (item.downloaded !== null) metrics.push(formatBytes(item.downloaded) + (item.total !== null && item.total > 0 ? ' / ' + formatBytes(item.total) : ' downloaded'));
        if (item.speed !== null) metrics.push(formatBytes(item.speed) + '/s');
        if (item.eta !== null) metrics.push('ETA ' + formatDuration(item.eta));
        if (item.phase === 'finalizing') metrics.push('Finalizing…');
        if (item.status === 'complete') metrics.push('Complete');
        if (item.status === 'failed') metrics.push('Failed' + (item.error ? ' · ' + item.error : ''));
        if (item.status === 'canceled') metrics.push('Canceled');
        return metrics.join(' · ') || (item.status === 'active' ? 'Starting…' : '—');
    }

    function updateItemLine(item) {
        const line = itemLine(item);
        line.classList.toggle('done', item.status === 'complete');
        line.classList.toggle('failed', item.status === 'failed' || item.status === 'canceled');
        line.querySelector('.log-title').textContent = item.title;
        line.querySelector('.log-progress').textContent = itemMetricText(item);
    }

    function updateAggregateProgress() {
        if (!state.activeJob) return;
        const items = Array.from(state.activeJob.items.values());
        const total = state.activeJob.total !== null && state.activeJob.total > 0 ? state.activeJob.total : items.length;
        if (!total) {
            setAggregateIndeterminate(true);
            return;
        }
        let contribution = 0;
        let unknownActive = false;
        let activeTitle = '';
        items.forEach((item) => {
            if (item.status === 'complete') contribution += 1;
            else if (item.status === 'active') {
                if (item.percent === null) unknownActive = true;
                else contribution += Math.min(0.99, item.percent / 100);
                if (!activeTitle) activeTitle = item.title;
            }
        });
        const fraction = Math.min(0.99, contribution / total);
        if (unknownActive) setAggregateIndeterminate(true);
        else setAggregateProgress(fraction);
        const completed = items.filter((item) => item.status === 'complete').length;
        els.progressLabel.textContent = activeTitle ? completed + ' of ' + total + ' · ' + activeTitle : completed + ' of ' + total + ' complete';
    }

    function applyProgressMetrics(item, event) {
        const downloaded = eventNumber(event, ['downloadedBytes', 'receivedBytes']);
        const total = eventNumber(event, ['totalBytes', 'expectedBytes']);
        const percent = eventNumber(event, ['percent']);
        const speed = eventNumber(event, ['speedBytesPerSecond', 'speed', 'bytesPerSecond']);
        const eta = eventNumber(event, ['etaSeconds', 'eta']);
        if (downloaded !== null) item.downloaded = downloaded;
        if (total !== null) item.total = total;
        if (percent !== null) item.percent = Math.max(0, Math.min(100, percent));
        else if (item.percent === null && item.downloaded !== null && item.total !== null && item.total > 0) item.percent = Math.max(0, Math.min(100, (item.downloaded / item.total) * 100));
        if (speed !== null) item.speed = speed;
        if (eta !== null) item.eta = eta;
    }

    function eventJobId(event) {
        return typeof event.jobId === 'string' && event.jobId.trim() ? event.jobId : '';
    }

    function updateProgress(rawEvent) {
        if (!rawEvent || typeof rawEvent !== 'object' || !state.activeJob) return;
        const event = rawEvent;
        const type = typeof event.type === 'string' ? event.type.toLowerCase() : '';
        const jobId = eventJobId(event);
        if (state.activeJob.pending && !state.activeJob.id) {
            if (jobId && state.activeJob.preStartEvents.length < 64) state.activeJob.preStartEvents.push(event);
            return;
        }
        if (!state.activeJob.id) {
            if (type !== 'job-started' || !jobId) return;
            state.activeJob.id = jobId;
            state.activeJob.pending = false;
        } else if (!jobId || state.activeJob.id !== jobId) {
            return;
        }
        const eventTotal = eventNumber(event, ['total', 'itemCount', 'count']);
        if (eventTotal !== null && eventTotal > 0) state.activeJob.total = eventTotal;
        if (type === 'job-started') {
            state.activeJob.pending = false;
            els.progressLabel.textContent = state.activeJob.total ? 'Preparing 0 of ' + state.activeJob.total : 'Preparing…';
            updateControls();
            return;
        }
        if (type === 'playlist-scan-progress') {
            const completed = eventNumber(event, ['completed', 'scanned', 'index']);
            const total = eventNumber(event, ['total', 'itemCount']);
            els.progressLabel.textContent = completed !== null && total !== null ? 'Checking playlist ' + completed + ' of ' + total : 'Checking playlist…';
            if (completed !== null && total !== null && total > 0) setAggregateProgress(Math.min(0.25, completed / total / 4));
            else setAggregateIndeterminate(true);
            return;
        }
        if (type === 'playlist-ready') {
            const total = eventNumber(event, ['total', 'itemCount', 'count']);
            if (total !== null && total > 0) state.activeJob.total = total;
            state.activeJob.destinationFolder = textValue(event.folderName, state.activeJob.destinationFolder);
            els.progressLabel.textContent = state.activeJob.total ? 'Ready · 0 of ' + state.activeJob.total : 'Ready to download';
            els.progressDetail.textContent = state.activeJob.destinationFolder ? 'Saving sequentially to ' + playlistPathLabel(state.activeJob.destinationFolder) + '.' : 'Saving sequentially to a playlist-specific Downloads folder.';
            setAggregateProgress(0);
            return;
        }
        if (type === 'item-started') {
            const itemId = eventJobItemId(event);
            const item = ensureItem(itemId, event);
            if (!item) return;
            item.status = 'active';
            item.phase = 'downloading';
            item.title = textValue(event.title, textValue(event.url, item.title));
            const index = eventNumber(event, ['index', 'itemIndex']);
            if (index !== null) item.index = index;
            applyProgressMetrics(item, event);
            updateItemLine(item);
            updateAggregateProgress();
            return;
        }
        if (type === 'item-progress' || type === 'progress' || type === 'item-finalizing' || type === 'stream-finished') {
            const itemId = eventJobItemId(event);
            const item = ensureItem(itemId, event);
            if (!item) return;
            applyProgressMetrics(item, event);
            const status = typeof event.status === 'string' ? event.status.toLowerCase() : '';
            if (type === 'item-finalizing' || type === 'stream-finished' || status === 'finished' || status === 'finalizing') item.phase = 'finalizing';
            item.status = 'active';
            updateItemLine(item);
            els.progressDetail.textContent = itemMetricText(item);
            updateAggregateProgress();
            return;
        }
        const normalizedStatus = typeof event.status === 'string' ? event.status.toLowerCase() : '';
        if (type === 'item-complete' || type === 'item-completed' || (type === 'item-status' && normalizedStatus === 'complete')) {
            const itemId = eventJobItemId(event);
            const item = ensureItem(itemId, event);
            if (!item) return;
            applyProgressMetrics(item, event);
            item.status = 'complete';
            item.phase = 'complete';
            item.percent = 100;
            item.historySaved = event.historySaved !== false;
            updateItemLine(item);
            updateAggregateProgress();
            return;
        }
        if (type === 'item-failed' || type === 'item-error') {
            const itemId = eventJobItemId(event);
            const item = ensureItem(itemId, event);
            if (!item) return;
            item.status = event.canceled === true || event.cancelled === true ? 'canceled' : 'failed';
            item.phase = 'terminal';
            item.error = textValue(event.error, textValue(event.message, 'Download failed.'));
            updateItemLine(item);
            updateAggregateProgress();
            return;
        }
        if (type === 'item-canceled' || type === 'item-cancelled') {
            const itemId = eventJobItemId(event);
            const item = ensureItem(itemId, event);
            if (!item) return;
            item.status = 'canceled';
            item.phase = 'terminal';
            updateItemLine(item);
            updateAggregateProgress();
            return;
        }
        if (type === 'job-complete' || type === 'job-completed' || type === 'job-failed' || type === 'job-canceled' || type === 'job-cancelled' || type === 'job-error') {
            finishJob(event, type);
        }
    }

    function eventJobItemId(event) {
        if (typeof event.itemId === 'string' && event.itemId.trim()) return event.itemId;
        if (typeof event.id === 'string' && event.id.trim() && event.id !== event.jobId) return event.id;
        return '';
    }

    function finishJob(event, type) {
        if (!state.activeJob) return;
        const job = state.activeJob;
        const status = typeof event.status === 'string' ? event.status.toLowerCase() : '';
        const canceled = event.canceled === true || type === 'job-canceled' || type === 'job-cancelled' || status === 'canceled' || status === 'cancelled';
        const itemFailed = Array.from(job.items.values()).some((item) => item.status === 'failed' || item.status === 'canceled');
        const historyUnavailable = Array.from(job.items.values()).some((item) => item.historySaved === false);
        const results = Array.isArray(event.results) ? event.results : [];
        const resultFailures = results.filter((result) => result && result.ok !== true).length;
        const resultSuccesses = results.filter((result) => result && result.ok === true).length;
        const failed = !canceled && (event.failed === true || event.ok === false || type === 'job-failed' || type === 'job-error' || status === 'failed' || itemFailed || resultFailures > 0);
        const savedCount = Math.max(Array.from(job.items.values()).filter((item) => item.status === 'complete').length, resultSuccesses);
        if (canceled) {
            els.progressLabel.textContent = 'Queue canceled';
            els.progressDetail.textContent = savedCount ? 'Queue stopped. Completed files remain in ' + destinationLabel(job) + '.' : 'Queue stopped before the remaining files were saved.';
            showMessage('The download queue was canceled.', 'info');
        } else if (failed) {
            els.progressLabel.textContent = 'Queue finished with errors';
            els.progressDetail.textContent = savedCount ? 'Some files were saved to ' + destinationLabel(job) + '.' : 'No files were saved.';
            showMessage(textValue(event.message, textValue(event.error, 'One or more downloads failed.')), 'error');
        } else {
            els.progressLabel.textContent = 'Queue complete';
            els.progressDetail.textContent = historyUnavailable
                ? 'Saved to ' + destinationLabel(job) + '; history could not be saved.'
                : 'Saved to ' + destinationLabel(job) + '.';
            setAggregateProgress(1);
            showMessage(historyUnavailable
                ? 'Downloads are ready, but completed history could not be saved.'
                : 'Downloads are ready in ' + destinationLabel(job) + '.', historyUnavailable ? 'error' : 'success');
        }
        if (savedCount) els.progressOpenFolder.classList.remove('hidden');
        else els.progressOpenFolder.classList.add('hidden');
        els.cancelDownloads.classList.add('hidden');
        state.activeJob = null;
        updateControls();
        loadDownloadHistory();
    }

    function destinationLabel(job) {
        return job && job.destination === 'playlist'
            ? playlistPathLabel(textValue(job.destinationFolder, 'the playlist folder'))
            : 'Android Downloads';
    }

    function acceptJobResult(result) {
        if (!result || result.ok !== true) throw serviceError(result, 'The download queue could not start.');
        const jobId = typeof result.jobId === 'string' && result.jobId.trim() ? result.jobId : '';
        if (!jobId || !state.activeJob) throw new Error('The native download queue did not return a job id.');
        if (state.activeJob.id && state.activeJob.id !== jobId) throw new Error('The native download queue returned a stale job id.');
        state.activeJob.id = jobId;
        state.activeJob.pending = false;
        const total = finiteNumber(result.total);
        if (total !== null && total > 0) state.activeJob.total = total;
        if (result.destination === 'playlist' || result.destination === 'downloads') state.destination = result.destination;
        const queuedEvents = state.activeJob.preStartEvents.slice();
        state.activeJob.preStartEvents.length = 0;
        updateControls();
        queuedEvents.filter((event) => eventJobId(event) === jobId).forEach(updateProgress);
    }

    function failStartingJob(error) {
        state.activeJob = null;
        setVisible(els.progress, false);
        updateControls();
        showMessage(error && error.message ? error.message : 'The download queue could not start.', 'error');
    }

    async function startDirectDownload() {
        if (isDownloadActive()) return;
        const resources = selectedDirectResources();
        if (!resources.length) return;
        showProgress('Downloading ' + resources.length + ' resource' + (resources.length === 1 ? '' : 's'), resources.length, 'direct', 'downloads');
        resources.forEach((resource, index) => state.activeJob.titles.set('resource-' + (index + 1), textValue(resource.label, resource.url)));
        try {
            acceptJobResult(await api.downloadResources(resources));
        } catch (error) {
            failStartingJob(error);
        }
    }

    async function startVideoDownload() {
        if (isDownloadActive()) return;
        const media = state.platformResult && state.platformResult.media;
        if (!media || typeof media.url !== 'string') return;
        showProgress('Downloading video', 1, 'video', 'downloads');
        state.activeJob.titles.set('video-1', textValue(media.title, 'Video'));
        try {
            acceptJobResult(await api.downloadPlatformMedia({ url: media.url, maxHeight: els.videoResolution.value || null, playlist: false }));
        } catch (error) {
            failStartingJob(error);
        }
    }

    async function startPlaylistDownload() {
        if (isDownloadActive()) return;
        const playlist = state.platformResult && state.platformResult.playlist;
        if (!playlist || typeof playlist.url !== 'string') return;
        const declaredCount = finiteNumber(playlist.availableCount);
        const entryCount = Array.isArray(playlist.entries) ? playlist.entries.filter((entry) => entry && entry.available === true).length : 0;
        const count = declaredCount === null ? entryCount : declaredCount;
        showProgress('Downloading playlist', count === null ? 0 : count, 'playlist', 'playlist');
        state.activeJob.destinationFolder = textValue(playlist.folderName, '');
        if (state.activeJob.destinationFolder) els.progressDetail.textContent = 'Saving sequentially to ' + playlistPathLabel(state.activeJob.destinationFolder) + '.';
        (Array.isArray(playlist.entries) ? playlist.entries : []).forEach((entry) => {
            const order = finiteNumber(entry && entry.order);
            if (order !== null) state.activeJob.titles.set('video-' + Math.round(order), textValue(entry.title, 'Video ' + Math.round(order)));
        });
        try {
            acceptJobResult(await api.downloadPlatformMedia({ url: playlist.url, maxHeight: els.playlistResolution.value || null, playlist: true, sequential: true, destination: 'playlist' }));
        } catch (error) {
            failStartingJob(error);
        }
    }

    async function cancelActiveJob() {
        if (!state.activeJob || !state.activeJob.id || state.activeJob.cancelPending) return;
        const job = state.activeJob;
        job.cancelPending = true;
        updateControls();
        try {
            const result = await api.cancelDownloads(job.id);
            if (!result || result.ok !== true) throw serviceError(result, 'The download queue could not be canceled.');
            if (result.canceled === true && state.activeJob && state.activeJob.id === job.id) updateProgress({ type: 'job-canceled', jobId: job.id, canceled: true });
            else if (state.activeJob && state.activeJob.id === job.id) {
                finishJob({ type: 'job-complete', jobId: job.id, status: result.code === 'NO_ACTIVE_JOB' ? 'complete' : 'canceled', canceled: result.code !== 'NO_ACTIVE_JOB' }, 'job-complete');
            }
        } catch (error) {
            if (state.activeJob && state.activeJob.id === job.id) state.activeJob.cancelPending = false;
            updateControls();
            showMessage(error && error.message ? error.message : 'The download queue could not be canceled.', 'error');
        }
    }

    async function openDownloads(destination) {
        try {
            const result = await api.openDownloads(destination || 'downloads');
            if (!result || result.ok !== true) throw serviceError(result, 'Android Downloads could not be opened.');
            showMessage(textValue(result.message, 'Android Downloads opened.'), 'success');
        } catch (error) {
            showMessage(error && error.message ? error.message : 'Android Downloads could not be opened.', 'error');
        }
    }

    async function loadNotices() {
        setVisible(els.aboutPanel, true);
        els.notices.textContent = 'Loading third-party notices…';
        try {
            const response = await fetch('third-party-notices.txt', { cache: 'no-store', credentials: 'omit' });
            if (!response.ok) throw new Error('Notices unavailable.');
            const text = await response.text();
            els.notices.textContent = text || 'No third-party notices were bundled.';
        } catch (error) {
            els.notices.textContent = 'Third-party notices are not available in this build.';
        }
    }

    els.form.addEventListener('submit', (event) => { event.preventDefault(); scanUrl(); });
    els.url.addEventListener('input', () => els.clearUrl.classList.toggle('hidden', !els.url.value));
    els.clearUrl.addEventListener('click', () => { els.url.value = ''; els.clearUrl.classList.add('hidden'); els.url.focus(); });
    els.selectAll.addEventListener('click', () => {
        if (state.selected.size === state.directResources.length && state.selected.size) state.selected.clear();
        else state.directResources.slice(0, MAX_DIRECT_RESOURCES).forEach((_item, index) => state.selected.add(index));
        els.directList.querySelectorAll('input[data-resource-index]').forEach((checkbox) => { checkbox.checked = state.selected.has(parseInt(checkbox.dataset.resourceIndex, 10)); });
        updateControls();
    });
    els.directList.addEventListener('change', (event) => {
        const checkbox = event.target.closest('input[data-resource-index]');
        if (!checkbox) return;
        const index = parseInt(checkbox.dataset.resourceIndex, 10);
        if (checkbox.checked && state.selected.size >= MAX_DIRECT_RESOURCES) {
            checkbox.checked = false;
            showMessage('Select no more than ' + MAX_DIRECT_RESOURCES + ' resources at a time.', 'info');
            return;
        }
        if (checkbox.checked) state.selected.add(index);
        else state.selected.delete(index);
        updateControls();
    });
    els.downloadSelected.addEventListener('click', startDirectDownload);
    els.downloadVideo.addEventListener('click', startVideoDownload);
    els.downloadPlaylist.addEventListener('click', startPlaylistDownload);
    els.cancelDownloads.addEventListener('click', cancelActiveJob);
    els.openDownloads.addEventListener('click', () => { closeMenu(); openDownloads('downloads'); });
    els.progressOpenFolder.addEventListener('click', () => openDownloads(state.destination));
    els.themeToggle.addEventListener('click', toggleTheme);
    els.menuToggle.addEventListener('click', openMenu);
    els.menuClose.addEventListener('click', closeMenu);
    els.menuBackdrop.addEventListener('click', closeMenu);
    els.menuHome.addEventListener('click', goHome);
    els.menuUrlHistory.addEventListener('click', () => navigate('url-history', true));
    els.menuDownloadHistory.addEventListener('click', () => navigate('download-history', true));
    els.menuCheckUpdates.addEventListener('click', () => { closeMenu(); checkForUpdates(true); });
    els.urlHistoryBack.addEventListener('click', goBackFromPage);
    els.urlHistoryHome.addEventListener('click', goHome);
    els.downloadHistoryBack.addEventListener('click', goBackFromPage);
    els.downloadHistoryHome.addEventListener('click', goHome);
    els.clearUrlHistory.addEventListener('click', clearUrlHistory);
    els.urlHistoryList.addEventListener('click', (event) => {
        const item = event.target.closest('button[data-history-index]');
        if (!item) return;
        const index = parseInt(item.dataset.historyIndex, 10);
        const url = Number.isInteger(index) ? state.urlHistory[index] : '';
        if (!isRestorableUrl(url)) return;
        els.url.value = url;
        els.clearUrl.classList.remove('hidden');
        goHome();
        els.url.focus();
        showMessage('URL restored. Press Scan page to inspect it again.', 'info');
    });
    els.clearDownloadHistory.addEventListener('click', clearDownloadHistory);
    els.downloadHistoryList.addEventListener('click', (event) => {
        const item = event.target.closest('button[data-download-history-id]');
        if (item) openDownloadHistory(item.dataset.downloadHistoryId || '');
    });
    els.about.addEventListener('click', () => { closeMenu(); loadNotices(); });
    els.aboutClose.addEventListener('click', () => setVisible(els.aboutPanel, false));
    els.updateClose.addEventListener('click', hideUpdatePanel);
    els.updateRetry.addEventListener('click', () => checkForUpdates(true));
    els.updateDownload.addEventListener('click', downloadUpdate);
    els.updateSettings.addEventListener('click', openUpdateInstallSettings);
    window.addEventListener('popstate', () => renderRoute(routeFromLocation()));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && handleBack()) event.preventDefault(); });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopUpdatePolling();
        else refreshUpdateStatus(true);
    });

    try {
        api.onDownloadEvent(updateProgress);
    } catch (error) {
        setServiceState({ ok: false, message: error.message });
    }
    loadUrlHistory();
    renderDownloadHistory();
    loadDownloadHistory();
    loadTheme();
    renderRoute(routeFromLocation());
    setServiceState({ loading: true });
    api.getMediaToolStatus().then(setServiceState).catch((error) => setServiceState({ ok: false, message: error.message }));
    refreshUpdateStatus(true).finally(() => checkForUpdates(false));
    updateControls();
}());
