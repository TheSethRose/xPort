import { extractTweets } from './lib/tweet-parser.js';

const traceStorage = chrome.storage.session || chrome.storage.local;
const traceArea = chrome.storage.session ? 'session' : 'local';
const settingsStorage = chrome.storage?.local || null;

const DEFAULT_SETTINGS = {
  density: 'compact',
  defaultTab: 'tweets',
  timestampFormat: 'relative_exact',
  theme: 'charcoal',
  autoRefresh: true,
  autoScrollLiveEvents: true,
  captureEnabled: true,
  deduplicateTweets: true,
  preserveRawPayloads: true,
  debugLogging: false,
  discoveryMode: false,
  verboseEndpointLogging: false,
};

const state = {
  health: null,
  storedTweets: [],
  events: [],
  hiddenIds: new Set(),
  reviewedIds: new Set(),
  selectedIds: new Set(),
  activeTweetId: null,
  activeTab: 'tweets',
  settings: { ...DEFAULT_SETTINGS },
  pendingVisualRefresh: {
    storedTweets: null,
    events: null,
  },
  interactingUntil: 0,
  interactionTimer: null,
  lastRefreshAt: null,
  activeDropdownId: null,
  storedTweetsRefreshInFlight: false,
  filters: {
    search: '',
    status: 'all',
    source: 'all',
    endpoint: 'all',
    media: 'all',
    transcription: 'all',
    author: 'all',
    time: 'all',
    sort: 'newest',
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
  headerRefreshState: $('header-refresh-state'),
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
  transcriptionFilter: $('transcription-filter'),
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
  dropdownLayer: $('dropdown-layer'),

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
  timestampFormat: $('timestamp-format'),
  themeSelect: $('theme-select'),
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

const SEARCHABLE_THRESHOLD = 7;
const VIRTUALIZE_DROPDOWN_THRESHOLD = 500;
const DROPDOWN_OPTION_HEIGHT = 44;
const STORED_TWEET_PAGE_SIZE = 500;
const STORED_TWEET_RECENT_PAGE_SIZE = 100;
const STORED_TWEET_MAX_OFFSET = 100000;
const searchableDropdowns = new Map();

const dropdownConfigs = {
  status: {
    filterKey: 'status',
    select: els.statusFilter,
    wrapperClass: 'status-select',
    allLabel: 'All statuses',
    placeholder: 'Search statuses...',
    ariaLabel: 'Search statuses',
    emptyName: 'statuses',
    searchableThreshold: SEARCHABLE_THRESHOLD,
  },
  source: {
    filterKey: 'source',
    select: els.sourceFilter,
    wrapperClass: 'source-select',
    allLabel: 'All sources',
    placeholder: 'Search sources...',
    ariaLabel: 'Search sources',
    emptyName: 'sources',
    searchableThreshold: SEARCHABLE_THRESHOLD,
    alwaysSearchable: true,
  },
  endpoint: {
    filterKey: 'endpoint',
    select: els.endpointFilter,
    wrapperClass: 'endpoint-select',
    allLabel: 'All endpoints',
    placeholder: 'Search endpoints...',
    ariaLabel: 'Search endpoints',
    emptyName: 'endpoints',
    searchableThreshold: SEARCHABLE_THRESHOLD,
    alwaysSearchable: true,
  },
  media: {
    filterKey: 'media',
    select: els.mediaFilter,
    wrapperClass: 'media-select',
    allLabel: 'All media',
    placeholder: 'Search media...',
    ariaLabel: 'Search media',
    emptyName: 'media options',
    searchableThreshold: Number.POSITIVE_INFINITY,
  },
  transcription: {
    filterKey: 'transcription',
    select: els.transcriptionFilter,
    wrapperClass: 'transcription-select',
    allLabel: 'All transcription',
    placeholder: 'Search transcription...',
    ariaLabel: 'Search transcription',
    emptyName: 'transcription states',
    searchableThreshold: Number.POSITIVE_INFINITY,
  },
  author: {
    filterKey: 'author',
    select: els.authorFilter,
    wrapperClass: 'author-select',
    allLabel: 'All authors',
    placeholder: 'Search authors...',
    ariaLabel: 'Search authors',
    emptyName: 'authors',
    searchableThreshold: SEARCHABLE_THRESHOLD,
    minWidth: 300,
    ignoreAt: true,
    alwaysSearchable: true,
  },
};

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => resolve(resp));
  });
}

function getLocalSettings() {
  if (settingsStorage) {
    return new Promise((resolve) => {
      settingsStorage.get(['dashboardSettings', 'captureEnabled', 'debugLogging', 'verboseLogging'], resolve);
    });
  }
  try {
    return Promise.resolve({ dashboardSettings: JSON.parse(localStorage.getItem('dashboardSettings') || '{}') });
  } catch {
    return Promise.resolve({ dashboardSettings: {} });
  }
}

function setLocalSettings(value) {
  if (settingsStorage) {
    return new Promise((resolve) => settingsStorage.set(value, resolve));
  }
  localStorage.setItem('dashboardSettings', JSON.stringify(value.dashboardSettings || state.settings));
  return Promise.resolve();
}

async function loadSettings() {
  const stored = await getLocalSettings();
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...(stored.dashboardSettings || {}),
  };
  if (typeof stored.captureEnabled === 'boolean') state.settings.captureEnabled = stored.captureEnabled;
  if (typeof stored.debugLogging === 'boolean') state.settings.debugLogging = stored.debugLogging;
  if (typeof stored.verboseLogging === 'boolean') {
    state.settings.discoveryMode = stored.verboseLogging;
    state.settings.verboseEndpointLogging = stored.verboseLogging;
  }
  applySettingsToUi();
}

async function saveSettings(partial, toastMessage) {
  state.settings = { ...state.settings, ...partial };
  await setLocalSettings({ dashboardSettings: state.settings });
  applySettingsToUi();
  if (toastMessage) showToast(toastMessage);
}

