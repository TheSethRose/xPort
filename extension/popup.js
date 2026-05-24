const statusEl = document.getElementById('status');
const statusPill = document.getElementById('status-pill');
const statusLabel = document.getElementById('status-label');
const transportErrorEl = document.getElementById('transport-error');
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
const openDebugBtn = document.getElementById('open-debug');
const openSettingsBtn = document.getElementById('open-settings');
const openDebugSummaryBtn = document.getElementById('open-debug-summary');
const debugTransport = document.getElementById('debug-transport');
const debugCapture = document.getElementById('debug-capture');
const debugBuffer = document.getElementById('debug-buffer');
const debugParserErrors = document.getElementById('debug-parser-errors');
const debugDiscovery = document.getElementById('debug-discovery');
const videoSection = document.getElementById('video-section');
const videoLabel = document.getElementById('video-label');
const transcribeBtn = document.getElementById('transcribe-btn');

let pollTimer = null;
let currentTransport = null;
let videoChecked = false;
let currentVideo = null;
let latestState = null;
let lastSavedOutputDir = '';

function render(state) {
  latestState = state;
  sessionEl.textContent = state.sessionCount.toLocaleString();
  alltimeEl.textContent = state.allTimeCount.toLocaleString();

  const errors = Number(state.parserErrors || 0) + (state.ingestError ? 1 : 0);
  errorEl.textContent = errors.toLocaleString();
  errorCard.style.display = errors > 0 ? '' : 'none';

  renderStatus(state);
  renderPrimaryAction(state);
  renderRecentTweets(state);
  renderDebugSummary(state);

  if (state.outputDir !== undefined && document.activeElement !== outputDirInput) {
    outputDirInput.value = state.outputDir || '';
    lastSavedOutputDir = state.outputDir || '';
  }

  currentTransport = state.transport;
}

function renderStatus(state) {
  const derived = deriveStatus(state);
  statusLabel.textContent = derived.label;
  statusPill.className = `status-pill ${derived.kind}`;
  statusEl.textContent = derived.banner;
  statusEl.className = `status ${derived.tone}`;

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
    return { kind: 'error', tone: 'error', label: 'Error', banner: 'Unable to save tweets', showError: true };
  }
  if (!state.connected) {
    return { kind: 'offline', tone: 'offline', label: 'Offline', banner: 'Extension not connected', showError: true };
  }
  if (!state.captureEnabled) {
    return { kind: 'paused', tone: 'paused', label: 'Paused', banner: 'Capture paused', showError: false };
  }
  if (state.verboseLogging) {
    return { kind: 'discovery', tone: 'discovery', label: 'Live', banner: 'Discovery mode active', showError: false };
  }
  if (state.sessionCount === 0) {
    return { kind: 'live', tone: 'warning', label: 'Live', banner: 'Connected, but no tweets this session', showError: false };
  }
  return { kind: 'live', tone: 'success', label: 'Live', banner: 'Saving tweets to Postgres', showError: false };
}

function renderPrimaryAction(state) {
  if (!state.connected) {
    toggleBtn.textContent = 'Reconnect';
    toggleBtn.className = 'retry';
    toggleBtn.setAttribute('aria-label', 'Reconnect XPort daemon');
  } else if (state.ingestError) {
    toggleBtn.textContent = 'Retry Save';
    toggleBtn.className = 'retry';
    toggleBtn.setAttribute('aria-label', 'Retry saving buffered tweets');
  } else if (state.captureEnabled) {
    toggleBtn.textContent = 'Pause Capture';
    toggleBtn.className = 'capturing';
    toggleBtn.setAttribute('aria-label', 'Pause tweet capture');
  } else {
    toggleBtn.textContent = 'Resume Capture';
    toggleBtn.className = 'paused';
    toggleBtn.setAttribute('aria-label', 'Resume tweet capture');
  }
}

function renderRecentTweets(state) {
  recentTweetsEl.innerHTML = '';
  const tweets = state.recentTweets || [];
  if (!state.captureEnabled && tweets.length === 0) {
    renderRecentEmpty('Capture is paused. Previously captured tweets remain available.');
    return;
  }
  if (tweets.length === 0) {
    renderRecentEmpty('No tweets captured this session');
    return;
  }

  for (const tweet of tweets.slice(0, 3)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-tweet';
    item.setAttribute('aria-label', `Open captured tweet ${tweet.id || ''} in dashboard`.trim());
    item.addEventListener('click', () => {
      const selected = tweet.id ? `?selectedTweet=${encodeURIComponent(tweet.id)}#tab-tweets` : '#tab-tweets';
      openDashboard(selected);
    });

    const author = document.createElement('span');
    author.className = 'tweet-author';
    author.textContent = tweet.author || '@unknown';

    const text = document.createElement('span');
    text.className = 'tweet-preview';
    text.textContent = tweet.text || 'No text captured.';

    const time = document.createElement('span');
    time.className = 'tweet-time';
    time.textContent = relativeTime(tweet.capturedAt);

    item.append(author, text, time);
    recentTweetsEl.appendChild(item);
  }
}

