import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createLocalizationMock, installDom, installStorageMock, teardownDom } from './testUtils.js';
import { initPassport, planetDayArt, updatePassportUi } from '../passport.js';
import { markPlanetVisited, setPreferredUnit } from '../storage.js';
import { PLANET_RULES } from '../planets.js';
import { readFileSync } from 'fs';
import { join } from 'path';

globalThis.__SWW_SKIP_INIT__ = true;

let newtab = null;

beforeAll(async () => {
  newtab = await import('../newtab.js');
});

function stampArt() {
  return [...document.querySelectorAll('.passport-stamp-art')];
}

function loadedSources() {
  return stampArt().map((art) => art.getAttribute('src')).filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installPassportDom() {
  return installDom(`
    <p id="planet"></p>
    <aside id="exploreMenu" class="explore-menu hidden">
      <button type="button" id="exploreMenuButton" class="explore-menu-button" aria-expanded="false" aria-controls="exploreMenuPanel"></button>
      <div id="exploreMenuPanel" class="explore-menu-panel hidden" role="menu">
        <button type="button" id="exploreSettingsItem" class="explore-menu-item" role="menuitem">
          <img class="explore-menu-item-icon" src="/public/assets/icons/ui/settings.svg" alt="" aria-hidden="true">
          <span class="explore-menu-item-label">Settings</span>
        </button>
        <button type="button" id="exploreTourItem" class="explore-menu-item" role="menuitem">
          <img class="explore-menu-item-icon" src="/public/assets/icons/ui/tour.svg" alt="" aria-hidden="true">
          <span class="explore-menu-item-label">Tour the Galaxy</span>
        </button>
        <div class="explore-menu-separator" role="separator"></div>
        <button type="button" id="explorePassportItem" class="explore-menu-item" role="menuitem">
          <img class="explore-menu-item-icon" src="/public/assets/icons/ui/passport.svg" alt="" aria-hidden="true">
          <span class="explore-menu-item-label">Planet Passport</span>
        </button>
      </div>
    </aside>
    <aside id="passport" class="passport hidden">
      <div id="passportPanel" class="passport-panel hidden" role="dialog">
        <div class="passport-dossier">
          <div class="passport-panel-header">
            <div class="passport-heading-row">
              <div class="passport-heading">
                <h2 id="passportTitle" class="passport-title">Planet Passport</h2>
                <p id="passportCount" class="passport-count"></p>
              </div>
              <button type="button" id="passportClose" class="passport-close" aria-label="Close">×</button>
            </div>
            <div class="passport-progress" aria-hidden="true">
              <div id="passportProgressBar" class="passport-progress-bar"></div>
            </div>
          </div>
          <ul id="passportGrid" class="passport-grid"></ul>
          <p id="passportHint" class="passport-hint"></p>
        </div>
      </div>
    </aside>
  `);
}

beforeEach(() => {
  installStorageMock();
  installPassportDom();
});

afterEach(() => {
  teardownDom();
  delete globalThis.localStorage;
  delete globalThis.chrome;
});

describe('passport explore menu', () => {
  test('updatePassportUi reveals explore menu and keeps passport panel closed', () => {
    const localization = createLocalizationMock({
      explore_menu_label: { message: 'Explore' },
      explore_menu_settings: { message: 'Settings' },
      popup_tour_open: { message: 'Tour the Galaxy' },
      passport_title: { message: 'Planet Passport' },
      passport_hint: { message: 'Stamps unlock when local weather matches a world.' },
      passport_worlds_visited: { message: '$1/$2 worlds visited' },
      passport_close: { message: 'Close' }
    });

    updatePassportUi(localization);

    expect(document.getElementById('exploreMenu').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('passport').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('passport').classList.contains('is-open')).toBe(false);
    expect(document.getElementById('passportPanel').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('passportTrigger')).toBeNull();
    expect(document.getElementById('exploreWhyItem')).toBeNull();
    expect(document.getElementById('passportAuthority')).toBeNull();
    expect(document.getElementById('exploreGithubItem')).toBeNull();
    expect(document.getElementById('exploreMenuButton').getAttribute('aria-label')).toBe('Explore');
    expect(document.querySelector('#exploreSettingsItem .explore-menu-item-label').textContent).toBe('Settings');
    expect(document.querySelector('#exploreTourItem .explore-menu-item-label').textContent).toBe('Tour the Galaxy');
    expect(document.getElementById('passportCount').textContent).toBe(`0/${PLANET_RULES.length} worlds visited`);
    expect(document.getElementById('passportProgressBar').style.width).toBe('0%');
  });

  test('explore menu opens passport panel with planet image stamps', () => {
    const localization = createLocalizationMock({
      explore_menu_label: { message: 'Explore' },
      explore_menu_settings: { message: 'Settings' },
      popup_tour_open: { message: 'Tour the Galaxy' },
      passport_title: { message: 'Planet Passport' },
      passport_worlds_visited: { message: '$1/$2 worlds visited' },
      passport_stamp_visited: { message: '$1 visited' },
      passport_stamp_locked: { message: '$1 locked' },
      planet_hoth_name: { message: 'Hoth' }
    });

    markPlanetVisited('hoth');
    initPassport(localization);

    document.getElementById('exploreMenuButton').click();
    expect(document.getElementById('exploreMenuPanel').classList.contains('hidden')).toBe(false);

    document.getElementById('explorePassportItem').click();
    expect(document.getElementById('exploreMenuPanel').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('passportPanel').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('passport').classList.contains('is-open')).toBe(true);
    expect(document.getElementById('passportCount').textContent).toBe(`1/${PLANET_RULES.length} worlds visited`);
    expect(document.getElementById('passportProgressBar').style.width)
      .toBe(`${Math.round((1 / PLANET_RULES.length) * 100)}%`);

    const stamps = [...document.querySelectorAll('.passport-stamp')];
    expect(stamps).toHaveLength(PLANET_RULES.length);

    const hoth = stamps.find((stamp) => stamp.classList.contains('visited'));
    expect(hoth).toBeTruthy();
    expect(hoth.querySelector('.passport-stamp-art').dataset.art).toBe('/public/assets/passport/hoth.webp');
    expect(hoth.querySelector('.passport-stamp-name').textContent).toBe('Hoth');

    const locked = stamps.find((stamp) => stamp.classList.contains('locked'));
    expect(locked).toBeTruthy();
    expect(locked.querySelector('.passport-stamp-art').dataset.art).toMatch(/\/public\/assets\/passport\/.+\.webp/);
  });

  test('escape and outside click close the passport panel', () => {
    const localization = createLocalizationMock({
      explore_menu_label: { message: 'Explore' },
      explore_menu_settings: { message: 'Settings' },
      popup_tour_open: { message: 'Tour the Galaxy' },
      passport_title: { message: 'Planet Passport' },
      passport_worlds_visited: { message: '$1/$2 worlds visited' }
    });

    initPassport(localization);
    document.getElementById('exploreMenuButton').click();
    document.getElementById('explorePassportItem').click();
    expect(document.getElementById('passportPanel').classList.contains('hidden')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('passportPanel').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('passport').classList.contains('is-open')).toBe(false);

    document.getElementById('exploreMenuButton').click();
    document.getElementById('explorePassportItem').click();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.getElementById('passportPanel').classList.contains('hidden')).toBe(true);
  });

  test('settings menu item opens settings as a full HTML tab', () => {
    const localization = createLocalizationMock({
      explore_menu_label: { message: 'Explore' },
      explore_menu_settings: { message: 'Settings' },
      popup_tour_open: { message: 'Tour the Galaxy' },
      passport_title: { message: 'Planet Passport' },
      passport_worlds_visited: { message: '$1/$2 worlds visited' }
    });

    const created = [];
    globalThis.chrome = {
      runtime: {
        getURL: (path) => `chrome-extension://id/${path}`
      },
      tabs: {
        create: (opts) => {
          created.push(opts);
        }
      }
    };

    initPassport(localization);
    document.getElementById('exploreMenuButton').click();
    document.getElementById('exploreSettingsItem').click();

    expect(document.getElementById('exploreMenuPanel').classList.contains('hidden')).toBe(true);
    expect(created).toEqual([{ url: 'chrome-extension://id/public/options.html' }]);
  });

  test('planetDayArt uses day background asset id', () => {
    expect(planetDayArt({ id: 'bespin', backgrounds: { day: 'bespin', night: 'bespinNight' } })).toBe('bespin');
    expect(planetDayArt({ id: 'naboo' })).toBe('naboo');
  });
});