function applySettingsToUi() {
  document.body.classList.toggle('density-compact', state.settings.density === 'compact');
  document.body.classList.toggle('density-comfortable', state.settings.density !== 'compact');
  els.densityComfortable.classList.toggle('active', state.settings.density !== 'compact');
  els.densityCompact.classList.toggle('active', state.settings.density === 'compact');
  els.defaultTab.value = state.settings.defaultTab || 'tweets';
  els.timestampFormat.value = state.settings.timestampFormat || 'relative_exact';
  els.themeSelect.value = state.settings.theme || 'charcoal';
  els.tweetsAutoRefresh.checked = !!state.settings.autoRefresh;
  els.eventsAutoRefresh.checked = !!state.settings.autoRefresh;
  els.settingsAutoRefresh.checked = !!state.settings.autoRefresh;
  els.tweetsAutoScroll.checked = !!state.settings.autoScrollLiveEvents;
  els.autoScroll.checked = !!state.settings.autoScrollLiveEvents;
  els.settingsAutoScroll.checked = !!state.settings.autoScrollLiveEvents;
}

async function refreshHealth() {
  const resp = await sendMessage({ type: 'GET_STATUS' });
  if (!resp) return;
  state.health = resp;
  renderHealth();
}

async function refreshStoredTweets(options = {}) {
  if (state.storedTweetsRefreshInFlight) return;
  state.storedTweetsRefreshInFlight = true;
  if (!options.incremental) updateRefreshState('Refreshing...');
  try {
    if (options.incremental) {
      const resp = await sendMessage({
        type: 'GET_STORED_TWEETS',
        limit: STORED_TWEET_RECENT_PAGE_SIZE,
        offset: 0,
        includeRaw: true,
      });
      if (!resp?.ok) {
        updateRefreshState('Update failed');
        return;
      }
      const existingTweets = state.pendingVisualRefresh.storedTweets || state.storedTweets;
      const tweets = mergeStoredTweets((resp.tweets || []).map(normalizeStoredTweet), existingTweets);
      if (options.deferable && shouldDeferVisualRefresh()) {
        state.pendingVisualRefresh.storedTweets = tweets;
        updateRefreshState('Auto-refresh paused while editing');
        return;
      }
      applyStoredTweets(tweets, options);
      return;
    }

    const tweets = [];
    const seenPageIds = new Set();
    let offset = 0;
    let resp = null;
    do {
      resp = await sendMessage({
        type: 'GET_STORED_TWEETS',
        limit: STORED_TWEET_PAGE_SIZE,
        offset,
        includeRaw: true,
      });
      if (!resp?.ok) break;
      const page = resp.tweets || [];
      const normalizedPage = page.map(normalizeStoredTweet);
      const newPageRows = normalizedPage.filter((tweet) => {
        if (!tweet.id || seenPageIds.has(tweet.id)) return false;
        seenPageIds.add(tweet.id);
        return true;
      });
      tweets.push(...newPageRows);
      offset += page.length;
      if (page.length > 0) {
        updateRefreshState(`Loaded ${tweets.length.toLocaleString()} tweets...`);
        if (!shouldDeferVisualRefresh()) {
          state.storedTweets = tweets;
          renderAllTweets({ autoScroll: !!options.autoScroll && offset === page.length });
        }
      }
      if (newPageRows.length === 0 && page.length > 0) break;
    } while ((resp.tweets || []).length > 0 && offset <= STORED_TWEET_MAX_OFFSET);

    if (!resp?.ok) {
      state.storedTweets = [];
      renderTweetMessage(resp?.error || 'Stored tweets are unavailable.');
      renderMetrics();
      updateRefreshState('Update failed');
      return;
    }
    if (options.deferable && shouldDeferVisualRefresh()) {
      state.pendingVisualRefresh.storedTweets = tweets;
      updateRefreshState('Auto-refresh paused while editing');
      return;
    }
    applyStoredTweets(tweets, options);
  } finally {
    state.storedTweetsRefreshInFlight = false;
  }
}

function mergeStoredTweets(incoming, existing) {
  const byId = new Map();
  for (const tweet of incoming) {
    if (tweet.id) byId.set(tweet.id, tweet);
  }
  for (const tweet of existing) {
    if (tweet.id && !byId.has(tweet.id)) byId.set(tweet.id, tweet);
  }
  return [...byId.values()];
}

function refreshEvents(options = {}) {
  traceStorage.get(['lastEvents'], (result) => {
    const events = normalizeEvents(result.lastEvents || []);
    if (options.deferable && shouldDeferVisualRefresh()) {
      state.pendingVisualRefresh.events = events;
      updateRefreshState('Auto-refresh paused while editing');
      return;
    }
    applyEvents(events, options);
  });
}

function applyStoredTweets(tweets, options = {}) {
  state.storedTweets = tweets;
  renderAllTweets({ autoScroll: !!options.autoScroll });
  markUpdated();
}

