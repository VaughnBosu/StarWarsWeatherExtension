import {
  clearGeolocationAlerted,
  clearWeatherCache,
  getManualLocation,
  getPreferredLanguage,
  getPreferredUnit,
  getVisitedPlanets,
  hasShownGeolocationError,
  isOnboardingComplete,
  markGeolocationAlerted,
  markPlanetVisited,
  clearBackendRetryAt,
  readBackendRetryAt,
  readLastKnownWeather,
  readWeatherCache,
  setPreferredUnit,
  STORAGE_KEYS,
  writeBackendRetryAt,
  writeLastKnownWeather,
  writeWeatherCache
} from './storage.js';
import { loadLocalization } from './i18n.js';
import { stateToAbbreviation } from './geo.js';
import { PLANET_RULES, DEFAULT_PLANET_RULE, explainMatch } from './planets.js';
import {
  BACKEND_BACKOFF_DEFAULT_MS,
  BACKEND_BACKOFF_MAX_MS,
  BACKEND_BACKOFF_MIN_MS,
  BACKGROUND_GEOLOCATION_OPTIONS,
  GEOLOCATION_OPTIONS,
  DEGREE_SYMBOL,
  GEOLOCATION_POSITION_MAX_AGE_MS,
  GEOLOCATION_REFINEMENT_COOLDOWN_MS,
  GEOLOCATION_REFINEMENT_THRESHOLD_METERS,
  HIGH_ACCURACY_GEOLOCATION_OPTIONS,
  HYPERSPACE_MIN_MS,
  STALE_WEATHER_RETRY_MS,
  TRAVEL_MARGIN_MAX_METERS,
  TRAVEL_MARGIN_MIN_METERS,
  WEATHER_COORDINATE_PRECISION
} from './config.js';
import {
  BackendRequestError,
  buildWeatherCoordinateKey,
  getWeather
} from './backend-client.js';
import {
  recordError,
  recordTabOpen,
  recordTabOutcome,
  recordWeatherCall,
  track
} from './telemetry.js';
import { initPassport, updatePassportUi } from './passport.js';
import { fetchLocationDetails } from './location-details.js';

const DEBUG = globalThis.SWW_DEBUG === true;
const DEBUG_FORCE_PLANET_ID = null;

const SHOULD_INIT = !(typeof globalThis !== 'undefined' && globalThis.__SWW_SKIP_INIT__ === true);

let currentViewModel = null;
let currentLocalization = null;

const HYPERSPACE_VIDEO_PATH = '/public/assets/hyperspace.mp4';

function debug(...args) {
  if (DEBUG) {
    console.log('[StarWarsWeather]', ...args);
  }
}

function buildManualLocationKey(location) {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) {
    return 'manual:invalid';
  }

  return `manual:${location.lat.toFixed(4)},${location.lon.toFixed(4)}`;
}

function parseFiniteTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function currentLocationKey() {
  const manualLocation = getManualLocation();
  const manualKey = manualLocation ? buildManualLocationKey(manualLocation) : null;
  return manualLocation && manualKey !== 'manual:invalid' ? manualKey : 'auto';
}

function isRefreshContextCurrent({
  preferredLanguage,
  unit,
  locationKey,
  expectedViewModel = null,
  generation = null
}) {
  return isRefreshPassCurrent(generation)
    && getPreferredLanguage() === preferredLanguage
    && getPreferredUnit() === unit
    && currentLocationKey() === locationKey
    && (!expectedViewModel || currentViewModel === expectedViewModel);
}

/**
 * A reading the backend served stale is re-checked after a short wait. A normal
 * reading is kept for the full local TTL, not the backend's shorter freshness window.
 */
function isStaleWeatherDue(weather, now = Date.now()) {
  if (weather?.stale !== true) {
    return false;
  }
  const cachedAt = parseFiniteTimestamp(weather.cachedAt);
  return cachedAt === null || (now - cachedAt) >= STALE_WEATHER_RETRY_MS;
}

/** The furthest ahead noteBackendFailure writes; anything later predates a clock change. */
const BACKEND_RETRY_AT_MAX_AHEAD_MS = BACKEND_BACKOFF_MAX_MS * 1.5;

function isBackendBackingOff(now = Date.now()) {
  try {
    const retryAt = readBackendRetryAt();
    if (retryAt === null || retryAt <= now) {
      return false;
    }
    if (retryAt - now > BACKEND_RETRY_AT_MAX_AHEAD_MS) {
      clearBackendRetryAt();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared across open tabs through localStorage so new tabs back off together during
 * an outage. Jitter spreads out retries from installs that failed together.
 */
function noteBackendFailure(error) {
  if (!(error instanceof BackendRequestError) || error.retryable !== true) {
    return;
  }
  // A device with no network says nothing about the service.
  if ((error.code === 'network_error' || error.code === 'timeout') && isNavigatorOffline()) {
    return;
  }
  const requestedMs = Number.isFinite(error.retryAfterSeconds)
    ? error.retryAfterSeconds * 1000
    : BACKEND_BACKOFF_DEFAULT_MS;
  const baseMs = Math.min(BACKEND_BACKOFF_MAX_MS, Math.max(BACKEND_BACKOFF_MIN_MS, requestedMs));
  const delayMs = Math.round(baseMs * (1 + (Math.random() * 0.5)));
  safeStorageWrite('backend retry time', () => writeBackendRetryAt(Date.now() + delayMs));
}

function noteBackendSuccess() {
  safeStorageWrite('backend retry time', () => {
    if (readBackendRetryAt() !== null) {
      clearBackendRetryAt();
    }
  });
}

function positionAccuracyMeters(position) {
  const accuracy = Number(position?.coords?.accuracy);
  return Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null;
}

function positionTimestamp(position) {
  const timestamp = Number(position?.timestamp);
  const parsed = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : null;
  return parsed && Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}

function isPositionStale(position, now = Date.now()) {
  const timestamp = Number(position?.timestamp);
  return !Number.isFinite(timestamp)
    || timestamp <= 0
    || (now - timestamp) > GEOLOCATION_POSITION_MAX_AGE_MS;
}

function buildWeatherLocation(position, { highAccuracyCheckedAt = null } = {}) {
  const cell = buildWeatherCoordinateKey(
    position?.coords?.latitude,
    position?.coords?.longitude
  );
  return {
    cell,
    accuracyMeters: positionAccuracyMeters(position),
    positionAt: positionTimestamp(position),
    ...(parseFiniteTimestamp(highAccuracyCheckedAt) !== null ? { highAccuracyCheckedAt } : {})
  };
}

/**
 * Whether a fix still belongs to the cached cell once that cell is widened by a margin,
 * so jitter across a gridline is not treated as travel.
 */
function isNearWeatherCell(position, cell) {
  const [cellLat, cellLon] = String(cell ?? '').split(',').map(Number);
  const lat = Number(position?.coords?.latitude);
  const lon = Number(position?.coords?.longitude);
  if (![cellLat, cellLon, lat, lon].every(Number.isFinite)) {
    return false;
  }

  const marginMeters = Math.min(
    TRAVEL_MARGIN_MAX_METERS,
    Math.max(TRAVEL_MARGIN_MIN_METERS, positionAccuracyMeters(position) ?? 0)
  );
  const halfCellDegrees = 0.5 * (10 ** -WEATHER_COORDINATE_PRECISION);
  const metersPerDegree = 111320;
  const latSlack = halfCellDegrees + (marginMeters / metersPerDegree);
  const lonSlack = halfCellDegrees
    + (marginMeters / (metersPerDegree * Math.max(Math.cos(lat * Math.PI / 180), 0.01)));
  const lonDelta = Math.abs((((lon - cellLon) % 360) + 540) % 360 - 180);
  return Math.abs(lat - cellLat) <= latSlack && lonDelta <= lonSlack;
}

function shouldRefinePosition(position, weatherLocation, now = Date.now(), force = false) {
  const accuracy = positionAccuracyMeters(position);
  if (!force && accuracy !== null && accuracy <= GEOLOCATION_REFINEMENT_THRESHOLD_METERS) {
    return false;
  }

  const lastChecked = parseFiniteTimestamp(weatherLocation?.highAccuracyCheckedAt);
  return lastChecked === null || (now - lastChecked) >= GEOLOCATION_REFINEMENT_COOLDOWN_MS;
}

function isMateriallyBetterPosition(initialPosition, refinedPosition) {
  const initialAccuracy = positionAccuracyMeters(initialPosition);
  const refinedAccuracy = positionAccuracyMeters(refinedPosition);
  if (refinedAccuracy === null) {
    return false;
  }
  if (initialAccuracy === null) {
    return refinedAccuracy <= GEOLOCATION_REFINEMENT_THRESHOLD_METERS;
  }
  return refinedAccuracy <= GEOLOCATION_REFINEMENT_THRESHOLD_METERS
    || refinedAccuracy <= initialAccuracy / 2;
}

const WATCHED_SETTINGS = new Set([
  STORAGE_KEYS.unit,
  STORAGE_KEYS.language,
  STORAGE_KEYS.manualLocation
]);

function waitForMinimumHyperspace(startedAt, minMs = HYPERSPACE_MIN_MS) {
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, minMs - elapsed);
  if (remaining === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, remaining);
  });
}

function isNavigatorOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** A full or blocked localStorage must not take the render down with it. */
function safeStorageWrite(label, write) {
  try {
    write();
    return true;
  } catch (error) {
    console.warn(`Unable to persist ${label}`, error);
    return false;
  }
}

/** The page an `online` retry is already armed on, so retries cannot stack. */
let onlineRetryTarget = null;

/**
 * Without this a tab that failed offline sits on the signal-lost screen until reopened.
 * Every failed pass asks for a retry, so only the first on a page arms a listener.
 */
function scheduleOnlineRetry() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }

  if (onlineRetryTarget === window) {
    return;
  }

  onlineRetryTarget = window;
  window.addEventListener('online', () => {
    onlineRetryTarget = null;
    debug('Connectivity restored; retrying weather');
    refreshWeather({ isNewTab: false });
  }, { once: true });
}

function persistSuccessfulWeather(viewModel, localization = currentLocalization) {
  // Runs inside refreshWeather's try/catch: anything escaping here would repaint a
  // successful render as "Sensors offline". Covers the gaps between guarded writes.
  try {
    // applyWeatherToUi already drew the passport; only a new stamp changes it, and a
    // redraw still rewrites thirteen tiles plus the count.
    const isNewStamp = Boolean(viewModel.planetId)
      && !getVisitedPlanets().includes(viewModel.planetId);
    const marked = Boolean(viewModel.planetId)
      && safeStorageWrite('visited planets', () => markPlanetVisited(viewModel.planetId));

    if (marked && isNewStamp && localization) {
      updatePassportUi(localization);
    }

    safeStorageWrite('weather cache', () => writeWeatherCache(viewModel));
    // Only the live cache carries the cell; the last-known fallback omits location metadata.
    const { weatherLocation, ...lastKnownViewModel } = viewModel;
    safeStorageWrite('last known weather', () => writeLastKnownWeather(lastKnownViewModel));
    safeStorageWrite('geolocation alert flag', () => clearGeolocationAlerted());
  } catch (error) {
    console.warn('Unable to persist the successful weather load', error);
  }
}

/**
 * Only a real new-tab render feeds the rollup. The settings listener, unit toggle and
 * online retry all re-enter refreshWeather(); counting them inflates `tabs`.
 */
function recordRenderOutcome(isNewTab, outcome, details) {
  if (isNewTab) {
    recordTabOutcome(outcome, details);
  }
}

function buildOfflineRandomViewModel(localization, language, unit) {
  const rule = PLANET_RULES[Math.floor(Math.random() * PLANET_RULES.length)] ?? DEFAULT_PLANET_RULE;
  const timeOfDay = resolveTimeOfDay(new Date(), localization);
  const planetName = localization.getMessage(`planet_${rule.id}_name`) || rule.name;
  const description = localization.getMessage(`planet_${rule.id}_description`) || '';
  const offlineMessage = localization.getMessage('offline_random_planet')
    || 'Sensors offline — signal lost. Displaying a random sector.';

  return {
    planetId: rule.id,
    planetClass: selectBackground(rule, timeOfDay.id, timeOfDay.isDaytime),
    planetName,
    headingPrefix: localization.getMessage('center_heading_prefix') || "IT'S LIKE",
    headingSuffix: localization.getMessage('center_heading_suffix') || 'OUTSIDE',
    message: offlineMessage,
    description,
    lastUpdated: null,
    lastUpdatedLabel: localization.getMessage('offline_signal_lost', [planetName])
      || `Sensors offline — last known: ${planetName}`,
    locationKey: 'offline',
    locationName: null,
    language,
    unit,
    timeOfDay: timeOfDay.id,
    timeOfDayLabel: timeOfDay.label,
    sunrise: null,
    sunset: null,
    timezoneOffset: null,
    offline: true
  };
}

function rehydrateLastKnownViewModel(stored, localization, language, unit) {
  const planetId = stored.planetId;
  const rule = planetId
    ? (PLANET_RULES.find((entry) => entry.id === planetId) ?? DEFAULT_PLANET_RULE)
    : null;
  const sunTimes = extractSunTimes(stored);
  const timeOfDay = resolveTimeOfDay(new Date(), localization, sunTimes);

  let planetName = stored.planetName;
  let description = stored.description;
  let message = stored.message;
  let planetClass = stored.planetClass;

  if (rule) {
    planetName = localization.getMessage(`planet_${rule.id}_name`) || rule.name || stored.planetName;
    description = localization.getMessage(`planet_${rule.id}_description`) || stored.description || '';
    planetClass = selectBackground(rule, timeOfDay.id, timeOfDay.isDaytime);

    // Stored message has the temperature baked in, in the unit and language of the
    // write, so it is only reusable while both still match.
    const isStale = (stored.language && stored.language !== language)
      || (stored.unit && stored.unit !== unit);

    if (isStale) {
      // Rebuilding from the persisted temps also keeps the temperature clickable:
      // updateMessage only wraps a label it can match.
      message = buildSummaryMessage({
        planetId: rule.id,
        tempF: stored.tempF,
        tempC: stored.tempC,
        unit,
        timeOfDayLabel: timeOfDay.label
      }, localization)
        || localization.getMessage('offline_signal_lost', [planetName])
        || `Sensors offline — last known: ${planetName}`;
    }
  }

  return {
    ...stored,
    planetId: rule?.id ?? stored.planetId ?? null,
    planetClass,
    planetName,
    headingPrefix: localization.getMessage('center_heading_prefix') || stored.headingPrefix || "IT'S LIKE",
    headingSuffix: localization.getMessage('center_heading_suffix') || stored.headingSuffix || 'OUTSIDE',
    message,
    description,
    lastUpdatedLabel: localization.getMessage('offline_signal_lost', [planetName])
      || `Sensors offline — last known: ${planetName}`,
    language,
    unit,
    timeOfDay: timeOfDay.id,
    timeOfDayLabel: timeOfDay.label,
    sunrise: sunTimes?.sunrise ?? stored.sunrise ?? null,
    sunset: sunTimes?.sunset ?? stored.sunset ?? null,
    timezoneOffset: sunTimes?.timezoneOffset ?? stored.timezoneOffset ?? null,
    offline: true
  };
}

