import { extractTweets } from './lib/tweet-parser.js';

const traceStorage = chrome.storage.session || chrome.storage.local;
const traceArea = chrome.storage.session ? 'session' : 'local';

const state = {
  health: null,
  storedTweets: [],
  events: [],
  hiddenIds: new Set(),
  reviewedIds: new Set(),
  selectedIds: new Set(),
  activeTweetId: null,
  activeTab: 'tweets',
  filters: {
    search: '',
    status: 'all',
    source: 'all',
    endpoint: 'all',
    media: 'all',
    author: 'all',
    time: 'all',
    sort: 'newest',
    hasLink: false,
    hasMedia: false,
    hasImage: false,
    hasVideo: false,
    hasQuoted: false,
    hasReply: false,
    duplicateOnly: false,
    parserErrorOnly: false,
    newOnly: false,
  },
  eventFilters: {
    search: '',
    status: 'all',
    endpoint: 'all',
    reason: 'all',
  },
};

const $ = (id) => document.getElementById(id);

const els = {
  headerTransport: $('header-transport'),
  headerCapture: $('header-capture'),
  headerLastTweet: $('header-last-tweet'),
  headerStatus: $('header-status'),
  pauseCapture: $('pause-capture'),
  refreshAll: $('refresh-all'),
  exportVisible: $('export-visible'),
  openSettings: $('open-settings'),
  tabs: [...document.querySelectorAll('.tab-btn')],
  tabPanels: [...document.querySelectorAll('.tab-panel')],

  tweetsSummary: $('tweets-summary'),
  tweetsBody: $('tweets-body'),
  tweetsWrap: $('tweets-wrap'),
  tweetsAutoRefresh: $('tweets-auto-refresh'),
  tweetsAutoScroll: $('tweets-auto-scroll'),
  tweetSearch: $('tweet-search'),
  statusFilter: $('status-filter'),
  sourceFilter: $('source-filter'),
  endpointFilter: $('endpoint-filter'),
  mediaFilter: $('media-filter'),
  authorFilter: $('author-filter'),
  timeFilter: $('time-filter'),
  sortFilter: $('sort-filter'),
  clearFilters: $('clear-filters'),
  activeFilters: $('active-filters'),
  selectAllTweets: $('select-all-tweets'),
  bulkBar: $('bulk-bar'),
  bulkCount: $('bulk-count'),
  bulkExport: $('bulk-export'),
  bulkCopyUrls: $('bulk-copy-urls'),
  bulkCopyText: $('bulk-copy-text'),
  bulkRerun: $('bulk-rerun'),
  bulkRemove: $('bulk-remove'),
  bulkReviewed: $('bulk-reviewed'),

  metricCaptured: $('metric-captured'),
  metricAccepted: $('metric-accepted'),
  metricDeduped: $('metric-deduped'),
  metricErrors: $('metric-errors'),
  metricMedia: $('metric-media'),
  metricSources: $('metric-sources'),
  metricSourceList: $('metric-source-list'),

  eventsSummary: $('events-summary'),
  eventsBody: $('events-body'),
  eventsWrap: $('events-wrap'),
  eventsAutoRefresh: $('events-auto-refresh'),
  autoScroll: $('auto-scroll'),
  clearEvents: $('clear-events'),
  eventSearch: $('event-search'),
  eventStatusFilter: $('event-status-filter'),
  eventEndpointFilter: $('event-endpoint-filter'),
  eventReasonFilter: $('event-reason-filter'),

  sandboxEndpoint: $('sandbox-endpoint'),
  sandboxJson: $('sandbox-json'),
  sandboxRun: $('sandbox-run'),
  sandboxFormat: $('sandbox-format'),
  sandboxClear: $('sandbox-clear'),
  sandboxOutput: $('sandbox-output'),
  parserResultSummary: $('parser-result-summary'),
  loadLatestEvent: $('load-latest-event'),
  loadLatestAccepted: $('load-latest-accepted'),
  loadLatestError: $('load-latest-error'),
  loadSelected: $('load-selected'),

  hTransport: $('h-transport'),
  hStatus: $('h-status'),
  hCapture: $('h-capture'),
  hSession: $('h-session'),
  hAlltime: $('h-alltime'),
  hBuffer: $('h-buffer'),
  hErrorRow: $('h-error-row'),
  hError: $('h-error'),
  debugToggle: $('debug-toggle'),
  verboseToggle: $('verbose-toggle'),
  verboseEndpointToggle: $('verbose-endpoint-toggle'),
  discoveredSection: $('discovered-section'),
  discoveredList: $('discovered-list'),
  diagDebug: $('diag-debug'),
  diagVerbose: $('diag-verbose'),
  diagRefresh: $('diag-refresh'),
  diagError: $('diag-error'),
  logSearch: $('log-search'),
  rawLogOutput: $('raw-log-output'),
  exportEvents: $('export-events'),

  captureEnabledToggle: $('capture-enabled-toggle'),
  settingsAutoRefresh: $('settings-auto-refresh'),
  settingsAutoScroll: $('settings-auto-scroll'),
  densityComfortable: $('density-comfortable'),
  densityCompact: $('density-compact'),
  defaultTab: $('default-tab'),
  exportAllTweets: $('export-all-tweets'),
  exportAllEvents: $('export-all-events'),
  clearViewTweets: $('clear-view-tweets'),
  clearLiveEvents: $('clear-live-events'),
  resetSessionView: $('reset-session-view'),

  drawer: $('tweet-drawer'),
  drawerContent: $('drawer-content'),
  closeDrawer: $('close-drawer'),
  drawerBackdrop: $('drawer-backdrop'),
  toast: $('toast'),
};

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => resolve(resp));
  });
}

async function refreshHealth() {
  const resp = await sendMessage({ type: 'GET_STATUS' });
  if (!resp) return;
  state.health = resp;
  renderHealth();
}

async function refreshStoredTweets() {
  const resp = await sendMessage({ type: 'GET_STORED_TWEETS', limit: 100, includeRaw: true });
  if (!resp?.ok) {
    state.storedTweets = [];
    renderTweetMessage(resp?.error || 'Stored tweets are unavailable.');
    renderMetrics();
    return;
  }
  state.storedTweets = (resp.tweets || []).map(normalizeStoredTweet);
  renderAllTweets();
}

function refreshEvents() {
  traceStorage.get(['lastEvents'], (result) => {
    state.events = normalizeEvents(result.lastEvents || []);
    renderAllTweets();
    renderEvents();
    renderDiagnostics();
  });
}

