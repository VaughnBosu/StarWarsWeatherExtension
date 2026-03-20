import {
  clearGeolocationAlerted,
  getManualLocation,
  getPreferredLanguage,
  getPreferredUnit,
  hasShownGeolocationError,
  markGeolocationAlerted,
  readWeatherCache,
  STORAGE_KEYS,
  writeWeatherCache
} from './storage.js';
import { loadLocalization } from './i18n.js';
import { stateToAbbreviation } from './geo.js';
import { PLANET_RULES, DEFAULT_PLANET_RULE } from './planets.js';
import { WEATHER_ENDPOINT, GEOCODING_REVERSE_ENDPOINT, GEOLOCATION_OPTIONS, DEGREE_SYMBOL } from './config.js';

const DEBUG = true;
const DEBUG_FORCE_PLANET_ID = null; // Set to null to disable

const SHOULD_INIT = !(typeof globalThis !== 'undefined' && globalThis.__SWW_SKIP_INIT__ === true);

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

const WATCHED_SETTINGS = new Set([
  STORAGE_KEYS.unit,
  STORAGE_KEYS.language,
  STORAGE_KEYS.manualLocation
]);

async function refreshWeather() {
  const preferredLanguage = getPreferredLanguage();
  const unit = getPreferredUnit();
  const manualLocation = getManualLocation();
  const manualLocationKey = manualLocation ? buildManualLocationKey(manualLocation) : null;
  const usingManualLocation = Boolean(manualLocation && manualLocationKey && manualLocationKey !== 'manual:invalid');
  const locationKey = usingManualLocation ? manualLocationKey : 'auto';

  const localization = await loadLocalization(preferredLanguage);
  const language = localization.language;

  debug('Initialising extension', { preferredLanguage, resolvedLanguage: language, unit, manualLocation, locationKey });

  const cached = readWeatherCache({ language, unit, locationKey });
  if (cached) {
    debug('Using cached weather data', cached);
    applyWeatherToUi(cached, localization);
    return;
  }

  debug('No cached weather data available; showing loading state');
  showLoadingState(localization, usingManualLocation ? (manualLocation.displayName || manualLocation.name || null) : null);

  if (usingManualLocation && manualLocation) {
    try {
      const weather = await fetchWeather(manualLocation.lat, manualLocation.lon);
      debug('Weather payload received (manual location)', weather);

      const viewModel = buildViewModel({
        weather,
        localization,
        language,
        unit,
        locationKey,
        fallbackLocationName: manualLocation.displayName || manualLocation.name || ''
      });

      debug('Constructed view model (manual location)', viewModel);
      applyWeatherToUi(viewModel, localization);
      writeWeatherCache(viewModel);
      clearGeolocationAlerted();
    } catch (error) {
      console.error('Unable to refresh weather data for manual location', error);
      showErrorState(localization, manualLocation.displayName || manualLocation.name || null);
    }

    return;
  }

  try {
    const position = await resolveLocation(localization);
    debug('Geolocation resolved', position);
    const weather = await fetchWeather(position.coords.latitude, position.coords.longitude);
    debug('Weather payload received', weather);

    let fallbackLocationName = '';
    try {
      const details = await fetchLocationDetails(position.coords.latitude, position.coords.longitude);
      if (details) {
        fallbackLocationName = formatDisplayName(details.name ?? '', details.state ?? '', details.country ?? '');
      }
    } catch (locationError) {
      debug('Reverse geocoding lookup failed', locationError);
    }

    const viewModel = buildViewModel({
      weather,
      localization,
      language,
      unit,
      locationKey: 'auto',
      fallbackLocationName
    });

    debug('Constructed view model', viewModel);
    applyWeatherToUi(viewModel, localization);
    writeWeatherCache(viewModel);
    clearGeolocationAlerted();
  } catch (error) {
    console.error('Unable to refresh weather data', error);
    showErrorState(localization);
  }
}

if (SHOULD_INIT) {
  refreshWeather();

  window.addEventListener('storage', (event) => {
    if (WATCHED_SETTINGS.has(event.key)) {
      debug('Settings changed via storage event', event.key);
      refreshWeather();
    }
  });
}

function showLoadingState(localization, locationName = null) {
  const loadingElement = document.getElementById('loading');
  if (loadingElement) {
    loadingElement.innerText = '';
  }

  updateLocationLabel(localization, locationName);
  updateLastUpdated(localization.getMessage('last_updated_placeholder'));
}

function applyWeatherToUi(viewModel, localization) {
  if (!viewModel) {
    return;
  }

  const {
    planetClass,
    planetName,
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
    timeOfDayLabel
  } = viewModel;

  debug('Applying weather to UI', {
    planetClass,
    planetName,
    headingPrefix,
    headingSuffix,
    message,
    description,
    lastUpdated,
    locationName,
    locationKey,
    language,
    unit,
    timeOfDay,
    timeOfDayLabel
  });

  hideElementById('test');

  updateBackground(planetClass);
  updatePlanetHeading({ name: planetName, prefix: headingPrefix, suffix: headingSuffix });
  updateMessage(message);
  updateDescription(description);
  updateLastUpdated(lastUpdatedLabel || formatLastUpdated(lastUpdated, localization));
  updateLocationLabel(localization, locationName);
  clearLoadingText();
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

function showErrorState(localization, locationName = null) {
  const messageElement = document.getElementById('message');
  if (messageElement) {
    messageElement.innerText = localization.getMessage('error_weather_unavailable') || 'Unable to retrieve weather data right now.';
  }

  const descriptionElement = document.getElementById('description');
  if (descriptionElement) {
    descriptionElement.innerText = '';
  }

  const loadingElement = document.getElementById('loading');
  if (loadingElement) {
    loadingElement.innerText = '';
  }

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
      if (!hasShownGeolocationError()) {
        alert(errorMessage);
        markGeolocationAlerted();
      }

      try {
        const retryPosition = await requestGeolocation();
        debug('Geolocation retry succeeded', retryPosition);
        resolve(retryPosition);
      } catch (retryError) {
        debug('Geolocation retry failed', retryError);
        reject(retryError);
      }
    }, GEOLOCATION_OPTIONS);
  });
}