/** `locationKey` scopes the stale reading: weather saved elsewhere is no fallback for here. */
function applyOfflineFallback(localization, language, unit, { errorType = 'unknown', errorCode = null, locationKey = null, isNewTab = false } = {}) {
  // Only renders that recordTabOpen() counted may report a fallback, or
  // offlineFallbacks/tabs exceeds 1. Re-renders still add to `errors`.
  const fallbackForRollup = (mode) => (isNewTab ? mode : null);

  const lastKnown = readLastKnownWeather({ language, unit, locationKey });
  if (lastKnown) {
    debug('Applying last-known weather offline fallback');
    const viewModel = rehydrateLastKnownViewModel(lastKnown, localization, language, unit);
    applyWeatherToUi(viewModel, localization);
    recordError({ errorType, errorCode, fallback: fallbackForRollup('last_known') });
    recordRenderOutcome(isNewTab, 'error', {
      planetId: viewModel.planetId,
      planet: viewModel.planetName,
      timeOfDay: viewModel.timeOfDay
    });
    return viewModel;
  }

  debug('No last-known weather; showing random offline planet');
  const viewModel = buildOfflineRandomViewModel(localization, language, unit);
  applyWeatherToUi(viewModel, localization);
  recordError({ errorType, errorCode, fallback: fallbackForRollup('random') });
  recordRenderOutcome(isNewTab, 'error', {
    planetId: viewModel.planetId,
    planet: viewModel.planetName,
    timeOfDay: viewModel.timeOfDay
  });
  return viewModel;
}

/**
 * A retryable backend/provider failure uses the last known reading. Client mistakes such as a
 * malformed request remain visible instead of silently masking a broken release.
 */
function handleWeatherFailure(error, { localization, language, unit, locationKey, locationName = null, errorType, isNewTab }) {
  const status = typeof error?.status === 'number' ? error.status : Number.NaN;
  // backend-client.js classifies HTTP 429/5xx, timeouts and network failures as retryable;
  // anything without a status (geolocation errors, storage) is treated the same way.
  const retryable = error?.retryable === true || !Number.isFinite(status);
  if (!retryable) {
    debug('Weather service responded with a failure status', status);
    showErrorState(localization, locationName);
    // No `fallback`: nothing stale was shown, so keep this out of offlineFallbacks.
    recordError({ errorType, errorCode: String(status) });
    recordRenderOutcome(isNewTab, 'error');
    return null;
  }

  // navigator.onLine only says an interface exists, so it labels the failure rather than deciding it.
  scheduleOnlineRetry();
  return applyOfflineFallback(localization, language, unit, {
    errorType: isNavigatorOffline() ? 'offline' : errorType,
    errorCode: String(Number.isFinite(status) ? status : (error?.code ?? 'unknown')),
    locationKey,
    isNewTab
  });
}

/** One page can receive several settings/storage events together; only one refresh may run. */
let refreshWeatherPromise = null;
let queuedRefreshOptions = null;

function queueRefresh(options) {
  const queued = { ...options, isNewTab: false };
  // A user/settings refresh takes precedence over opportunistic background work.
  if (!queuedRefreshOptions || queuedRefreshOptions.background === true || queued.background !== true) {
    queuedRefreshOptions = queued;
  }
}

/**
 * A user refresh abandons a background or refinement pass instead of queuing behind it.
 * Bumping the generation fails the abandoned pass's next check, so it never renders or
 * writes the cache.
 */
let refreshGeneration = 0;
let activeRefresh = null;

function isRefreshPassCurrent(generation) {
  return generation === null || generation === refreshGeneration;
}

function supersedeActiveRefresh() {
  if (!activeRefresh?.preemptible) {
    return false;
  }

  debug('Abandoning background weather work for a user refresh');
  refreshGeneration += 1;
  activeRefresh.release();
  activeRefresh = null;
  return true;
}

/** Called once a foreground pass has rendered; only optional refinement is left. */
function allowRefreshPreemption(generation) {
  if (activeRefresh?.generation !== generation) {
    return;
  }

  activeRefresh.preemptible = true;
  if (queuedRefreshOptions && queuedRefreshOptions.background !== true) {
    supersedeActiveRefresh();
  }
}

function refreshWeather(options = {}) {
  if (refreshWeatherPromise) {
    // A settings-triggered render must eventually use the new setting even if the old
    // render is already awaiting the network. Several changes collapse into one pass.
    if (options.isNewTab === false) {
      queueRefresh(options);
      if (options.background !== true) {
        supersedeActiveRefresh();
      }
    }
    return refreshWeatherPromise;
  }

  const request = (async () => {
    let nextOptions = options;
    while (nextOptions) {
      queuedRefreshOptions = null;
      refreshGeneration += 1;
      const generation = refreshGeneration;
      const superseded = new Promise((resolve) => {
        activeRefresh = { generation, preemptible: nextOptions.background === true, release: resolve };
      });
      const pass = performWeatherRefresh({ ...nextOptions, generation });
      // An abandoned pass still settles later; nothing awaits it then.
      pass.catch(() => {});
      try {
        await Promise.race([pass, superseded]);
      } finally {
        if (activeRefresh?.generation === generation) {
          activeRefresh = null;
        }
      }
      nextOptions = queuedRefreshOptions;
    }
  })().finally(() => {
    refreshWeatherPromise = null;
    queuedRefreshOptions = null;
    activeRefresh = null;
  });
  refreshWeatherPromise = request;
  return request;
}