function normalizeStoredTweet(tweet) {
  const media = Array.isArray(tweet.media) ? tweet.media : [];
  const raw = tweet.raw || tweet;
  return {
    id: String(tweet.tweet_id || tweet.id || ''),
    rowId: `tweet:${tweet.tweet_id || tweet.id || crypto.randomUUID()}`,
    kind: 'tweet',
    tweet,
    raw,
    text: tweet.text || raw.text || '',
    authorName: tweet.author_name || raw.author?.display_name || '',
    authorHandle: tweet.author_username || raw.author?.username || '',
    source: tweet.source_endpoint || raw.source_endpoint || 'unknown',
    endpoint: tweet.source_endpoint || raw.source_endpoint || 'unknown',
    capturedAt: tweet.captured_at || raw.captured_at || tweet.created_at || raw.created_at || null,
    createdAt: tweet.created_at || raw.created_at || null,
    status: 'ACCEPTED',
    reason: '',
    url: tweet.url || raw.url || '',
    media,
    urls: raw.urls || [],
    quotedTweetId: tweet.quoted_tweet_id || raw.quoted_tweet_id || null,
    inReplyTo: tweet.in_reply_to || raw.in_reply_to || null,
    sessionId: 'current',
    bufferPosition: null,
    parserWarnings: [],
    parserErrors: [],
  };
}

function normalizeEvents(events) {
  return events.map((event, index) => ({
    ...event,
    rowId: `event:${event.timestamp || index}:${event.tweetId || 'none'}:${event.status || 'unknown'}`,
    timestamp: event.timestamp || Date.now(),
    endpoint: event.endpoint || 'unknown',
    status: event.status || 'PENDING',
    reason: event.reason || '',
    tweetId: event.tweetId ? String(event.tweetId) : '',
    tweetLabel: event.tweetLabel || '',
  }));
}

function buildTweetRows() {
  const byId = new Map();
  for (const tweet of state.storedTweets) {
    if (!tweet.id || state.hiddenIds.has(tweet.rowId)) continue;
    byId.set(tweet.id, { ...tweet, events: relatedEvents(tweet.id) });
  }

  for (const event of state.events) {
    const eventId = event.tweetId || event.rowId;
    if (state.hiddenIds.has(event.rowId)) continue;
    const existing = event.tweetId ? byId.get(event.tweetId) : null;
    if (existing) {
      existing.events = relatedEvents(existing.id);
      if (event.status === 'PARSER_ERROR') existing.status = 'PARSER_ERROR';
      continue;
    }
    byId.set(eventId, eventToTweetRow(event));
  }

  return [...byId.values()].filter(row => !state.hiddenIds.has(row.rowId));
}

function eventToTweetRow(event) {
  return {
    id: event.tweetId || event.rowId,
    rowId: event.rowId,
    kind: 'event',
    tweet: null,
    raw: event,
    text: event.tweetLabel || event.reason || 'No tweet extracted.',
    authorName: '',
    authorHandle: '',
    source: event.endpoint,
    endpoint: event.endpoint,
    capturedAt: new Date(event.timestamp).toISOString(),
    createdAt: null,
    status: event.status,
    reason: event.reason || '',
    url: event.tweetId ? `https://x.com/i/status/${event.tweetId}` : '',
    media: [],
    urls: [],
    quotedTweetId: null,
    inReplyTo: null,
    sessionId: 'current',
    bufferPosition: null,
    parserWarnings: [],
    parserErrors: event.status === 'PARSER_ERROR' ? [event.reason || 'Parser error'] : [],
    events: [event],
  };
}

function relatedEvents(tweetId) {
  if (!tweetId) return [];
  return state.events.filter(event => event.tweetId === tweetId);
}

function renderAllTweets() {
  const rows = buildTweetRows();
  populateTweetFilterOptions(rows);
  renderMetrics(rows);
  const filteredRows = filterTweetRows(rows);
  renderTweetTable(filteredRows);
  renderActiveFilters();
  renderBulkBar(filteredRows);
  updateHeaderLastTweet(rows);
}

function renderMetrics(rows = buildTweetRows()) {
  const stored = state.storedTweets.length;
  const acceptedEvents = state.events.filter(ev => ev.status === 'ACCEPTED').length;
  const deduped = state.events.filter(ev => ev.status === 'DEDUPLICATED').length;
  const errors = state.events.filter(ev => ev.status === 'PARSER_ERROR').length;
  const withMedia = rows.filter(hasAnyMedia).length;
  const sources = unique(rows.map(row => row.source).filter(Boolean));

  els.metricCaptured.textContent = String(stored);
  els.metricAccepted.textContent = String(acceptedEvents || stored);
  els.metricDeduped.textContent = String(deduped);
  els.metricErrors.textContent = String(errors);
  els.metricMedia.textContent = String(withMedia);
  els.metricSources.textContent = String(sources.length);
  els.metricSourceList.textContent = sources.slice(0, 2).join(', ') || 'active';
  els.tweetsSummary.textContent = `${stored} captured · ${acceptedEvents || stored} accepted · ${deduped} deduplicated · ${errors} parser errors · ${withMedia} with media`;
}

function populateTweetFilterOptions(rows) {
  replaceOptions(els.statusFilter, 'All statuses', unique(rows.map(row => row.status)));
  replaceOptions(els.sourceFilter, 'All sources', unique(rows.map(row => row.source)));
  replaceOptions(els.endpointFilter, 'All endpoints', unique(rows.map(row => row.endpoint)));
  replaceOptions(els.authorFilter, 'All authors', unique(rows.map(row => row.authorHandle).filter(Boolean)).map(handle => `@${handle}`));
  els.statusFilter.value = optionValueOrAll(els.statusFilter, state.filters.status);
  els.sourceFilter.value = optionValueOrAll(els.sourceFilter, state.filters.source);
  els.endpointFilter.value = optionValueOrAll(els.endpointFilter, state.filters.endpoint);
  els.authorFilter.value = optionValueOrAll(els.authorFilter, state.filters.author);
}

function replaceOptions(select, allLabel, values) {
  const current = select.value;
  select.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = allLabel;
  select.appendChild(all);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = normalizeFilterValue(value);
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = optionValueOrAll(select, current);
}

function optionValueOrAll(select, value) {
  return [...select.options].some(option => option.value === value) ? value : 'all';
}

function normalizeFilterValue(value) {
  return String(value || '').replace(/^@/, '');
}

