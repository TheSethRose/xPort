const statusEl = document.getElementById('status');
const statusPill = document.getElementById('status-pill');
const statusIcon = document.getElementById('status-icon');
const statusLabel = document.getElementById('status-label');
const statusBannerIcon = document.getElementById('status-banner-icon');
const statusText = document.getElementById('status-text');
const transportErrorEl = document.getElementById('transport-error');
const systemStateEl = document.getElementById('system-state');
const sessionEl = document.getElementById('session-count');
const alltimeEl = document.getElementById('alltime-count');
const errorCard = document.getElementById('error-card');
const errorEl = document.getElementById('error-count');
const sessionCard = document.getElementById('session-card');
const alltimeCard = document.getElementById('alltime-card');
const toggleBtn = document.getElementById('toggle');
const outputDirInput = document.getElementById('output-dir');
const saveDirBtn = document.getElementById('save-dir');
const dirFeedback = document.getElementById('dir-feedback');
const recentTweetsEl = document.getElementById('recent-tweets');
const viewAllTweetsBtn = document.getElementById('view-all-tweets');
const openTweetsBtn = document.getElementById('open-tweets');
const openSettingsBtn = document.getElementById('open-settings');
const videoSection = document.getElementById('video-section');
const videoLabel = document.getElementById('video-label');
const transcribeBtn = document.getElementById('transcribe-btn');

let pollTimer = null;
let currentTransport = null;
let videoChecked = false;
let currentVideo = null;
let latestState = null;
let lastSavedOutputDir = '';

const ICONS = {
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>',
  'arrow-right': '<path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>',
  'check-circle': '<path d="M9 12l2 2 4-4"></path><circle cx="12" cy="12" r="10"></circle>',
  clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"></path><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"></path>',
  'external-link': '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"></path><path d="m3 12 9 5 9-5"></path><path d="m3 17 9 5 9-5"></path>',
  link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"></path>',
  lock: '<rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
  'message-check': '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"></path><path d="m9 11 2 2 4-4"></path>',
  'message-square': '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"></path>',
  'message-x': '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"></path><path d="m10 9 4 4"></path><path d="m14 9-4 4"></path>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect>',
  'pause-circle': '<circle cx="12" cy="12" r="10"></circle><path d="M10 15V9"></path><path d="M14 15V9"></path>',
  play: '<polygon points="6 3 20 12 6 21 6 3"></polygon>',
  'play-square': '<rect x="3" y="3" width="18" height="18" rx="2"></rect><polygon points="10 8 16 12 10 16 10 8"></polygon>',
  plug: '<path d="M12 22v-5"></path><path d="M9 7V2"></path><path d="M15 7V2"></path><path d="M6 7h12v5a6 6 0 0 1-12 0Z"></path>',
  'refresh-cw': '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"></path><path d="M3 21v-5h5"></path><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"></path><path d="M21 3v5h-5"></path>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path>',
  search: '<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path>',
  server: '<rect x="3" y="4" width="18" height="8" rx="2"></rect><rect x="3" y="12" width="18" height="8" rx="2"></rect><path d="M7 8h.01"></path><path d="M7 16h.01"></path>',
  settings: '<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"></path><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"></path>',
  'triangle-alert': '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  'wifi-off': '<path d="M12 20h.01"></path><path d="M8.5 16.4a5 5 0 0 1 7 0"></path><path d="M2 8.8a15 15 0 0 1 5.1-2.9"></path><path d="M16.9 5.9A15 15 0 0 1 22 8.8"></path><path d="M5 12.6a10 10 0 0 1 10.2-2.2"></path><path d="m2 2 20 20"></path>',
};

function createIcon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.className.baseVal = className;
  svg.innerHTML = ICONS[name] || ICONS['message-square'];
  return svg;
}

function setIcon(el, name, className = 'icon') {
  el.replaceChildren(createIcon(name, className));
}