/** `isNewTab` is false when the page re-renders itself (settings change, unit toggle, online retry). */
async function performWeatherRefresh({
  isNewTab = true,
  background = false,
  cachedWeather = null,
  generation = null
} = {}) {
  const preferredLanguage = getPreferredLanguage();
  const unit = getPreferredUnit();
  const manualLocation = getManualLocation();
  const locationKey = currentLocationKey();
  const usingManualLocation = locationKey !== 'auto';
  const manualLocationName = usingManualLocation
    ? (manualLocation.displayName || manualLocation.name || null)
    : null;

  const localization = await loadLocalization(preferredLanguage);
  const language = localization.language;

  debug('Initialising extension', { resolvedLanguage: language, unit, locationMode: usingManualLocation ? 'manual' : 'auto' });
  if (isNewTab) {
    recordTabOpen();
  }

  initPassport(localization);

  const cached = background
    ? cachedWeather
    : readWeatherCache({ language, unit, locationKey });
  if (!background && cached) {
    debug('Using cached weather data');
    recordRenderOutcome(isNewTab, 'cache_hit', {
      planetId: cached.planetId,
      planet: cached.planetName,
      timeOfDay: cached.timeOfDay
    });
    applyWeatherToUi(cached, localization);

    // Cache-first keeps a new tab instant. Automatic locations are re-checked in the
    // background to catch travel; otherwise only a stale reading is re-fetched early.
    if (!usingManualLocation || isStaleWeatherDue(cached)) {
      refreshWeather({ isNewTab: false, background: true, cachedWeather: cached });
    }
    return;
  }

  // A real new tab honours the shared backoff and goes straight to the last-known
  // reading. Settings changes and the online retry are user-driven and still try.
  if (isNewTab && !background && isBackendBackingOff()) {
    debug('Backend asked clients to wait; using the last-known reading');
    handleWeatherFailure(
      new BackendRequestError('Weather service asked clients to wait', { code: 'backoff', retryable: true }),
      {
        localization,
        language,
        unit,
        locationKey,
        locationName: manualLocationName,
        errorType: usingManualLocation ? 'manual_fetch' : 'auto_fetch',
        isNewTab
      }
    );
    return;
  }

  debug(background ? 'Validating cached weather in the background' : 'No cached weather data available; showing loading state');
  // With a reading on screen the hyperspace wrapper is hidden, so clear the reading instead.
  const quietLoad = !isNewTab && hasRenderedWeather();
  const minimumLoadingMs = quietLoad ? 0 : HYPERSPACE_MIN_MS;
  const loadingStartedAt = Date.now();
  if (!background) {
    showLoadingState(localization, manualLocationName, { quiet: quietLoad });
  }

  // Fetch even when navigator.onLine is false: it reads false on VPN and virtual
  // adapters, which stranded those users on a random planet that re-rolled every tab.

  const failureContext = {
    localization,
    language,
    unit,
    locationKey,
    locationName: manualLocationName,
    isNewTab
  };
  const backgroundContext = {
    preferredLanguage,
    unit,
    locationKey,
    expectedViewModel: background ? cached : null,
    generation
  };

  if (usingManualLocation && manualLocation) {
    if (background
      && ((cached?.locationKey === locationKey && !isStaleWeatherDue(cached)) || isBackendBackingOff())) {
      return;
    }

    try {
      const weatherResponse = await fetchWeather(manualLocation.lat, manualLocation.lon);

      const viewModel = buildViewModel({
        weather: weatherResponse.weather,
        observedAt: weatherResponse.observedAt,
        freshUntil: weatherResponse.freshUntil,
        stale: weatherResponse.stale,
        localization,
        language,
        unit,
        locationKey,
        fallbackLocationName: manualLocation.displayName
          || manualLocation.name
          || formatDisplayName(
            weatherResponse.location?.name,
            weatherResponse.location?.state,
            weatherResponse.location?.country
          )
          || ''
      });

      debug('Constructed view model for manual location');
      if (!background) {
        await waitForMinimumHyperspace(loadingStartedAt, minimumLoadingMs);
      }
      if (background && !isRefreshContextCurrent(backgroundContext)) {
        debug('Discarding superseded background manual-weather result');
        return;
      }
      applyWeatherToUi(viewModel, localization);
      persistSuccessfulWeather(viewModel, localization);
      recordRenderOutcome(isNewTab, 'loaded', {
        planetId: viewModel.planetId,
        planet: viewModel.planetName,
        timeOfDay: viewModel.timeOfDay
      });
    } catch (error) {
      if (background) {
        if (!isRefreshPassCurrent(generation)) {
          return;
        }
        debug('Background manual-weather refresh failed; keeping cached weather', error?.code ?? 'unknown');
        recordError({ errorType: 'background_manual_fetch', errorCode: String(error?.status ?? error?.code ?? 'unknown') });
        scheduleOnlineRetry();
        return;
      }
      console.error('Unable to refresh weather data for manual location', error);
      await waitForMinimumHyperspace(loadingStartedAt, minimumLoadingMs);
      handleWeatherFailure(error, { ...failureContext, errorType: 'manual_fetch' });
    }

    return;
  }

  try {
    const position = background
      ? await requestGeolocation(BACKGROUND_GEOLOCATION_OPTIONS)
      : await resolveLocation(localization);
    debug('Geolocation resolved');
    if (background && !isRefreshContextCurrent(backgroundContext)) {
      debug('Discarding a superseded background location check');
      return;
    }
    const weatherLocation = buildWeatherLocation(position, {
      highAccuracyCheckedAt: cached?.weatherLocation?.highAccuracyCheckedAt
    });

    // Readings cached before 2.5 have no cell; adopt the current one instead of refetching.
    const cachedCell = cached?.weatherLocation?.cell ?? null;
    if (background
      && cached?.locationKey === 'auto'
      && (cachedCell === null
        || cachedCell === weatherLocation.cell
        || isNearWeatherCell(position, cachedCell))
      && !isStaleWeatherDue(cached)) {
      debug('Cached weather still matches the current location');
      const current = cachedCell === null
        ? persistWeatherLocationMetadata(cached, weatherLocation)
        : cached;
      if (shouldRefinePosition(position, current.weatherLocation)) {
        await refineAutomaticWeather(position, current, {
          localization,
          language,
          unit,
          preferredLanguage,
          generation
        });
      }
      return;
    }

    if (background && isBackendBackingOff()) {
      debug('Backend asked clients to wait; keeping cached weather');
      return;
    }

    const viewModel = await fetchAutomaticWeatherViewModel(position, {
      localization,
      language,
      unit,
      previousWeatherLocation: cached?.weatherLocation
    });

    debug('Constructed view model');
    if (!background) {
      await waitForMinimumHyperspace(loadingStartedAt, minimumLoadingMs);
    }
    if (background && !isRefreshContextCurrent(backgroundContext)) {
      debug('Discarding superseded background location/weather result');
      return;
    }
    applyWeatherToUi(viewModel, localization);
    persistSuccessfulWeather(viewModel, localization);
    recordRenderOutcome(isNewTab, 'loaded', {
      planetId: viewModel.planetId,
      planet: viewModel.planetName,
      timeOfDay: viewModel.timeOfDay
    });

    // A poor fast fix gets one GPS-quality refinement after render. Its failure must
    // not reach handleWeatherFailure and repaint the rendered weather as offline.
    allowRefreshPreemption(generation);
    try {
      await refineAutomaticWeather(position, viewModel, {
        localization,
        language,
        unit,
        preferredLanguage,
        generation
      });
    } catch (error) {
      if (!isRefreshPassCurrent(generation)) {
        return;
      }
      debug('Location refinement failed; keeping the rendered weather', error?.code ?? 'unknown');
      recordError({ errorType: 'refine_auto_fetch', errorCode: String(error?.status ?? error?.code ?? 'unknown') });
    }
  } catch (error) {
    if (background) {
      if (!isRefreshPassCurrent(generation)) {
        return;
      }
      debug('Background location/weather validation failed; keeping cached weather', error?.code ?? 'unknown');
      recordError({ errorType: 'background_auto_fetch', errorCode: String(error?.status ?? error?.code ?? 'unknown') });
      scheduleOnlineRetry();
      return;
    }
    console.error('Unable to refresh weather data', error);
    await waitForMinimumHyperspace(loadingStartedAt, minimumLoadingMs);
    handleWeatherFailure(error, { ...failureContext, errorType: 'auto_fetch' });
  }
}

if (SHOULD_INIT) {
  refreshWeather();

  window.addEventListener('storage', (event) => {
    if (WATCHED_SETTINGS.has(event.key)) {
      debug('Settings changed via storage event', event.key);
      refreshWeather({ isNewTab: false });
    }
  });
}