function filterTweetRows(rows) {
  const query = state.filters.search.trim().toLowerCase();
  const now = Date.now();
  const filtered = rows.filter((row) => {
    if (query && !tweetSearchText(row).includes(query)) return false;
    if (state.filters.status !== 'all' && row.status !== state.filters.status) return false;
    if (state.filters.source !== 'all' && row.source !== state.filters.source) return false;
    if (state.filters.endpoint !== 'all' && row.endpoint !== state.filters.endpoint) return false;
    if (state.filters.author !== 'all' && row.authorHandle !== state.filters.author) return false;
    if (!matchesMediaFilter(row)) return false;
    if (!matchesTimeFilter(row, now)) return false;
    if (state.filters.hasLink && !hasLink(row)) return false;
    if (state.filters.hasMedia && !hasAnyMedia(row)) return false;
    if (state.filters.hasImage && !hasMediaType(row, 'photo')) return false;
    if (state.filters.hasVideo && !hasMediaType(row, 'video')) return false;
    if (state.filters.hasQuoted && !row.quotedTweetId) return false;
    if (state.filters.hasReply && !row.inReplyTo) return false;
    if (state.filters.duplicateOnly && !isDuplicate(row)) return false;
    if (state.filters.parserErrorOnly && row.status !== 'PARSER_ERROR') return false;
    if (state.filters.newOnly && row.status !== 'ACCEPTED') return false;
    return true;
  });
  return sortTweetRows(filtered);
}

function tweetSearchText(row) {
  return [
    row.text,
    row.authorName,
    row.authorHandle,
    row.url,
    row.source,
    row.endpoint,
    row.status,
    row.reason,
  ].join(' ').toLowerCase();
}

function matchesMediaFilter(row) {
  switch (state.filters.media) {
    case 'none': return !hasAnyMedia(row);
    case 'media': return hasAnyMedia(row);
    case 'image': return hasMediaType(row, 'photo');
    case 'video': return hasMediaType(row, 'video');
    case 'gif': return hasMediaType(row, 'animated_gif');
    case 'link': return hasLink(row);
    case 'multiple': return mediaItems(row).length + (hasLink(row) ? 1 : 0) > 1;
    default: return true;
  }
}

function matchesTimeFilter(row, now) {
  if (state.filters.time === 'all') return true;
  const ts = new Date(row.capturedAt).getTime();
  if (Number.isNaN(ts)) return false;
  const windows = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };
  return now - ts <= windows[state.filters.time];
}

function sortTweetRows(rows) {
  const sorted = [...rows];
  const byTime = (a, b) => dateValue(b.capturedAt) - dateValue(a.capturedAt);
  switch (state.filters.sort) {
    case 'oldest': return sorted.sort((a, b) => dateValue(a.capturedAt) - dateValue(b.capturedAt));
    case 'author': return sorted.sort((a, b) => a.authorHandle.localeCompare(b.authorHandle) || byTime(a, b));
    case 'source': return sorted.sort((a, b) => a.source.localeCompare(b.source) || byTime(a, b));
    case 'status': return sorted.sort((a, b) => a.status.localeCompare(b.status) || byTime(a, b));
    case 'media': return sorted.sort((a, b) => summarizeMedia(a).localeCompare(summarizeMedia(b)) || byTime(a, b));
    default: return sorted.sort(byTime);
  }
}

function renderTweetTable(rows) {
  els.tweetsBody.innerHTML = '';
  if (rows.length === 0) {
    renderTweetMessage(state.storedTweets.length === 0 && state.events.length === 0
      ? 'No tweets captured yet.'
      : 'No tweets match the active filters.');
    return;
  }

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.rowId = row.rowId;
    tr.tabIndex = 0;
    if (row.id === state.activeTweetId || row.rowId === state.activeTweetId) tr.classList.add('selected');

    const selectTd = document.createElement('td');
    selectTd.className = 'select-col';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedIds.has(row.rowId);
    checkbox.setAttribute('aria-label', `Select ${row.text || row.id}`);
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      toggleSelection(row.rowId, checkbox.checked);
      renderBulkBar(rows);
    });
    selectTd.appendChild(checkbox);
    tr.appendChild(selectTd);

    tr.append(
      tweetCell(row),
      textCell(authorLabel(row)),
      textCell(row.source),
      textCell(row.endpoint),
      capturedCell(row),
      statusCell(row.status),
      mediaCell(row),
      actionsCell(row),
    );

    tr.addEventListener('click', () => openTweetDrawer(row.id || row.rowId));
    tr.addEventListener('keydown', (event) => handleRowKeydown(event, row));
    els.tweetsBody.appendChild(tr);
  }
  if (els.tweetsAutoScroll.checked) els.tweetsWrap.scrollTop = 0;
}

function renderTweetMessage(message) {
  els.tweetsBody.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 9;
  td.className = 'empty-state';
  const emptyAction = message === 'No tweets captured yet.'
    ? '<div class="empty-actions"><button id="empty-check" class="small-btn">Check connection</button><a class="small-btn action-link" href="https://x.com" target="_blank" rel="noreferrer">Open X</a><button id="empty-events" class="small-btn">View Live Events</button></div>'
    : '';
  td.innerHTML = `<strong>${escapeHtml(message)}</strong><span class="empty-hint">Once XPort detects timeline activity, captured tweets will appear here.</span>${emptyAction}`;
  tr.appendChild(td);
  els.tweetsBody.appendChild(tr);
  $('empty-check')?.addEventListener('click', refreshHealth);
  $('empty-events')?.addEventListener('click', () => switchTab('events'));
}

function tweetCell(row) {
  const td = document.createElement('td');
  const text = document.createElement('div');
  text.className = 'tweet-text';
  text.innerHTML = highlight(row.text || 'No text captured.', state.filters.search);
  td.appendChild(text);
  const meta = document.createElement('div');
  meta.className = 'tweet-meta';
  const parts = [];
  if (row.url) parts.push(`<a class="tweet-link" href="${escapeAttr(row.url)}" target="_blank" rel="noreferrer">Open on X</a>`);
  if (isDuplicate(row)) parts.push('Duplicate capture');
  if (state.reviewedIds.has(row.rowId)) parts.push('Reviewed');
  meta.innerHTML = parts.join(' · ');
  td.appendChild(meta);
  return td;
}

function authorLabel(row) {
  if (!row.authorName && !row.authorHandle) return '—';
  const handle = row.authorHandle ? `@${row.authorHandle}` : '';
  return row.authorName ? `${row.authorName}\n${handle}` : handle;
}

function textCell(value) {
  const td = document.createElement('td');
  td.textContent = value || '—';
  return td;
}

function capturedCell(row) {
  const td = document.createElement('td');
  const relative = document.createElement('div');
  relative.textContent = formatRelative(row.capturedAt);
  const exact = document.createElement('div');
  exact.className = 'capture-exact';
  exact.textContent = formatExactTime(row.capturedAt);
  td.append(relative, exact);
  return td;
}