function setIconText(el, name, text) {
  el.replaceChildren(createIcon(name), document.createTextNode(text));
}

function hydrateStaticIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    setIcon(el, el.dataset.icon, el.dataset.iconClass || 'icon');
  });
}

function render(state) {
  latestState = state;
  sessionEl.textContent = state.sessionCount.toLocaleString();
  alltimeEl.textContent = state.allTimeCount.toLocaleString();

  const errors = Number(state.parserErrors || 0) + (state.ingestError ? 1 : 0);
  errorEl.textContent = errors.toLocaleString();
  errorCard.style.display = errors > 0 ? '' : 'none';

  renderStatus(state);
  renderSystemState(state);
  renderPrimaryAction(state);
  renderRecentTweets(state);

  if (state.outputDir !== undefined && document.activeElement !== outputDirInput) {
    outputDirInput.value = state.outputDir || '';
    lastSavedOutputDir = state.outputDir || '';
  }

  currentTransport = state.transport;
}

function renderStatus(state) {
  const derived = deriveStatus(state);
  statusLabel.textContent = derived.label;
  setIcon(statusIcon, derived.headerIcon, 'icon status-pill-icon');
  statusPill.className = `status-pill ${derived.kind}`;
  statusPill.setAttribute('aria-label', derived.ariaLabel);
  statusPill.title = derived.ariaLabel;
  setIcon(statusBannerIcon, derived.bannerIcon, 'icon status-banner-icon');
  statusText.textContent = derived.banner;
  statusEl.className = `status ${derived.tone}`;
  statusEl.setAttribute('aria-label', derived.banner);

  const errorText = state.ingestError || state.transportError || '';
  if (derived.showError && errorText) {
    transportErrorEl.textContent = errorText;
    transportErrorEl.style.display = '';
  } else {
    transportErrorEl.style.display = 'none';
  }
}

function deriveStatus(state) {
  if (state.ingestError) {
    return { kind: 'error', tone: 'error', label: 'Error', headerIcon: 'triangle-alert', bannerIcon: 'triangle-alert', banner: 'Unable to save tweets', ariaLabel: 'Capture has an error', showError: true };
  }
  if (!state.connected) {
    return { kind: 'offline', tone: 'offline', label: 'Offline', headerIcon: 'wifi-off', bannerIcon: 'wifi-off', banner: 'Extension not connected', ariaLabel: 'Extension is not connected', showError: true };
  }
  if (!state.captureEnabled) {
    return { kind: 'paused', tone: 'paused', label: 'Paused', headerIcon: 'pause-circle', bannerIcon: 'pause-circle', banner: 'Capture paused', ariaLabel: 'Capture is paused', showError: false };
  }
  if (state.verboseLogging) {
    return { kind: 'discovery', tone: 'discovery', label: 'Live', headerIcon: 'activity', bannerIcon: 'search', banner: 'Discovery mode active', ariaLabel: 'Capture is live in discovery mode', showError: false };
  }
  if (state.sessionCount === 0) {
    return { kind: 'live', tone: 'warning', label: 'Live', headerIcon: 'activity', bannerIcon: 'message-x', banner: 'Connected, no tweets this session', ariaLabel: 'Capture is live', showError: false };
  }
  return { kind: 'live', tone: 'success', label: 'Live', headerIcon: 'activity', bannerIcon: 'database', banner: 'Saving tweets to Postgres', ariaLabel: 'Capture is live', showError: false };
}

function renderSystemState(state) {
  const recent = (state.recentTweets || [])[0];
  const lastTweet = recent ? `Latest ${relativeTime(recent.capturedAt)}` : 'No tweets yet';
  const items = [
    { icon: 'server', label: state.transport === 'http' ? 'HTTP' : 'No transport' },
    { icon: 'database', label: state.ingestError ? 'Save error' : 'Postgres' },
    { icon: state.captureEnabled ? 'activity' : 'pause-circle', label: state.captureEnabled ? 'on' : 'paused' },
    { icon: 'clock', label: lastTweet },
  ];

  systemStateEl.replaceChildren(...items.map((item) => {
    const el = document.createElement('span');
    el.className = 'system-state-item';
    el.append(createIcon(item.icon, 'icon system-state-icon'), document.createTextNode(item.label));
    return el;
  }));
}