function applyEvents(events, options = {}) {
  state.events = events;
  renderAllTweets({ autoScroll: !!options.autoScroll });
  renderEvents({ autoScroll: !!options.autoScroll });
  renderDiagnostics();
  markUpdated();
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

function renderAllTweets(options = {}) {
  const rows = buildTweetRows();
  populateTweetFilterOptions(rows);
  renderMetrics(rows);
  const filteredRows = filterTweetRows(rows);
  renderTweetTable(filteredRows, options);
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

  setTextIfChanged(els.metricCaptured, String(stored));
  setTextIfChanged(els.metricAccepted, String(acceptedEvents || stored));
  setTextIfChanged(els.metricDeduped, String(deduped));
  setTextIfChanged(els.metricErrors, String(errors));
  setTextIfChanged(els.metricMedia, String(withMedia));
  setTextIfChanged(els.metricSources, String(sources.length));
  setTextIfChanged(els.metricSourceList, sources.slice(0, 2).join(', ') || 'active');
  setTextIfChanged(els.tweetsSummary, `${stored} captured · ${acceptedEvents || stored} accepted · ${deduped} deduplicated · ${errors} parser errors · ${withMedia} with media`);
}

function populateTweetFilterOptions(rows) {
  replaceOptions(els.statusFilter, 'All statuses', unique(rows.map(row => row.status)));
  replaceOptions(els.sourceFilter, 'All sources', countedOptions(rows, 'source'));
  replaceOptions(els.endpointFilter, 'All endpoints', countedOptions(rows, 'endpoint'));
  replaceOptions(els.authorFilter, 'All authors', authorOptions(rows));
  els.statusFilter.value = optionValueOrAll(els.statusFilter, state.filters.status);
  els.sourceFilter.value = optionValueOrAll(els.sourceFilter, state.filters.source);
  els.endpointFilter.value = optionValueOrAll(els.endpointFilter, state.filters.endpoint);
  els.authorFilter.value = optionValueOrAll(els.authorFilter, state.filters.author);
  syncAllSearchableDropdowns();
}

function syncDropdownSelect(select) {
  const dropdown = searchableDropdowns.get(select);
  if (!dropdown) return;
  dropdown.options = [...select.options].map((option, index) => ({
    id: `${dropdown.id}-filter-option-${index}`,
    value: option.value,
    label: option.textContent || option.value,
    secondary: option.dataset.secondary || '',
    searchText: option.dataset.searchText || '',
    selected: option.value === select.value,
    all: option.value === 'all',
  }));
  dropdown.button.textContent = selectedOptionLabel(select, select.value);
  if (dropdown.menu) {
    dropdown.pendingSync = true;
    return;
  }
  dropdown.pendingSync = false;
}

function syncAllSearchableDropdowns() {
  for (const select of searchableDropdowns.keys()) syncDropdownSelect(select);
}

function replaceOptions(select, allLabel, values) {
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = allLabel;
  select.appendChild(all);
  for (const item of values) {
    const normalized = normalizeOptionItem(item);
    const option = document.createElement('option');
    option.value = normalized.value;
    option.textContent = normalized.label;
    if (normalized.secondary) option.dataset.secondary = normalized.secondary;
    if (normalized.searchText) option.dataset.searchText = normalized.searchText;
    select.appendChild(option);
  }
  select.value = optionValueOrAll(select, current);
  syncDropdownSelect(select);
}

function optionValueOrAll(select, value) {
  return [...select.options].some(option => option.value === value) ? value : 'all';
}

function normalizeFilterValue(value) {
  return String(value || '').replace(/^@/, '');
}

function normalizeOptionItem(item) {
  if (typeof item === 'object' && item !== null) {
    return {
      value: normalizeFilterValue(item.value ?? item.label),
      label: String(item.label ?? item.value ?? ''),
      secondary: item.secondary ? String(item.secondary) : '',
      searchText: item.searchText ? String(item.searchText) : '',
    };
  }
  return {
    value: normalizeFilterValue(item),
    label: String(item ?? ''),
    secondary: '',
    searchText: '',
  };
}

function countedOptions(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([value, count]) => ({
      value,
      label: value,
      secondary: `${count} ${count === 1 ? 'tweet' : 'tweets'}`,
      searchText: value,
    }));
}

function authorOptions(rows) {
  const authors = new Map();
  for (const row of rows) {
    if (!row.authorHandle) continue;
    const existing = authors.get(row.authorHandle) || { name: '', count: 0 };
    authors.set(row.authorHandle, {
      name: existing.name || row.authorName || '',
      count: existing.count + 1,
    });
  }
  return [...authors.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([handle, meta]) => ({
      value: handle,
      label: `@${handle}`,
      secondary: meta.name || `${meta.count} ${meta.count === 1 ? 'tweet' : 'tweets'}`,
      searchText: `@${handle} ${handle} ${meta.name}`,
    }));
}

function initSearchableDropdowns() {
  for (const [id, config] of Object.entries(dropdownConfigs)) {
    const select = config.select;
    if (!select || searchableDropdowns.has(select)) continue;
    const wrapper = document.createElement('div');
    wrapper.className = `searchable-select ${config.wrapperClass || ''}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'searchable-trigger';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${id}-filter-listbox`);
    button.textContent = selectedOptionLabel(select, select.value);
    select.classList.add('enhanced-native-select');
    select.after(wrapper);
    wrapper.appendChild(button);

    const dropdown = {
      id,
      config,
      select,
      wrapper,
      button,
      menu: null,
      input: null,
      listbox: null,
      options: [],
      visibleOptions: [],
      search: '',
      highlightedIndex: 0,
      pendingSync: false,
    };
    searchableDropdowns.set(select, dropdown);

    button.addEventListener('click', () => toggleSearchableDropdown(dropdown));
    button.addEventListener('keydown', (event) => handleTriggerKeydown(event, dropdown));
    select.addEventListener('change', () => syncDropdownSelect(select));
    syncDropdownSelect(select);
  }
}

function toggleSearchableDropdown(dropdown) {
  if (dropdown.menu) closeSearchableDropdown(dropdown, { applyPending: true });
  else openSearchableDropdown(dropdown);
}

function openSearchableDropdown(dropdown) {
  closeOpenSearchableDropdown();
  syncDropdownSelect(dropdown.select);
  state.activeDropdownId = dropdown.id;
  markUserInteracting(60000);
  dropdown.search = '';
  dropdown.highlightedIndex = selectedOptionIndex(dropdown);

  const menu = document.createElement('div');
  menu.className = 'searchable-menu';
  menu.id = `${dropdown.id}-filter-menu`;
  const shouldSearch = shouldShowDropdownSearch(dropdown);
  if (shouldSearch) {
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = dropdown.config.placeholder;
    input.setAttribute('aria-label', dropdown.config.ariaLabel);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', `${dropdown.id}-filter-listbox`);
    input.setAttribute('aria-expanded', 'true');
    input.spellcheck = false;
    input.addEventListener('input', () => {
      dropdown.search = input.value;
      markUserInteracting(60000);
      renderSearchableOptions(dropdown, { preferSelected: true });
    });
    input.addEventListener('keydown', (event) => handleSearchKeydown(event, dropdown));
    menu.appendChild(input);
    dropdown.input = input;
  } else {
    dropdown.input = null;
    menu.addEventListener('keydown', (event) => handleSearchKeydown(event, dropdown));
  }

  const listbox = document.createElement('div');
  listbox.className = 'searchable-options';
  listbox.id = `${dropdown.id}-filter-listbox`;
  listbox.setAttribute('role', 'listbox');
  listbox.addEventListener('scroll', () => {
    if (dropdown.visibleOptions.length > VIRTUALIZE_DROPDOWN_THRESHOLD) renderSearchableOptions(dropdown, { fromScroll: true });
  });
  menu.appendChild(listbox);
  dropdown.menu = menu;
  dropdown.listbox = listbox;
  dropdown.button.setAttribute('aria-expanded', 'true');
  els.dropdownLayer.appendChild(menu);
  renderSearchableOptions(dropdown, { preferSelected: true });
  positionSearchableDropdown(dropdown);
  window.addEventListener('resize', positionOpenSearchableDropdown, true);
  window.addEventListener('scroll', positionOpenSearchableDropdown, true);
  if (dropdown.input) {
    dropdown.input.focus();
  } else {
    menu.tabIndex = -1;
    menu.focus();
  }
}