function statusCell(status) {
  const td = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = `status-chip status-${status}`;
  chip.textContent = statusLabel(status);
  td.appendChild(chip);
  return td;
}

function mediaCell(row) {
  const td = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = 'media-pill';
  pill.textContent = summarizeMedia(row);
  td.appendChild(pill);
  return td;
}

function actionsCell(row) {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';
  wrap.append(
    actionButton('Details', () => openTweetDrawer(row.id || row.rowId)),
    actionButton('Copy URL', () => copyText(row.url || '', 'Tweet URL copied')),
    actionButton('Copy Text', () => copyText(row.text || '', 'Tweet text copied')),
    actionButton('Copy JSON', () => copyJson(row.raw || row, 'Tweet JSON copied')),
    actionButton('Re-run Parser', () => loadRowIntoParser(row)),
    actionButton('Remove', () => removeRows([row.rowId])),
  );
  if (row.url) {
    const open = actionButton('Open on X', () => window.open(row.url, '_blank', 'noreferrer'));
    wrap.prepend(open);
  }
  for (const item of mediaItems(row)) {
    if (item.media_type === 'video' || item.media_type === 'animated_gif') {
      wrap.appendChild(actionButton('Transcribe', () => transcribeMedia(row, item)));
      break;
    }
  }
  td.appendChild(wrap);
  td.addEventListener('click', (event) => event.stopPropagation());
  return td;
}

function actionButton(label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'small-btn';
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function handleRowKeydown(event, row) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openTweetDrawer(row.id || row.rowId);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const rows = [...els.tweetsBody.querySelectorAll('tr[tabindex="0"]')];
    const index = rows.indexOf(event.currentTarget);
    const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    next?.focus();
  }
}

function openTweetDrawer(id) {
  const row = buildTweetRows().find(item => item.id === id || item.rowId === id);
  if (!row) return;
  state.activeTweetId = row.id || row.rowId;
  els.drawerContent.innerHTML = drawerHtml(row);
  els.drawer.classList.add('open');
  els.drawer.setAttribute('aria-hidden', 'false');
  els.drawerBackdrop.hidden = false;
  bindDrawerActions(row);
  renderAllTweets();
}

function closeTweetDrawer() {
  state.activeTweetId = null;
  els.drawer.classList.remove('open');
  els.drawer.setAttribute('aria-hidden', 'true');
  els.drawerBackdrop.hidden = true;
  renderAllTweets();
}