function renderPrimaryAction(state) {
  if (!state.connected) {
    setIconText(toggleBtn, 'plug', 'Reconnect');
    toggleBtn.className = 'retry';
    toggleBtn.setAttribute('aria-label', 'Reconnect XPort daemon');
  } else if (state.ingestError) {
    setIconText(toggleBtn, 'refresh-cw', 'Retry Save');
    toggleBtn.className = 'retry';
    toggleBtn.setAttribute('aria-label', 'Retry saving buffered tweets');
  } else if (state.captureEnabled) {
    setIconText(toggleBtn, 'pause', 'Pause Capture');
    toggleBtn.className = 'capturing';
    toggleBtn.setAttribute('aria-label', 'Pause tweet capture');
  } else {
    setIconText(toggleBtn, 'play', 'Resume Capture');
    toggleBtn.className = 'paused';
    toggleBtn.setAttribute('aria-label', 'Resume tweet capture');
  }
}

function renderRecentTweets(state) {
  recentTweetsEl.innerHTML = '';
  const tweets = state.recentTweets || [];
  if (!state.captureEnabled && tweets.length === 0) {
    renderRecentEmpty('Capture paused', 'pause-circle');
    return;
  }
  if (tweets.length === 0) {
    renderRecentEmpty('No tweets this session', 'message-x');
    return;
  }

  for (const tweet of tweets.slice(0, 3)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-tweet';
    item.setAttribute('aria-label', `Open captured tweet ${tweet.id || ''} in dashboard`.trim());
    item.addEventListener('click', () => {
      const selected = tweet.id ? `?selectedTweet=${encodeURIComponent(tweet.id)}#tab=tweets` : '#tab=tweets';
      openDashboard(selected);
    });

    const header = document.createElement('span');
    header.className = 'tweet-header';

    const tweetIcon = document.createElement('span');
    tweetIcon.className = 'tweet-type-icon';
    tweetIcon.appendChild(createIcon(tweetIconName(tweet)));

    const author = document.createElement('span');
    author.className = 'tweet-author';
    author.textContent = tweet.author || '@unknown';

    const openIcon = document.createElement('span');
    openIcon.className = 'tweet-open-icon';
    openIcon.appendChild(createIcon('external-link'));

    const text = document.createElement('span');
    text.className = 'tweet-preview';
    text.textContent = tweet.text || 'No text captured.';

    const time = document.createElement('span');
    time.className = 'tweet-time';
    time.append(createIcon('clock', 'icon tweet-time-icon'), document.createTextNode(relativeTime(tweet.capturedAt)));

    header.append(tweetIcon, author, openIcon);
    item.append(header, text, time);
    recentTweetsEl.appendChild(item);
  }
}

function renderRecentEmpty(message, iconName) {
  const empty = document.createElement('div');
  empty.className = 'recent-empty';
  empty.append(createIcon(iconName, 'icon recent-empty-icon'), document.createTextNode(message));
  recentTweetsEl.appendChild(empty);
}

function tweetIconName(tweet) {
  const types = Array.isArray(tweet.mediaTypes)
    ? tweet.mediaTypes
    : Array.isArray(tweet.media)
      ? tweet.media.map(item => item?.type).filter(Boolean)
      : [];
  if (types.length > 1) return 'layers';
  if (types.includes('video') || types.includes('animated_gif')) return 'play-square';
  if (types.includes('photo')) return 'image';
  if (tweet.hasLinks || Number(tweet.urlCount || 0) > 0) return 'link';
  return 'message-square';
}

