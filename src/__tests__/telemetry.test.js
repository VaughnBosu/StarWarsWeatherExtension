import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, installStorageMock, teardownDom } from './testUtils.js';
import { Moderok } from '../vendor/moderok.js';
import {
  DAILY_ACTIVITY_SAMPLE,
  MAX_PARTIAL_FLUSHES,
  NEW_TAB_SAMPLE,
  PARTIAL_FLUSH_INTERVAL_MS,
  flushDailyActivity,
  hashBucket,
  recordError,
  recordGeocodeCall,
  recordTabOpen,
  recordTabOutcome,
  recordWeatherCall,
  resetTelemetryForTests,
  track
} from '../telemetry.js';
import { STORAGE_KEYS, writeTelemetryState } from '../storage.js';

// Buckets are 0..9999. Asserted below so a hash change fails here instead of silently
// reshuffling live cohorts.
const ID_IN_BOTH_COHORTS = 'user-132'; // bucket 5    -> daily_activity + new_tab
const ID_IN_ROLLUP_ONLY = 'user-2'; //    bucket 1357 -> daily_activity only
const ID_IN_NO_COHORT = 'user-0'; //      bucket 6119 -> neither

const realDateNow = Date.now;
let tracked = [];
let realTrack;
let realFlush;
let clock = 0;

/**
 * A rollup leaves the counters only once the SDK settles its flush, so anything asserting
 * on the remaining counters must let that land. A macro task drains the microtask chain.
 */
function settleFlush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function setToday(dateString) {
  clock = Date.parse(`${dateString}T12:00:00.000Z`);
  Date.now = () => clock;
}

/** Moves time within the same UTC day, which the mid-day flush throttle keys off. */
function advance(ms) {
  clock += ms;
}

function seedUser(id) {
  writeTelemetryState({ id });
}

function eventsNamed(name) {
  return tracked.filter((event) => event.name === name);
}

function storedState() {
  const raw = localStorage.getItem(STORAGE_KEYS.telemetry);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  installStorageMock();
  tracked = [];
  realTrack = Moderok.track;
  Moderok.track = (name, properties) => {
    tracked.push({ name, properties });
  };
  realFlush = Moderok.flush;
  // Stands in for the SDK confirming custody. Tests of the never-confirms case swap in
  // a promise that never settles.
  Moderok.flush = () => Promise.resolve();
  setToday('2026-07-28');
  resetTelemetryForTests();
});

afterEach(() => {
  Moderok.track = realTrack;
  Moderok.flush = realFlush;
  Date.now = realDateNow;
  teardownDom();
  delete globalThis.localStorage;
});

describe('hashBucket', () => {
  test('is deterministic and stable for the ids the cohort tests rely on', () => {
    expect(hashBucket(ID_IN_BOTH_COHORTS)).toBe(5);
    expect(hashBucket(ID_IN_ROLLUP_ONLY)).toBe(1357);
    expect(hashBucket(ID_IN_NO_COHORT)).toBe(6119);
    expect(hashBucket(ID_IN_BOTH_COHORTS)).toBe(hashBucket(ID_IN_BOTH_COHORTS));
  });

  test('spreads ids roughly evenly so the sample is not biased', () => {
    const sampled = Array.from({ length: 20000 }, (_, i) => hashBucket(`u${i}`) < DAILY_ACTIVITY_SAMPLE * 10000);
    const rate = sampled.filter(Boolean).length / sampled.length;
    expect(Math.abs(rate - DAILY_ACTIVITY_SAMPLE)).toBeLessThan(0.02);
  });

  test('new_tab cohort is a strict subset of the daily_activity cohort', () => {
    for (let i = 0; i < 5000; i += 1) {
      const bucket = hashBucket(`u${i}`);
      if (bucket < NEW_TAB_SAMPLE * 10000) {
        expect(bucket).toBeLessThan(DAILY_ACTIVITY_SAMPLE * 10000);
      }
    }
  });
});

