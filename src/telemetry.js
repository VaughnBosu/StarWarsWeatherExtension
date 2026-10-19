/**
 * Telemetry facade over the Moderok SDK.
 *
 * Per-render events were ~85% of volume and kept blowing the monthly quota, so
 * activity is accumulated in localStorage and emitted as `daily_activity` rollups per
 * user per UTC day: one at rollover, plus up to MAX_PARTIAL_FLUSHES throttled ones on
 * page hide so a user who stops opening tabs still reports their last day. Counters
 * are deltas since the previous rollup and sum to the day; the rest is a snapshot.
 *
 * Sampling is by user (hash bucket), never by event, so unique-user counts and
 * in-cohort ratios stay valid and totals scale back up by the sample rate. Buckets
 * nest: every `new_tab` user is also a `daily_activity` user, so the raw stream can be
 * reconciled against the same users' rollups.
 *
 * INGEST CONTRACT: `daily_activity` is at-least-once. Pages share one localStorage
 * record and localStorage has no compare-and-swap, so a rollup can be sent twice.
 * Duplicates carry the same (userId, date, sequence, partial) and ingest MUST dedup on
 * that tuple. Failing this direction is deliberate: a duplicate is droppable, while a
 * destroyed slice leaves nothing behind and the historical request projection reads
 * it as a quiet day. Provider usage is measured by backend metrics.
 */
import { Moderok, utcDateStamp } from './vendor/moderok.js';
import {
  getManualLocation,
  getPreferredLanguage,
  getPreferredUnit,
  getShowExtrasInHyperspace,
  getShowGoogleApps,
  getShowSearchBar,
  getShowShortcuts,
  getVisitedPlanets,
  readTelemetryState,
  writeTelemetryState
} from './storage.js';

/** Share of users that emit the daily rollup. Divide totals by this to scale back up. */
export const DAILY_ACTIVITY_SAMPLE = 0.25;

/**
 * Share of users that also emit raw per-render events, to validate rollup counters
 * against un-aggregated data. Can go to 0 once trusted.
 */
export const NEW_TAB_SAMPLE = 0.01;

const SAMPLE_BUCKETS = 10000;

/**
 * Smallest gap between two rollups for the same day. Pages hide constantly, so without
 * the throttle the hide hook degenerates into a per-render event. It gates on the
 * previous rollup, so a day that has shipped nothing yet flushes on its first hide.
 */
export const PARTIAL_FLUSH_INTERVAL_MS = 15 * 60 * 1000;

/** Hard ceiling on mid-day rollups, so a user who browses all day still costs ~5 events. */
export const MAX_PARTIAL_FLUSHES = 4;

/** Counters a rollup consumes as deltas. Everything else is snapshot or bookkeeping. */
const COUNTER_KEYS = [
  'tabs',
  'cacheHits',
  'weatherCalls',
  'geocodeCalls',
  'errors',
  'offlineFallbacks'
];

/** FNV-1a, 32-bit. Per-user sampling needs a hash stable across sessions and platforms. */
export function hashBucket(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash % SAMPLE_BUCKETS;
}

function isSampled(id, rate) {
  if (!id || rate <= 0) {
    return false;
  }

  return hashBucket(id) < rate * SAMPLE_BUCKETS;
}

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function emptyDay(date) {
  return {
    date,
    tabs: 0,
    cacheHits: 0,
    weatherCalls: 0,
    geocodeCalls: 0,
    errors: 0,
    offlineFallbacks: 0,
    planets: {},
    errorsSeen: [],
    settings: {},
    // zero rather than `now`, so a short final session still flushes on its first hide
    flushedAt: 0,
    // `flushAttempts` caps mid-day volume; `flushes` is the sequence number and only
    // advances once a slice was subtracted. They diverge when a send went unconfirmed.
    flushes: 0,
    flushAttempts: 0
  };
}

/** A day worth reporting: cacheHits and offlineFallbacks are implied by tabs and errors. */
function hasActivity(state) {
  return Boolean(state.tabs || state.weatherCalls || state.geocodeCalls || state.errors);
}

/** Prevalence across the installed base; toggle events only cover users who changed a setting. */
function currentSettings() {
  try {
    return {
      unit: getPreferredUnit(),
      language: getPreferredLanguage(),
      searchBar: getShowSearchBar(),
      shortcuts: getShowShortcuts(),
      googleApps: getShowGoogleApps(),
      extrasInHyperspace: getShowExtrasInHyperspace(),
      manualLocation: Boolean(getManualLocation())
    };
  } catch {
    return {};
  }
}