function closeSearchableDropdown(dropdown, options = {}) {
  if (!dropdown?.menu) return;
  dropdown.menu.remove();
  dropdown.menu = null;
  dropdown.input = null;
  dropdown.listbox = null;
  dropdown.visibleOptions = [];
  dropdown.search = '';
  dropdown.button.setAttribute('aria-expanded', 'false');
  if (state.activeDropdownId === dropdown.id) state.activeDropdownId = null;
  if (!state.activeDropdownId) state.interactingUntil = 0;
  window.removeEventListener('resize', positionOpenSearchableDropdown, true);
  window.removeEventListener('scroll', positionOpenSearchableDropdown, true);
  if (options.applyPending && dropdown.pendingSync) {
    dropdown.pendingSync = false;
    syncDropdownSelect(dropdown.select);
  }
  setTimeout(applyPendingVisualRefresh, 0);
}

function closeOpenSearchableDropdown() {
  for (const dropdown of searchableDropdowns.values()) {
    if (dropdown.menu) {
      closeSearchableDropdown(dropdown, { applyPending: true });
      return;
    }
  }
}

function positionOpenSearchableDropdown() {
  const dropdown = [...searchableDropdowns.values()].find(item => item.menu);
  if (dropdown) positionSearchableDropdown(dropdown);
}

function positionSearchableDropdown(dropdown) {
  if (!dropdown.menu) return;
  const rect = dropdown.button.getBoundingClientRect();
  const viewportPadding = 8;
  const width = Math.min(
    Math.max(rect.width, dropdown.config.minWidth || 0),
    window.innerWidth - viewportPadding * 2,
  );
  const left = Math.min(
    Math.max(viewportPadding, rect.left),
    window.innerWidth - width - viewportPadding,
  );
  dropdown.menu.style.width = `${width}px`;
  dropdown.menu.style.left = `${left}px`;
  dropdown.menu.style.top = '0px';
  const menuHeight = Math.min(dropdown.menu.offsetHeight || 320, 320);
  const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
  const spaceAbove = rect.top - viewportPadding;
  const openUp = spaceBelow < menuHeight && spaceAbove > spaceBelow;
  const top = openUp
    ? Math.max(viewportPadding, rect.top - menuHeight - 4)
    : Math.min(rect.bottom + 4, window.innerHeight - menuHeight - viewportPadding);
  dropdown.menu.style.top = `${top}px`;
}

function renderSearchableOptions(dropdown, options = {}) {
  const query = normalizeDropdownSearch(dropdown.search, dropdown.config);
  const allOption = dropdown.options.find(option => option.all);
  const matchedOptions = dropdown.options.filter(option => !option.all && optionMatchesSearch(option, query, dropdown.config));
  dropdown.visibleOptions = allOption ? [allOption, ...matchedOptions] : matchedOptions;
  const selectedIndex = dropdown.visibleOptions.findIndex(option => option.value === dropdown.select.value);
  if (options.preferSelected) {
    dropdown.highlightedIndex = selectedIndex >= 0 ? selectedIndex : 0;
  } else if (dropdown.highlightedIndex >= dropdown.visibleOptions.length) {
    dropdown.highlightedIndex = Math.max(0, dropdown.visibleOptions.length - 1);
  }

  dropdown.listbox.innerHTML = '';
  const virtualized = dropdown.visibleOptions.length > VIRTUALIZE_DROPDOWN_THRESHOLD;
  dropdown.listbox.classList.toggle('virtualized', virtualized);
  const optionsToRender = virtualized ? virtualizedOptionWindow(dropdown, options) : dropdown.visibleOptions.map((option, index) => [option, index]);
  let spacer = null;
  if (virtualized) {
    spacer = document.createElement('div');
    spacer.className = 'searchable-options-spacer';
    spacer.style.height = `${dropdown.visibleOptions.length * DROPDOWN_OPTION_HEIGHT}px`;
    dropdown.listbox.appendChild(spacer);
  }
  for (const [option, index] of optionsToRender) {
    const button = renderSearchableOption(dropdown, option, index);
    if (virtualized) button.style.transform = `translateY(${index * DROPDOWN_OPTION_HEIGHT}px)`;
    dropdown.listbox.appendChild(button);
  }

  if (query && matchedOptions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'searchable-empty';
    empty.textContent = `No ${dropdown.config.emptyName} found for "${dropdown.search}"`;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'small-btn';
    clear.textContent = 'Clear search';
    clear.addEventListener('click', () => {
      dropdown.search = '';
      if (dropdown.input) {
        dropdown.input.value = '';
        dropdown.input.focus();
      }
      renderSearchableOptions(dropdown, { preferSelected: true });
    });
    empty.appendChild(clear);
    dropdown.listbox.appendChild(empty);
  }

  updateActiveDescendant(dropdown);
  if (!options.fromScroll) scrollHighlightedOptionIntoView(dropdown);
}