/** `quiet` replaces a reading already on screen, where the hyperspace wrapper is hidden. */
function showLoadingState(localization, locationName = null, { quiet = false } = {}) {
  if (quiet) {
    ['planet', 'center1Text', 'center3Text', 'message', 'description'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        element.innerText = '';
      }
    });
    // Nothing on screen is a reading until this pass renders one.
    currentViewModel = null;
  } else {
    ensureHyperspaceVideo();
  }

  const loadingElement = document.getElementById('loading');
  if (loadingElement) {
    loadingElement.innerText = '';
  }

  updateLocationLabel(localization, locationName);
  updateLastUpdated(localization.getMessage('last_updated_placeholder'));
}

/**
 * Keep the 5 MB animation off the critical path for the common local-cache hit.
 * The empty wrapper is present in index.html so the layout remains stable.
 */
function ensureHyperspaceVideo() {
  const wrapper = document.getElementById('test');
  if (!wrapper) {
    return null;
  }

  const existing = wrapper.querySelector('video');
  if (existing) {
    return existing;
  }

  const video = document.createElement('video');
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  const source = document.createElement('source');
  source.setAttribute('src', HYPERSPACE_VIDEO_PATH);
  source.setAttribute('type', 'video/mp4');
  video.appendChild(source);
  wrapper.appendChild(video);

  return video;
}

function applyWeatherToUi(viewModel, localization) {
  if (!viewModel) {
    return;
  }

  currentViewModel = viewModel;
  currentLocalization = localization;

  const {
    planetClass,
    planetName,
    planetId,
    headingPrefix,
    headingSuffix,
    message,
    description,
    lastUpdated,
    lastUpdatedLabel = null,
    locationName,
    locationKey,
    language,
    unit,
    timeOfDay,
    timeOfDayLabel,
    matchReason = '',
    tempF,
    tempC
  } = viewModel;

  debug('Applying weather to UI', { planetId, timeOfDay });

  hideElementById('test');

  updateBackground(planetClass);
  updatePlanetHeading({ name: planetName, prefix: headingPrefix, suffix: headingSuffix });
  updateMatchReason(matchReason, localization);
  updateMessage(message, viewModel, localization);
  updateDescription(description);
  updateLastUpdated(lastUpdatedLabel || formatLastUpdated(lastUpdated, localization));
  updateLocationLabel(localization, locationName);
  // Reads localStorage inside refreshWeather's try: an unreadable stamp list must not
  // repaint a rendered forecast as the offline fallback.
  try {
    updatePassportUi(localization);
  } catch (error) {
    console.warn('Unable to update the passport for this render', error);
  }
  clearLoadingText();
}

function hasRenderedWeather() {
  return document.getElementById('test')?.style.display === 'none';
}

function hideElementById(id) {
  const element = document.getElementById(id);
  if (element) {
    element.style.display = 'none';
  }
}

function clearLoadingText() {
  const loadingElement = document.getElementById('loading');
  if (loadingElement) {
    loadingElement.innerText = '';
  }
}

/**
 * Terminal state for a service failure. Clears anything that could read as the
 * current sky (video, planet, leftover heading) so old data is not passed off as today's.
 */
function showErrorState(localization, locationName = null) {
  hideElementById('test');

  ['planet', 'center1Text', 'center3Text', 'description', 'loading'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) {
      element.innerText = '';
    }
  });

  const messageElement = document.getElementById('message');
  if (messageElement) {
    messageElement.innerText = localization.getMessage('error_weather_unavailable') || 'Unable to retrieve weather data right now.';
  }

  // Nothing on screen is a reading any more, so a unit toggle must reload.
  currentViewModel = null;
  currentLocalization = localization;

  updateLocationLabel(localization, locationName);
  updateLastUpdated(localization.getMessage('last_updated_placeholder'));
}

async function resolveLocation(localization) {
  if (!('geolocation' in navigator)) {
    debug('Geolocation API unavailable');
    return Promise.reject(new Error('Geolocation API is not available.'));
  }

  const errorMessage = localization.getMessage('alert_geolocation_error') || 'Unable to retrieve your location. Please enable location services for this extension. Check the FAQ for more information.';

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, async (error) => {
      debug('Geolocation error', error);
      recordError({ errorType: 'geolocation', errorCode: String(error.code || 'unknown') });
      if (!hasShownGeolocationError() && !isOnboardingComplete()) {
        alert(errorMessage);
        markGeolocationAlerted();
      }

      try {
        const retryPosition = await requestGeolocation();
        debug('Geolocation retry succeeded');
        resolve(retryPosition);
      } catch (retryError) {
        debug('Geolocation retry failed', retryError);
        reject(retryError);
      }
    }, GEOLOCATION_OPTIONS);
  });
}

function requestGeolocation(options = GEOLOCATION_OPTIONS) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function fetchWeather(latitude, longitude) {
  recordWeatherCall();
  try {
    const response = await getWeather(latitude, longitude);
    noteBackendSuccess();
    return response;
  } catch (error) {
    noteBackendFailure(error);
    throw error;
  }
}

async function fetchAutomaticWeatherViewModel(position, {
  localization,
  language,
  unit,
  previousWeatherLocation = null,
  highAccuracyCheckedAt = null
}) {
  const { latitude, longitude } = position.coords;
  // Run in parallel. Place details are optional: the weather response carries a
  // city/country fallback.
  const [weatherResponse, details] = await Promise.all([
    fetchWeather(latitude, longitude),
    fetchLocationDetails(latitude, longitude).catch((locationError) => {
      debug('Reverse geocoding lookup failed', locationError?.code ?? 'unknown');
      return null;
    })
  ]);

  const fallbackLocationName = details
    ? formatDisplayName(details.name ?? '', details.state ?? '', details.country ?? '')
    : formatDisplayName(
      weatherResponse.location?.name,
      weatherResponse.location?.state,
      weatherResponse.location?.country
    );

  const cell = buildWeatherCoordinateKey(latitude, longitude);
  // A previous high-accuracy check only carries over while the cell is unchanged.
  const inheritedHighAccuracyCheck = previousWeatherLocation?.cell === cell
    ? previousWeatherLocation.highAccuracyCheckedAt
    : null;

  return buildViewModel({
    weather: weatherResponse.weather,
    observedAt: weatherResponse.observedAt,
    freshUntil: weatherResponse.freshUntil,
    stale: weatherResponse.stale,
    localization,
    language,
    unit,
    locationKey: 'auto',
    fallbackLocationName,
    weatherLocation: buildWeatherLocation(position, {
      highAccuracyCheckedAt: highAccuracyCheckedAt ?? inheritedHighAccuracyCheck
    })
  });
}

function persistWeatherLocationMetadata(viewModel, weatherLocation) {
  if (currentViewModel !== viewModel) {
    return viewModel;
  }

  const updated = { ...viewModel, weatherLocation };
  currentViewModel = updated;
  safeStorageWrite('weather cache refinement metadata', () => writeWeatherCache(updated));
  return updated;
}