function relativeTime(value) {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return 'Captured just now';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return 'Captured just now';
  if (seconds < 90) return 'Captured 1m ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Captured ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Captured ${hours}h ago`;
  return 'Captured earlier';
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response) {
      render(response);
      checkForVideo();
    }
  });
}

function openDashboard(target) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`debug.html${target || '#tab=tweets'}`) });
}

toggleBtn.addEventListener('click', () => {
  if (!latestState?.connected || latestState?.ingestError) {
    toggleBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'RETRY_TRANSPORT' }, () => {
      toggleBtn.disabled = false;
      refresh();
    });
    return;
  }
  chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' }, (response) => {
    if (response) refresh();
  });
});

saveDirBtn.addEventListener('click', () => {
  const dir = outputDirInput.value.trim();
  setIconText(saveDirBtn, 'clock', 'Saving');
  saveDirBtn.disabled = true;
  setDirectoryFeedback('', '');
  chrome.runtime.sendMessage({ type: 'SET_OUTPUT_DIR', outputDir: dir }, (resp) => {
    saveDirBtn.disabled = false;
    setIconText(saveDirBtn, 'save', 'Save');
    if (resp?.error) {
      saveDirBtn.classList.add('error');
      outputDirInput.title = resp.error;
      const error = classifyDirectoryError(resp.error);
      setDirectoryFeedback(error.message, 'error', error.icon);
    } else {
      saveDirBtn.classList.remove('error');
      outputDirInput.title = '';
      lastSavedOutputDir = resp?.outputDir || dir;
      setDirectoryFeedback('Directory saved', 'success', 'check-circle');
    }
  });
});

outputDirInput.addEventListener('input', () => {
  if (outputDirInput.value.trim() !== lastSavedOutputDir) {
    setDirectoryFeedback('Unsaved changes', 'unsaved', 'clock');
  } else {
    setDirectoryFeedback('', '');
  }
});

function setDirectoryFeedback(message, type, iconName) {
  dirFeedback.replaceChildren();
  if (message) {
    if (iconName) dirFeedback.appendChild(createIcon(iconName, 'icon dir-feedback-icon'));
    dirFeedback.appendChild(document.createTextNode(message));
  }
  dirFeedback.className = type ? `dir-feedback ${type}` : 'dir-feedback';
}

function classifyDirectoryError(message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('permission') || lower.includes('denied')) {
    return { message: 'Permission denied', icon: 'lock' };
  }
  if (lower.includes('not running') || lower.includes('transport') || lower.includes('daemon')) {
    return { message: message || 'Extension not connected', icon: 'wifi-off' };
  }
  if (lower.includes('not found') || lower.includes('no such')) {
    return { message: 'Directory not found', icon: 'triangle-alert' };
  }
  return { message: message || 'Unable to save directory', icon: 'triangle-alert' };
}

sessionCard.addEventListener('click', () => openDashboard('?session=current#tab=tweets'));
alltimeCard.addEventListener('click', () => openDashboard('#tab=tweets'));
errorCard.addEventListener('click', () => openDashboard('#tab=events'));
viewAllTweetsBtn.addEventListener('click', () => openDashboard('#tab=tweets'));
openTweetsBtn.addEventListener('click', () => openDashboard('#tab=tweets'));
openSettingsBtn.addEventListener('click', () => openDashboard('#tab=settings'));

// --- On-demand video transcription (HTTP daemon only) ---

function checkForVideo() {
  // Transcription requires the HTTP daemon
  if (currentTransport !== 'http') return;
  // Only check once per popup open
  if (videoChecked) return;
  videoChecked = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const url = tabs[0].url || '';
    const match = url.match(/\/status\/(\d+)/);
    if (!match) return;
    const tweetId = match[1];

    chrome.runtime.sendMessage({ type: 'CHECK_VIDEO', tweetId }, (resp) => {
      if (!resp || !resp.hasVideo) return;

      const typeLabel = resp.mediaType === 'animated_gif' ? 'GIF' : 'Video';
      let duration = '';
      if (resp.durationMs) {
        const totalSec = Math.round(resp.durationMs / 1000);
        duration = totalSec >= 60
          ? ` (${Math.floor(totalSec / 60)}m ${totalSec % 60}s)`
          : ` (${totalSec}s)`;
      }
      videoLabel.textContent = `${typeLabel} detected${duration}`;
      videoSection.style.display = '';
      currentVideo = resp;
      setTranscribeState(resp.transcriptStatus || 'not_requested');

      if (resp.transcriptStatus === 'queued' || resp.transcriptStatus === 'transcribing') {
        pollTranscription(resp.mediaId);
      }
    });
  });
}

