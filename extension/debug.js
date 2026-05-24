import { extractTweets } from './lib/tweet-parser.js';

// --- Health polling ---

const hTransport = document.getElementById('h-transport');
const hStatus = document.getElementById('h-status');
const hCapture = document.getElementById('h-capture');
const hSession = document.getElementById('h-session');
const hAlltime = document.getElementById('h-alltime');
const hBuffer = document.getElementById('h-buffer');
const hErrorRow = document.getElementById('h-error-row');
const hError = document.getElementById('h-error');
const debugToggle = document.getElementById('debug-toggle');
const verboseToggle = document.getElementById('verbose-toggle');
const discoveredSection = document.getElementById('discovered-section');
const discoveredList = document.getElementById('discovered-list');
const tweetsBody = document.getElementById('tweets-body');

function refreshHealth() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
    if (!resp) return;
    hTransport.textContent = resp.transport || 'none';
    hStatus.textContent = resp.connected ? 'Connected' : 'Disconnected';
    hStatus.className = resp.connected ? 'status-connected' : 'status-disconnected';
    hCapture.textContent = resp.captureEnabled ? 'Enabled' : 'Paused';
    hSession.textContent = resp.sessionCount.toLocaleString();
    hAlltime.textContent = resp.allTimeCount.toLocaleString();
    hBuffer.textContent = resp.buffered;
    if (resp.transportError) {
      hErrorRow.style.display = '';
      hError.textContent = resp.transportError;
    } else {
      hErrorRow.style.display = 'none';
    }
    debugToggle.checked = !!resp.debugLogging;
    verboseToggle.checked = !!resp.verboseLogging;
    // Discovered endpoints
    if (resp.discoveredEndpoints && resp.discoveredEndpoints.length > 0) {
      discoveredSection.style.display = '';
      discoveredList.textContent = resp.discoveredEndpoints.join(', ');
    } else {
      discoveredSection.style.display = 'none';
    }
  });
}

refreshHealth();
setInterval(refreshHealth, 5000);
refreshStoredTweets();
setInterval(refreshStoredTweets, 5000);

debugToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_DEBUG', debugLogging: debugToggle.checked }, () => {
    refreshHealth();
  });
});

verboseToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_VERBOSE', verboseLogging: verboseToggle.checked }, () => {
    refreshHealth();
  });
});

function refreshStoredTweets() {
  chrome.runtime.sendMessage({ type: 'GET_STORED_TWEETS', limit: 50 }, (resp) => {
    if (!resp?.ok) {
      renderTweetMessage(resp?.error || 'Stored tweets are unavailable.');
      return;
    }
    renderTweets(resp.tweets || []);
  });
}

function renderTweetMessage(message) {
  tweetsBody.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 5;
  td.textContent = message;
  tr.appendChild(td);
  tweetsBody.appendChild(tr);
}

function renderTweets(tweets) {
  tweetsBody.innerHTML = '';
  if (tweets.length === 0) {
    renderTweetMessage('No stored tweets found in Postgres.');
    return;
  }
  for (const tweet of tweets) {
    const tr = document.createElement('tr');
    appendTweetSummaryCell(tr, tweet);
    appendTweetCell(tr, summarizeMedia(tweet.media || []));
    appendTweetCell(tr, tweet.source_endpoint || 'unknown');
    appendTweetCell(tr, formatDateTime(tweet.captured_at || tweet.created_at));
    const actions = document.createElement('td');
    for (const item of tweet.media || []) {
      if (item.media_type === 'video' || item.media_type === 'animated_gif') {
        actions.appendChild(mediaButton('Transcribe video', () => transcribeMedia(tweet, item)));
      }
      if (item.transcript_status === 'done') {
        actions.appendChild(mediaButton('View transcript', () => viewTranscript(item)));
      }
    }
    if (!actions.children.length) actions.textContent = '—';
    tr.appendChild(actions);
    tweetsBody.appendChild(tr);
  }
}

function appendTweetSummaryCell(tr, tweet) {
  const td = document.createElement('td');
  const author = document.createElement('div');
  author.className = 'tweet-author';
  const username = tweet.author_username ? `@${tweet.author_username}` : 'Unknown author';
  author.textContent = tweet.author_name ? `${tweet.author_name} (${username})` : username;
  const text = document.createElement('div');
  text.className = 'tweet-text';
  text.textContent = tweet.text || 'No text captured.';
  td.append(author, text);
  if (tweet.url) {
    const link = document.createElement('a');
    link.href = tweet.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Open on X';
    td.appendChild(link);
  }
  tr.appendChild(td);
}