async function refineAutomaticWeather(initialPosition, initialViewModel, {
  localization,
  language,
  unit,
  preferredLanguage,
  generation = null
}) {
  let activePosition = initialPosition;
  let activeViewModel = initialViewModel;
  let freshStandardFailed = false;
  const contextIsCurrent = (viewModel) => isRefreshContextCurrent({
    preferredLanguage,
    unit,
    locationKey: 'auto',
    expectedViewModel: viewModel,
    generation
  });
  if (!contextIsCurrent(activeViewModel)) {
    return activeViewModel;
  }

  // The foreground may use a browser-cached position. Once weather is visible,
  // replace one older than two minutes before deciding whether to refine.
  if (isPositionStale(activePosition)) {
    try {
      const freshPosition = await requestGeolocation(BACKGROUND_GEOLOCATION_OPTIONS);
      if (!contextIsCurrent(activeViewModel)) {
        return activeViewModel;
      }

      const freshWeatherLocation = buildWeatherLocation(freshPosition, {
        highAccuracyCheckedAt: activeViewModel.weatherLocation?.highAccuracyCheckedAt
      });
      const activeCell = activeViewModel.weatherLocation?.cell;
      if (freshWeatherLocation.cell === activeCell || isNearWeatherCell(freshPosition, activeCell)) {
        // The cell stays anchored to the reading, so jitter back across the edge is a no-op too.
        activeViewModel = persistWeatherLocationMetadata(activeViewModel, {
          ...freshWeatherLocation,
          cell: activeCell
        });
      } else {
        const freshViewModel = await fetchAutomaticWeatherViewModel(freshPosition, {
          localization,
          language,
          unit,
          previousWeatherLocation: activeViewModel.weatherLocation
        });
        if (!contextIsCurrent(activeViewModel)) {
          return activeViewModel;
        }
        debug('Applying a fresh standard-location weather result');
        applyWeatherToUi(freshViewModel, localization);
        persistSuccessfulWeather(freshViewModel, localization);
        activeViewModel = freshViewModel;
      }
      activePosition = freshPosition;
    } catch (error) {
      freshStandardFailed = true;
      debug('Fresh standard-location background check unavailable', error?.code ?? 'unknown');
    }
  }

  if (!contextIsCurrent(activeViewModel)) {
    return activeViewModel;
  }

  if (!shouldRefinePosition(
    activePosition,
    activeViewModel.weatherLocation,
    Date.now(),
    freshStandardFailed
  )) {
    return activeViewModel;
  }

  const checkedAt = new Date().toISOString();
  let refinedPosition;
  try {
    refinedPosition = await requestGeolocation(HIGH_ACCURACY_GEOLOCATION_OPTIONS);
  } catch (error) {
    debug('High-accuracy background refinement unavailable', error?.code ?? 'unknown');
    if (!contextIsCurrent(activeViewModel)) {
      return activeViewModel;
    }
    return persistWeatherLocationMetadata(activeViewModel, {
      ...activeViewModel.weatherLocation,
      highAccuracyCheckedAt: checkedAt
    });
  }

  if (!contextIsCurrent(activeViewModel)) {
    return activeViewModel;
  }

  if (!isMateriallyBetterPosition(activePosition, refinedPosition)) {
    debug('High-accuracy result did not materially improve the position');
    return persistWeatherLocationMetadata(activeViewModel, {
      ...activeViewModel.weatherLocation,
      highAccuracyCheckedAt: checkedAt
    });
  }

  const refinedWeatherLocation = buildWeatherLocation(refinedPosition, {
    highAccuracyCheckedAt: checkedAt
  });
  if (refinedWeatherLocation.cell === activeViewModel.weatherLocation?.cell) {
    debug('High-accuracy result stayed inside the current weather cell');
    return persistWeatherLocationMetadata(activeViewModel, refinedWeatherLocation);
  }

  try {
    const refinedViewModel = await fetchAutomaticWeatherViewModel(refinedPosition, {
      localization,
      language,
      unit,
      highAccuracyCheckedAt: checkedAt
    });
    if (!contextIsCurrent(activeViewModel)) {
      return activeViewModel;
    }
    debug('Applying refined weather location');
    applyWeatherToUi(refinedViewModel, localization);
    persistSuccessfulWeather(refinedViewModel, localization);
    return refinedViewModel;
  } catch (error) {
    debug('Refined weather request failed; keeping the fast result', error?.code ?? 'unknown');
    if (!contextIsCurrent(activeViewModel)) {
      return activeViewModel;
    }
    return persistWeatherLocationMetadata(activeViewModel, {
      ...activeViewModel.weatherLocation,
      highAccuracyCheckedAt: checkedAt
    });
  }
}

function buildViewModel({
  weather,
  observedAt = null,
  freshUntil = null,
  stale = false,
  localization,
  language,
  unit,
  locationKey,
  fallbackLocationName,
  weatherLocation = null
}) {
  const now = new Date();
  const temperature = weather?.main?.temp;
  const weatherMain = weather?.weather?.[0]?.main;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    throw new Error('Weather payload has no valid temperature');
  }
  if (typeof weatherMain !== 'string' || !weatherMain.trim()) {
    throw new Error('Weather payload has no valid condition');
  }

  const weatherDescription = weather.weather?.[0]?.description ?? '';
  const tempF = Math.round(temperature);
  const tempC = Math.round((((tempF - 32) * 5) / 9) * 2) / 2;
  const humidity = Number.isFinite(weather.main?.humidity) ? weather.main.humidity : 0;
  const windSpeedMph = Number.isFinite(weather.wind?.speed) ? weather.wind.speed : 0;
  const sunTimes = extractSunTimes(weather);
  const timeOfDay = resolveTimeOfDay(now, localization, sunTimes);
  const locationName = resolveLocationName(weather, fallbackLocationName);
  const observationTime = observedAt && Number.isFinite(Date.parse(observedAt))
    ? new Date(observedAt)
    : now;
  const parsedFreshUntil = parseFiniteTimestamp(freshUntil);

  const matchContext = {
    tempF,
    weatherMain,
    weatherDescription,
    humidity,
    windSpeedMph
  };

  const planetRule = selectPlanetRule(matchContext);
  const reasonKey = explainMatch(planetRule, matchContext);

  const planetKeyBase = `planet_${planetRule.id}`;
  const descriptionKey = `${planetKeyBase}_description`;
  const nameKey = `${planetKeyBase}_name`;

  const message = buildSummaryMessage({
    planetId: planetRule.id,
    tempF,
    tempC,
    unit,
    timeOfDayLabel: timeOfDay.label
  }, localization);
  const description = localization.getMessage(descriptionKey) || '';
  const planetDisplayName = localization.getMessage(nameKey) || planetRule.name;
  const matchReason = localization.getMessage(reasonKey) || '';

  return {
    planetId: planetRule.id,
    planetClass: selectBackground(planetRule, timeOfDay.id, timeOfDay.isDaytime),
    planetName: planetDisplayName,
    headingPrefix: localization.getMessage('center_heading_prefix') || "IT'S LIKE",
    headingSuffix: localization.getMessage('center_heading_suffix') || 'OUTSIDE',
    message,
    description,
    lastUpdated: observationTime.toISOString(),
    lastUpdatedLabel: formatLastUpdated(observationTime, localization),
    // The fetch time travels with the reading, so re-persisting it (unit toggle,
    // location metadata) cannot hand an old reading a fresh one-hour TTL.
    cachedAt: now.toISOString(),
    ...(parsedFreshUntil !== null ? { freshUntil: new Date(parsedFreshUntil).toISOString() } : {}),
    ...(stale === true ? { stale: true } : {}),
    locationKey,
    locationName,
    ...(weatherLocation ? { weatherLocation } : {}),
    language,
    unit,
    tempF,
    tempC,
    timeOfDay: timeOfDay.id,
    timeOfDayLabel: timeOfDay.label,
    sunrise: sunTimes?.sunrise ?? null,
    sunset: sunTimes?.sunset ?? null,
    timezoneOffset: sunTimes?.timezoneOffset ?? null,
    matchReason
  };
}