function drawerHtml(row) {
  const rawEvent = row.events?.[0] || row.raw || {};
  return `
    <section class="drawer-section">
      <h3>Tweet</h3>
      <p class="tweet-text">${escapeHtml(row.text || 'No text captured.')}</p>
      <dl class="detail-list">
        <dt>Author</dt><dd>${escapeHtml(row.authorName || '—')}</dd>
        <dt>Handle</dt><dd>${escapeHtml(row.authorHandle ? `@${row.authorHandle}` : '—')}</dd>
        <dt>Tweet URL</dt><dd>${row.url ? `<a class="tweet-link" href="${escapeAttr(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.url)}</a>` : '—'}</dd>
        <dt>Captured</dt><dd>${escapeHtml(formatFullDate(row.capturedAt))}</dd>
        <dt>Source</dt><dd>${escapeHtml(row.source || '—')}</dd>
        <dt>Endpoint</dt><dd>${escapeHtml(row.endpoint || '—')}</dd>
        <dt>Media</dt><dd>${escapeHtml(summarizeMedia(row))}</dd>
      </dl>
    </section>
    <section class="drawer-section">
      <h3>Capture Status</h3>
      <dl class="detail-list">
        <dt>Status</dt><dd>${escapeHtml(statusLabel(row.status))}</dd>
        <dt>Reason</dt><dd>${escapeHtml(row.reason || latestReason(row) || '—')}</dd>
        <dt>Duplicate match</dt><dd>${escapeHtml(isDuplicate(row) ? 'seenIds' : '—')}</dd>
        <dt>Seen ID status</dt><dd>${escapeHtml(row.id ? 'tracked' : 'no tweet id')}</dd>
        <dt>Session ID</dt><dd>${escapeHtml(row.sessionId || 'current')}</dd>
        <dt>Buffer position</dt><dd>${escapeHtml(row.bufferPosition ?? '—')}</dd>
      </dl>
    </section>
    <section class="drawer-section">
      <h3>Debug Data</h3>
      <details>
        <summary>Raw event JSON</summary>
        <pre class="json-block">${escapeHtml(JSON.stringify(rawEvent, null, 2))}</pre>
      </details>
      <details>
        <summary>Parsed tweet JSON</summary>
        <pre class="json-block">${escapeHtml(JSON.stringify(row.raw || row.tweet || row, null, 2))}</pre>
      </details>
      <details>
        <summary>Parser warnings</summary>
        <pre class="json-block">${escapeHtml(JSON.stringify(row.parserWarnings || [], null, 2))}</pre>
      </details>
      <details>
        <summary>Parser errors</summary>
        <pre class="json-block">${escapeHtml(JSON.stringify(row.parserErrors || [], null, 2))}</pre>
      </details>
      <details>
        <summary>Endpoint response snippet</summary>
        <pre class="json-block">${escapeHtml(JSON.stringify(endpointSnippet(row), null, 2))}</pre>
      </details>
    </section>
    <section class="drawer-section">
      <h3>Actions</h3>
      <div class="stacked-actions">
        <button id="drawer-open-x" class="small-btn">Open on X</button>
        <button id="drawer-copy-text" class="small-btn">Copy tweet text</button>
        <button id="drawer-copy-url" class="small-btn">Copy tweet URL</button>
        <button id="drawer-copy-raw" class="small-btn">Copy raw JSON</button>
        <button id="drawer-copy-parsed" class="small-btn">Copy parsed JSON</button>
        <button id="drawer-rerun" class="small-btn">Re-run parser</button>
        <button id="drawer-export" class="small-btn">Export this tweet</button>
        <button id="drawer-delete" class="small-btn">Remove from view</button>
      </div>
    </section>
  `;
}

function bindDrawerActions(row) {
  $('drawer-open-x')?.addEventListener('click', () => row.url && window.open(row.url, '_blank', 'noreferrer'));
  $('drawer-copy-text')?.addEventListener('click', () => copyText(row.text || '', 'Tweet text copied'));
  $('drawer-copy-url')?.addEventListener('click', () => copyText(row.url || '', 'Tweet URL copied'));
  $('drawer-copy-raw')?.addEventListener('click', () => copyJson(row.events?.[0] || row.raw || row, 'Raw JSON copied'));
  $('drawer-copy-parsed')?.addEventListener('click', () => copyJson(row.raw || row.tweet || row, 'Parsed JSON copied'));
  $('drawer-rerun')?.addEventListener('click', () => loadRowIntoParser(row));
  $('drawer-export')?.addEventListener('click', () => exportJson([exportTweet(row)], `xport-tweet-${row.id || 'event'}.json`));
  $('drawer-delete')?.addEventListener('click', () => removeRows([row.rowId]));
}

function renderEvents() {
  populateEventFilters();
  const filtered = filterEvents();
  els.eventsBody.innerHTML = '';
  if (!filtered.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty-state';
    td.innerHTML = '<strong>No live events.</strong><span class="empty-hint">Capture activity will appear here as the service worker records events.</span>';
    tr.appendChild(td);
    els.eventsBody.appendChild(tr);
  }
  for (const event of filtered) {
    const tr = document.createElement('tr');
    tr.append(
      textCell(formatTime(event.timestamp)),
      textCell(event.endpoint),
      textCell(eventType(event)),
      textCell(event.tweetLabel || event.tweetId || '—'),
      statusCell(event.status),
      textCell(event.reason || '—'),
      eventActionsCell(event),
    );
    els.eventsBody.appendChild(tr);
  }
  const accepted = state.events.filter(ev => ev.status === 'ACCEPTED').length;
  const deduped = state.events.filter(ev => ev.status === 'DEDUPLICATED').length;
  const errors = state.events.filter(ev => ev.status === 'PARSER_ERROR').length;
  els.eventsSummary.textContent = `${state.events.length} events · ${accepted} accepted · ${deduped} deduplicated · ${errors} errors`;
  if (els.autoScroll.checked) els.eventsWrap.scrollTop = els.eventsWrap.scrollHeight;
}

function eventActionsCell(event) {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';
  if (event.tweetId) wrap.appendChild(actionButton('View tweet', () => openTweetFromEvent(event)));
  wrap.append(
    actionButton('Copy JSON', () => copyJson(event, 'Event JSON copied')),
    actionButton('Load parser', () => loadEventIntoParser(event)),
  );
  td.appendChild(wrap);
  return td;
}

function openTweetFromEvent(event) {
  switchTab('tweets');
  openTweetDrawer(event.tweetId || event.rowId);
}

function populateEventFilters() {
  replaceOptions(els.eventStatusFilter, 'All statuses', unique(state.events.map(ev => ev.status)));
  replaceOptions(els.eventEndpointFilter, 'All endpoints', unique(state.events.map(ev => ev.endpoint)));
  replaceOptions(els.eventReasonFilter, 'All reasons', unique(state.events.map(ev => ev.reason).filter(Boolean)));
}

function filterEvents() {
  const query = state.eventFilters.search.trim().toLowerCase();
  return state.events.filter((event) => {
    const haystack = [event.endpoint, event.status, event.reason, event.tweetLabel, event.tweetId].join(' ').toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (state.eventFilters.status !== 'all' && event.status !== state.eventFilters.status) return false;
    if (state.eventFilters.endpoint !== 'all' && event.endpoint !== state.eventFilters.endpoint) return false;
    if (state.eventFilters.reason !== 'all' && event.reason !== state.eventFilters.reason) return false;
    return true;
  });
}

function renderHealth() {
  const health = state.health;
  if (!health) return;
  const connected = !!health.connected;
  els.headerTransport.textContent = health.transport || 'none';
  els.headerCapture.textContent = health.captureEnabled ? 'Capture Enabled' : 'Capture Paused';
  els.headerStatus.textContent = connected ? 'Connected' : 'Disconnected';
  els.headerStatus.classList.toggle('connected', connected);
  els.pauseCapture.textContent = health.captureEnabled ? 'Pause' : 'Resume';

  els.hTransport.textContent = health.transport || 'none';
  els.hStatus.textContent = connected ? 'Connected' : 'Disconnected';
  els.hStatus.className = connected ? 'status-connected' : 'status-disconnected';
  els.hCapture.textContent = health.captureEnabled ? 'Enabled' : 'Paused';
  els.hSession.textContent = number(health.sessionCount);
  els.hAlltime.textContent = number(health.allTimeCount);
  els.hBuffer.textContent = number(health.buffered);
  els.hErrorRow.hidden = !health.transportError;
  els.hError.textContent = health.transportError || '—';
  els.debugToggle.checked = !!health.debugLogging;
  els.verboseToggle.checked = !!health.verboseLogging;
  els.verboseEndpointToggle.checked = !!health.verboseLogging;
  els.captureEnabledToggle.checked = !!health.captureEnabled;
  renderDiagnostics();

  const endpoints = health.discoveredEndpoints || [];
  els.discoveredList.textContent = endpoints.length ? endpoints.join(', ') : 'No endpoints discovered this session.';
}

function renderDiagnostics() {
  const health = state.health || {};
  els.diagDebug.textContent = health.debugLogging ? 'Enabled' : 'Disabled';
  els.diagVerbose.textContent = health.verboseLogging ? 'Enabled' : 'Disabled';
  els.diagRefresh.textContent = formatFullDate(new Date().toISOString());
  els.diagError.textContent = health.transportError || health.ingestError || latestEventError() || '—';
}

function renderActiveFilters() {
  const chips = [];
  const add = (label, value) => {
    if (value && value !== 'all') chips.push(`${label}: ${value}`);
  };
  add('Status', state.filters.status);
  add('Source', state.filters.source);
  add('Endpoint', state.filters.endpoint);
  add('Media', state.filters.media);
  add('Author', state.filters.author && state.filters.author !== 'all' ? `@${state.filters.author}` : 'all');
  add('Time', state.filters.time);
  if (state.filters.search) chips.push(`Search: ${state.filters.search}`);
  for (const [key, label] of [
    ['hasLink', 'Has link'],
    ['hasMedia', 'Has media'],
    ['hasImage', 'Has image'],
    ['hasVideo', 'Has video'],
    ['hasQuoted', 'Has quoted tweet'],
    ['hasReply', 'Has reply'],
    ['duplicateOnly', 'Duplicates only'],
    ['parserErrorOnly', 'Parser errors only'],
    ['newOnly', 'New tweets only'],
  ]) {
    if (state.filters[key]) chips.push(label);
  }
  els.activeFilters.innerHTML = chips.map(chip => `<span class="filter-chip">${escapeHtml(chip)}</span>`).join('');
}

function renderBulkBar(visibleRows = filterTweetRows(buildTweetRows())) {
  const visibleIds = new Set(visibleRows.map(row => row.rowId));
  for (const id of [...state.selectedIds]) {
    if (!visibleIds.has(id)) state.selectedIds.delete(id);
  }
  const count = state.selectedIds.size;
  els.bulkBar.hidden = count === 0;
  els.bulkCount.textContent = `${count} selected`;
  els.selectAllTweets.checked = count > 0 && visibleRows.every(row => state.selectedIds.has(row.rowId));
}

function updateHeaderLastTweet(rows) {
  const sorted = sortTweetRows(rows).filter(row => row.status === 'ACCEPTED' || row.kind === 'tweet');
  els.headerLastTweet.textContent = `Last tweet: ${sorted[0] ? formatRelative(sorted[0].capturedAt) : '—'}`;
}

function toggleSelection(rowId, checked) {
  if (checked) state.selectedIds.add(rowId);
  else state.selectedIds.delete(rowId);
}

function selectedRows() {
  const rows = buildTweetRows();
  return rows.filter(row => state.selectedIds.has(row.rowId));
}

function removeRows(rowIds) {
  for (const rowId of rowIds) state.hiddenIds.add(rowId);
  state.selectedIds.clear();
  closeTweetDrawer();
  renderAllTweets();
  showToast('Removed from dashboard view');
}

function markRowsReviewed(rows) {
  for (const row of rows) state.reviewedIds.add(row.rowId);
  showToast('Marked reviewed');
  renderAllTweets();
}

async function transcribeMedia(row, item) {
  const resp = await sendMessage({
    type: 'TRANSCRIBE_MEDIA',
    mediaId: item.media_id,
    tweetId: row.id,
    sourceUrl: item.source_url,
    durationMs: item.duration_ms,
  });
  showToast(resp?.ok ? 'Transcription queued' : (resp?.error || 'Transcription failed'));
  refreshStoredTweets();
}

function loadRowIntoParser(row) {
  const payload = row.raw || row.tweet || row.events?.[0] || row;
  els.sandboxEndpoint.value = row.endpoint || 'unknown';
  els.sandboxJson.value = JSON.stringify(payload, null, 2);
  switchTab('parser');
}

function loadEventIntoParser(event) {
  els.sandboxEndpoint.value = event.endpoint || 'unknown';
  els.sandboxJson.value = JSON.stringify(event, null, 2);
  switchTab('parser');
}

function runParser() {
  const endpoint = els.sandboxEndpoint.value.trim() || 'unknown';
  const raw = els.sandboxJson.value.trim();
  els.sandboxOutput.classList.add('visible');
  els.sandboxOutput.classList.remove('error');
  els.parserResultSummary.textContent = '';

  if (!raw) {
    els.sandboxOutput.classList.add('error');
    els.sandboxOutput.textContent = 'Paste JSON above first.';
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    els.sandboxOutput.classList.add('error');
    els.sandboxOutput.textContent = `JSON parse error: ${e.message}`;
    return;
  }

  try {
    const tweets = extractTweets(endpoint, data);
    els.parserResultSummary.textContent = `${tweets.length} tweet(s) extracted.`;
    els.sandboxOutput.textContent = tweets.length
      ? `Extracted Tweets\n${JSON.stringify(tweets, null, 2)}\n\nParser Result\n${JSON.stringify({ endpoint, count: tweets.length }, null, 2)}\n\nWarnings\n[]\n\nErrors\n[]`
      : `Extracted Tweets\n[]\n\nParser Result\nNo tweets extracted.\n\nWarnings\n[]\n\nErrors\n[]`;
  } catch (e) {
    els.sandboxOutput.classList.add('error');
    els.parserResultSummary.textContent = 'Parser failed.';
    els.sandboxOutput.textContent = `Parser error: ${e.message}\n\n${e.stack}`;
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  for (const btn of els.tabs) btn.classList.toggle('active', btn.dataset.tab === tab);
  for (const panel of els.tabPanels) panel.classList.toggle('active', panel.id === `tab-${tab}`);
  els.defaultTab.value = tab;
}

function tabFromHash() {
  const tab = location.hash.startsWith('#tab-') ? location.hash.slice('#tab-'.length) : '';
  return els.tabPanels.some(panel => panel.id === `tab-${tab}`) ? tab : '';
}

function exportTweet(row) {
  return {
    tweet: row.tweet || null,
    author: {
      name: row.authorName,
      handle: row.authorHandle,
    },
    media: mediaItems(row),
    capture: {
      tweet_id: row.id,
      source: row.source,
      endpoint: row.endpoint,
      captured_at: row.capturedAt,
      status: row.status,
      reason: row.reason || latestReason(row),
      session_id: row.sessionId,
    },
    parser: {
      warnings: row.parserWarnings || [],
      errors: row.parserErrors || [],
    },
    raw_event_reference: row.events || [],
    raw: row.raw || null,
  };
}

function exportJson(data, filename) {
  download(JSON.stringify(data, null, 2), filename, 'application/json');
}

function exportCsv(rows, filename) {
  const fields = ['tweet_id', 'author_name', 'author_handle', 'tweet_text', 'tweet_url', 'source', 'endpoint', 'captured_at', 'status', 'reason', 'media_type', 'has_link', 'has_media', 'session_id'];
  const lines = [fields.join(',')];
  for (const row of rows) {
    lines.push([
      row.id,
      row.authorName,
      row.authorHandle,
      row.text,
      row.url,
      row.source,
      row.endpoint,
      row.capturedAt,
      row.status,
      row.reason || latestReason(row),
      summarizeMedia(row),
      hasLink(row),
      hasAnyMedia(row),
      row.sessionId,
    ].map(csvCell).join(','));
  }
  download(lines.join('\n'), filename, 'text/csv');
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function copyJson(value, message) {
  copyText(JSON.stringify(value, null, 2), message);
}

async function copyText(value, message) {
  if (!value) {
    showToast('Nothing to copy');
    return;
  }
  await navigator.clipboard.writeText(value);
  showToast(message);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 1800);
}

function bindEvents() {
  els.tabs.forEach(btn => btn.addEventListener('click', () => {
    history.replaceState(null, '', `#tab-${btn.dataset.tab}`);
    switchTab(btn.dataset.tab);
  }));
  els.openSettings.addEventListener('click', () => {
    history.replaceState(null, '', '#tab-settings');
    switchTab('settings');
  });
  els.refreshAll.addEventListener('click', refreshAll);
  els.exportVisible.addEventListener('click', () => exportCsv(filterTweetRows(buildTweetRows()), 'xport-visible-tweets.csv'));
  els.pauseCapture.addEventListener('click', async () => {
    await sendMessage({ type: 'TOGGLE_CAPTURE' });
    refreshHealth();
  });

  els.tweetSearch.addEventListener('input', () => updateFilter('search', els.tweetSearch.value));
  els.statusFilter.addEventListener('change', () => updateFilter('status', els.statusFilter.value));
  els.sourceFilter.addEventListener('change', () => updateFilter('source', els.sourceFilter.value));
  els.endpointFilter.addEventListener('change', () => updateFilter('endpoint', els.endpointFilter.value));
  els.mediaFilter.addEventListener('change', () => updateFilter('media', els.mediaFilter.value));
  els.authorFilter.addEventListener('change', () => updateFilter('author', normalizeFilterValue(els.authorFilter.value)));
  els.timeFilter.addEventListener('change', () => updateFilter('time', els.timeFilter.value));
  els.sortFilter.addEventListener('change', () => updateFilter('sort', els.sortFilter.value));
  for (const [id, key] of [
    ['filter-link', 'hasLink'],
    ['filter-media', 'hasMedia'],
    ['filter-image', 'hasImage'],
    ['filter-video', 'hasVideo'],
    ['filter-quoted', 'hasQuoted'],
    ['filter-reply', 'hasReply'],
    ['filter-duplicate', 'duplicateOnly'],
    ['filter-parser-error', 'parserErrorOnly'],
    ['filter-new', 'newOnly'],
  ]) {
    $(id).addEventListener('change', (event) => updateFilter(key, event.target.checked));
  }
  els.clearFilters.addEventListener('click', clearFilters);
  document.querySelectorAll('.sort-heading').forEach(btn => {
    btn.addEventListener('click', () => {
      const sort = btn.dataset.sort === 'newest' && state.filters.sort === 'newest' ? 'oldest' : btn.dataset.sort;
      updateFilter('sort', sort);
      els.sortFilter.value = sort;
    });
  });

  els.selectAllTweets.addEventListener('change', () => {
    for (const row of filterTweetRows(buildTweetRows())) toggleSelection(row.rowId, els.selectAllTweets.checked);
    renderAllTweets();
  });
  els.bulkExport.addEventListener('click', () => exportJson(selectedRows().map(exportTweet), 'xport-selected-tweets.json'));
  els.bulkCopyUrls.addEventListener('click', () => copyText(selectedRows().map(row => row.url).filter(Boolean).join('\n'), 'Selected URLs copied'));
  els.bulkCopyText.addEventListener('click', () => copyText(selectedRows().map(row => row.text).filter(Boolean).join('\n\n'), 'Selected text copied'));
  els.bulkRerun.addEventListener('click', () => selectedRows()[0] && loadRowIntoParser(selectedRows()[0]));
  els.bulkRemove.addEventListener('click', () => removeRows([...state.selectedIds]));
  els.bulkReviewed.addEventListener('click', () => markRowsReviewed(selectedRows()));

  els.eventSearch.addEventListener('input', () => updateEventFilter('search', els.eventSearch.value));
  els.eventStatusFilter.addEventListener('change', () => updateEventFilter('status', els.eventStatusFilter.value));
  els.eventEndpointFilter.addEventListener('change', () => updateEventFilter('endpoint', els.eventEndpointFilter.value));
  els.eventReasonFilter.addEventListener('change', () => updateEventFilter('reason', els.eventReasonFilter.value));
  els.clearEvents.addEventListener('click', clearLiveEvents);

  els.sandboxRun.addEventListener('click', runParser);
  els.sandboxFormat.addEventListener('click', formatSandboxJson);
  els.sandboxClear.addEventListener('click', () => {
    els.sandboxJson.value = '';
    els.sandboxOutput.textContent = '';
    els.sandboxOutput.classList.remove('visible', 'error');
    els.parserResultSummary.textContent = '';
  });
  els.loadLatestEvent.addEventListener('click', () => state.events[0] && loadEventIntoParser(state.events[state.events.length - 1]));
  els.loadLatestAccepted.addEventListener('click', () => {
    const row = buildTweetRows().find(item => item.status === 'ACCEPTED');
    if (row) loadRowIntoParser(row);
  });
  els.loadLatestError.addEventListener('click', () => {
    const event = [...state.events].reverse().find(item => item.status === 'PARSER_ERROR');
    if (event) loadEventIntoParser(event);
  });
  els.loadSelected.addEventListener('click', () => selectedRows()[0] && loadRowIntoParser(selectedRows()[0]));

  els.debugToggle.addEventListener('change', () => setDebug(els.debugToggle.checked));
  els.verboseToggle.addEventListener('change', () => setVerbose(els.verboseToggle.checked));
  els.verboseEndpointToggle.addEventListener('change', () => setVerbose(els.verboseEndpointToggle.checked));
  els.captureEnabledToggle.addEventListener('change', async () => {
    if (!!state.health?.captureEnabled !== els.captureEnabledToggle.checked) {
      await sendMessage({ type: 'TOGGLE_CAPTURE' });
      refreshHealth();
    }
  });
  els.settingsAutoRefresh.addEventListener('change', () => {
    els.tweetsAutoRefresh.checked = els.settingsAutoRefresh.checked;
    els.eventsAutoRefresh.checked = els.settingsAutoRefresh.checked;
  });
  els.settingsAutoScroll.addEventListener('change', () => {
    els.tweetsAutoScroll.checked = els.settingsAutoScroll.checked;
    els.autoScroll.checked = els.settingsAutoScroll.checked;
  });
  els.densityComfortable.addEventListener('click', () => setDensity('comfortable'));
  els.densityCompact.addEventListener('click', () => setDensity('compact'));
  els.defaultTab.addEventListener('change', () => switchTab(els.defaultTab.value));
  els.exportAllTweets.addEventListener('click', () => exportJson(buildTweetRows().map(exportTweet), 'xport-all-tweets.json'));
  els.exportAllEvents.addEventListener('click', () => exportJson(state.events, 'xport-live-events.json'));
  els.exportEvents.addEventListener('click', () => exportJson(state.events, 'xport-live-events.json'));
  els.clearViewTweets.addEventListener('click', () => {
    state.hiddenIds.clear();
    renderAllTweets();
    showToast('Dashboard view restored');
  });
  els.clearLiveEvents.addEventListener('click', clearLiveEvents);
  els.resetSessionView.addEventListener('click', () => {
    state.hiddenIds.clear();
    state.reviewedIds.clear();
    state.selectedIds.clear();
    renderAllTweets();
    showToast('Session view reset');
  });

  els.closeDrawer.addEventListener('click', closeTweetDrawer);
  els.drawerBackdrop.addEventListener('click', closeTweetDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.drawer.classList.contains('open')) closeTweetDrawer();
    if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      event.preventDefault();
      switchTab('tweets');
      els.tweetSearch.focus();
    }
    if (event.key === 'Enter' && document.activeElement === els.tweetSearch) {
      const first = filterTweetRows(buildTweetRows())[0];
      if (first) openTweetDrawer(first.id || first.rowId);
    }
  });
}