describe('passport stamp requirements', () => {
  const enMessages = JSON.parse(
    readFileSync(join(import.meta.dir, '..', '..', '_locales', 'en', 'messages.json'), 'utf8')
  );

  function realLocalization() {
    return createLocalizationMock(enMessages);
  }

  test('every planet rule declares a requirement key present in the en locale', () => {
    PLANET_RULES.forEach((rule) => {
      expect(rule.requirement?.key).toBeTruthy();
      expect(enMessages[rule.requirement.key]?.message).toBeTruthy();
    });
  });

  test('stamps expose unlock conditions on hover targets and to screen readers', () => {
    updatePassportUi(realLocalization());

    const stamp = document.querySelector('.passport-stamp');
    const tip = stamp.querySelector('.passport-stamp-requirement');

    expect(tip).not.toBeNull();
    // hover-only would strand keyboard users
    expect(stamp.tabIndex).toBe(0);
    expect(stamp.getAttribute('aria-describedby')).toBe(tip.id);
    expect(stamp.getAttribute('aria-label')).toContain('Snow');

    const hoth = [...document.querySelectorAll('.passport-stamp')].find(
      (el) => el.querySelector('.passport-stamp-name').textContent === 'Hoth'
    );
    expect(hoth.querySelector('.passport-stamp-requirement-text').textContent)
      .toBe('Snow, or 32°F and colder');
    expect(hoth.querySelector('.passport-stamp-requirement-label').textContent).toBe('Requires');
  });

  test('thresholds follow the preferred unit', () => {
    setPreferredUnit('celsius');
    updatePassportUi(realLocalization());

    const texts = [...document.querySelectorAll('.passport-stamp-requirement-text')]
      .map((el) => el.textContent);

    expect(texts.some((t) => t === 'Snow, or 0°C and colder')).toBe(true);
    expect(texts.some((t) => t.includes('°F'))).toBe(false);

    setPreferredUnit('fahrenheit');
    updatePassportUi(realLocalization());

    const back = [...document.querySelectorAll('.passport-stamp-requirement-text')]
      .map((el) => el.textContent);
    expect(back.some((t) => t === 'Snow, or 32°F and colder')).toBe(true);
  });

  test('conditions render for locked and visited worlds alike', () => {
    markPlanetVisited('hoth');
    updatePassportUi(realLocalization());

    const stamps = [...document.querySelectorAll('.passport-stamp')];
    const visited = stamps.filter((el) => el.classList.contains('visited'));
    const locked = stamps.filter((el) => el.classList.contains('locked'));

    expect(visited.length).toBeGreaterThan(0);
    expect(locked.length).toBeGreaterThan(0);
    stamps.forEach((el) => {
      expect(el.querySelector('.passport-stamp-requirement-text').textContent.length)
        .toBeGreaterThan(0);
    });
  });

  test('stamps omit the tooltip when the locale lacks requirement strings', () => {
    updatePassportUi(createLocalizationMock({ planet_hoth_name: { message: 'Hoth' } }));

    const stamp = document.querySelector('.passport-stamp');
    expect(stamp.querySelector('.passport-stamp-requirement')).toBeNull();
    expect(stamp.hasAttribute('aria-describedby')).toBe(false);
    expect(stamp.tabIndex).toBe(-1);
  });
});