function formatTemperatureLabel(tempF, tempC, unit) {
  return unit === 'celsius'
    ? `${tempC}${DEGREE_SYMBOL}C`
    : `${tempF}${DEGREE_SYMBOL}F`;
}

function getOppositeUnit(unit) {
  return unit === 'celsius' ? 'fahrenheit' : 'celsius';
}

/**
 * Derives only from the persisted temperatures, so a stored view model can be
 * re-rendered in the current language and unit. Null for payloads written before that.
 */
function buildSummaryMessage({ planetId, tempF, tempC, unit, timeOfDayLabel }, localization) {
  if (typeof tempF !== 'number' || typeof tempC !== 'number') {
    return null;
  }

  const temperature = formatTemperatureLabel(tempF, tempC, unit);
  const summaryKey = `planet_${planetId || DEFAULT_PLANET_RULE.id}_summary`;
  return localization?.getMessage(summaryKey, [temperature, timeOfDayLabel || '']) || temperature;
}

function rebuildViewModelForUnit(viewModel, unit, localization) {
  if (!viewModel) {
    return null;
  }

  const message = buildSummaryMessage({
    planetId: viewModel.planetId,
    tempF: viewModel.tempF,
    tempC: viewModel.tempC,
    unit,
    timeOfDayLabel: viewModel.timeOfDayLabel
  }, localization);

  if (!message) {
    return null;
  }

  return {
    ...viewModel,
    unit,
    message
  };
}

async function handleTempToggle() {
  const currentUnit = getPreferredUnit();
  const nextUnit = getOppositeUnit(currentUnit);
  setPreferredUnit(nextUnit);
  clearWeatherCache();
  track('setting_changed', { setting: 'unit', value: nextUnit, surface: 'newtab' });

  if (currentViewModel && currentLocalization) {
    const rebuilt = rebuildViewModelForUnit(currentViewModel, nextUnit, currentLocalization);
    if (rebuilt) {
      applyWeatherToUi(rebuilt, currentLocalization);

      // Only a live reading may be re-cached. An offline fallback in the TTL cache
      // hands the next tab a cache hit on "Sensors offline" with no refresh attempt.
      if (!rebuilt.offline) {
        safeStorageWrite('weather cache', () => writeWeatherCache(rebuilt));
      }

      // Last-known moves either way, or the next offline load re-renders the temperature
      // in the old unit. Offline presentation is rebuilt per render, so it is dropped.
      const { offline, lastUpdatedLabel, weatherLocation, ...lastKnown } = rebuilt;
      safeStorageWrite('last known weather', () => writeLastKnownWeather(lastKnown));
      return;
    }
  }

  await refreshWeather({ isNewTab: false });
}

function selectPlanetRule(context) {
  const matchedRule = PLANET_RULES.find((rule) => rule.predicate(context)) ?? DEFAULT_PLANET_RULE;

  if (DEBUG_FORCE_PLANET_ID) {
    const overrideRule = PLANET_RULES.find((rule) => rule.id === DEBUG_FORCE_PLANET_ID);
    if (overrideRule) {
      debug('Forcing planet override', DEBUG_FORCE_PLANET_ID);
      return overrideRule;
    }
  }

  return matchedRule;
}

/** Sunrise/sunset as unix UTC seconds, from a backend weather payload or a persisted view model. */
function extractSunTimes(source) {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const sunrise = Number(source.sys?.sunrise ?? source.sunrise);
  const sunset = Number(source.sys?.sunset ?? source.sunset);
  if (!Number.isFinite(sunrise) || !Number.isFinite(sunset) || sunset === sunrise) {
    return null;
  }

  const timezoneOffset = Number(source.timezone ?? source.timezoneOffset);
  return {
    sunrise,
    sunset,
    timezoneOffset: Number.isFinite(timezoneOffset) ? timezoneOffset : null
  };
}

function resolveTimezoneOffsetSeconds(date, timezoneOffset) {
  if (Number.isFinite(timezoneOffset)) {
    return timezoneOffset;
  }

  // Device offset is minutes west of UTC; callers want seconds east.
  return -date.getTimezoneOffset() * 60;
}

function secondsOfDay(unixSeconds, timezoneOffsetSeconds) {
  const localSeconds = unixSeconds + timezoneOffsetSeconds;
  return ((localSeconds % 86400) + 86400) % 86400;
}

/**
 * Seconds-of-day, so persisted sunrise/sunset stay usable offline on later days.
 * Null when sun times are unavailable; caller falls back to hour buckets.
 */
function resolveIsDaytime(date, sunTimes) {
  if (!sunTimes) {
    return null;
  }

  const tz = resolveTimezoneOffsetSeconds(date, sunTimes.timezoneOffset);
  const nowSod = secondsOfDay(Math.floor(date.getTime() / 1000), tz);
  const sunriseSod = secondsOfDay(sunTimes.sunrise, tz);
  const sunsetSod = secondsOfDay(sunTimes.sunset, tz);

  if (sunriseSod < sunsetSod) {
    return nowSod >= sunriseSod && nowSod < sunsetSod;
  }

  // Polar / wrap-around: day is anything outside the night window.
  return nowSod >= sunriseSod || nowSod < sunsetSod;
}

function localHourForSunTimes(date, sunTimes) {
  if (!sunTimes || !Number.isFinite(sunTimes.timezoneOffset)) {
    return date.getHours();
  }

  const localMs = date.getTime() + sunTimes.timezoneOffset * 1000;
  return new Date(localMs).getUTCHours();
}

function selectBackground(rule, timeOfDay, isDaytime = null) {
  const daytime = typeof isDaytime === 'boolean'
    ? isDaytime
    : (timeOfDay === 'morning' || timeOfDay === 'afternoon');
  return daytime
    ? (rule.backgrounds.day ?? rule.backgrounds.night)
    : (rule.backgrounds.night ?? rule.backgrounds.day);
}

function resolveTimeOfDayByHour(date, localization) {
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) {
    return {
      id: 'morning',
      label: localization.getMessage('time_of_day_morning') || 'Morning',
      isDaytime: true
    };
  }

  if (hour >= 12 && hour < 17) {
    return {
      id: 'afternoon',
      label: localization.getMessage('time_of_day_afternoon') || 'Afternoon',
      isDaytime: true
    };
  }

  if (hour >= 17 && hour <= 20) {
    return {
      id: 'evening',
      label: localization.getMessage('time_of_day_evening') || 'Evening',
      isDaytime: false
    };
  }

  if (hour > 0 && hour < 5) {
    return {
      id: 'night',
      label: localization.getMessage('time_of_day_pre_dawn') || 'Late Night',
      isDaytime: false
    };
  }

  return {
    id: 'night',
    label: localization.getMessage('time_of_day_night') || 'Night',
    isDaytime: false
  };
}

/**
 * With sun times, day/night for the background art follows the sun and labels are
 * refined against it. Without them, falls back to hour buckets.
 */
