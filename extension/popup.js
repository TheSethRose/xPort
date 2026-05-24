const statusEl = document.getElementById('status');
const transportErrorEl = document.getElementById('transport-error');
const sessionEl = document.getElementById('session-count');
const alltimeEl = document.getElementById('alltime-count');
const toggleBtn = document.getElementById('toggle');
const outputDirInput = document.getElementById('output-dir');
const saveDirBtn = document.getElementById('save-dir');
const videoSection = document.getElementById('video-section');
const videoLabel = document.getElementById('video-label');
const transcribeBtn = document.getElementById('transcribe-btn');

function render(state) {
  sessionEl.textContent = state.sessionCount.toLocaleString();
  alltimeEl.textContent = state.allTimeCount.toLocaleString();

  if (state.connected) {
    if (state.ingestError) {
      statusEl.textContent = 'Postgres error';
      statusEl.className = 'status disconnected';
      transportErrorEl.textContent = state.ingestError;
      transportErrorEl.style.display = '';
    } else {
      statusEl.textContent = 'Saving to Postgres';
      statusEl.className = 'status connected';
      transportErrorEl.style.display = 'none';
    }
  } else {
    statusEl.textContent = 'Not connected';
    statusEl.className = 'status disconnected';
    if (state.transportError) {
      transportErrorEl.textContent = state.transportError;
      transportErrorEl.style.display = '';
    }
  }

  if (state.captureEnabled) {
    toggleBtn.textContent = 'Pause';
    toggleBtn.className = 'capturing';
  } else {
    toggleBtn.textContent = 'Resume';
    toggleBtn.className = 'paused';
  }

  if (state.outputDir) {
    outputDirInput.value = state.outputDir;
  }

  currentTransport = state.transport;
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response) {
      render(response);
      checkForVideo();
    }
  });
}

toggleBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' }, (response) => {
    if (response) refresh();
  });
});

saveDirBtn.addEventListener('click', () => {
  const dir = outputDirInput.value.trim();
  saveDirBtn.textContent = '...';
  saveDirBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'SET_OUTPUT_DIR', outputDir: dir }, (resp) => {
    saveDirBtn.disabled = false;
    if (resp?.error) {
      saveDirBtn.textContent = 'Error';
      saveDirBtn.classList.add('error');
      outputDirInput.title = resp.error;
    } else {
      saveDirBtn.textContent = 'Saved!';
      saveDirBtn.classList.remove('error');
      outputDirInput.title = '';
    }
    setTimeout(() => { saveDirBtn.textContent = 'Save'; }, 2000);
  });
});

// --- On-demand video transcription (HTTP daemon only) ---

let pollTimer = null;
let currentTransport = null;
let videoChecked = false;
let currentVideo = null;

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
        showTranscriptionResult('error', 'Error');
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

document.getElementById('open-debug').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
});

refresh();
setInterval(refresh, 2000);