function requestGeolocation() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, GEOLOCATION_OPTIONS);
  });
}

async function fetchWeather(latitude, longitude) {
  const url = new URL(WEATHER_ENDPOINT);
  url.searchParams.set('lat', latitude);
  url.searchParams.set('lon', longitude);
  url.searchParams.set('appid', API_KEY);
  url.searchParams.set('units', 'imperial');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Weather request failed with status ${response.status}`);
  }

  return response.json();
}

function buildViewModel({ weather, localization, language, unit, locationKey, fallbackLocationName }) {
  const now = new Date();
  const weatherMain = weather.weather?.[0]?.main ?? 'Clear';
  const weatherDescription = weather.weather?.[0]?.description ?? '';
  const tempF = Math.round(weather.main?.temp ?? 0);
  const tempC = Math.round((((tempF - 32) * 5) / 9) * 2) / 2;
  const humidity = weather.main?.humidity ?? 0;
  const windSpeedMph = weather.wind?.speed ?? 0;
  const timeOfDay = resolveTimeOfDay(now, localization);
  const locationName = resolveLocationName(weather, fallbackLocationName);

  const planetRule = selectPlanetRule({
    tempF,
    weatherMain,
    weatherDescription,
    humidity,
    windSpeedMph
  });

  const usesCelsius = unit === 'celsius';
  const temperature = usesCelsius ? `${tempC}${DEGREE_SYMBOL}C` : `${tempF}${DEGREE_SYMBOL}F`;

  const planetKeyBase = `planet_${planetRule.id}`;
  const summaryKey = `${planetKeyBase}_summary`;
  const descriptionKey = `${planetKeyBase}_description`;
  const nameKey = `${planetKeyBase}_name`;

  const message = localization.getMessage(summaryKey, [temperature, timeOfDay.label]) || `${temperature}`;
  const description = localization.getMessage(descriptionKey) || '';
  const planetDisplayName = localization.getMessage(nameKey) || planetRule.name;

  return {
    planetClass: selectBackground(planetRule, timeOfDay.id),
    planetName: planetDisplayName,
    headingPrefix: localization.getMessage('center_heading_prefix') || "IT'S LIKE",
    headingSuffix: localization.getMessage('center_heading_suffix') || 'OUTSIDE',
    message,
    description,
    lastUpdated: now.toISOString(),
    lastUpdatedLabel: formatLastUpdated(now, localization),
    locationKey,
    locationName,
    language,
    unit,
    timeOfDay: timeOfDay.id,
    timeOfDayLabel: timeOfDay.label
  };
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

function selectBackground(rule, timeOfDay) {
  const isDaytime = timeOfDay === 'morning' || timeOfDay === 'afternoon';
  return isDaytime ? (rule.backgrounds.day ?? rule.backgrounds.night) : (rule.backgrounds.night ?? rule.backgrounds.day);
}

function resolveTimeOfDay(date, localization) {
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) {
    return { id: 'morning', label: localization.getMessage('time_of_day_morning') || 'Morning' };
  }

  if (hour >= 12 && hour < 17) {
    return { id: 'afternoon', label: localization.getMessage('time_of_day_afternoon') || 'Afternoon' };
  }

  if (hour >= 17 && hour <= 20) {
    return { id: 'evening', label: localization.getMessage('time_of_day_evening') || 'Evening' };
  }

  if (hour > 0 && hour < 5) {
    return { id: 'night', label: localization.getMessage('time_of_day_pre_dawn') || 'Late Night' };
  }

  return { id: 'night', label: localization.getMessage('time_of_day_night') || 'Night' };
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

function updateMessage(message) {
  const element = document.getElementById('message');
  if (element && typeof message === 'string') {
    element.innerText = message;
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

async function fetchLocationDetails(latitude, longitude) {
  if (typeof API_KEY === 'undefined') {
    throw new Error('API key is not available');
  }

  const url = new URL(GEOCODING_REVERSE_ENDPOINT);
  url.searchParams.set('lat', latitude);
  url.searchParams.set('lon', longitude);
  url.searchParams.set('limit', '1');
  url.searchParams.set('appid', API_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Reverse geocoding failed with status ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

export {
  applyWeatherToUi,
  buildManualLocationKey,
  buildViewModel,
  fetchLocationDetails,
  fetchWeather,
  formatDisplayName,
  formatLastUpdated,
  refreshWeather,
  requestGeolocation,
  resolveLocation,
  resolveLocationName,
  resolveTimeOfDay,
  selectBackground,
  selectPlanetRule,
  showErrorState,
  showLoadingState,
  stateToAbbreviation,
  updateLocationLabel
};