describe('daily rollup', () => {
  test('emits one rollup for the previous day on the first activity of the next', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordTabOutcome('cache_hit');
    recordTabOpen();
    recordWeatherCall();
    recordGeocodeCall();
    recordGeocodeCall();

    setToday('2026-07-29');
    recordTabOpen();

    const rollups = eventsNamed('daily_activity');
    expect(rollups).toHaveLength(1);
    expect(rollups[0].properties).toMatchObject({
      date: '2026-07-28',
      tabs: 2,
      cacheHits: 1,
      weatherCalls: 1,
      geocodeCalls: 2,
      errors: 0,
      sampleRate: DAILY_ACTIVITY_SAMPLE
    });
  });

  test('starts the new day from zero', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();

    setToday('2026-07-29');
    recordTabOpen();
    setToday('2026-07-30');
    recordTabOpen();

    const [, second] = eventsNamed('daily_activity');
    expect(second.properties).toMatchObject({ date: '2026-07-29', tabs: 1, weatherCalls: 0 });
  });

  test('is not emitted for users outside the sample', () => {
    seedUser(ID_IN_NO_COHORT);
    recordTabOpen();
    recordWeatherCall();

    setToday('2026-07-29');
    recordTabOpen();

    expect(eventsNamed('daily_activity')).toHaveLength(0);
  });

  test('skips days with no activity', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    track('search_performed', { kind: 'query' });

    setToday('2026-07-29');
    recordTabOpen();

    expect(eventsNamed('daily_activity')).toHaveLength(0);
  });

  test('carries the settings snapshot and most-seen planet', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    localStorage.setItem(STORAGE_KEYS.unit, 'celsius');
    localStorage.setItem(STORAGE_KEYS.showSearchBar, 'true');
    localStorage.setItem(STORAGE_KEYS.visitedPlanets, JSON.stringify(['hoth', 'tatooine']));

    recordTabOpen();
    recordTabOutcome('loaded', { planetId: 'hoth' });
    recordTabOutcome('loaded', { planetId: 'tatooine' });
    recordTabOutcome('loaded', { planetId: 'tatooine' });

    setToday('2026-07-29');
    recordTabOpen();

    expect(eventsNamed('daily_activity')[0].properties).toMatchObject({
      unit: 'celsius',
      searchBar: true,
      shortcuts: false,
      topPlanet: 'tatooine',
      planetsSeen: 2
    });
  });

  test('still holds the day in storage at the moment it is handed to the SDK', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();

    setToday('2026-07-29');

    let recordAtEmit = null;
    const push = Moderok.track;
    Moderok.track = (name, properties) => {
      if (name === 'daily_activity') {
        recordAtEmit = storedState();
      }
      push(name, properties);
    };
    recordTabOpen();

    // Counters must not roll to the new day before yesterday is handed over. Rolling
    // first let an overnight tab destroy the day, and `lastEmittedDate` blocked retries.
    expect(recordAtEmit).toMatchObject({ date: '2026-07-28', tabs: 1 });
  });
});

