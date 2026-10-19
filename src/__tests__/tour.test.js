import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, installStorageMock, teardownDom } from './testUtils.js';
import {
  cyclePlanetIndex,
  getPlanetBackgroundClass,
  getTourPlanet,
  isPlanetVisited,
  openSettingsPage,
  openTourPage,
  OPTIONS_PAGE_PATH,
  PLANET_RULES,
  TOUR_PAGE_PATH
} from '../tour.js';

globalThis.__SWW_SKIP_INIT__ = true;

const realBrowser = globalThis.browser;
const realChrome = globalThis.chrome;
const realWindow = globalThis.window;

afterEach(() => {
  if (realBrowser) {
    globalThis.browser = realBrowser;
  } else {
    delete globalThis.browser;
  }

  if (realChrome) {
    globalThis.chrome = realChrome;
  } else {
    delete globalThis.chrome;
  }

  if (realWindow) {
    globalThis.window = realWindow;
  }
});

describe('tour helpers', () => {
  test('cyclePlanetIndex wraps forward and backward', () => {
    expect(cyclePlanetIndex(0, 1, 10)).toBe(1);
    expect(cyclePlanetIndex(9, 1, 10)).toBe(0);
    expect(cyclePlanetIndex(0, -1, 10)).toBe(9);
    expect(cyclePlanetIndex(5, 0, 10)).toBe(5);
  });

  test('cyclePlanetIndex handles invalid length', () => {
    expect(cyclePlanetIndex(3, 1, 0)).toBe(0);
    expect(cyclePlanetIndex(3, 1, -2)).toBe(0);
  });

  test('getPlanetBackgroundClass picks day or night art', () => {
    const planet = { backgrounds: { day: 'hoth', night: 'hothNight' } };
    expect(getPlanetBackgroundClass(planet, 'day')).toBe('hoth');
    expect(getPlanetBackgroundClass(planet, 'night')).toBe('hothNight');
    expect(getPlanetBackgroundClass({ backgrounds: { day: 'naboo' } }, 'night')).toBe('naboo');
    expect(getPlanetBackgroundClass(null, 'day')).toBe('');
  });

  test('getTourPlanet returns planets from PLANET_RULES', () => {
    expect(PLANET_RULES.length).toBeGreaterThan(0);
    expect(getTourPlanet(0).id).toBe(PLANET_RULES[0].id);
    expect(getTourPlanet(PLANET_RULES.length).id).toBe(PLANET_RULES[0].id);
    expect(getTourPlanet(-1).id).toBe(PLANET_RULES[PLANET_RULES.length - 1].id);
  });

  test('isPlanetVisited checks visited list', () => {
    expect(isPlanetVisited('hoth', ['hoth', 'naboo'])).toBe(true);
    expect(isPlanetVisited('kamino', ['hoth', 'naboo'])).toBe(false);
    expect(isPlanetVisited('', ['hoth'])).toBe(false);
    expect(isPlanetVisited('hoth', null)).toBe(false);
  });

  test('openTourPage opens extension tour URL', () => {
    const opened = [];
    globalThis.browser = {
      runtime: {
        getURL: (path) => `chrome-extension://test/${path}`
      }
    };
    delete globalThis.chrome;
    globalThis.window = {
      open: (url, target) => {
        opened.push({ url, target });
      }
    };

    const url = openTourPage();
    expect(url).toBe(`chrome-extension://test/${TOUR_PAGE_PATH}`);
    expect(opened).toEqual([{ url, target: '_blank' }]);
  });

  test('openSettingsPage opens options HTML in a new tab', () => {
    const created = [];
    globalThis.chrome = {
      runtime: {
        getURL: (path) => `chrome-extension://test/${path}`
      },
      tabs: {
        create: (opts) => {
          created.push(opts);
        }
      }
    };
    delete globalThis.browser;

    const url = openSettingsPage();
    expect(url).toBe(`chrome-extension://test/${OPTIONS_PAGE_PATH}`);
    expect(created).toEqual([{ url }]);
  });
});

describe('tour keyboard shortcuts and browser shortcuts', () => {
  let tourPage = null;

  beforeAll(async () => {
    tourPage = await import('../tourPage.js');
  });

  beforeEach(() => {
    installStorageMock();
    installDom(`
      <div id="tourStage" class="tour-stage"></div>
      <p id="tourVisitedStamp" hidden></p>
      <p id="tourCounter"></p>
      <h1 id="tourPlanetName"></h1>
      <p id="tourPlanetDescription"></p>
      <button id="tourDay" type="button" aria-pressed="true"></button>
      <button id="tourNight" type="button" aria-pressed="false"></button>
    `);
    tourPage.resetTourPageStateForTests();
    tourPage.attachKeyboardNavigation();
    tourPage.renderTourPlanet();
  });

  afterEach(() => {
    teardownDom();
    delete globalThis.localStorage;
  });

  function press(init) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(event);
    return event;
  }

  function currentPlanet() {
    return document.getElementById('tourStage').dataset.planet;
  }

  function currentTimeOfDay() {
    return document.getElementById('tourStage').dataset.timeOfDay;
  }

  test('plain arrows still navigate and are handled by the tour', () => {
    const first = currentPlanet();

    const right = press({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(right.defaultPrevented).toBe(true);
    expect(currentPlanet()).not.toBe(first);

    const left = press({ key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(left.defaultPrevented).toBe(true);
    expect(currentPlanet()).toBe(first);
  });

  test('plain d and n still switch the time of day', () => {
    press({ key: 'n', code: 'KeyN' });
    expect(currentTimeOfDay()).toBe('night');

    press({ key: 'd', code: 'KeyD' });
    expect(currentTimeOfDay()).toBe('day');

    // shift (or Caps Lock) still reads as the same letter shortcut
    press({ key: 'N', code: 'KeyN', shiftKey: true });
    expect(currentTimeOfDay()).toBe('night');
  });

  test('back-navigation shortcuts are left to the browser', () => {
    const first = currentPlanet();

    const altBack = press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(altBack.defaultPrevented).toBe(false);
    expect(currentPlanet()).toBe(first);

    const metaBack = press({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true });
    expect(metaBack.defaultPrevented).toBe(false);
    expect(currentPlanet()).toBe(first);

    const metaForward = press({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true });
    expect(metaForward.defaultPrevented).toBe(false);
    expect(currentPlanet()).toBe(first);
  });

  test('shift+arrow selection does not move planets', () => {
    const first = currentPlanet();

    const shiftRight = press({ key: 'ArrowRight', code: 'ArrowRight', shiftKey: true });
    expect(shiftRight.defaultPrevented).toBe(false);
    expect(currentPlanet()).toBe(first);
  });

  test('bookmark and new-window shortcuts do not change the stage', () => {
    expect(currentTimeOfDay()).toBe('day');

    press({ key: 'n', code: 'KeyN', metaKey: true });
    expect(currentTimeOfDay()).toBe('day');

    press({ key: 'n', code: 'KeyN', ctrlKey: true });
    expect(currentTimeOfDay()).toBe('day');

    press({ key: 'n', code: 'KeyN' });
    expect(currentTimeOfDay()).toBe('night');

    press({ key: 'd', code: 'KeyD', metaKey: true });
    press({ key: 'd', code: 'KeyD', ctrlKey: true });
    expect(currentTimeOfDay()).toBe('night');
  });
});