transcribeBtn.addEventListener('click', () => {
  if (!currentVideo) return;
  startTranscription(currentVideo);
});

function startTranscription(video) {
  transcribeBtn.disabled = true;
  setIconText(transcribeBtn, 'clock', 'Queued');
  transcribeBtn.className = 'download-btn downloading';

  chrome.runtime.sendMessage({
    type: 'TRANSCRIBE_MEDIA',
    mediaId: video.mediaId,
    tweetId: video.tweetUrl?.match(/\/status\/(\d+)/)?.[1],
    sourceUrl: video.sourceUrl,
    durationMs: video.durationMs,
  }, (resp) => {
    if (!resp || !resp.ok) {
      showTranscriptionResult('error', resp?.error || 'Transcription failed');
      return;
    }
    setTranscribeState(resp.status || 'queued');
    pollTranscription(video.mediaId);
  });
}

function pollTranscription(mediaId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPTION_STATUS',
      mediaId,
    }, (resp) => {
      if (!resp || !resp.ok) return;
      setTranscribeState(resp.status || 'queued');
      if (resp.status === 'done') {
        clearInterval(pollTimer);
        showTranscriptionResult('success', 'Done');
      } else if (resp.status === 'skipped') {
        clearInterval(pollTimer);
        showTranscriptionResult('error', 'Skipped');
      } else if (resp.status === 'error') {
        clearInterval(pollTimer);
        showTranscriptionResult('error', resp.error || 'Error');
      }
    });
  }, 1000);
}

function setTranscribeState(status) {
  if (status === 'queued') {
    setIconText(transcribeBtn, 'clock', 'Queued');
    transcribeBtn.className = 'download-btn downloading';
    transcribeBtn.disabled = true;
  } else if (status === 'transcribing') {
    setIconText(transcribeBtn, 'activity', 'Transcribing');
    transcribeBtn.className = 'download-btn downloading';
    transcribeBtn.disabled = true;
  } else if (status === 'done') {
    setIconText(transcribeBtn, 'check-circle', 'Done');
    transcribeBtn.className = 'download-btn success';
    transcribeBtn.disabled = true;
  } else if (status === 'skipped') {
    setIconText(transcribeBtn, 'triangle-alert', 'Skipped');
    transcribeBtn.className = 'download-btn error';
    transcribeBtn.disabled = true;
  } else if (status === 'error') {
    setIconText(transcribeBtn, 'triangle-alert', 'Error');
    transcribeBtn.className = 'download-btn error';
    transcribeBtn.disabled = false;
  } else {
    setIconText(transcribeBtn, 'play-square', 'Transcribe Video');
    transcribeBtn.className = 'download-btn';
    transcribeBtn.disabled = false;
  }
}

function showTranscriptionResult(type, message) {
  setIconText(transcribeBtn, type === 'success' ? 'check-circle' : 'triangle-alert', message);
  transcribeBtn.className = `download-btn ${type}`;
  transcribeBtn.disabled = type === 'success';
  if (type !== 'success') {
    setTimeout(() => {
      setIconText(transcribeBtn, 'play-square', 'Transcribe Video');
      transcribeBtn.className = 'download-btn';
      transcribeBtn.disabled = false;
    }, 3000);
  }
}

hydrateStaticIcons();
refresh();
setInterval(refresh, 2000);