describe('mid-day flush', () => {
  test('ships the day so far when a page hides, so an abandoned day is not lost', async () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();
    recordGeocodeCall();

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    flushDailyActivity();

    const rollups = eventsNamed('daily_activity');
    expect(rollups).toHaveLength(1);
    expect(rollups[0].properties).toMatchObject({
      date: '2026-07-28',
      partial: true,
      sequence: 0,
      tabs: 1,
      weatherCalls: 1,
      geocodeCalls: 1
    });

    await settleFlush();
    expect(storedState()).toMatchObject({ tabs: 0, weatherCalls: 0, geocodeCalls: 0, flushes: 1 });
  });

  test('still holds the counters at the moment the slice is handed to the SDK', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordTabOpen();
    recordWeatherCall();

    advance(PARTIAL_FLUSH_INTERVAL_MS);

    let recordAtEmit = null;
    const push = Moderok.track;
    Moderok.track = (name, properties) => {
      if (name === 'daily_activity') {
        recordAtEmit = storedState();
      }
      push(name, properties);
    };
    flushDailyActivity();

    // Inverse of the rollover above: nothing leaves the record until the SDK has the
    // slice, or a page dying in between loses the event and the counters with it.
    expect(recordAtEmit).toMatchObject({ date: '2026-07-28', tabs: 2, weatherCalls: 1 });
  });

  test('stays quiet until the throttle interval has passed since the last rollup', async () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();

    // The throttle clock starts at the previous rollup, so the first flush never waits.
    flushDailyActivity();
    await settleFlush();
    expect(eventsNamed('daily_activity')).toHaveLength(1);

    recordTabOpen();
    advance(PARTIAL_FLUSH_INTERVAL_MS - 1);
    flushDailyActivity();
    flushDailyActivity();
    flushDailyActivity();
    await settleFlush();

    expect(eventsNamed('daily_activity')).toHaveLength(1);
  });

  test('a session that hides a minute in still reports its day', async () => {
    const window = installDom();
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();

    // Churned user: one short session and never opened again, so nothing after this
    // point will ever close the day out.
    advance(60 * 1000);
    window.dispatchEvent(new Event('pagehide'));
    await settleFlush();

    expect(eventsNamed('daily_activity')).toHaveLength(1);
    expect(eventsNamed('daily_activity')[0].properties).toMatchObject({
      date: '2026-07-28',
      partial: true,
      tabs: 1,
      weatherCalls: 1
    });
  });

  test('stops after MAX_PARTIAL_FLUSHES so an all-day session cannot flood the quota', async () => {
    seedUser(ID_IN_ROLLUP_ONLY);

    for (let i = 0; i < MAX_PARTIAL_FLUSHES + 3; i += 1) {
      recordTabOpen();
      advance(PARTIAL_FLUSH_INTERVAL_MS);
      flushDailyActivity();
      await settleFlush();
    }

    expect(eventsNamed('daily_activity')).toHaveLength(MAX_PARTIAL_FLUSHES);
  });

  test('emits deltas, so the partials and the closing rollup sum to the day', async () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    flushDailyActivity();
    await settleFlush();

    recordTabOpen();
    recordTabOpen();
    recordGeocodeCall();

    setToday('2026-07-29');
    recordTabOpen();

    const rollups = eventsNamed('daily_activity');
    expect(rollups.map((event) => event.properties.tabs)).toEqual([1, 2]);
    expect(rollups[1].properties).toMatchObject({
      date: '2026-07-28',
      partial: false,
      sequence: 1,
      weatherCalls: 0,
      geocodeCalls: 1
    });
  });

  test('a slice the SDK never confirms is kept rather than consumed', async () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordTabOpen();
    recordWeatherCall();

    // Renderer dies before the SDK's non-keepalive fetch or its 5s persistence debounce
    // lands, so the flush never settles.
    Moderok.flush = () => new Promise(() => {});

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    flushDailyActivity();
    await settleFlush();

    expect(storedState()).toMatchObject({ tabs: 2, weatherCalls: 1, flushes: 0 });

    // The next page re-sends the same slice under the same sequence, which ingest drops.
    advance(PARTIAL_FLUSH_INTERVAL_MS);
    flushDailyActivity();
    await settleFlush();

    const rollups = eventsNamed('daily_activity');
    expect(rollups).toHaveLength(2);
    expect(rollups.map((event) => event.properties.sequence)).toEqual([0, 0]);
    expect(rollups.map((event) => event.properties.partial)).toEqual([true, true]);
    expect(rollups[1].properties).toMatchObject({ tabs: 2, weatherCalls: 1 });
  });

  test('a wedged SDK still cannot exceed the daily cap on rollups', async () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    Moderok.flush = () => new Promise(() => {});

    for (let i = 0; i < MAX_PARTIAL_FLUSHES + 3; i += 1) {
      advance(PARTIAL_FLUSH_INTERVAL_MS);
      flushDailyActivity();
      await settleFlush();
    }

    expect(eventsNamed('daily_activity')).toHaveLength(MAX_PARTIAL_FLUSHES);
  });

  test('the two hide events of one teardown send a single rollup', async () => {
    const window = installDom();
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    await settleFlush();

    expect(eventsNamed('daily_activity')).toHaveLength(1);
  });

  test('closes out yesterday when a page that sat open overnight hides', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();

    setToday('2026-07-29');
    flushDailyActivity();
    flushDailyActivity();

    const rollups = eventsNamed('daily_activity');
    expect(rollups).toHaveLength(1);
    expect(rollups[0].properties).toMatchObject({
      date: '2026-07-28',
      partial: false,
      tabs: 1,
      weatherCalls: 1
    });
  });

  test('sends nothing for a day with no activity', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    track('search_performed', { kind: 'query' });

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    flushDailyActivity();

    expect(eventsNamed('daily_activity')).toHaveLength(0);
  });

  test('a hiding page flushes without waiting for a future session', () => {
    const window = installDom();
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    window.dispatchEvent(new Event('pagehide'));

    expect(eventsNamed('daily_activity')).toHaveLength(1);
    expect(eventsNamed('daily_activity')[0].properties).toMatchObject({ partial: true, tabs: 1 });
  });

  test('a visibilitychange that leaves the page visible is not a flush', () => {
    const window = installDom();
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    window.document.dispatchEvent(new Event('visibilitychange'));

    expect(eventsNamed('daily_activity')).toHaveLength(0);
  });
});