function updateFilter(key, value) {
  state.filters[key] = value;
  renderAllTweets();
}

function updateEventFilter(key, value) {
  state.eventFilters[key] = value;
  renderEvents();
}

function clearFilters() {
  Object.assign(state.filters, {
    search: '',
    status: 'all',
    source: 'all',
    endpoint: 'all',
    media: 'all',
    author: 'all',
    time: 'all',
    sort: 'newest',
    hasLink: false,
    hasMedia: false,
    hasImage: false,
    hasVideo: false,
    hasQuoted: false,
    hasReply: false,
    duplicateOnly: false,
    parserErrorOnly: false,
    newOnly: false,
  });
  els.tweetSearch.value = '';
  els.mediaFilter.value = 'all';
  els.timeFilter.value = 'all';
  els.sortFilter.value = 'newest';
  for (const id of ['filter-link', 'filter-media', 'filter-image', 'filter-video', 'filter-quoted', 'filter-reply', 'filter-duplicate', 'filter-parser-error', 'filter-new']) {
    $(id).checked = false;
  }
  renderAllTweets();
}

async function setDebug(enabled) {
  await sendMessage({ type: 'SET_DEBUG', debugLogging: enabled });
  refreshHealth();
}

async function setVerbose(enabled) {
  await sendMessage({ type: 'SET_VERBOSE', verboseLogging: enabled });
  refreshHealth();
}