function renderRecentEmpty(message) {
  const empty = document.createElement('div');
  empty.className = 'recent-empty';
  empty.textContent = message;
  recentTweetsEl.appendChild(empty);
}

function renderDebugSummary(state) {
  debugTransport.textContent = state.transport || 'none';
  debugCapture.textContent = state.captureEnabled ? 'Enabled' : 'Paused';
  debugBuffer.textContent = Number(state.buffered || 0).toLocaleString();
  debugParserErrors.textContent = Number(state.parserErrors || 0).toLocaleString();
  debugDiscovery.textContent = state.verboseLogging ? 'On' : 'Off';
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
  chrome.tabs.create({ url: chrome.runtime.getURL(`debug.html${target || '#tweets'}`) });
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
  saveDirBtn.textContent = 'Saving';
  saveDirBtn.disabled = true;
  setDirectoryFeedback('', '');
  chrome.runtime.sendMessage({ type: 'SET_OUTPUT_DIR', outputDir: dir }, (resp) => {
    saveDirBtn.disabled = false;
    saveDirBtn.textContent = 'Save';
    if (resp?.error) {
      saveDirBtn.classList.add('error');
      outputDirInput.title = resp.error;
      setDirectoryFeedback(classifyDirectoryError(resp.error), 'error');
    } else {
      saveDirBtn.classList.remove('error');
      outputDirInput.title = '';
      lastSavedOutputDir = resp?.outputDir || dir;
      setDirectoryFeedback('Directory saved', 'success');
    }
  });
});

outputDirInput.addEventListener('input', () => {
  if (outputDirInput.value.trim() !== lastSavedOutputDir) {
    setDirectoryFeedback('Unsaved directory change', 'unsaved');
  } else {
    setDirectoryFeedback('', '');
  }
});

function setDirectoryFeedback(message, type) {
  dirFeedback.textContent = message;
  dirFeedback.className = type ? `dir-feedback ${type}` : 'dir-feedback';
}

function classifyDirectoryError(message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('permission') || lower.includes('denied')) {
    return 'XPort does not have permission to write here';
  }
  if (lower.includes('not running') || lower.includes('transport') || lower.includes('daemon')) {
    return message || 'Extension not connected';
  }
  if (lower.includes('not found') || lower.includes('no such')) {
    return 'Directory not found';
  }
  return message || 'Unable to save directory';
}

sessionCard.addEventListener('click', () => openDashboard('?session=current#tab-tweets'));
alltimeCard.addEventListener('click', () => openDashboard('#tab-tweets'));
errorCard.addEventListener('click', () => openDashboard('#tab-events'));
viewAllTweetsBtn.addEventListener('click', () => openDashboard('#tab-tweets'));
openTweetsBtn.addEventListener('click', () => openDashboard('#tab-tweets'));
openDebugBtn.addEventListener('click', () => openDashboard('#tab-debug'));
openDebugSummaryBtn.addEventListener('click', () => openDashboard('#tab-debug'));
openSettingsBtn.addEventListener('click', () => openDashboard('#tab-settings'));

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
  transcribeBtn.textContent = 'Queued';
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
    transcribeBtn.textContent = 'Queued';
    transcribeBtn.className = 'download-btn downloading';
    transcribeBtn.disabled = true;
  } else if (status === 'transcribing') {
    transcribeBtn.textContent = 'Transcribing';
    transcribeBtn.className = 'download-btn downloading';
    transcribeBtn.disabled = true;
  } else if (status === 'done') {
    transcribeBtn.textContent = 'Done';
    transcribeBtn.className = 'download-btn success';
    transcribeBtn.disabled = true;
  } else if (status === 'skipped') {
    transcribeBtn.textContent = 'Skipped';
    transcribeBtn.className = 'download-btn error';
    transcribeBtn.disabled = true;
  } else if (status === 'error') {
    transcribeBtn.textContent = 'Error';
    transcribeBtn.className = 'download-btn error';
    transcribeBtn.disabled = false;
  } else {
    transcribeBtn.textContent = 'Transcribe Video';
    transcribeBtn.className = 'download-btn';
    transcribeBtn.disabled = false;
  }
}

function showTranscriptionResult(type, message) {
  transcribeBtn.textContent = message;
  transcribeBtn.className = `download-btn ${type}`;
  transcribeBtn.disabled = type === 'success';
  if (type !== 'success') {
    setTimeout(() => {
      transcribeBtn.textContent = 'Transcribe Video';
      transcribeBtn.className = 'download-btn';
      transcribeBtn.disabled = false;
    }, 3000);
  }
}

refresh();
setInterval(refresh, 2000);