function appendTweetCell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

function summarizeMedia(media) {
  if (!media.length) return '—';
  const counts = new Map();
  for (const item of media) {
    const key = item.media_type || 'media';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const parts = [...counts.entries()].map(([type, count]) => `${count} ${type}${count === 1 ? '' : 's'}`);
  const photos = media.filter(item => item.media_type === 'photo');
  if (photos.length) {
    const stored = photos.filter(item => item.asset_status === 'stored').length;
    parts.push(`${stored}/${photos.length} images saved`);
  }
  const videos = media.filter(item => item.media_type === 'video' || item.media_type === 'animated_gif');
  if (videos.length) {
    const done = videos.filter(item => item.transcript_status === 'done').length;
    parts.push(`${done}/${videos.length} transcripts`);
  }
  return parts.join(', ');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function mediaButton(label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'small-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function transcribeMedia(tweet, item) {
  chrome.runtime.sendMessage({
    type: 'TRANSCRIBE_MEDIA',
    mediaId: item.media_id,
    tweetId: tweet.tweet_id,
    sourceUrl: item.source_url,
    durationMs: item.duration_ms,
  }, refreshStoredTweets);
}

function viewTranscript(item) {
  sandboxOutput.classList.add('visible');
  sandboxOutput.classList.remove('error');
  sandboxOutput.textContent = item.transcript_text || 'Transcript is marked done, but no transcript text was returned.';
}

// --- Capture events ---

const eventsBody = document.getElementById('events-body');
const autoScrollCheckbox = document.getElementById('auto-scroll');
const clearBtn = document.getElementById('clear-events');
const eventsWrap = document.getElementById('events-wrap');
const traceStorage = chrome.storage.session || chrome.storage.local;
const traceArea = chrome.storage.session ? 'session' : 'local';

let renderedCount = 0;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function renderEvents(events) {
  eventsBody.innerHTML = '';
  renderedCount = 0;
  for (const ev of events) {
    appendEventRow(ev);
  }
}

function appendEventRow(ev) {
  const tr = document.createElement('tr');
  const cells = [formatTime(ev.timestamp), ev.endpoint, ev.tweetLabel || '—', ev.status, ev.reason || ''];
  for (const text of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  }
  tr.children[3].className = `status-${ev.status}`;
  eventsBody.appendChild(tr);
  renderedCount++;
  if (autoScrollCheckbox.checked) {
    eventsWrap.scrollTop = eventsWrap.scrollHeight;
  }
}

// Load initial events
traceStorage.get(['lastEvents'], (result) => {
  if (result.lastEvents) renderEvents(result.lastEvents);
});

// Live updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === traceArea && changes.lastEvents) {
    const events = changes.lastEvents.newValue || [];
    // Re-render if the new batch has fewer (was trimmed) or is a fresh set
    if (events.length <= renderedCount || events.length === 0) {
      renderEvents(events);
    } else {
      // Append only new events
      const newEvents = events.slice(renderedCount);
      for (const ev of newEvents) {
        appendEventRow(ev);
      }
    }
  }
});

clearBtn.addEventListener('click', () => {
  eventsBody.innerHTML = '';
  renderedCount = 0;
  traceStorage.set({ lastEvents: [] });
});

// --- Parser sandbox ---

const sandboxEndpoint = document.getElementById('sandbox-endpoint');
const sandboxJson = document.getElementById('sandbox-json');
const sandboxRun = document.getElementById('sandbox-run');
const sandboxOutput = document.getElementById('sandbox-output');

sandboxRun.addEventListener('click', () => {
  const endpoint = sandboxEndpoint.value.trim() || 'unknown';
  const raw = sandboxJson.value.trim();
  sandboxOutput.classList.add('visible');
  sandboxOutput.classList.remove('error');

  if (!raw) {
    sandboxOutput.classList.add('error');
    sandboxOutput.textContent = 'Paste JSON above first.';
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    sandboxOutput.classList.add('error');
    sandboxOutput.textContent = `JSON parse error: ${e.message}`;
    return;
  }

  try {
    const tweets = extractTweets(endpoint, data);
    if (tweets.length === 0) {
      sandboxOutput.textContent = 'No tweets extracted.';
    } else {
      sandboxOutput.textContent = `${tweets.length} tweet(s) extracted:\n\n${JSON.stringify(tweets, null, 2)}`;
    }
  } catch (e) {
    sandboxOutput.classList.add('error');
    sandboxOutput.textContent = `Parser error: ${e.message}\n\n${e.stack}`;
  }
});
