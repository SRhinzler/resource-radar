const api = window.resourceRadar;

const state = {
  mode: 'empty',
  url: '',
  directResources: [],
  selected: new Set(),
  platformResult: null,
  jobId: '',
  jobMode: 'direct',
  downloadDirectory: '',
  jobTotal: 0,
  completed: 0,
  currentItem: null,
  downloadResults: [],
  itemProgress: new Map(),
};

const $ = (id) => document.getElementById(id);
const els = {
  url: $('url-input'),
  scan: $('scan-button'),
  clearUrl: $('clear-url'),
  message: $('global-message'),
  empty: $('empty-state'),
  direct: $('direct-results'),
  directCount: $('direct-count'),
  directPageUrl: $('direct-page-url'),
  directList: $('direct-list'),
  directEmpty: $('direct-empty'),
  selectAll: $('select-all'),
  downloadSelected: $('download-selected'),
  video: $('video-results'),
  videoPlatformIcon: $('video-platform-icon'),
  videoPlatformName: $('video-platform-name'),
  videoTitle: $('video-title'),
  videoUploader: $('video-uploader'),
  videoMeta: $('video-meta'),
  videoQualitySummary: $('video-quality-summary'),
  videoResolution: $('video-resolution'),
  downloadVideo: $('download-video'),
  playlist: $('playlist-results'),
  playlistTitle: $('playlist-title'),
  playlistUploader: $('playlist-uploader'),
  playlistCount: $('playlist-count'),
  playlistResolution: $('playlist-resolution'),
  playlistList: $('playlist-list'),
  downloadPlaylist: $('download-playlist'),
  progress: $('progress-card'),
  progressTitle: $('progress-title'),
  progressLabel: $('progress-label'),
  progressPercent: $('progress-percent'),
  progressTrack: $('progress-track'),
  progressFill: $('progress-fill'),
  progressDetail: $('progress-detail'),
  progressOpenFolder: $('progress-open-folder'),
  downloadLog: $('download-log'),
  cancelDownloads: $('cancel-downloads'),
  openDownloads: $('open-downloads'),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function showMessage(text, kind = 'error') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}

function clearMessage() {
  els.message.textContent = '';
  els.message.className = 'message hidden';
}

function setBusy(busy, label = 'Working…') {
  els.scan.disabled = busy;
  els.scan.innerHTML = busy ? `<span class="button-icon">◌</span> ${escapeHtml(label)}` : '<span class="button-icon">⌕</span> Scan page';
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 'B';
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024 || next === units[units.length - 1]) break;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

