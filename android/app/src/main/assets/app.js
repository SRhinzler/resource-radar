(function () {
    'use strict';

    const nativeBridge = window.AndroidResourceRadar;
    const MAX_PENDING_REQUESTS = 32;
    const MAX_URL_LENGTH = 4096;
    const MAX_DIRECT_RESOURCES = 80;
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
    };

    const $ = (id) => document.getElementById(id);
    const els = {
        form: $('scan-form'), url: $('url-input'), clearUrl: $('clear-url'), scan: $('scan-button'),
        message: $('global-message'), serviceTitle: $('service-title'), serviceMessage: $('service-message'), serviceStatus: $('service-status'),
        empty: $('empty-state'), direct: $('direct-results'), directCount: $('direct-count'), directPageUrl: $('direct-page-url'), directList: $('direct-list'), directEmpty: $('direct-empty'),
        selectAll: $('select-all'), downloadSelected: $('download-selected'), video: $('video-results'), videoPlatformIcon: $('video-platform-icon'), videoPlatformName: $('video-platform-name'), videoTitle: $('video-title'), videoUploader: $('video-uploader'), videoMeta: $('video-meta'), videoQualitySummary: $('video-quality-summary'), videoResolution: $('video-resolution'), downloadVideo: $('download-video'),
        playlist: $('playlist-results'), playlistTitle: $('playlist-title'), playlistUploader: $('playlist-uploader'), playlistCount: $('playlist-count'), playlistResolution: $('playlist-resolution'), playlistList: $('playlist-list'), downloadPlaylist: $('download-playlist'),
        progress: $('progress-card'), progressTitle: $('progress-title'), progressLabel: $('progress-label'), progressPercent: $('progress-percent'), progressTrack: $('progress-track'), progressFill: $('progress-fill'), progressDetail: $('progress-detail'), progressOpenFolder: $('progress-open-folder'), downloadLog: $('download-log'), cancelDownloads: $('cancel-downloads'), openDownloads: $('open-downloads'),
        about: $('about-button'), aboutPanel: $('about-panel'), aboutClose: $('about-close'), notices: $('notices-copy'),
    };

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
    }

    function textValue(value, fallback) {
        return typeof value === 'string' && value.trim() ? value : fallback;
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
            els.url.value = url;
            els.clearUrl.classList.remove('hidden');
            scanUrl();
        },
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
            items: new Map(),
            titles: new Map(),
            preStartEvents: [],
            cancelPending: false,
        };
        els.progressTitle.textContent = title;
        els.progressLabel.textContent = state.activeJob.total ? 'Preparing 0 of ' + state.activeJob.total : 'Preparing…';
        els.progressDetail.textContent = destination === 'playlist' ? 'Saving sequentially to Downloads/Playlist.' : 'Saving to Android Downloads.';
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
            item = { id: itemId, title: textValue(event && event.title, textValue(knownTitle, textValue(event && event.url, itemId))), status: 'active', phase: 'downloading', percent: null, downloaded: null, total: null, speed: null, eta: null, index: null, line: null };
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
            els.progressLabel.textContent = state.activeJob.total ? 'Ready · 0 of ' + state.activeJob.total : 'Ready to download';
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
            els.progressDetail.textContent = 'Saved to ' + destinationLabel(job) + '.';
            setAggregateProgress(1);
            showMessage('Downloads are ready in ' + destinationLabel(job) + '.', 'success');
        }
        if (savedCount) els.progressOpenFolder.classList.remove('hidden');
        else els.progressOpenFolder.classList.add('hidden');
        els.cancelDownloads.classList.add('hidden');
        state.activeJob = null;
        updateControls();
    }

    function destinationLabel(job) {
        return job && job.destination === 'playlist' ? 'Downloads/Playlist' : 'Android Downloads';
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
    els.openDownloads.addEventListener('click', () => openDownloads('downloads'));
    els.progressOpenFolder.addEventListener('click', () => openDownloads(state.destination));
    els.about.addEventListener('click', loadNotices);
    els.aboutClose.addEventListener('click', () => setVisible(els.aboutPanel, false));

    try {
        api.onDownloadEvent(updateProgress);
    } catch (error) {
        setServiceState({ ok: false, message: error.message });
    }
    setServiceState({ loading: true });
    api.getMediaToolStatus().then(setServiceState).catch((error) => setServiceState({ ok: false, message: error.message }));
    updateControls();
}());