function topPlanet(planets) {
  const entries = Object.entries(planets || {});
  if (!entries.length) {
    return '';
  }

  return entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

/**
 * Send one rollup. A date can produce several, so counters are deltas that sum to the
 * day, while `topPlanet`, `planetsSeen` and settings describe the user at emission
 * time; take the highest `sequence` per user per date for those. Returns whether the
 * SDK got anything, since the caller must not consume a slice it never sent.
 */
function emitDailyActivity(state, partial) {
  if (!hasActivity(state)) {
    return false;
  }

  if (!isSampled(state.id, DAILY_ACTIVITY_SAMPLE)) {
    return false;
  }

  let planetsSeen = 0;
  try {
    planetsSeen = getVisitedPlanets().length;
  } catch {
    planetsSeen = 0;
  }

  Moderok.track('daily_activity', {
    date: state.date,
    sampleRate: DAILY_ACTIVITY_SAMPLE,
    partial: Boolean(partial),
    sequence: state.flushes || 0,
    tabs: state.tabs,
    cacheHits: state.cacheHits,
    weatherCalls: state.weatherCalls,
    geocodeCalls: state.geocodeCalls,
    errors: state.errors,
    offlineFallbacks: state.offlineFallbacks,
    topPlanet: topPlanet(state.planets),
    planetsSeen,
    ...state.settings
  });

  return true;
}

/**
 * Take an emitted slice back out of the day's totals. Subtraction rather than
 * assignment because this runs after the send, and renders counted in between (by any
 * page) must survive. The clamp covers two pages subtracting the same slice.
 */
function subtractSlice(state, slice) {
  for (const key of COUNTER_KEYS) {
    state[key] = Math.max(0, (state[key] || 0) - (slice[key] || 0));
  }

  return state;
}

/** Fallback for when localStorage is unavailable or unwritable. */
let memoryState = null;

/** Set when a write did not land, so storage is stale. */
let memoryStateIsAhead = false;

function persist(state) {
  try {
    writeTelemetryState(state);
    memoryStateIsAhead = false;
    return true;
  } catch {
    // the realistic failure is `setItem` throwing QuotaExceededError while `getItem`
    // keeps working, which leaves the two copies disagreeing
    memoryStateIsAhead = true;
    return false;
  }
}

/**
 * Storage normally wins: another page may have advanced the counters, and losing an
 * increment beats emitting a duplicate rollup that the sample rate scales up 4x. After
 * a failed write it holds a day this page already rolled over or flushed, and trusting
 * it would replay that emission on every call for the rest of the session.
 */
function loadState() {
  let stored = null;
  try {
    stored = readTelemetryState();
  } catch {
    stored = null;
  }

  if (!stored || (memoryStateIsAhead && memoryState)) {
    return memoryState || {};
  }

  return stored;
}

/**
 * Load, close out the previous UTC day if the date turned over, apply `mutate`,
 * persist. Every entry point goes through here so any activity flushes yesterday's
 * rollup. Storage failures downgrade to an in-memory rollup rather than propagating;
 * telemetry must never break the page it measures.
 */
function withState(mutate) {
  installFlushHooks();

  const now = Date.now();
  const date = utcDateStamp(now);
  const stored = loadState();
  const id = stored.id || createId();

  let state;
  if (stored.date === date) {
    state = { ...emptyDay(date), ...stored, id };
  } else {
    state = { ...emptyDay(date), id };
    if (stored.lastEmittedDate) {
      state.lastEmittedDate = stored.lastEmittedDate;
    }

    if (stored.date && stored.date !== stored.lastEmittedDate) {
      const closing = { ...emptyDay(stored.date), ...stored, id };
      // Order matters: emit yesterday BEFORE the record rolls over, and stamp
      // `lastEmittedDate` only after. Claiming the rollover first destroys the day if
      // the page is torn down in the gap (an overnight tab hidden past midnight), and
      // the stamp stops any later page retrying. This order can let two racing pages
      // both emit, which the ingest contract at the top of this file dedups.
      emitDailyActivity(closing, false);
      state.lastEmittedDate = stored.date;
    }
  }

  try {
    mutate(state);
  } catch (error) {
    console.warn('Telemetry rollup update failed', error);
  }

  memoryState = state;
  persist(state);

  return state;
}

/**
 * Consume a slice the SDK has confirmed custody of. Deliberately not done at emission
 * time: until `Moderok.flush()` settles the event lives only in the SDK's in-memory
 * queue (five-second persistence debounce, non-keepalive `fetch`), so a teardown in
 * between takes both the event and any counters already zeroed. Holding them costs a
 * re-send of the same `sequence`, which ingest drops.
 */
function settleSlice(slice) {
  const current = loadState();
  if (current.date !== slice.date) {
    // Midnight beat the confirmation: the rollover already emitted these counters, so
    // the slice was a duplicate of the closing rollup and there is nothing to subtract.
    return;
  }

  const next = subtractSlice({ ...current }, slice);
  next.flushes = Math.max(next.flushes || 0, (slice.flushes || 0) + 1);
  memoryState = next;
  persist(next);
}

/**
 * Ship what today has accumulated and start a fresh delta. Called on page hide, because
 * a rollup that only leaves on the next day's first render never leaves at all for a
 * churned user, dropping their last active day from the historical request projection.
 *
 * `flushedAt` spaces rollups PARTIAL_FLUSH_INTERVAL_MS apart and `flushAttempts` caps
 * the day at MAX_PARTIAL_FLUSHES, so at most MAX_PARTIAL_FLUSHES + 1 per user per day.
 */
export function flushDailyActivity() {
  const now = Date.now();
  const date = utcDateStamp(now);
  const stored = loadState();

  if (stored.date && stored.date !== date) {
    // day turned over while this page sat open; withState closes it out exactly once
    withState(() => {});
    return;
  }

  if (stored.date !== date || !hasActivity(stored)) {
    return;
  }

  // before any write, so the 75% outside the cohort turn a hide into a read only
  if (!isSampled(stored.id, DAILY_ACTIVITY_SAMPLE)) {
    return;
  }

  if ((stored.flushAttempts || 0) >= MAX_PARTIAL_FLUSHES) {
    return;
  }

  if (now - (stored.flushedAt || 0) < PARTIAL_FLUSH_INTERVAL_MS) {
    return;
  }

  const slice = { ...emptyDay(date), ...stored };

  // Record the attempt before sending: `visibilitychange` and `pagehide` both fire on
  // the same teardown, so an unconfirmed send would retry unboundedly. Only the
  // throttle moves; counters stay in the record until `settleSlice`.
  const attempt = { ...slice, flushedAt: now, flushAttempts: (slice.flushAttempts || 0) + 1 };
  memoryState = attempt;
  persist(attempt);

  if (!emitDailyActivity(slice, true)) {
    return;
  }

  // The SDK debounces its persistence by five seconds and the page may not have five
  // seconds, so drain now. Once settled the event is accepted or in the SDK's retry
  // storage, which is when the slice can be consumed.
  let flushed = null;
  try {
    flushed = Moderok.flush();
  } catch {
    flushed = null;
  }

  if (flushed && typeof flushed.then === 'function') {
    // fulfilment only: a rejected flush leaves the event's fate unknown, and an
    // unconsumed slice is re-sent where a consumed one is lost
    flushed.then(() => settleSlice(slice), () => {});
    return;
  }

  settleSlice(slice);
}

let flushHooksInstalled = false;

/**
 * Attach the hide hooks once per page. `visibilitychange` is the one that matters: it
 * fires while the page can still send, where `pagehide` often only reaches the SDK
 * queue. Installed from `withState`, so non-newtab pages arm them too; the caps live in
 * the shared record, so extra surfaces cost no extra events.
 */
function installFlushHooks() {
  if (flushHooksInstalled || typeof document === 'undefined' || !document.addEventListener) {
    return;
  }

  flushHooksInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushDailyActivity();
    }
  });

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', () => {
      flushDailyActivity();
    });
  }
}

