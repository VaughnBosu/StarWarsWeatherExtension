import { getVisitedPlanets, getPreferredUnit } from './storage.js';
import { PLANET_RULES } from './planets.js';
import { openSettingsPage, openTourPage } from './tour.js';
import { DEGREE_SYMBOL } from './config.js';
import { track } from './telemetry.js';

const TOTAL_WORLDS = PLANET_RULES.length;

function getPassportElements() {
  return {
    exploreRoot: document.getElementById('exploreMenu'),
    exploreButton: document.getElementById('exploreMenuButton'),
    explorePanel: document.getElementById('exploreMenuPanel'),
    exploreSettingsItem: document.getElementById('exploreSettingsItem'),
    exploreTourItem: document.getElementById('exploreTourItem'),
    explorePassportItem: document.getElementById('explorePassportItem'),
    root: document.getElementById('passport'),
    panel: document.getElementById('passportPanel'),
    count: document.getElementById('passportCount'),
    grid: document.getElementById('passportGrid'),
    close: document.getElementById('passportClose'),
    hint: document.getElementById('passportHint'),
    progressBar: document.getElementById('passportProgressBar')
  };
}

function planetDisplayName(planet, localization) {
  return localization?.getMessage?.(`planet_${planet.id}_name`) || planet.name;
}

function planetDayArt(planet) {
  return planet.backgrounds?.day || planet.id;
}

/** Decode stamp thumbnails serially so opening the grid stays smooth on low-end devices. */
const STAMP_ART_GAP_MS = 32;
const STAMP_ART_MARGIN = '96px';
// a request that fires neither load nor error would hold the lock forever
const STAMP_ART_TIMEOUT_MS = 15000;

let artObserver = null;
let artQueue = [];
let artLoading = false;
// Bumped on teardown, so a load still in flight for a discarded grid can't
// release the lock a fresh render is holding.
let artGeneration = 0;
let artStallTimer = null;

function resetStampArt() {
  artObserver?.disconnect();
  artObserver = null;
  artQueue = [];
  artLoading = false;
  artGeneration += 1;

  if (artStallTimer !== null) {
    clearTimeout(artStallTimer);
    artStallTimer = null;
  }
}

function loadNextStampArt() {
  if (artLoading) {
    return;
  }

  let art = artQueue.shift();
  while (art && art.getAttribute('src')) {
    art = artQueue.shift();
  }

  if (!art || !art.dataset.art) {
    return;
  }

  artLoading = true;

  const generation = artGeneration;
  let settled = false;

  const advance = (loaded) => {
    if (settled || generation !== artGeneration) {
      return;
    }

    settled = true;
    if (artStallTimer !== null) {
      clearTimeout(artStallTimer);
      artStallTimer = null;
    }
    if (loaded) {
      art.classList.add('loaded');
    }
    artLoading = false;
    // yield between decodes so a full grid never lands in a single frame
    setTimeout(loadNextStampArt, STAMP_ART_GAP_MS);
  };

  art.addEventListener('load', () => advance(true), { once: true });
  art.addEventListener('error', () => advance(false), { once: true });
  artStallTimer = setTimeout(() => advance(false), STAMP_ART_TIMEOUT_MS);
  art.src = art.dataset.art;
}

function queueStampArt(art) {
  if (!art || art.dataset.queued === 'true') {
    return;
  }

  art.dataset.queued = 'true';
  artQueue.push(art);
  loadNextStampArt();
}

function observeStampArt(art) {
  if (typeof IntersectionObserver !== 'function') {
    // no viewport gating available; still load, one tile at a time
    queueStampArt(art);
    return;
  }

  if (!artObserver) {
    artObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        observer.unobserve(entry.target);
        queueStampArt(entry.target);
      });
    }, { rootMargin: STAMP_ART_MARGIN });
  }

  artObserver.observe(art);
}

function createStampArt(planet) {
  const art = document.createElement('img');
  art.className = 'passport-stamp-art';
  art.alt = '';
  art.setAttribute('aria-hidden', 'true');
  art.setAttribute('loading', 'lazy');
  art.setAttribute('decoding', 'async');
  // src stays empty until the tile is on screen and its turn comes up
  art.dataset.art = `/public/assets/passport/${planetDayArt(planet)}.webp`;
  return art;
}

/** Nearest-half-degree rounding matches the weather readout. */
function formatThreshold(tempF, unit) {
  if (unit === 'celsius') {
    const tempC = Math.round((((tempF - 32) * 5) / 9) * 2) / 2;
    return `${tempC}${DEGREE_SYMBOL}C`;
  }

  return `${tempF}${DEGREE_SYMBOL}F`;
}

function planetRequirement(planet, localization, unit) {
  const requirement = planet?.requirement;
  if (!requirement?.key) {
    return '';
  }

  const substitutions = (requirement.tempsF || []).map((tempF) => formatThreshold(tempF, unit));
  return localization?.getMessage?.(requirement.key, substitutions) || '';
}