describe('unwritable storage', () => {
  // storage.js swallows parse errors and returns {}, so the realistic failure is setItem
  // throwing QuotaExceededError while getItem keeps serving the old record.
  function breakWrites() {
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
  }

  test('emits the rollover once, not once per call for the rest of the session', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();

    setToday('2026-07-29');
    breakWrites();

    recordTabOpen();
    recordWeatherCall();
    recordGeocodeCall();
    recordError({ errorType: 'auto_fetch' });
    recordTabOutcome('cache_hit');
    track('search_performed', { kind: 'query' });

    const rollups = eventsNamed('daily_activity');
    expect(rollups).toHaveLength(1);
    expect(rollups[0].properties).toMatchObject({ date: '2026-07-28', tabs: 1, weatherCalls: 1 });
  });

  test('keeps counting in memory instead of freezing the day at zero', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();

    setToday('2026-07-29');
    const realSetItem = localStorage.setItem;
    breakWrites();

    recordTabOpen();
    recordWeatherCall();
    recordGeocodeCall();
    recordGeocodeCall();

    localStorage.setItem = realSetItem;
    setToday('2026-07-30');
    recordTabOpen();

    const [, second] = eventsNamed('daily_activity');
    expect(second.properties).toMatchObject({
      date: '2026-07-29',
      tabs: 1,
      weatherCalls: 1,
      geocodeCalls: 2
    });
  });

  test('a mid-day flush that cannot be persisted is not repeated', async () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    breakWrites();

    advance(PARTIAL_FLUSH_INTERVAL_MS);
    flushDailyActivity();
    await settleFlush();
    advance(PARTIAL_FLUSH_INTERVAL_MS);
    flushDailyActivity();
    await settleFlush();

    expect(eventsNamed('daily_activity')).toHaveLength(1);
  });
});

describe('concurrent pages', () => {
  test('a rollover interrupted before its write still shipped the day', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();

    setToday('2026-07-29');

    // Page dies the instant it rolls the record over (the ordinary overnight-tab
    // teardown); the day must already be on its way out by then.
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key, value) => {
      if (key === STORAGE_KEYS.telemetry && JSON.parse(value).date === '2026-07-29') {
        throw new Error('renderer torn down');
      }

      realSetItem(key, value);
    };

    try {
      recordTabOpen();
    } catch {
      // The teardown itself is not what is under test.
    }

    localStorage.setItem = realSetItem;

    const sent = eventsNamed('daily_activity');
    expect(sent).toHaveLength(1);
    expect(sent[0].properties).toMatchObject({ date: '2026-07-28', tabs: 1, weatherCalls: 1 });
  });

  test('a page that reads after the rollover has landed does not close the day again', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();
    recordWeatherCall();

    setToday('2026-07-29');
    recordTabOpen();

    expect(storedState()).toMatchObject({ lastEmittedDate: '2026-07-28' });

    recordTabOpen();
    recordWeatherCall();
    track('search_performed', { kind: 'query' });

    expect(eventsNamed('daily_activity')).toHaveLength(1);
  });

  test('a page holding a stale record cannot re-close a day another page already closed', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOpen();

    setToday('2026-07-29');

    // Another page rolled the day over while this one was idle.
    writeTelemetryState({
      id: ID_IN_ROLLUP_ONLY,
      date: '2026-07-28',
      tabs: 7,
      lastEmittedDate: '2026-07-28'
    });

    recordTabOpen();

    expect(eventsNamed('daily_activity')).toHaveLength(0);
  });
});