function formatSpeed(value) {
  const text = String(value ?? '').trim();
  if (text && !Number.isFinite(Number(text))) return /\/s$/i.test(text) ? text : `${text}/s`;
  const bytesPerSecond = Number(value);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.includes(':')) return `ETA ${text}`;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? `ETA ${formatDuration(seconds)}` : `ETA ${text}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function progressBytes(event) {
  const downloadedBytes = finiteNumber(event.receivedBytes ?? event.downloadedBytes);
  const totalBytes = finiteNumber(event.expectedBytes ?? event.totalBytes);
  return {
    downloadedBytes: downloadedBytes === null ? null : Math.max(0, downloadedBytes),
    totalBytes: totalBytes !== null && totalBytes > 0 ? totalBytes : null,
  };
}

function updateProgressDetail(event) {
  const { downloadedBytes, totalBytes } = progressBytes(event);
  const details = [];
  if (downloadedBytes !== null) details.push(totalBytes ? `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}` : `${formatBytes(downloadedBytes)} downloaded`);
  const activeSpeed = [...state.itemProgress.values()]
    .filter((item) => !item.finished)
    .reduce((sum, item) => sum + (item.speedBytesPerSecond || 0), 0);
  const speed = event.speed || (activeSpeed > 0 ? formatSpeed(activeSpeed) : formatSpeed(event.speedBytesPerSecond));
  if (speed) details.push(`Speed ${formatSpeed(speed)}`);
  const eta = event.eta || event.etaSeconds;
  if (eta !== null && eta !== undefined && String(eta).trim()) details.push(formatEta(eta));
  if (details.length) els.progressDetail.textContent = details.join(' · ');
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatDate(value) {
  const text = String(value || '');
  if (!/^\d{8}$/.test(text)) return 'Date unavailable';
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function platformLabel(platform) {
  return ({ youtube: 'YouTube', dailymotion: 'Dailymotion', linkedin: 'LinkedIn', instagram: 'Instagram' }[platform]) || 'Platform video';
}

function platformIcon(platform) {
  return ({ youtube: '▶', dailymotion: 'D', linkedin: 'in', instagram: '◎' }[platform]) || '▶';
}

function setVisible(section, visible) {
  section.classList.toggle('hidden', !visible);
}

function resetResults() {
  setVisible(els.empty, false);
  setVisible(els.direct, false);
  setVisible(els.video, false);
  setVisible(els.playlist, false);
  state.directResources = [];
  state.selected = new Set();
  state.platformResult = null;
}

function showEmpty() {
  resetResults();
  setVisible(els.empty, true);
  state.mode = 'empty';
}

function addLog(text, kind = '', itemId = '') {
  const line = document.createElement('div');
  line.className = `log-line ${kind}`;
  if (itemId) line.dataset.itemId = itemId;
  line.innerHTML = escapeHtml(text);
  els.downloadLog.appendChild(line);
  els.downloadLog.scrollTop = els.downloadLog.scrollHeight;
}

function updateSelectionControls() {
  const count = state.selected.size;
  els.downloadSelected.disabled = count === 0 || state.jobId;
  els.downloadSelected.textContent = count ? `Download selected (${count})` : 'Download selected';
  els.selectAll.textContent = count === state.directResources.length && count ? 'Clear all' : 'Select all';
}

function renderDirectResults(result) {
  resetResults();
  state.mode = 'direct';
  state.directResources = Array.isArray(result.resources) ? result.resources : [];
  els.directCount.textContent = String(state.directResources.length);
  els.directPageUrl.textContent = result.pageUrl || state.url;
  els.directList.innerHTML = state.directResources.map((resource, index) => `
    <tr>
      <td class="check-col"><input type="checkbox" data-resource-index="${index}" aria-label="Select ${escapeHtml(resource.label || resource.url)}" /></td>
      <td><div class="resource-cell"><span class="resource-icon">${resource.kind === 'video' ? '▶' : '▤'}</span><div><strong title="${escapeHtml(resource.url)}">${escapeHtml(resource.label || resource.url)}</strong><span title="${escapeHtml(resource.url)}">${escapeHtml(resource.url)}</span></div></div></td>
      <td><span class="type-pill ${resource.kind === 'video' ? 'video' : 'document'}">${escapeHtml(resource.kind)}</span></td>
      <td>${escapeHtml(formatBytes(resource.contentLength))}</td>
      <td><span class="source-pill">${escapeHtml(resource.source || 'link')}</span></td>
    </tr>`).join('');
  setVisible(els.direct, true);
  setVisible(els.directEmpty, state.directResources.length === 0);
  updateSelectionControls();
}

function addResolutionOptions(select, resolutions) {
  const options = ['<option value="">Highest available</option>'];
  for (const height of resolutions || []) {
    options.push(`<option value="${Number(height)}">Up to ${Number(height)}p</option>`);
  }
  select.innerHTML = options.join('');
}

function renderVideoResults(media) {
  resetResults();
  state.mode = 'video';
  state.platformResult = { mode: 'video', media };
  els.videoPlatformIcon.textContent = platformIcon(media.platform);
  els.videoPlatformName.textContent = platformLabel(media.platform);
  els.videoTitle.textContent = media.title || 'Untitled video';
  els.videoUploader.textContent = media.uploader ? `By ${media.uploader}` : 'Public video URL';
  els.videoMeta.innerHTML = [
    media.duration ? `<span>${escapeHtml(formatDuration(media.duration))}</span>` : '',
    media.uploadDate ? `<span>Published ${escapeHtml(formatDate(media.uploadDate))}</span>` : '',
    media.formats?.length ? `<span>${media.formats.length} formats</span>` : '',
  ].filter(Boolean).join('<span>•</span>') || '<span>Metadata available</span>';
  const highest = media.resolutions?.[0];
  els.videoQualitySummary.textContent = highest ? `Up to ${highest}p` : 'Automatic';
  addResolutionOptions(els.videoResolution, media.resolutions || []);
  setVisible(els.video, true);
}

function renderPlaylistResults(playlist) {
  resetResults();
  state.mode = 'playlist';
  state.platformResult = { mode: 'playlist', playlist };
  els.playlistTitle.textContent = playlist.title || 'YouTube playlist';
  els.playlistUploader.textContent = playlist.uploader ? `By ${playlist.uploader}` : 'Sorted oldest first by upload date';
  els.playlistCount.textContent = String(playlist.availableCount ?? (playlist.entries || []).filter((entry) => entry.available).length);
  addResolutionOptions(els.playlistResolution, playlist.resolutions || []);
  els.playlistList.innerHTML = (playlist.entries || []).map((entry) => `
    <tr class="${entry.available ? '' : 'unavailable-row'}">
      <td class="order-col">${entry.order ? `<span class="order-number">${entry.order}.</span>` : '<span class="status-skip">—</span>'}</td>
      <td><div class="playlist-video-title"><span class="resource-icon">▶</span><div><strong title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.id || entry.url)}</small></div></div></td>
      <td>${escapeHtml(formatDate(entry.uploadDate))}</td>
      <td>${escapeHtml(formatDuration(entry.duration))}</td>
      <td>${entry.available ? '<span class="status-ok">Ready</span>' : `<span class="status-skip" title="${escapeHtml(entry.error || '')}">Skipped</span>`}</td>
    </tr>`).join('');
  setVisible(els.playlist, true);
}

function showProgress(title, total, downloadDirectory) {
  state.jobTotal = total || 0;
  state.completed = 0;
  state.currentItem = null;
  state.downloadResults = [];
  state.itemProgress = new Map();
  state.jobMode = 'direct';
  state.downloadDirectory = downloadDirectory || '';
  els.progressTitle.textContent = title;
  els.progressLabel.textContent = total ? `Preparing 0 of ${total}` : 'Preparing playlist…';
  setAggregateProgress(0, false);
  els.progressDetail.textContent = downloadDirectory ? `Saving to ${downloadDirectory}` : 'Your files are saved to Downloads.';
  els.progressOpenFolder.classList.add('hidden');
  els.cancelDownloads.classList.remove('hidden');
  els.cancelDownloads.disabled = false;
  els.downloadLog.innerHTML = '';
  setVisible(els.progress, true);
}

function hideResultActions(disabled) {
  els.downloadVideo.disabled = disabled;
  els.downloadPlaylist.disabled = disabled;
  els.downloadSelected.disabled = disabled || state.selected.size === 0;
  els.scan.disabled = disabled;
}

function setAggregateProgress(fraction, indeterminate) {
  const safeFraction = fraction === null || fraction === undefined
    ? null
    : Math.max(0, Math.min(1, Number(fraction)));
  els.progressFill.classList.toggle('indeterminate', Boolean(indeterminate));
  if (safeFraction === null || !Number.isFinite(safeFraction)) {
    els.progressPercent.textContent = indeterminate ? 'Live' : '—';
    els.progressFill.style.width = indeterminate ? '36%' : '0%';
    els.progressTrack?.removeAttribute('aria-valuenow');
    return;
  }
  els.progressPercent.textContent = `${Math.round(safeFraction * 100)}%`;
  els.progressFill.style.width = `${safeFraction * 100}%`;
  els.progressTrack?.setAttribute('aria-valuenow', String(Math.round(safeFraction * 100)));
}

function updateAggregateProgress() {
  if (!state.jobTotal) return;
  const items = [...state.itemProgress.values()];
  const activeUnknownSize = items.some((item) => !item.finished && item.totalBytes === null);
  const hasUnknownSize = items.some((item) => item.totalBytes === null);
  const knownItems = items.filter((item) => item.totalBytes !== null && item.totalBytes > 0);
  const totalBytes = knownItems.reduce((sum, item) => sum + item.totalBytes, 0);
  const downloadedBytes = knownItems.reduce((sum, item) => sum + Math.min(item.totalBytes, item.receivedBytes), 0);

  if (!activeUnknownSize && totalBytes > 0) {
    setAggregateProgress(downloadedBytes / totalBytes, false);
  } else {
    setAggregateProgress(null, hasUnknownSize);
  }
}

function findLogLine(itemId) {
  return [...els.downloadLog.querySelectorAll('.log-line')].find((line) => line.dataset.itemId === itemId);
}

async function scanUrl() {
  const rawUrl = els.url.value.trim();
  if (!rawUrl) {
    showMessage('Enter a webpage URL first.', 'error');
    els.url.focus();
    return;
  }

  clearMessage();
  state.url = rawUrl;
  state.jobId = '';
  setBusy(true, 'Scanning…');
  resetResults();
  setVisible(els.empty, true);
  els.empty.querySelector('h3').textContent = 'Reading the public page…';
  els.empty.querySelector('p:last-child').textContent = 'Looking for direct files and supported platform metadata.';

  try {
    const platformResult = await api.inspectPlatform(rawUrl);
    if (platformResult.mode === 'video') {
      renderVideoResults(platformResult.media);
      showMessage('Video formats are ready. Choose a maximum resolution or keep the highest available.', 'success');
    } else if (platformResult.mode === 'playlist') {
      renderPlaylistResults(platformResult);
      showMessage(`Playlist sorted oldest first. ${platformResult.availableCount} video${platformResult.availableCount === 1 ? '' : 's'} ready to download.`, 'success');
    } else {
      const result = await api.scanPage(platformResult.url || rawUrl);
      renderDirectResults(result);
      if (!result.resources?.length) showMessage('The page loaded, but no supported direct video or document files were found.', 'error');
      else showMessage(`Found ${result.resources.length} downloadable resource${result.resources.length === 1 ? '' : 's'}. Select what you want to keep.`, 'success');
    }
    setVisible(els.empty, false);
  } catch (error) {
    setVisible(els.empty, true);
    els.empty.querySelector('h3').textContent = 'Nothing saved yet';
    els.empty.querySelector('p:last-child').textContent = 'Check the URL, tool setup, or whether the resource is public and directly downloadable.';
    showMessage(error?.message || 'The scan failed.', 'error');
  } finally {
    setBusy(false);
  }
}

function selectedDirectResources() {
  return [...state.selected]
    .map((index) => state.directResources[index])
    .filter(Boolean)
    .map((resource) => ({ url: resource.url, kind: resource.kind }));
}

async function startDirectDownload() {
  const resources = selectedDirectResources();
  if (!resources.length) return;
  clearMessage();
  showProgress(`Downloading ${resources.length} resource${resources.length === 1 ? '' : 's'}`, resources.length);
  hideResultActions(true);
  try {
    await api.downloadResources(resources);
  } catch (error) {
    showMessage(error?.message || 'The download queue could not start.', 'error');
    hideResultActions(false);
    setVisible(els.progress, false);
  }
}

async function startVideoDownload() {
  const media = state.platformResult?.media;
  if (!media) return;
  clearMessage();
  showProgress('Downloading video', 1);
  hideResultActions(true);
  try {
    await api.downloadPlatformMedia({ url: media.url, maxHeight: els.videoResolution.value || null, playlist: false });
  } catch (error) {
    showMessage(error?.message || 'The video download could not start.', 'error');
    hideResultActions(false);
    setVisible(els.progress, false);
  }
}

async function startPlaylistDownload() {
  const playlist = state.platformResult?.playlist;
  if (!playlist) return;
  const available = (playlist.entries || []).filter((entry) => entry.available);
  if (!available.length) {
    showMessage('There are no available videos to download in this playlist.', 'error');
    return;
  }
  clearMessage();
  showProgress(`Downloading playlist · ${available.length} videos`, available.length);
  hideResultActions(true);
  try {
    await api.downloadPlatformMedia({ url: playlist.url, maxHeight: els.playlistResolution.value || null, playlist: true });
  } catch (error) {
    showMessage(error?.message || 'The playlist download could not start.', 'error');
    hideResultActions(false);
    setVisible(els.progress, false);
  }
}

function updateProgress(event) {
  if (event.type === 'job-started') {
    state.jobId = event.jobId;
    state.jobMode = event.mode || 'direct';
    state.downloadDirectory = event.downloadDirectory || '';
    if (event.total) state.jobTotal = event.total;
    state.itemProgress = new Map();
    setAggregateProgress(0, false);
    els.progressDetail.textContent = event.downloadDirectory ? `Saving to ${event.downloadDirectory}` : 'Your files are saved to Downloads.';
    return;
  }

  if (state.jobId && event.jobId && state.jobId !== event.jobId) return;

  if (event.type === 'playlist-scan-progress') {
    els.progressLabel.textContent = `Checking playlist ${event.completed} of ${event.total}`;
    setAggregateProgress(event.total ? event.completed / event.total : 0, false);
    return;
  }

  if (event.type === 'playlist-ready') {
    state.jobTotal = event.total;
    els.progressLabel.textContent = `Ready · 0 of ${event.total}`;
    setAggregateProgress(0, false);
    return;
  }

  if (event.type === 'item-started') {
    state.currentItem = event;
    state.itemProgress.set(event.itemId, {
      receivedBytes: 0,
      totalBytes: null,
      finished: false,
    });
    els.progressLabel.textContent = `${event.index + 1} of ${event.total || state.jobTotal} · ${event.title || 'Starting download…'}`;
    els.progressDetail.textContent = event.order ? `Playlist order ${event.order} · downloading sequentially` : 'Choosing the best available streams…';
    addLog(`${event.order ? `${event.order}. ` : ''}${event.title || event.url}`, '', event.itemId);
    updateAggregateProgress();
    return;
  }

  if (event.type === 'item-progress') {
    const previous = state.itemProgress.get(event.itemId) || { receivedBytes: 0, totalBytes: null, finished: false };
    const { downloadedBytes, totalBytes } = progressBytes(event);
    const percent = finiteNumber(event.percent);
    state.itemProgress.set(event.itemId, {
      ...previous,
      receivedBytes: downloadedBytes ?? previous.receivedBytes,
      totalBytes: totalBytes ?? previous.totalBytes,
      fraction: totalBytes ? totalBytes > 0 ? Math.max(0, Math.min(1, (downloadedBytes ?? previous.receivedBytes) / totalBytes)) : null : percent === null ? previous.fraction ?? null : Math.max(0, Math.min(1, percent / 100)),
      speedBytesPerSecond: finiteNumber(event.speedBytesPerSecond),
      etaSeconds: finiteNumber(event.etaSeconds),
      finished: false,
    });
    updateAggregateProgress();
    updateProgressDetail(event);
    return;
  }

  if (event.type === 'item-complete') {
    state.completed += 1;
    const previous = state.itemProgress.get(event.itemId) || { receivedBytes: 0, totalBytes: null };
    const completedBytes = previous.totalBytes || previous.receivedBytes;
    state.itemProgress.set(event.itemId, {
      ...previous,
      receivedBytes: completedBytes,
      fraction: 1,
      finished: true,
    });
    state.downloadResults.push(event);
    updateAggregateProgress();
    els.progressDetail.textContent = event.fileName ? `Saved ${event.fileName}` : 'File saved to Downloads.';
    const line = findLogLine(event.itemId);
    if (line) line.classList.add('done');
    return;
  }

  if (event.type === 'item-failed') {
    state.completed += 1;
    const previous = state.itemProgress.get(event.itemId) || { receivedBytes: 0, totalBytes: null };
    state.itemProgress.set(event.itemId, { ...previous, finished: true, failed: true });
    const line = findLogLine(event.itemId);
    if (line) {
      line.classList.add('failed');
      line.textContent += ` · ${event.error}`;
    }
    updateAggregateProgress();
    return;
  }

  if (event.type === 'job-complete') {
    state.jobId = '';
    const successes = (event.results || []).filter((result) => result.ok).length;
    const failures = (event.results || []).filter((result) => !result.ok).length;
    els.progressLabel.textContent = event.canceled ? 'Queue stopped' : 'Queue complete';
    if (!event.canceled && failures === 0) setAggregateProgress(1, false);
    else {
      updateAggregateProgress();
      if ((failures || event.canceled) && [...state.itemProgress.values()].some((item) => item.totalBytes === null)) {
        setAggregateProgress(null, false);
      }
    }
    const savedDirectory = state.downloadDirectory || (state.jobMode === 'playlist' ? 'Downloads\\Playlist' : 'Downloads');
    els.progressDetail.textContent = failures
      ? `${successes} saved · ${failures} failed · ${savedDirectory}`
      : `${successes} file${successes === 1 ? '' : 's'} saved to ${savedDirectory}.`;
    els.progressOpenFolder.classList.remove('hidden');
    els.cancelDownloads.classList.add('hidden');
    hideResultActions(false);
    if (failures) showMessage(`${successes} saved, ${failures} could not be downloaded. See the queue details below.`, 'error');
    else if (!event.canceled) showMessage(`${successes} file${successes === 1 ? '' : 's'} saved to your ${state.jobMode === 'playlist' ? 'Downloads\\Playlist' : 'Downloads'} folder.`, 'success');
  }
}

function bindEvents() {
  els.scan.addEventListener('click', scanUrl);
  els.url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') scanUrl();
  });
  els.url.addEventListener('input', () => {
    els.clearUrl.classList.toggle('hidden', !els.url.value);
  });
  els.clearUrl.addEventListener('click', () => {
    els.url.value = '';
    els.url.focus();
    els.clearUrl.classList.add('hidden');
  });

  els.selectAll.addEventListener('click', () => {
    if (state.selected.size === state.directResources.length && state.selected.size) state.selected.clear();
    else state.directResources.forEach((_resource, index) => state.selected.add(index));
    els.directList.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.checked = state.selected.has(Number(checkbox.dataset.resourceIndex));
    });
    updateSelectionControls();
  });
  els.directList.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-resource-index]');
    if (!checkbox) return;
    const index = Number(checkbox.dataset.resourceIndex);
    if (checkbox.checked) state.selected.add(index);
    else state.selected.delete(index);
    updateSelectionControls();
  });
  els.downloadSelected.addEventListener('click', startDirectDownload);
  els.downloadVideo.addEventListener('click', startVideoDownload);
  els.downloadPlaylist.addEventListener('click', startPlaylistDownload);
  els.cancelDownloads.addEventListener('click', async () => {
    if (!state.jobId) return;
    els.cancelDownloads.disabled = true;
    await api.cancelDownloads(state.jobId);
  });
  els.openDownloads.addEventListener('click', () => api.openDownloads());
  els.progressOpenFolder.addEventListener('click', () => api.openDownloads(state.jobMode === 'playlist' ? 'playlist' : undefined));
  els.videoResolution.addEventListener('change', () => {
    const value = els.videoResolution.value;
    els.videoQualitySummary.textContent = value ? `Up to ${value}p` : `Up to ${state.platformResult?.media?.resolutions?.[0] || 'best'}p`;
  });
}

api.onDownloadEvent(updateProgress);
bindEvents();
els.clearUrl.classList.add('hidden');

api.getMediaToolStatus().then((status) => {
  if (!status.ready) {
    showMessage('The bundled media tools are missing or damaged. Please reinstall Resource Radar; no separate applications are required.', 'error');
  }
}).catch(() => {});