function setDensity(density) {
  document.body.classList.toggle('compact', density === 'compact');
  els.densityComfortable.classList.toggle('active', density === 'comfortable');
  els.densityCompact.classList.toggle('active', density === 'compact');
}

function formatSandboxJson() {
  try {
    els.sandboxJson.value = JSON.stringify(JSON.parse(els.sandboxJson.value), null, 2);
  } catch (e) {
    showToast(`Invalid JSON: ${e.message}`);
  }
}

function clearLiveEvents() {
  state.events = [];
  traceStorage.set({ lastEvents: [] });
  renderAllTweets();
  renderEvents();
}

async function refreshAll() {
  await Promise.all([refreshHealth(), refreshStoredTweets()]);
  refreshEvents();
}

function mediaItems(row) {
  return Array.isArray(row.media) ? row.media : [];
}

function hasAnyMedia(row) {
  return mediaItems(row).length > 0;
}

function hasMediaType(row, type) {
  return mediaItems(row).some(item => item.media_type === type || item.type === type);
}

function hasLink(row) {
  return (row.urls && row.urls.length > 0) || /\bhttps?:\/\//i.test(row.text || '');
}

function isDuplicate(row) {
  return row.status === 'DEDUPLICATED' || row.events?.some(event => event.status === 'DEDUPLICATED');
}

