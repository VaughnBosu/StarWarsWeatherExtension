import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createLocalizationMock, installDom, teardownDom } from './testUtils.js';

globalThis.__SWW_SKIP_INIT__ = true;

let app = null;

beforeAll(async () => {
  app = await import('../app.js');
});

beforeEach(() => {
  installDom(`
    <div id="background"></div>
    <div id="test"></div>
    <div id="planet"></div>
    <div id="center1Text"></div>
    <div id="center3Text"></div>
    <div id="message"></div>
    <div id="description"></div>
    <div id="LastUpdated"></div>
    <div id="locationLabel"></div>
    <div id="loading"></div>
  `);
});

afterEach(() => {
  teardownDom();
});

describe('app DOM updates', () => {
  test('applyWeatherToUi updates core elements', () => {
    const localization = createLocalizationMock({
      location_display: { message: 'Showing weather in: $1' },
      last_updated_placeholder: { message: 'Last Updated: --' }
    });

    app.applyWeatherToUi({
      planetClass: 'tatooine',
      planetName: 'Tatooine',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'Hot',
      description: 'Dry',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      locationName: 'Austin',
      locationKey: 'auto',
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon'
    }, localization);

    expect(document.getElementById('background').className).toBe('tatooine');
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(document.getElementById('message').innerText).toBe('Hot');
    expect(document.getElementById('description').innerText).toBe('Dry');
    expect(document.getElementById('LastUpdated').innerText).toBe('Last Updated: now');
    expect(document.getElementById('locationLabel').innerText).toBe('Showing weather in: Austin');
    expect(document.getElementById('test').style.display).toBe('none');
  });

  test('showLoadingState clears loading and sets placeholder', () => {
    const localization = createLocalizationMock({
      last_updated_placeholder: { message: 'Last Updated: --' },
      location_display: { message: 'Showing weather in: $1' },
      location_display_unknown: { message: 'Showing weather in: your area' }
    });
    document.getElementById('loading').innerText = 'Loading...';

    app.showLoadingState(localization, 'Paris');

    expect(document.getElementById('loading').innerText).toBe('');
    expect(document.getElementById('locationLabel').innerText).toBe('Showing weather in: Paris');
    expect(document.getElementById('LastUpdated').innerText).toBe('Last Updated: --');
  });

  test('showErrorState updates message and clears description', () => {
    const localization = createLocalizationMock({
      error_weather_unavailable: { message: 'Unable to retrieve weather data right now.' },
      last_updated_placeholder: { message: 'Last Updated: --' },
      location_display_unknown: { message: 'Showing weather in: your area' }
    });

    app.showErrorState(localization, null);

    expect(document.getElementById('message').innerText).toBe('Unable to retrieve weather data right now.');
    expect(document.getElementById('description').innerText).toBe('');
    expect(document.getElementById('LastUpdated').innerText).toBe('Last Updated: --');
  });
});
