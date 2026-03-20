import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createLocalizationMock,
  installDom,
  installStorageMock,
  teardownDom
} from './testUtils.js';

globalThis.__SWW_SKIP_INIT__ = true;

let newtab = null;

beforeAll(async () => {
  newtab = await import('../newtab.js');
});

beforeEach(() => {
  installStorageMock();
  installDom();
});

afterEach(() => {
  teardownDom();
  delete globalThis.localStorage;
});

describe('getFaviconUrl', () => {
  test('returns google favicon URL for valid site', () => {
    const url = newtab.getFaviconUrl('https://example.com/page');
    expect(url).toContain('google.com/s2/favicons');
    expect(url).toContain('example.com');
  });

  test('returns empty string for invalid URL', () => {
    expect(newtab.getFaviconUrl('not a url')).toBe('');
  });
});

describe('getShortcutLabel', () => {
  test('uses title when available', () => {
    expect(newtab.getShortcutLabel({ title: 'GitHub', url: 'https://github.com' })).toBe('GitHub');
  });

  test('truncates long titles to 12 characters', () => {
    expect(newtab.getShortcutLabel({ title: 'A Very Long Title Here', url: 'https://example.com' })).toBe('A Very Long ');
  });

  test('falls back to hostname without www', () => {
    expect(newtab.getShortcutLabel({ title: '', url: 'https://www.example.com/path' })).toBe('example.com');
  });

  test('returns url as last resort', () => {
    expect(newtab.getShortcutLabel({ title: '', url: 'not-a-url' })).toBe('not-a-url');
  });
});

describe('getInitial', () => {
  test('uses first character of title', () => {
    expect(newtab.getInitial({ title: 'GitHub', url: 'https://github.com' })).toBe('G');
  });

  test('uses hostname first char when no title', () => {
    expect(newtab.getInitial({ title: '', url: 'https://example.com' })).toBe('E');
  });

  test('returns ? for invalid input', () => {
    expect(newtab.getInitial({ title: '', url: '' })).toBe('?');
  });
});

describe('renderShortcuts', () => {
  test('renders tiles into container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const sites = [
      { title: 'GitHub', url: 'https://github.com' },
      { title: 'Google', url: 'https://google.com' }
    ];

    newtab.renderShortcuts(sites, container);
    const tiles = container.querySelectorAll('.shortcut-tile');
    expect(tiles.length).toBe(2);
    expect(tiles[0].href).toBe('https://github.com/');
    expect(tiles[0].querySelector('.shortcut-label').textContent).toBe('GitHub');
  });

  test('limits to 8 shortcuts', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const sites = Array.from({ length: 12 }, (_, i) => ({
      title: `Site ${i}`,
      url: `https://site${i}.com`
    }));

    newtab.renderShortcuts(sites, container);
    expect(container.querySelectorAll('.shortcut-tile').length).toBe(8);
  });

  test('skips sites without url', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    newtab.renderShortcuts([{ title: 'No URL' }, { title: 'Has URL', url: 'https://x.com' }], container);
    expect(container.querySelectorAll('.shortcut-tile').length).toBe(1);
  });

  test('handles null container gracefully', () => {
    expect(() => newtab.renderShortcuts([], null)).not.toThrow();
  });
});

describe('applySearchPlaceholder', () => {
  test('sets placeholder from localization', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const localization = createLocalizationMock({
      search_placeholder: { message: 'Search Google or type a URL' }
    });

    newtab.applySearchPlaceholder(input, localization);
    expect(input.placeholder).toBe('Search Google or type a URL');
  });

  test('handles null input gracefully', () => {
    const localization = createLocalizationMock({});
    expect(() => newtab.applySearchPlaceholder(null, localization)).not.toThrow();
  });
});