function summarizeMedia(row) {
  const media = mediaItems(row);
  const parts = [];
  const photoCount = media.filter(item => (item.media_type || item.type) === 'photo').length;
  const videoCount = media.filter(item => (item.media_type || item.type) === 'video').length;
  const gifCount = media.filter(item => (item.media_type || item.type) === 'animated_gif').length;
  if (photoCount) parts.push(photoCount > 1 ? `${photoCount} Images` : 'Image');
  if (videoCount) parts.push(videoCount > 1 ? `${videoCount} Videos` : 'Video');
  if (gifCount) parts.push(gifCount > 1 ? `${gifCount} GIFs` : 'GIF');
  if (hasLink(row)) parts.push('Link');
  if (!parts.length) return '—';
  return parts.length > 1 ? 'Multiple' : parts[0];
}

function latestReason(row) {
  return row.events?.findLast?.(event => event.reason)?.reason || row.events?.filter(event => event.reason).at(-1)?.reason || '';
}

function latestEventError() {
  return [...state.events].reverse().find(event => event.status === 'PARSER_ERROR' || event.status === 'STAGE_FAILED')?.reason || '';
}

function endpointSnippet(row) {
  const raw = row.raw || {};
  return {
    endpoint: row.endpoint,
    keys: typeof raw === 'object' && raw ? Object.keys(raw).slice(0, 20) : [],
    status: row.status,
    reason: row.reason || latestReason(row),
  };
}

function eventType(event) {
  if (event.status === 'ACCEPTED' || event.status === 'DEDUPLICATED') return 'Tweet capture';
  if (event.status === 'PARSER_ERROR') return 'Parser';
  if (event.status === 'BUFFER_OVERFLOW') return 'Buffer';
  return 'System';
}

function statusLabel(status) {
  return String(status || 'PENDING').replace(/_/g, ' ');
}

function formatRelative(value) {
  if (!value) return '—';
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return '—';
  const delta = Date.now() - ts;
  if (delta < 30 * 1000) return 'just now';
  if (delta < 60 * 60 * 1000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3600000)}h ago`;
  return `${Math.floor(delta / 86400000)}d ago`;
}

function formatExactTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

function formatFullDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

function dateValue(value) {
  const date = new Date(value).getTime();
  return Number.isNaN(date) ? 0 : date;
}

function number(value) {
  return Number(value || 0).toLocaleString();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  const needle = query.trim();
  if (!needle) return safe;
  const escapedNeedle = escapeRegExp(escapeHtml(needle));
  return safe.replace(new RegExp(escapedNeedle, 'gi'), match => `<mark>${match}</mark>`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

bindEvents();
switchTab(tabFromHash() || state.activeTab);
window.addEventListener('hashchange', () => switchTab(tabFromHash() || 'tweets'));
refreshAll();

setInterval(refreshHealth, 5000);
setInterval(() => {
  if (els.tweetsAutoRefresh.checked) refreshStoredTweets();
  if (els.eventsAutoRefresh.checked) refreshEvents();
}, 5000);

traceStorage.get(['lastEvents'], (result) => {
  state.events = normalizeEvents(result.lastEvents || []);
  renderAllTweets();
  renderEvents();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === traceArea && changes.lastEvents && els.eventsAutoRefresh.checked) {
    state.events = normalizeEvents(changes.lastEvents.newValue || []);
    renderAllTweets();
    renderEvents();
  }
});