function setMenuItemLabel(item, text) {
  if (!item || typeof text !== 'string') {
    return;
  }

  const label = item.querySelector('.explore-menu-item-label');
  if (label) {
    label.textContent = text;
    return;
  }

  item.textContent = text;
}

function stampDescriptor(planet, visitedSet, localization, unit) {
  const isVisited = visitedSet.has(planet.id);
  const displayName = planetDisplayName(planet, localization);
  const status = isVisited
    ? (localization?.getMessage?.('passport_stamp_visited', [displayName]) || `${displayName} visited`)
    : (localization?.getMessage?.('passport_stamp_locked', [displayName]) || `${displayName} locked`);

  return {
    planet,
    isVisited,
    displayName,
    status,
    requirementLabel: localization?.getMessage?.('passport_requirement_label') || 'Requires',
    requirement: planetRequirement(planet, localization, unit),
    requirementAria: (requirementText) =>
      localization?.getMessage?.('passport_stamp_requirement', [status, requirementText])
      || `${status} requires: ${requirementText}`
  };
}

/**
 * Every branch has to be reversible: the same tile is reused across renders that
 * add or drop the requirement tooltip (a locale switch does that).
 */
function applyStampContent(stamp, descriptor) {
  const { planet, isVisited, displayName, status, requirement, requirementLabel } = descriptor;

  stamp.className = `passport-stamp${isVisited ? ' visited' : ' locked'}`;

  const name = stamp.querySelector('.passport-stamp-name');
  if (name) {
    name.textContent = displayName;
  }

  let tip = stamp.querySelector('.passport-stamp-requirement');

  if (!requirement) {
    tip?.remove();
    stamp.removeAttribute('tabindex');
    stamp.removeAttribute('aria-describedby');
    stamp.setAttribute('aria-label', status);
    return;
  }

  if (!tip) {
    tip = document.createElement('span');
    tip.className = 'passport-stamp-requirement';
    tip.id = `passportRequirement-${planet.id}`;

    const tipLabel = document.createElement('span');
    tipLabel.className = 'passport-stamp-requirement-label';

    const tipText = document.createElement('span');
    tipText.className = 'passport-stamp-requirement-text';

    tip.append(tipLabel, tipText);
    stamp.appendChild(tip);
  }

  tip.querySelector('.passport-stamp-requirement-label').textContent = requirementLabel;
  tip.querySelector('.passport-stamp-requirement-text').textContent = requirement;

  // keyboard route in, since the tooltip is otherwise hover-only
  stamp.tabIndex = 0;
  stamp.setAttribute('aria-describedby', tip.id);
  // screen readers get the conditions inline; the tooltip is visual only
  stamp.setAttribute('aria-label', descriptor.requirementAria(requirement));
}

function createStamp(descriptor) {
  const stamp = document.createElement('li');
  stamp.dataset.planet = descriptor.planet.id;
  stamp.appendChild(createStampArt(descriptor.planet));

  const name = document.createElement('span');
  name.className = 'passport-stamp-name';
  stamp.appendChild(name);

  applyStampContent(stamp, descriptor);
  return stamp;
}

/**
 * Rebuilding the grid restarted all thirteen image decodes and dropped keyboard
 * focus, so matching tiles are updated in place; only a mismatched grid rebuilds.
 */
function renderPassportGrid(grid, visited, localization) {
  if (!grid) {
    return;
  }

  const visitedSet = new Set(visited);
  const unit = getPreferredUnit();
  const descriptors = PLANET_RULES.map((planet) => stampDescriptor(planet, visitedSet, localization, unit));

  const existing = [...grid.children];
  const reusable = existing.length === descriptors.length
    && existing.every((stamp, index) => stamp.dataset?.planet === descriptors[index].planet.id
      && stamp.querySelector('.passport-stamp-art'));

  if (reusable) {
    descriptors.forEach((descriptor, index) => applyStampContent(existing[index], descriptor));
    return;
  }

  const focusedIndex = existing.indexOf(document.activeElement);

  // old tiles are about to be discarded, so drop any art still in flight
  resetStampArt();
  grid.innerHTML = '';

  descriptors.forEach((descriptor) => {
    const stamp = createStamp(descriptor);
    grid.appendChild(stamp);
    // after insertion, so the tile already has a box to intersect with
    observeStampArt(stamp.querySelector('.passport-stamp-art'));
  });

  if (focusedIndex >= 0) {
    grid.children[focusedIndex]?.focus?.();
  }
}