/** One new-tab render. Also refreshes the settings snapshot the rollup carries. */
export function recordTabOpen() {
  withState((state) => {
    state.tabs += 1;
    state.settings = currentSettings();
  });
}

/** How a render resolved: `cache_hit`, `loaded`, `error` or `offline`. */
export function recordTabOutcome(outcome, { planetId, planet, timeOfDay } = {}) {
  const state = withState((current) => {
    if (outcome === 'cache_hit') {
      current.cacheHits += 1;
    }

    if (planetId) {
      current.planets[planetId] = (current.planets[planetId] || 0) + 1;
    }
  });

  if (!isSampled(state.id, NEW_TAB_SAMPLE)) {
    return;
  }

  Moderok.track('new_tab', {
    outcome,
    sampleRate: NEW_TAB_SAMPLE,
    planet: planet || '',
    timeOfDay: timeOfDay || ''
  });
}

/** An extension-to-backend weather request is about to be issued. */
export function recordWeatherCall() {
  withState((state) => {
    state.weatherCalls += 1;
  });
}

/** An extension-to-backend location request is about to be issued (forward or reverse). */
export function recordGeocodeCall() {
  withState((state) => {
    state.geocodeCalls += 1;
  });
}

/**
 * The rollup keeps the exact count; the real-time `weather_failure` event fires once
 * per `errorType` per user per day, so an outage stays cheap and the metric reads as
 * "users affected today". `errors` includes failures a retry recovered from; use
 * `offlineFallbacks` for a failure rate.
 */
export function recordError({ errorType, errorCode, fallback } = {}) {
  const type = errorType || 'unknown';
  let firstToday = false;

  withState((state) => {
    state.errors += 1;
    // `'none'` is the payload's value for "no fallback", so it must not count here
    if (fallback && fallback !== 'none') {
      state.offlineFallbacks += 1;
    }

    if (!state.errorsSeen.includes(type)) {
      state.errorsSeen.push(type);
      firstToday = true;
    }
  });

  if (!firstToday) {
    return;
  }

  const properties = { errorType: type, fallback: fallback || 'none' };
  if (errorCode) {
    properties.errorCode = errorCode;
  }

  Moderok.track('weather_failure', properties);
}

/** Pass-through for interaction events, which are low volume and sent unsampled. */
export function track(name, properties) {
  // empty mutate: closes out yesterday from pages that never call recordTabOpen()
  withState(() => {});
  Moderok.track(name, properties);
}

export function resetTelemetryForTests() {
  memoryState = null;
  memoryStateIsAhead = false;
  flushHooksInstalled = false;
  try {
    writeTelemetryState(null);
  } catch {
    // no storage here; the in-memory reset is the whole state
  }
}