function resolveTimeOfDay(date, localization, sunTimes = null) {
  const isDaytime = resolveIsDaytime(date, sunTimes);
  if (isDaytime === null) {
    return resolveTimeOfDayByHour(date, localization);
  }

  const hour = localHourForSunTimes(date, sunTimes);
  const tz = resolveTimezoneOffsetSeconds(date, sunTimes.timezoneOffset);
  const nowSod = secondsOfDay(Math.floor(date.getTime() / 1000), tz);
  const sunsetSod = secondsOfDay(sunTimes.sunset, tz);
  const secondsUntilSunset = (sunsetSod - nowSod + 86400) % 86400;
  const eveningWindowSec = 3 * 60 * 60;
  // On the 3h window alone, a December sunset makes lunchtime "Evening": Boston sets
  // at 16:15, Stockholm at 14:48, leaving "Afternoon" unreachable for months.
  const eveningEarliestHour = 15;
  // But Stockholm sets before 15:00 for ~2 months, so the clock floor alone would kill
  // "Evening" there. The last stretch of daylight is evening whatever the hour.
  const eveningSunsetFloorSec = 45 * 60;

  if (!isDaytime) {
    if (hour > 0 && hour < 5) {
      return {
        id: 'night',
        label: localization.getMessage('time_of_day_pre_dawn') || 'Late Night',
        isDaytime: false
      };
    }

    return {
      id: 'night',
      label: localization.getMessage('time_of_day_night') || 'Night',
      isDaytime: false
    };
  }

  // hour >= 17 catches long summer days where sunset is still hours away
  if (
    secondsUntilSunset <= eveningSunsetFloorSec
    || (secondsUntilSunset <= eveningWindowSec && hour >= eveningEarliestHour)
    || hour >= 17
  ) {
    return {
      id: 'evening',
      label: localization.getMessage('time_of_day_evening') || 'Evening',
      isDaytime: true
    };
  }

  if (hour >= 12) {
    return {
      id: 'afternoon',
      label: localization.getMessage('time_of_day_afternoon') || 'Afternoon',
      isDaytime: true
    };
  }

  return {
    id: 'morning',
    label: localization.getMessage('time_of_day_morning') || 'Morning',
    isDaytime: true
  };
}

function updateBackground(planetClass) {
  const element = document.getElementById('background');
  if (element && planetClass) {
    element.className = planetClass;
  }
}

function updatePlanetHeading({ name, prefix, suffix }) {
  const planetElement = document.getElementById('planet');
  const center1Element = document.getElementById('center1Text');
  const center3Element = document.getElementById('center3Text');

  if (planetElement && name) {
    planetElement.innerText = name.toUpperCase();
  }

  if (center1Element) {
    center1Element.innerText = prefix || "IT'S LIKE";
  }

  if (center3Element) {
    center3Element.innerText = suffix || 'OUTSIDE';
  }
}

function updateMatchReason(_matchReason, _localization) {
  // Match reason stays in the view model for tests/analytics; it is not shown in the UI.
}

function updateMessage(message, viewModel = null, localization = null) {
  const element = document.getElementById('message');
  if (!element || typeof message !== 'string') {
    return;
  }

  const tempF = viewModel?.tempF;
  const tempC = viewModel?.tempC;
  const unit = viewModel?.unit ?? getPreferredUnit();
  const canWrap = typeof tempF === 'number' && typeof tempC === 'number';
  const temperature = canWrap ? formatTemperatureLabel(tempF, tempC, unit) : null;

  if (!temperature || !message.includes(temperature)) {
    element.innerText = message;
    return;
  }

  const hint = localization?.getMessage('temp_toggle_hint') || 'Click to switch units';
  const buttonHtml = `<button type="button" class="temp-toggle" title="${hint}" aria-label="${hint}">${temperature}</button>`;
  element.innerHTML = message.replace(temperature, buttonHtml);

  const toggle = element.querySelector('.temp-toggle');
  if (toggle) {
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      handleTempToggle();
    });
  }
}

function updateDescription(description) {
  const element = document.getElementById('description');
  if (element && typeof description === 'string') {
    element.innerText = description;
  }
}

function updateLastUpdated(label) {
  const lastUpdatedElement = document.getElementById('LastUpdated');
  if (!lastUpdatedElement) {
    return;
  }

  lastUpdatedElement.innerText = label ?? '';
}

function updateLocationLabel(localization, locationName) {
  const element = document.getElementById('locationLabel');
  if (!element) {
    return;
  }

  if (locationName) {
    element.innerText = localization.getMessage('location_display', [locationName]) || `Showing weather in: ${locationName}`;
    return;
  }

  element.innerText = localization.getMessage('location_display_unknown') || 'Showing weather in: your area';
}

function formatLastUpdated(timestamp, localization) {
  const placeholder = localization.getMessage('last_updated_placeholder') || 'Last Updated: --';

  if (!timestamp) {
    return placeholder;
  }

  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    return placeholder;
  }

  const locale = localization.language || 'en';
  const now = new Date();
  const sameDay = now.toDateString() === parsed.toDateString();

  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit'
  });

  const time = timeFormatter.format(parsed);

  if (sameDay) {
    return localization.getMessage('last_updated_time', [time]) || placeholder;
  }

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric'
  });

  const date = dateFormatter.format(parsed);
  return localization.getMessage('last_updated_date_time', [date, time]) || placeholder;
}

function resolveLocationName(weather, fallbackLocationName) {
  if (fallbackLocationName && fallbackLocationName.trim()) {
    return fallbackLocationName.trim();
  }

  const name = weather?.name ? weather.name.trim() : '';
  const country = weather?.sys?.country ? weather.sys.country.trim() : '';
  const state = weather?.sys?.state ? weather.sys.state.trim() : '';

  return formatDisplayName(name, state, country);
}

function formatDisplayName(name, state, country) {
  const cleanedName = (name ?? '').trim();
  const cleanedState = (state ?? '').trim();
  const cleanedCountry = (country ?? '').trim();

  if (!cleanedName) {
    return '';
  }

  const parts = [cleanedName];
  if (cleanedCountry && cleanedCountry.toUpperCase() === 'US') {
    const abbr = stateToAbbreviation(cleanedState);
    if (abbr) {
      parts.push(abbr);
    }
    return parts.join(', ');
  }

  if (cleanedState && cleanedState.toLowerCase() !== cleanedName.toLowerCase()) {
    parts.push(cleanedState);
  }

  if (cleanedCountry) {
    parts.push(cleanedCountry);
  }

  return parts.join(', ');
}

export {
  applyOfflineFallback,
  applyWeatherToUi,
  buildManualLocationKey,
  buildOfflineRandomViewModel,
  buildViewModel,
  ensureHyperspaceVideo,
  explainMatch,
  extractSunTimes,
  fetchLocationDetails,
  fetchWeather,
  formatDisplayName,
  formatLastUpdated,
  formatTemperatureLabel,
  getOppositeUnit,
  handleTempToggle,
  isNavigatorOffline,
  persistSuccessfulWeather,
  rebuildViewModelForUnit,
  refreshWeather,
  rehydrateLastKnownViewModel,
  requestGeolocation,
  resolveIsDaytime,
  resolveLocation,
  resolveLocationName,
  resolveTimeOfDay,
  selectBackground,
  selectPlanetRule,
  showErrorState,
  showLoadingState,
  stateToAbbreviation,
  updateLocationLabel,
  updateMatchReason,
  updateMessage,
  waitForMinimumHyperspace
};