describe('applyVisibility', () => {
  test('hides search form when showSearch is false', () => {
    const searchForm = document.createElement('form');
    const shortcutsGrid = document.createElement('div');
    const newtabExtras = document.createElement('section');
    document.body.appendChild(searchForm);
    document.body.appendChild(shortcutsGrid);
    document.body.appendChild(newtabExtras);

    newtab.applyVisibility({ searchForm, shortcutsGrid, newtabExtras, showSearch: false, showShortcuts: true });
    expect(searchForm.classList.contains('hidden')).toBe(true);
    expect(shortcutsGrid.classList.contains('hidden')).toBe(false);
    expect(newtabExtras.classList.contains('hidden')).toBe(false);
  });

  test('hides shortcuts grid when showShortcuts is false', () => {
    const searchForm = document.createElement('form');
    const shortcutsGrid = document.createElement('div');
    const newtabExtras = document.createElement('section');
    document.body.appendChild(searchForm);
    document.body.appendChild(shortcutsGrid);
    document.body.appendChild(newtabExtras);

    newtab.applyVisibility({ searchForm, shortcutsGrid, newtabExtras, showSearch: true, showShortcuts: false });
    expect(searchForm.classList.contains('hidden')).toBe(false);
    expect(shortcutsGrid.classList.contains('hidden')).toBe(true);
    expect(newtabExtras.classList.contains('hidden')).toBe(false);
  });

  test('hides newtab-extras when both children are hidden', () => {
    const searchForm = document.createElement('form');
    const shortcutsGrid = document.createElement('div');
    const newtabExtras = document.createElement('section');
    document.body.appendChild(searchForm);
    document.body.appendChild(shortcutsGrid);
    document.body.appendChild(newtabExtras);

    newtab.applyVisibility({ searchForm, shortcutsGrid, newtabExtras, showSearch: false, showShortcuts: false });
    expect(searchForm.classList.contains('hidden')).toBe(true);
    expect(shortcutsGrid.classList.contains('hidden')).toBe(true);
    expect(newtabExtras.classList.contains('hidden')).toBe(true);
  });

  test('shows both when both are true', () => {
    const searchForm = document.createElement('form');
    const shortcutsGrid = document.createElement('div');
    const newtabExtras = document.createElement('section');
    searchForm.classList.add('hidden');
    shortcutsGrid.classList.add('hidden');
    newtabExtras.classList.add('hidden');
    document.body.appendChild(searchForm);
    document.body.appendChild(shortcutsGrid);
    document.body.appendChild(newtabExtras);

    newtab.applyVisibility({ searchForm, shortcutsGrid, newtabExtras, showSearch: true, showShortcuts: true });
    expect(searchForm.classList.contains('hidden')).toBe(false);
    expect(shortcutsGrid.classList.contains('hidden')).toBe(false);
    expect(newtabExtras.classList.contains('hidden')).toBe(false);
  });

  test('handles null elements gracefully', () => {
    expect(() => newtab.applyVisibility({ searchForm: null, shortcutsGrid: null, newtabExtras: null, showSearch: true, showShortcuts: true })).not.toThrow();
  });
});

describe('applyHyperspaceHidden', () => {
  test('adds hyperspace-hidden when setting is off and background has hyperspace class', () => {
    const newtabExtras = document.createElement('section');
    const background = document.createElement('div');
    background.classList.add('hyperspace');
    document.body.appendChild(newtabExtras);
    document.body.appendChild(background);

    localStorage.setItem('showExtrasInHyperspace', 'false');
    newtab.applyHyperspaceHidden(newtabExtras, background);
    expect(newtabExtras.classList.contains('hyperspace-hidden')).toBe(true);
  });

  test('does not add hyperspace-hidden when setting is on', () => {
    const newtabExtras = document.createElement('section');
    const background = document.createElement('div');
    background.classList.add('hyperspace');
    document.body.appendChild(newtabExtras);
    document.body.appendChild(background);

    localStorage.setItem('showExtrasInHyperspace', 'true');
    newtab.applyHyperspaceHidden(newtabExtras, background);
    expect(newtabExtras.classList.contains('hyperspace-hidden')).toBe(false);
  });

  test('does not add hyperspace-hidden when background lacks hyperspace class', () => {
    const newtabExtras = document.createElement('section');
    const background = document.createElement('div');
    background.classList.add('tatooine');
    document.body.appendChild(newtabExtras);
    document.body.appendChild(background);

    localStorage.setItem('showExtrasInHyperspace', 'false');
    newtab.applyHyperspaceHidden(newtabExtras, background);
    expect(newtabExtras.classList.contains('hyperspace-hidden')).toBe(false);
  });

  test('removes hyperspace-hidden when background class changes away from hyperspace', () => {
    const newtabExtras = document.createElement('section');
    const background = document.createElement('div');
    background.classList.add('hyperspace');
    document.body.appendChild(newtabExtras);
    document.body.appendChild(background);

    localStorage.setItem('showExtrasInHyperspace', 'false');
    newtab.applyHyperspaceHidden(newtabExtras, background);
    expect(newtabExtras.classList.contains('hyperspace-hidden')).toBe(true);

    // Simulate background transitioning to a planet
    background.className = 'tatooine';

    // MutationObserver is async — wait a tick for it to fire
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(newtabExtras.classList.contains('hyperspace-hidden')).toBe(false);
        resolve();
      }, 50);
    });
  });

  test('handles null newtabExtras gracefully', () => {
    const background = document.createElement('div');
    expect(() => newtab.applyHyperspaceHidden(null, background)).not.toThrow();
  });

  test('removes existing hyperspace-hidden when setting is turned on', () => {
    const newtabExtras = document.createElement('section');
    newtabExtras.classList.add('hyperspace-hidden');
    const background = document.createElement('div');
    background.classList.add('hyperspace');
    document.body.appendChild(newtabExtras);
    document.body.appendChild(background);

    localStorage.setItem('showExtrasInHyperspace', 'true');
    newtab.applyHyperspaceHidden(newtabExtras, background);
    expect(newtabExtras.classList.contains('hyperspace-hidden')).toBe(false);
  });
});