// Stamp art is small, but serial decoding keeps the grid smooth on low-end devices.
describe('passport stamp art loading', () => {
  test('tiles hold their art url back instead of requesting all of it up front', () => {
    updatePassportUi(createLocalizationMock({}));

    const art = stampArt();
    expect(art).toHaveLength(PLANET_RULES.length);
    art.forEach((el) => {
      expect(el.dataset.art).toMatch(/^\/public\/assets\/passport\/.+\.webp$/);
      expect(el.getAttribute('loading')).toBe('lazy');
      expect(el.getAttribute('decoding')).toBe('async');
    });

    expect(loadedSources()).toHaveLength(1);
  });

  test('the next tile only starts once the previous one has finished', async () => {
    updatePassportUi(createLocalizationMock({}));

    const art = stampArt();
    expect(art[0].getAttribute('src')).toBe(art[0].dataset.art);
    expect(art[1].getAttribute('src')).toBeNull();

    art[0].dispatchEvent(new Event('load'));
    await sleep(80);

    expect(art[0].classList.contains('loaded')).toBe(true);
    expect(art[1].getAttribute('src')).toBe(art[1].dataset.art);
    expect(loadedSources()).toHaveLength(2);
  });

  test('a missing asset does not stall the rest of the queue', async () => {
    updatePassportUi(createLocalizationMock({}));

    const art = stampArt();
    art[0].dispatchEvent(new Event('error'));
    await sleep(80);

    expect(art[0].classList.contains('loaded')).toBe(false);
    expect(art[1].getAttribute('src')).toBe(art[1].dataset.art);
  });

  // A discarded tile keeps its load listener until the request resolves; if that late
  // completion advances the new queue, every rebuild adds another concurrent decode.
  test('art still in flight from a discarded grid cannot advance the new queue', async () => {
    updatePassportUi(createLocalizationMock({}));

    const stale = stampArt()[0];
    expect(stale.getAttribute('src')).toBe(stale.dataset.art);

    // tiles gone, so the next render rebuilds instead of updating in place
    document.getElementById('passportGrid').innerHTML = '';
    updatePassportUi(createLocalizationMock({}));

    const art = stampArt();
    expect(art).toHaveLength(PLANET_RULES.length);
    expect(loadedSources()).toHaveLength(1);

    stale.dispatchEvent(new Event('load'));
    await sleep(80);

    expect(loadedSources()).toHaveLength(1);
    expect(art[1].getAttribute('src')).toBeNull();
  });

  // artLoading is only cleared by load/error, so a request that fires neither would
  // hold the lock forever and leave every other tile blank.
  test('a request that never settles does not strand the rest of the queue', async () => {
    const realSetTimeout = globalThis.setTimeout;
    // collapse the stall timeout so the test does not sit through it
    globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms > 1000 ? 20 : ms, ...rest);

    try {
      updatePassportUi(createLocalizationMock({}));

      const art = stampArt();
      expect(art[0].getAttribute('src')).toBe(art[0].dataset.art);
      expect(art[1].getAttribute('src')).toBeNull();

      await new Promise((resolve) => realSetTimeout(resolve, 200));

      expect(art[0].classList.contains('loaded')).toBe(false);
      expect(art[1].getAttribute('src')).toBe(art[1].dataset.art);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  // Rebuilding an open passport restarts every decode from opacity 0 and drops
  // keyboard focus, so an unchanged stamp set must update in place.
  test('re-rendering keeps the existing tiles, their art and keyboard focus', async () => {
    const localization = createLocalizationMock({
      passport_worlds_visited: { message: '$1/$2 worlds visited' },
      passport_stamp_locked: { message: '$1 locked' },
      passport_stamp_visited: { message: '$1 visited' },
      passport_requirement_label: { message: 'Requires' },
      ...Object.fromEntries(PLANET_RULES.map((rule) => [rule.requirement.key, { message: 'Any weather' }]))
    });

    updatePassportUi(localization);

    const before = [...document.querySelectorAll('.passport-stamp')];
    const beforeArt = stampArt();
    beforeArt[0].dispatchEvent(new Event('load'));
    await sleep(80);
    expect(loadedSources()).toHaveLength(2);

    before[3].focus();
    expect(document.activeElement).toBe(before[3]);

    markPlanetVisited(PLANET_RULES[0].id);
    updatePassportUi(localization);

    const after = [...document.querySelectorAll('.passport-stamp')];
    expect(after).toHaveLength(before.length);
    after.forEach((stamp, index) => {
      expect(stamp).toBe(before[index]);
    });

    expect(stampArt()[0]).toBe(beforeArt[0]);
    expect(beforeArt[0].classList.contains('loaded')).toBe(true);
    expect(loadedSources()).toHaveLength(2);
    expect(document.activeElement).toBe(before[3]);

    expect(after[0].classList.contains('visited')).toBe(true);
    expect(after[0].classList.contains('locked')).toBe(false);
  });

  test('re-rendering still tracks unit changes and dropped requirement strings', () => {
    const enMessages = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '_locales', 'en', 'messages.json'), 'utf8')
    );

    updatePassportUi(createLocalizationMock(enMessages));
    const hothIndex = PLANET_RULES.findIndex((rule) => rule.id === 'hoth');
    const stamps = () => [...document.querySelectorAll('.passport-stamp')];
    const hoth = stamps()[hothIndex];
    expect(hoth.querySelector('.passport-stamp-requirement-text').textContent)
      .toBe('Snow, or 32°F and colder');

    setPreferredUnit('celsius');
    updatePassportUi(createLocalizationMock(enMessages));

    expect(stamps()[hothIndex]).toBe(hoth);
    expect(hoth.querySelector('.passport-stamp-requirement-text').textContent)
      .toBe('Snow, or 0°C and colder');

    // a locale without requirement strings has to tear the tooltip back down
    updatePassportUi(createLocalizationMock({ planet_hoth_name: { message: 'Hoth' } }));
    expect(stamps()[hothIndex]).toBe(hoth);
    expect(hoth.querySelector('.passport-stamp-requirement')).toBeNull();
    expect(hoth.hasAttribute('aria-describedby')).toBe(false);
    expect(hoth.tabIndex).toBe(-1);

    // and bringing them back has to rebuild it
    setPreferredUnit('fahrenheit');
    updatePassportUi(createLocalizationMock(enMessages));
    expect(stamps()[hothIndex]).toBe(hoth);
    expect(hoth.querySelector('.passport-stamp-requirement-text').textContent)
      .toBe('Snow, or 32°F and colder');
    expect(hoth.tabIndex).toBe(0);
    expect(hoth.getAttribute('aria-describedby')).toBe('passportRequirement-hoth');
  });
});