function virtualizedOptionWindow(dropdown, options = {}) {
  if (!options.fromScroll) keepVirtualizedHighlightVisible(dropdown);
  const visibleCount = Math.ceil((dropdown.listbox.clientHeight || 282) / DROPDOWN_OPTION_HEIGHT) + 6;
  const start = Math.max(0, Math.floor(dropdown.listbox.scrollTop / DROPDOWN_OPTION_HEIGHT) - 3);
  const end = Math.min(dropdown.visibleOptions.length, start + visibleCount);
  return dropdown.visibleOptions.slice(start, end).map((option, offset) => [option, start + offset]);
}

function keepVirtualizedHighlightVisible(dropdown) {
  const top = dropdown.highlightedIndex * DROPDOWN_OPTION_HEIGHT;
  const bottom = top + DROPDOWN_OPTION_HEIGHT;
  const viewTop = dropdown.listbox.scrollTop;
  const viewBottom = viewTop + (dropdown.listbox.clientHeight || 282);
  if (top < viewTop) dropdown.listbox.scrollTop = top;
  else if (bottom > viewBottom) dropdown.listbox.scrollTop = Math.max(0, bottom - (dropdown.listbox.clientHeight || 282));
}

function renderSearchableOption(dropdown, option, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `searchable-option${option.secondary ? ' has-secondary' : ''}${index === dropdown.highlightedIndex ? ' highlighted' : ''}`;
  button.id = option.id;
  button.setAttribute('role', 'option');
  button.setAttribute('aria-selected', option.value === dropdown.select.value ? 'true' : 'false');
  button.addEventListener('click', () => selectSearchableOption(dropdown, option));

  const check = document.createElement('span');
  check.className = 'option-check';
  check.textContent = option.value === dropdown.select.value ? '✓' : '';
  const body = document.createElement('span');
  const label = document.createElement('span');
  label.className = 'option-label';
  label.textContent = option.label;
  body.appendChild(label);
  if (option.secondary) {
    const secondary = document.createElement('span');
    secondary.className = 'option-secondary';
    secondary.textContent = option.secondary;
    body.appendChild(secondary);
  }
  button.append(check, body);
  return button;
}

function selectedOptionIndex(dropdown) {
  const index = dropdown.options.findIndex(option => option.value === dropdown.select.value);
  return index >= 0 ? index : 0;
}

function shouldShowDropdownSearch(dropdown) {
  return dropdown.config.alwaysSearchable || dropdown.options.length > dropdown.config.searchableThreshold;
}

function optionMatchesSearch(option, query, config) {
  if (!query) return true;
  const haystack = normalizeDropdownSearch(
    [option.label, option.secondary, option.value, option.searchText].filter(Boolean).join(' '),
    config,
  );
  return haystack.includes(query);
}

function normalizeDropdownSearch(value, config = {}) {
  const normalized = String(value || '').toLowerCase();
  return config.ignoreAt ? normalized.replaceAll('@', '') : normalized;
}

function handleTriggerKeydown(event, dropdown) {
  if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    openSearchableDropdown(dropdown);
  }
}