describe('new_tab sampling', () => {
  test('emits a raw event for the validation cohort only', () => {
    seedUser(ID_IN_BOTH_COHORTS);
    recordTabOutcome('cache_hit', { planet: 'Hoth', timeOfDay: 'night' });

    const events = eventsNamed('new_tab');
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      outcome: 'cache_hit',
      planet: 'Hoth',
      timeOfDay: 'night',
      sampleRate: NEW_TAB_SAMPLE
    });
  });

  test('stays silent for users only in the rollup cohort', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordTabOutcome('loaded', { planet: 'Hoth' });

    expect(eventsNamed('new_tab')).toHaveLength(0);
  });
});

describe('recordError', () => {
  test('emits once per errorType per day but keeps counting in the rollup', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordError({ errorType: 'auto_fetch', fallback: 'last_known' });
    recordError({ errorType: 'auto_fetch', fallback: 'random' });
    recordError({ errorType: 'auto_fetch', fallback: 'random' });

    expect(eventsNamed('weather_failure')).toHaveLength(1);
    expect(eventsNamed('weather_failure')[0].properties).toMatchObject({
      errorType: 'auto_fetch',
      fallback: 'last_known'
    });

    setToday('2026-07-29');
    recordTabOpen();
    expect(eventsNamed('daily_activity')[0].properties).toMatchObject({
      errors: 3,
      offlineFallbacks: 3
    });
  });

  test('reports each distinct errorType once', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordError({ errorType: 'auto_fetch', fallback: 'random' });
    recordError({ errorType: 'geolocation', errorCode: '1' });
    recordError({ errorType: 'geolocation', errorCode: '1' });

    expect(eventsNamed('weather_failure').map((event) => event.properties.errorType))
      .toEqual(['auto_fetch', 'geolocation']);
    expect(eventsNamed('weather_failure')[1].properties).toMatchObject({
      errorCode: '1',
      fallback: 'none'
    });
  });

  test('treats the documented "none" sentinel as no fallback at all', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    // The payload uses 'none' for "recovered without a fallback", so passing it
    // explicitly must not inflate the failure-rate numerator.
    recordError({ errorType: 'auto_fetch', fallback: 'none' });
    recordError({ errorType: 'geolocation' });
    recordError({ errorType: 'offline', fallback: 'random' });

    setToday('2026-07-29');
    recordTabOpen();

    expect(eventsNamed('daily_activity')[0].properties).toMatchObject({
      errors: 3,
      offlineFallbacks: 1
    });
  });

  test('reopens the cap on a new day', () => {
    seedUser(ID_IN_ROLLUP_ONLY);
    recordError({ errorType: 'auto_fetch', fallback: 'random' });

    setToday('2026-07-29');
    recordError({ errorType: 'auto_fetch', fallback: 'random' });

    expect(eventsNamed('weather_failure')).toHaveLength(2);
  });

  test('is sent regardless of sampling cohort', () => {
    seedUser(ID_IN_NO_COHORT);
    recordError({ errorType: 'offline', fallback: 'random' });

    expect(eventsNamed('weather_failure')).toHaveLength(1);
  });
});

describe('track', () => {
  test('passes interaction events straight through, unsampled', () => {
    seedUser(ID_IN_NO_COHORT);
    track('setting_changed', { setting: 'unit', value: 'celsius', surface: 'popup' });

    expect(tracked).toEqual([
      { name: 'setting_changed', properties: { setting: 'unit', value: 'celsius', surface: 'popup' } }
    ]);
  });
});

describe('resilience', () => {
  test('does not throw when storage is unavailable', () => {
    delete globalThis.localStorage;

    expect(() => {
      recordTabOpen();
      recordWeatherCall();
      recordTabOutcome('loaded', { planetId: 'hoth' });
      recordError({ errorType: 'auto_fetch', fallback: 'random' });
      track('search_performed', { kind: 'query' });
    }).not.toThrow();

    expect(eventsNamed('search_performed')).toHaveLength(1);
  });
});