// #exploreMenu lives outside .newtab-extras, so hyperspace hiding has to reach it
// explicitly, and has to survive updatePassportUi un-hiding the menu.
describe('explore menu during hyperspace', () => {
  function installHyperspaceChrome() {
    const background = document.createElement('div');
    background.id = 'background';
    background.className = 'hyperspace';

    const extras = document.createElement('section');
    extras.className = 'newtab-extras';

    const launcher = document.createElement('div');
    launcher.id = 'googleAppsLauncher';
    launcher.className = 'google-apps-launcher';

    document.body.append(background, extras, launcher);
    return { background, extras, launcher };
  }

  test('the explore menu and waffle hide alongside the newtab extras', () => {
    const { background, extras, launcher } = installHyperspaceChrome();
    localStorage.setItem('showExtrasInHyperspace', 'false');

    newtab.applyHyperspaceHidden(extras, background);

    expect(extras.classList.contains('hyperspace-hidden')).toBe(true);
    expect(launcher.classList.contains('hyperspace-hidden')).toBe(true);
    expect(document.getElementById('exploreMenu').classList.contains('hyperspace-hidden')).toBe(true);
  });

  test('updatePassportUi revealing the menu does not undo hyperspace hiding', () => {
    const { background, extras } = installHyperspaceChrome();
    localStorage.setItem('showExtrasInHyperspace', 'false');

    newtab.applyHyperspaceHidden(extras, background);
    updatePassportUi(createLocalizationMock({}));

    const explore = document.getElementById('exploreMenu');
    expect(explore.classList.contains('hidden')).toBe(false);
    expect(explore.classList.contains('hyperspace-hidden')).toBe(true);
  });

  test('leaving hyperspace brings the menu back', async () => {
    const { background, extras, launcher } = installHyperspaceChrome();
    localStorage.setItem('showExtrasInHyperspace', 'false');

    newtab.applyHyperspaceHidden(extras, background);
    background.className = 'tatooine';
    await sleep(60);

    expect(extras.classList.contains('hyperspace-hidden')).toBe(false);
    expect(launcher.classList.contains('hyperspace-hidden')).toBe(false);
    expect(document.getElementById('exploreMenu').classList.contains('hyperspace-hidden')).toBe(false);
  });

  test('the setting keeps everything visible through hyperspace', () => {
    const { background, extras, launcher } = installHyperspaceChrome();
    localStorage.setItem('showExtrasInHyperspace', 'true');

    newtab.applyHyperspaceHidden(extras, background);

    expect(extras.classList.contains('hyperspace-hidden')).toBe(false);
    expect(launcher.classList.contains('hyperspace-hidden')).toBe(false);
    expect(document.getElementById('exploreMenu').classList.contains('hyperspace-hidden')).toBe(false);
  });
});