function handleSearchKeydown(event, dropdown) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveDropdownHighlight(dropdown, 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveDropdownHighlight(dropdown, -1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    setDropdownHighlight(dropdown, 0);
  } else if (event.key === 'End') {
    event.preventDefault();
    setDropdownHighlight(dropdown, dropdown.visibleOptions.length - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const option = dropdown.visibleOptions[dropdown.highlightedIndex];
    if (option) selectSearchableOption(dropdown, option);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSearchableDropdown(dropdown, { applyPending: true });
    dropdown.button.focus();
  } else if (event.key === 'Tab') {
    closeSearchableDropdown(dropdown, { applyPending: true });
  }
}

function moveDropdownHighlight(dropdown, delta) {
  if (!dropdown.visibleOptions.length) return;
  const next = (dropdown.highlightedIndex + delta + dropdown.visibleOptions.length) % dropdown.visibleOptions.length;
  setDropdownHighlight(dropdown, next);
}

function setDropdownHighlight(dropdown, index) {
  if (!dropdown.visibleOptions.length) return;
  dropdown.highlightedIndex = Math.max(0, Math.min(index, dropdown.visibleOptions.length - 1));
  renderSearchableOptions(dropdown);
}

function updateActiveDescendant(dropdown) {
  const option = dropdown.visibleOptions[dropdown.highlightedIndex];
  const activeId = option?.id || '';
  if (dropdown.input) dropdown.input.setAttribute('aria-activedescendant', activeId);
}

function scrollHighlightedOptionIntoView(dropdown) {
  const option = dropdown.visibleOptions[dropdown.highlightedIndex];
  if (!option) return;
  dropdown.listbox.querySelector(`#${CSS.escape(option.id)}`)?.scrollIntoView({ block: 'nearest' });
}

function selectSearchableOption(dropdown, option) {
  dropdown.select.value = option.value;
  dropdown.select.dispatchEvent(new Event('change', { bubbles: true }));
  closeSearchableDropdown(dropdown, { applyPending: true });
  dropdown.button.focus();
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
    if (!matchesTranscriptionFilter(row)) return false;
    if (!matchesTimeFilter(row, now)) return false;
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

function matchesTranscriptionFilter(row) {
  const media = transcriptableMediaItems(row);
  if (state.filters.transcription === 'all') return true;
  if (state.filters.transcription === 'has_text') {
    return media.some(item => String(item.transcript_text || '').trim().length > 0);
  }
  return media.some(item => transcriptStatus(item) === state.filters.transcription);
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

function renderTweetTable(rows, options = {}) {
  if (rows.length === 0) {
    renderTweetMessage(state.storedTweets.length === 0 && state.events.length === 0
      ? 'No tweets captured yet.'
      : 'No tweets match the active filters.');
    return;
  }

  const scrollTop = els.tweetsWrap.scrollTop;
  els.tweetsBody.querySelectorAll('tr:not([data-row-id])').forEach(tr => tr.remove());
  const existingRows = new Map([...els.tweetsBody.querySelectorAll('tr[data-row-id]')]
    .map(tr => [tr.dataset.rowId, tr]));
  const visibleIds = new Set();

  for (const row of rows) {
    visibleIds.add(row.rowId);
    const signature = tweetRowSignature(row);
    const existing = existingRows.get(row.rowId);
    const tr = existing?.dataset.signature === signature ? existing : createTweetRow(row, rows, signature);
    if (existing && existing !== tr) existing.replaceWith(tr);
    els.tweetsBody.appendChild(tr);
  }

  for (const [rowId, tr] of existingRows) {
    if (!visibleIds.has(rowId)) tr.remove();
  }

  if (options.autoScroll && els.tweetsAutoScroll.checked) els.tweetsWrap.scrollTop = 0;
  else els.tweetsWrap.scrollTop = scrollTop;
}

function createTweetRow(row, rows, signature) {
  const tr = document.createElement('tr');
  tr.dataset.rowId = row.rowId;
  tr.dataset.signature = signature;
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
  return tr;
}

function tweetRowSignature(row) {
  return JSON.stringify({
    id: row.id,
    text: row.text,
    author: authorLabel(row),
    source: row.source,
    endpoint: row.endpoint,
    capturedAt: row.capturedAt,
    status: row.status,
    media: summarizeMedia(row),
    selected: state.selectedIds.has(row.rowId),
    active: row.id === state.activeTweetId || row.rowId === state.activeTweetId,
    reviewed: state.reviewedIds.has(row.rowId),
    search: state.filters.search,
    timestampFormat: state.settings.timestampFormat,
  });
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
  if (state.settings.timestampFormat !== 'exact') {
    const relative = document.createElement('div');
    relative.textContent = formatRelative(row.capturedAt);
    td.appendChild(relative);
  }
  if (state.settings.timestampFormat !== 'relative') {
    const exact = document.createElement('div');
    exact.className = 'capture-exact';
    exact.textContent = formatExactTime(row.capturedAt);
    td.appendChild(exact);
  }
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
  const transcribable = nextTranscribableMediaItem(row);
  if (transcribable) {
    wrap.appendChild(actionButton('Transcribe', () => transcribeMedia(row, transcribable)));
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
    ${drawerTranscriptionHtml(row)}
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

function drawerTranscriptionHtml(row) {
  const media = transcriptableMediaItems(row);
  if (!media.length) return '';
  return `
    <section class="drawer-section">
      <h3>Transcription</h3>
      <div class="transcription-list">
        ${media.map(drawerTranscriptionItemHtml).join('')}
      </div>
    </section>
  `;
}

function drawerTranscriptionItemHtml(item) {
  const transcript = String(item.transcript_text || '').trim();
  const status = transcriptStatus(item);
  const type = item.media_type || item.type || 'media';
  return `
    <article class="transcription-card">
      <dl class="detail-list">
        <dt>Media ID</dt><dd>${escapeHtml(item.media_id || item.id || '—')}</dd>
        <dt>Type</dt><dd>${escapeHtml(type)}</dd>
        <dt>Status</dt><dd>${escapeHtml(transcriptStatusLabel(status))}</dd>
        <dt>Model</dt><dd>${escapeHtml(item.transcript_model || '—')}</dd>
        <dt>Transcribed</dt><dd>${escapeHtml(formatFullDate(item.transcribed_at))}</dd>
        <dt>Message</dt><dd>${escapeHtml(item.transcript_error || '—')}</dd>
      </dl>
      ${transcript ? `<pre class="transcript-text">${escapeHtml(transcript)}</pre>` : '<p class="empty-note">No transcript text stored.</p>'}
    </article>
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

function renderEvents(options = {}) {
  populateEventFilters();
  const filtered = filterEvents();
  const accepted = state.events.filter(ev => ev.status === 'ACCEPTED').length;
  const deduped = state.events.filter(ev => ev.status === 'DEDUPLICATED').length;
  const errors = state.events.filter(ev => ev.status === 'PARSER_ERROR').length;
  els.eventsSummary.textContent = `${state.events.length} events · ${accepted} accepted · ${deduped} deduplicated · ${errors} errors`;
  if (!filtered.length) {
    els.eventsBody.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty-state';
    td.innerHTML = '<strong>No live events.</strong><span class="empty-hint">Capture activity will appear here as the service worker records events.</span>';
    tr.appendChild(td);
    els.eventsBody.appendChild(tr);
    return;
  }
  const scrollTop = els.eventsWrap.scrollTop;
  els.eventsBody.querySelectorAll('tr:not([data-row-id])').forEach(tr => tr.remove());
  const existingRows = new Map([...els.eventsBody.querySelectorAll('tr[data-row-id]')]
    .map(tr => [tr.dataset.rowId, tr]));
  const visibleIds = new Set();
  for (const event of filtered) {
    visibleIds.add(event.rowId);
    const signature = eventRowSignature(event);
    const existing = existingRows.get(event.rowId);
    const tr = existing?.dataset.signature === signature ? existing : createEventRow(event, signature);
    if (existing && existing !== tr) existing.replaceWith(tr);
    els.eventsBody.appendChild(tr);
  }
  for (const [rowId, tr] of existingRows) {
    if (!visibleIds.has(rowId)) tr.remove();
  }
  if (options.autoScroll && els.autoScroll.checked) els.eventsWrap.scrollTop = els.eventsWrap.scrollHeight;
  else els.eventsWrap.scrollTop = scrollTop;
}

function createEventRow(event, signature) {
  const tr = document.createElement('tr');
  tr.dataset.rowId = event.rowId;
  tr.dataset.signature = signature;
  tr.append(
    textCell(formatTime(event.timestamp)),
    textCell(event.endpoint),
    textCell(eventType(event)),
    textCell(event.tweetLabel || event.tweetId || '—'),
    statusCell(event.status),
    textCell(event.reason || '—'),
    eventActionsCell(event),
  );
  return tr;
}

function eventRowSignature(event) {
  return JSON.stringify({
    timestamp: event.timestamp,
    endpoint: event.endpoint,
    type: eventType(event),
    label: event.tweetLabel || event.tweetId || '—',
    status: event.status,
    reason: event.reason || '—',
  });
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
  state.settings.captureEnabled = !!health.captureEnabled;
  state.settings.debugLogging = !!health.debugLogging;
  state.settings.discoveryMode = !!health.verboseLogging;
  state.settings.verboseEndpointLogging = !!health.verboseLogging;
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
  const add = (key, label, value) => {
    if (value && value !== 'all') chips.push({ key, label: `${label}: ${value}` });
  };
  add('status', 'Status', state.filters.status);
  add('source', 'Source', state.filters.source);
  add('endpoint', 'Endpoint', state.filters.endpoint);
  add('media', 'Media', selectedOptionLabel(els.mediaFilter, state.filters.media));
  add('transcription', 'Transcription', selectedOptionLabel(els.transcriptionFilter, state.filters.transcription));
  add('author', 'Author', state.filters.author && state.filters.author !== 'all' ? `@${state.filters.author}` : 'all');
  add('time', 'Time', selectedOptionLabel(els.timeFilter, state.filters.time));
  add('sort', 'Sort', selectedOptionLabel(els.sortFilter, state.filters.sort === 'newest' ? 'all' : state.filters.sort));
  if (state.filters.search) chips.push({ key: 'search', label: `Search: ${state.filters.search}` });
  for (const [key, label] of [
    ['hasQuoted', 'Has quoted tweet'],
    ['hasReply', 'Has reply'],
    ['duplicateOnly', 'Duplicates only'],
    ['parserErrorOnly', 'Parser errors only'],
    ['newOnly', 'New tweets only'],
  ]) {
    if (state.filters[key]) chips.push({ key, label });
  }
  els.activeFilters.innerHTML = chips.map(chip => `
    <span class="filter-chip">
      ${escapeHtml(chip.label)}
      <button class="filter-chip-remove" type="button" data-filter-key="${escapeAttr(chip.key)}" aria-label="Remove ${escapeAttr(chip.label)} filter">&times;</button>
    </span>
  `).join('');
}

function selectedOptionLabel(select, value) {
  if (!value || value === 'all') return 'all';
  return [...select.options].find(option => option.value === value)?.textContent || value;
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
}

function tabFromHash() {
  const raw = location.hash.replace(/^#/, '');
  const tab = raw.startsWith('tab-') ? raw.slice('tab-'.length) : raw;
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
  initSearchableDropdowns();
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
  els.transcriptionFilter.addEventListener('change', () => updateFilter('transcription', els.transcriptionFilter.value));
  els.authorFilter.addEventListener('change', () => updateFilter('author', normalizeFilterValue(els.authorFilter.value)));
  els.timeFilter.addEventListener('change', () => updateFilter('time', els.timeFilter.value));
  els.sortFilter.addEventListener('change', () => updateFilter('sort', els.sortFilter.value));
  for (const [id, key] of [
    ['filter-quoted', 'hasQuoted'],
    ['filter-reply', 'hasReply'],
    ['filter-duplicate', 'duplicateOnly'],
    ['filter-parser-error', 'parserErrorOnly'],
    ['filter-new', 'newOnly'],
  ]) {
    $(id).addEventListener('change', (event) => updateFilter(key, event.target.checked));
  }
  els.clearFilters.addEventListener('click', clearFilters);
  els.activeFilters.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.filter-chip-remove');
    if (!button) return;
    resetFilter(button.dataset.filterKey);
  });
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
      await saveSettings({ captureEnabled: els.captureEnabledToggle.checked }, els.captureEnabledToggle.checked ? 'Capture enabled' : 'Capture paused');
      refreshHealth();
    }
  });
  const setAutoRefresh = (checked) => saveSettings({ autoRefresh: checked }, checked ? 'Auto-refresh enabled' : 'Auto-refresh disabled');
  els.tweetsAutoRefresh.addEventListener('change', () => setAutoRefresh(els.tweetsAutoRefresh.checked));
  els.eventsAutoRefresh.addEventListener('change', () => setAutoRefresh(els.eventsAutoRefresh.checked));
  els.settingsAutoRefresh.addEventListener('change', () => setAutoRefresh(els.settingsAutoRefresh.checked));
  const setAutoScroll = (checked) => saveSettings({ autoScrollLiveEvents: checked }, checked ? 'Auto-scroll enabled' : 'Auto-scroll disabled');
  els.tweetsAutoScroll.addEventListener('change', () => setAutoScroll(els.tweetsAutoScroll.checked));
  els.autoScroll.addEventListener('change', () => setAutoScroll(els.autoScroll.checked));
  els.settingsAutoScroll.addEventListener('change', () => setAutoScroll(els.settingsAutoScroll.checked));
  els.densityComfortable.addEventListener('click', () => setDensity('comfortable'));
  els.densityCompact.addEventListener('click', () => setDensity('compact'));
  els.defaultTab.addEventListener('change', () => saveSettings({ defaultTab: els.defaultTab.value }, 'Default tab saved'));
  els.timestampFormat.addEventListener('change', () => {
    saveSettings({ timestampFormat: els.timestampFormat.value }, 'Timestamp format saved');
    renderAllTweets();
  });
  els.themeSelect.addEventListener('change', () => saveSettings({ theme: els.themeSelect.value }, 'Theme saved'));
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
    if (event.key === 'Escape' && state.activeDropdownId) closeOpenSearchableDropdown();
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
  document.addEventListener('focusin', (event) => {
    if (event.target?.matches?.('input, select, textarea')) markUserInteracting(2000);
  });
  document.addEventListener('focusout', () => {
    setTimeout(applyPendingVisualRefresh, 150);
  });
  document.addEventListener('input', (event) => {
    if (event.target?.matches?.('input, select, textarea')) markUserInteracting(2000);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target?.closest?.('.searchable-select, .searchable-menu')) closeOpenSearchableDropdown();
    if (event.target?.closest?.('.filter-panel, .settings-grid, .detail-drawer')) markUserInteracting(1500);
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

function resetFilter(key) {
  const defaults = {
    search: '',
    status: 'all',
    source: 'all',
    endpoint: 'all',
    media: 'all',
    transcription: 'all',
    author: 'all',
    time: 'all',
    sort: 'newest',
    hasQuoted: false,
    hasReply: false,
    duplicateOnly: false,
    parserErrorOnly: false,
    newOnly: false,
  };
  if (!(key in defaults)) return;
  state.filters[key] = defaults[key];
  syncFilterInputs();
  renderAllTweets();
}

function clearFilters() {
  Object.assign(state.filters, {
    search: '',
    status: 'all',
    source: 'all',
    endpoint: 'all',
    media: 'all',
    transcription: 'all',
    author: 'all',
    time: 'all',
    sort: 'newest',
    hasQuoted: false,
    hasReply: false,
    duplicateOnly: false,
    parserErrorOnly: false,
    newOnly: false,
  });
  syncFilterInputs();
  renderAllTweets();
}

function syncFilterInputs() {
  els.tweetSearch.value = state.filters.search;
  els.statusFilter.value = state.filters.status;
  els.sourceFilter.value = state.filters.source;
  els.endpointFilter.value = state.filters.endpoint;
  els.authorFilter.value = state.filters.author;
  els.mediaFilter.value = state.filters.media;
  els.transcriptionFilter.value = state.filters.transcription;
  els.timeFilter.value = state.filters.time;
  els.sortFilter.value = state.filters.sort;
  $('filter-quoted').checked = !!state.filters.hasQuoted;
  $('filter-reply').checked = !!state.filters.hasReply;
  $('filter-duplicate').checked = !!state.filters.duplicateOnly;
  $('filter-parser-error').checked = !!state.filters.parserErrorOnly;
  $('filter-new').checked = !!state.filters.newOnly;
  syncAllSearchableDropdowns();
}

async function setDebug(enabled) {
  await sendMessage({ type: 'SET_DEBUG', debugLogging: enabled });
  await saveSettings({ debugLogging: enabled }, enabled ? 'Debug logging enabled' : 'Debug logging disabled');
  refreshHealth();
}

async function setVerbose(enabled) {
  await sendMessage({ type: 'SET_VERBOSE', verboseLogging: enabled });
  await saveSettings({ discoveryMode: enabled, verboseEndpointLogging: enabled }, enabled ? 'Discovery mode enabled' : 'Discovery mode disabled');
  refreshHealth();
}

async function setDensity(density) {
  await saveSettings({ density }, density === 'compact' ? 'Compact density applied' : 'Comfortable density applied');
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
  updateRefreshState('Refreshing...');
  await Promise.all([refreshHealth(), refreshStoredTweets()]);
  refreshEvents();
}

function markUserInteracting(duration = 1200) {
  state.interactingUntil = Date.now() + duration;
  clearTimeout(state.interactionTimer);
  state.interactionTimer = setTimeout(applyPendingVisualRefresh, duration + 50);
}

function shouldDeferVisualRefresh() {
  const active = document.activeElement;
  if (state.activeDropdownId) return true;
  if (active?.matches?.('input, select, textarea')) return true;
  if (Date.now() < state.interactingUntil) return true;
  if (els.drawer.classList.contains('open') && els.drawer.scrollTop > 0) return true;
  return false;
}

function applyPendingVisualRefresh() {
  if (shouldDeferVisualRefresh()) return;
  const pendingTweets = state.pendingVisualRefresh.storedTweets;
  const pendingEvents = state.pendingVisualRefresh.events;
  state.pendingVisualRefresh.storedTweets = null;
  state.pendingVisualRefresh.events = null;
  if (pendingTweets) applyStoredTweets(pendingTweets);
  if (pendingEvents) applyEvents(pendingEvents);
}

function markUpdated() {
  state.lastRefreshAt = Date.now();
  updateRefreshState('just now');
}

function updateRefreshState(label) {
  if (label === 'Refreshing...') {
    els.headerRefreshState.textContent = label;
    return;
  }
  if (label.startsWith('Auto-refresh')) {
    els.headerRefreshState.textContent = label;
    return;
  }
  els.headerRefreshState.textContent = label.startsWith('Last updated') ? label : `Last updated: ${label}`;
}

function mediaItems(row) {
  return Array.isArray(row.media) ? row.media : [];
}

function transcriptableMediaItems(row) {
  return mediaItems(row).filter(item => {
    const type = item.media_type || item.type;
    return type === 'video' || type === 'animated_gif';
  });
}

function nextTranscribableMediaItem(row) {
  return transcriptableMediaItems(row).find(item => !isMediaTranscribed(item) && !isTranscriptionInProgress(item));
}

function isMediaTranscribed(item) {
  return transcriptStatus(item) === 'done' || String(item.transcript_text || '').trim().length > 0;
}

function isTranscriptionInProgress(item) {
  return ['queued', 'transcribing'].includes(transcriptStatus(item));
}

function transcriptStatus(item) {
  return item.transcript_status || (String(item.transcript_text || '').trim() ? 'done' : 'not_requested');
}

function transcriptStatusLabel(status) {
  return String(status || 'not_requested').replaceAll('_', ' ');
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

function setTextIfChanged(el, value) {
  if (el.textContent !== value) el.textContent = value;
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

async function init() {
  await loadSettings();
  bindEvents();
  switchTab(tabFromHash() || state.settings.defaultTab || 'tweets');
  window.addEventListener('hashchange', () => switchTab(tabFromHash() || state.settings.defaultTab || 'tweets'));
  await refreshAll();

  setInterval(refreshHealth, 5000);
  setInterval(() => {
    if (!state.settings.autoRefresh) {
      updateRefreshState('Auto-refresh off');
      return;
    }
    if (document.hidden) {
      updateRefreshState('Auto-refresh paused while hidden');
      return;
    }
    if (state.health && !state.health.captureEnabled) {
      updateRefreshState('Auto-refresh paused while capture is paused');
      return;
    }
    refreshStoredTweets({ deferable: true, incremental: true });
    refreshEvents({ deferable: true });
  }, 5000);

  traceStorage.get(['lastEvents'], (result) => {
    applyEvents(normalizeEvents(result.lastEvents || []));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === traceArea && changes.lastEvents && state.settings.autoRefresh) {
      const events = normalizeEvents(changes.lastEvents.newValue || []);
      if (shouldDeferVisualRefresh()) {
        state.pendingVisualRefresh.events = events;
        updateRefreshState('Auto-refresh paused while editing');
      } else {
        applyEvents(events);
      }
    }
  });
}

init();