function updatePassportCount(countElement, visited, localization, progressBar) {
  if (!countElement) {
    return;
  }

  const count = visited.length;
  countElement.textContent = localization?.getMessage?.('passport_worlds_visited', [String(count), String(TOTAL_WORLDS)])
    || `${count}/${TOTAL_WORLDS} worlds visited`;

  if (progressBar) {
    const pct = TOTAL_WORLDS > 0 ? Math.round((count / TOTAL_WORLDS) * 100) : 0;
    progressBar.style.width = `${pct}%`;
  }
}

function setExploreOpen(explorePanel, exploreButton, open) {
  if (!explorePanel || !exploreButton) {
    return;
  }

  explorePanel.classList.toggle('hidden', !open);
  exploreButton.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setPassportOpen(panel, open, root = document.getElementById('passport')) {
  if (!panel) {
    return;
  }

  panel.classList.toggle('hidden', !open);
  root?.classList.toggle('is-open', Boolean(open));
}

function updateExploreLabels(localization) {
  const {
    exploreButton,
    exploreSettingsItem,
    exploreTourItem,
    explorePassportItem,
    hint
  } = getPassportElements();

  if (exploreButton) {
    const label = localization?.getMessage?.('explore_menu_label') || 'Explore';
    exploreButton.setAttribute('aria-label', label);
    exploreButton.title = label;

    const buttonLabel = exploreButton.querySelector('.explore-menu-button-label');
    if (buttonLabel) {
      buttonLabel.textContent = label;
    }
  }

  setMenuItemLabel(
    exploreSettingsItem,
    localization?.getMessage?.('explore_menu_settings') || 'Settings'
  );
  setMenuItemLabel(
    exploreTourItem,
    localization?.getMessage?.('popup_tour_open') || 'Tour the Galaxy'
  );
  setMenuItemLabel(
    explorePassportItem,
    localization?.getMessage?.('passport_title') || 'Planet Passport'
  );

  if (hint) {
    hint.textContent = localization?.getMessage?.('passport_hint')
      || 'Stamps unlock when local weather matches a world.';
  }
}

export function updatePassportUi(localization) {
  const { exploreRoot, root, panel, count, grid, close, progressBar } = getPassportElements();
  if (!exploreRoot || !root) {
    return;
  }

  const visited = getVisitedPlanets();
  updatePassportCount(count, visited, localization, progressBar);
  renderPassportGrid(grid, visited, localization);
  updateExploreLabels(localization);

  const title = document.getElementById('passportTitle');
  if (title) {
    title.textContent = localization?.getMessage?.('passport_title') || 'Planet Passport';
  }
  if (close) {
    close.setAttribute('aria-label', localization?.getMessage?.('passport_close') || 'Close');
  }

  exploreRoot.classList.remove('hidden');
  root.classList.remove('hidden');

  if (panel && !panel.dataset.initialized) {
    panel.dataset.initialized = 'true';
    setPassportOpen(panel, false, root);
  }
}

export function initPassport(localization) {
  const {
    exploreRoot,
    exploreButton,
    explorePanel,
    exploreSettingsItem,
    exploreTourItem,
    explorePassportItem,
    root,
    panel,
    close
  } = getPassportElements();

  if (!exploreRoot || !exploreButton || !explorePanel || !root || !panel) {
    return;
  }

  updatePassportUi(localization);

  if (exploreButton.dataset.bound === 'true') {
    return;
  }

  exploreButton.dataset.bound = 'true';

  exploreButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = explorePanel.classList.contains('hidden');
    if (open) {
      setPassportOpen(panel, false, root);
    }
    setExploreOpen(explorePanel, exploreButton, open);
  });

  if (exploreSettingsItem) {
    exploreSettingsItem.addEventListener('click', (event) => {
      event.stopPropagation();
      setExploreOpen(explorePanel, exploreButton, false);
      track('settings_opened', { surface: 'explore' });
      openSettingsPage();
    });
  }

  if (exploreTourItem) {
    exploreTourItem.addEventListener('click', (event) => {
      event.stopPropagation();
      setExploreOpen(explorePanel, exploreButton, false);
      openTourPage();
    });
  }

  if (explorePassportItem) {
    explorePassportItem.addEventListener('click', (event) => {
      event.stopPropagation();
      setExploreOpen(explorePanel, exploreButton, false);
      // discovery + retention signal; daily_activity carries planetsSeen for the other half
      track('passport_opened', { planetsSeen: getVisitedPlanets().length });
      setPassportOpen(panel, true, root);
    });
  }

  if (close) {
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      setPassportOpen(panel, false, root);
    });
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!explorePanel.classList.contains('hidden') && !exploreRoot.contains(target)) {
      setExploreOpen(explorePanel, exploreButton, false);
    }
    if (!panel.classList.contains('hidden') && !panel.contains(target) && !exploreRoot.contains(target)) {
      setPassportOpen(panel, false, root);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setExploreOpen(explorePanel, exploreButton, false);
      setPassportOpen(panel, false, root);
    }
  });
}

export { TOTAL_WORLDS, planetDayArt };
