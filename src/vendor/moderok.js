// src/version.ts
var SDK_VERSION = "0.1.0";

// src/context.ts
var cachedContext = null;
function parseBrowser(ua) {
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return { browser: "firefox", browserVersion: firefox[1] };
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return { browser: "edge", browserVersion: edge[1] };
  const chromeMatch = /Chrome\/([\d.]+)/.exec(ua);
  if (!chromeMatch) return { browser: "unknown", browserVersion: "unknown" };
  const browser = /OPR\/|Brave\/|Vivaldi\//.test(ua) ? "other_chromium" : "chrome";
  return { browser, browserVersion: chromeMatch[1] };
}
function parseOs(platform, ua) {
  const source = `${platform} ${ua}`;
  if (/Android/i.test(source)) return "Android";
  if (/CrOS/i.test(source)) return "ChromeOS";
  if (/Win/i.test(source)) return "Windows";
  if (/Mac/i.test(source)) return "MacOS";
  if (/Linux/i.test(source)) return "Linux";
  return "unknown";
}
function detectSource() {
  if (typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope) {
    return "background";
  }
  const href = typeof location === "undefined" ? "" : location.href;
  const protocol = typeof location === "undefined" ? "" : location.protocol;
  if (protocol !== "chrome-extension:" && protocol !== "moz-extension:" && protocol !== "extension:") {
    return typeof chrome !== "undefined" && chrome.runtime?.id ? "content_script" : "unknown";
  }
  if (/side[_-]?panel/i.test(href)) return "side_panel";
  if (/options/i.test(href)) return "options";
  if (/popup/i.test(href)) return "popup";
  return "extension_page";
}
function collectContext() {
  if (cachedContext) return cachedContext;
  const nav = typeof navigator === "undefined" ? void 0 : navigator;
  const ua = nav?.userAgent ?? "";
  const browser = parseBrowser(ua);
  const extensionId = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "unknown";
  const extensionVersion = typeof chrome !== "undefined" && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : "unknown";
  cachedContext = {
    sdkVersion: SDK_VERSION,
    extensionId,
    extensionVersion,
    browser: browser.browser,
    browserVersion: browser.browserVersion,
    os: parseOs(nav?.userAgentData?.platform ?? nav?.platform ?? "", ua),
    locale: nav?.language ?? "unknown",
    source: detectSource()
  };
  return cachedContext;
}

// src/identity.ts
function fallbackUuid() {
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
      continue;
    }
    if (i === 14) {
      out += "4";
      continue;
    }
    const value = Math.random() * 16 | 0;
    out += (i === 19 ? value & 3 | 8 : value).toString(16);
  }
  return out;
}
function createUuid() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : fallbackUuid();
}
function ensureUserId(state) {
  if (state.userId) {
    return { userId: state.userId, isNew: false, state };
  }
  const userId = createUuid();
  return {
    userId,
    isNew: true,
    state: { ...state, userId }
  };
}

// src/lifecycle.ts
var registered = false;
function registerOnInstalled(handler) {
  if (registered) return false;
  if (typeof chrome === "undefined" || !chrome.runtime?.onInstalled) return false;
  chrome.runtime.onInstalled.addListener(handler);
  registered = true;
  return true;
}

// src/transport.ts
async function sendPayload(endpoint, payload, debug) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8"
      },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      if (debug && typeof console !== "undefined") {
        console.debug(`[moderok] Transport accepted payload (${response.status}).`);
      }
      return { success: true };
    }
    if (response.status >= 500) {
      if (debug && typeof console !== "undefined") {
        console.warn(`[moderok] Transport failed with retryable status ${response.status}.`);
      }
      return { success: false, retryable: true, status: response.status };
    }
    if (debug && typeof console !== "undefined") {
      console.warn(`[moderok] Transport failed with non-retryable status ${response.status}.`);
    }
    return { success: false, retryable: false, status: response.status };
  } catch (error) {
    if (debug && typeof console !== "undefined") {
      console.warn("[moderok] Transport failed due to a network error.", error);
    }
    return { success: false, retryable: true };
  }
}

// src/queue.ts
var MAX_QUEUE_SIZE = 1e3;
var MAX_EVENT_BYTES = 8 * 1024;
var MAX_PERSISTED_EVENTS = 500;
var PERSIST_DEBOUNCE_MS = 5e3;
function capForPersistence(events) {
  if (events.length <= MAX_PERSISTED_EVENTS) return events;
  return events.slice(events.length - MAX_PERSISTED_EVENTS);
}
function capQueue(events, debug) {
  if (events.length <= MAX_QUEUE_SIZE) return;
  if (debug) {
    console.warn("[moderok] Queue full.");
  }
  events.splice(0, events.length - MAX_QUEUE_SIZE);
}
var EventQueue = class {
  constructor(appKey, endpoint, batchSize, flushInterval, debug, persistQueue) {
    this.appKey = appKey;
    this.endpoint = endpoint;
    this.batchSize = batchSize;
    this.flushInterval = flushInterval;
    this.debug = debug;
    this.persistQueue = persistQueue;
    this.queue = [];
    this.flushPromise = null;
    this.flushTimer = null;
    this.persistTimer = null;
  }
  start() {
    if (this.flushInterval <= 0 || this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }
  recover(events) {
    if (!events.length) return;
    this.queue = [...events, ...this.queue];
    capQueue(this.queue, this.debug);
  }
  get size() {
    return this.queue.length;
  }
  snapshot() {
    return capForPersistence(this.queue);
  }
  enqueue(event) {
    const json = JSON.stringify(event);
    if (new TextEncoder().encode(json).length > MAX_EVENT_BYTES) {
      if (this.debug) {
        console.warn("[moderok] Event too large.", event.name);
      }
      return;
    }
    this.queue.push(event);
    capQueue(this.queue, this.debug);
    if (this.debug) {
      console.debug(`[moderok] Enqueued "${event.name}" (queue size: ${this.queue.length})`);
    }
    this.schedulePersist();
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }
  async flush() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushLoop().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }
  async shutdown() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.flush();
    await this.persistQueue(capForPersistence(this.queue));
  }
  async flushLoop() {
    while (this.queue.length) {
      const batch = this.queue.slice(0, this.batchSize);
      if (this.debug) {
        console.debug(`[moderok] Flushing batch of ${batch.length} event(s)\u2026`);
      }
      const result = await sendPayload(
        this.endpoint,
        { appKey: this.appKey, events: batch, sentAt: Date.now() },
        this.debug
      );
      if (result.success) {
        if (this.debug) {
          console.debug(`[moderok] Flush succeeded. Remaining in queue: ${this.queue.length - batch.length}`);
        }
        this.queue = this.queue.slice(batch.length);
        await this.persistQueue(capForPersistence(this.queue));
        continue;
      }
      if (result.retryable) {
        await this.persistQueue(capForPersistence(this.queue));
        return;
      }
      this.queue = this.queue.slice(batch.length);
      if (this.debug) {
        console.warn("[moderok] Dropped batch.", result.status);
      }
      await this.persistQueue(capForPersistence(this.queue));
    }
  }
  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistQueue(capForPersistence(this.queue));
    }, PERSIST_DEBOUNCE_MS);
  }
};

// src/storage.ts
var STORAGE_KEY = "__moderok__";
var memoryState = {};
function hasStorageArea() {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}
async function loadState() {
  if (!hasStorageArea()) return memoryState;
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (chrome.runtime?.lastError) {
        resolve(memoryState);
        return;
      }
      const raw = result?.[STORAGE_KEY];
      memoryState = raw && typeof raw === "object" ? raw : {};
      resolve(memoryState);
    });
  });
}
async function saveState(state) {
  memoryState = state;
  if (!hasStorageArea()) return;
  await new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, () => {
      if (chrome.runtime?.lastError) {
        resolve();
        return;
      }
      resolve();
    });
  });
}

// src/index.ts
var DEFAULT_ENDPOINT = "https://y31isnjimb.execute-api.us-east-2.amazonaws.com/prod/v1/events";
var DEFAULT_FLUSH_INTERVAL = 3e4;
var DEFAULT_BATCH_SIZE = 20;
function utcDateStamp(now) {
  return new Date(now).toISOString().slice(0, 10);
}
function debugLog(enabled, level, message) {
  if (!enabled && level !== "error") return;
  console[level](`[moderok] ${message}`);
}
function sanitizeProperties(input, debug = false) {
  if (!input) return void 0;
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value;
      continue;
    }
    debugLog(debug, "warn", `Dropped unsupported event property "${key}".`);
  }
  return Object.keys(clean).length ? clean : void 0;
}
function normalizeConfig(config) {
  return {
    appKey: config.appKey,
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    flushInterval: Math.max(0, Math.floor(config.flushInterval ?? DEFAULT_FLUSH_INTERVAL)),
    batchSize: Math.max(1, Math.min(1e3, Math.floor(config.batchSize ?? DEFAULT_BATCH_SIZE))),
    debug: !!config.debug,
    trackUninstalls: !!config.trackUninstalls,
    trackErrors: !!config.trackErrors,
    uninstallUrl: config.uninstallUrl
  };
}
function buildUninstallUrl(config, userId) {
  try {
    const url = new URL(config.endpoint);
    url.pathname = url.pathname.replace(/\/[^/]*$/, "/uninstall");
    url.searchParams.set("app", config.appKey);
    url.searchParams.set("uid", userId);
    if (config.uninstallUrl) {
      url.searchParams.set("redirect", config.uninstallUrl);
    }
    return url.toString();
  } catch {
    return null;
  }
}
var ModerokClient = class {
  constructor() {
    this.config = null;
    this.initStarted = false;
    this.bootstrapped = false;
    this.autoInitAttempted = false;
    this.context = collectContext();
    this.userId = "";
    this.pendingLifecycle = null;
    this.drafts = [];
    this.state = {};
    this.queue = null;
  }
  init(config) {
    const nextConfig = normalizeConfig(config);
    registerOnInstalled((details) => {
      if (!this.bootstrapped) {
        this.pendingLifecycle = details;
        return;
      }
      this.handleLifecycle(details);
    });
    if (!nextConfig.appKey) {
      debugLog(nextConfig.debug, "error", "Missing appKey.");
      return;
    }
    if (this.initStarted) {
      debugLog(nextConfig.debug, "debug", "init() called again \u2014 skipping.");
      return;
    }
    this.initStarted = true;
    this.config = nextConfig;
    debugLog(nextConfig.debug, "debug", `Initializing with appKey="${nextConfig.appKey}".`);
    if (nextConfig.trackErrors) {
      debugLog(
        nextConfig.debug,
        "warn",
        "Error tracking is not yet available. This flag is reserved for a future release."
      );
    }
    this.queue = new EventQueue(
      nextConfig.appKey,
      nextConfig.endpoint,
      nextConfig.batchSize,
      nextConfig.flushInterval,
      nextConfig.debug,
      async (pendingEvents) => {
        this.state = { ...this.state, pendingEvents: pendingEvents.length ? pendingEvents : void 0 };
        await saveState(this.state);
      }
    );
    this.queue.start();
    void this.bootstrap();
  }
  track(name, properties) {
    if (!this.initStarted || !this.config) {
      this.drafts.push({
        id: createUuid(),
        name,
        properties: sanitizeProperties(properties),
        timestamp: Date.now()
      });
      if (!this.autoInitAttempted) {
        this.autoInitAttempted = true;
        debugLog(false, "debug", `track("${name}") called before init() \u2014 attempting auto-init from stored config.`);
        void this.autoInit();
      }
      return;
    }
    debugLog(this.config.debug, "debug", `track("${name}")`);
    const draft = {
      id: createUuid(),
      name,
      properties: sanitizeProperties(properties, this.config.debug),
      timestamp: Date.now()
    };
    if (!this.bootstrapped || !this.queue) {
      debugLog(this.config.debug, "debug", `  \u21B3 Buffered as draft (bootstrap not complete yet).`);
      this.drafts.push(draft);
      return;
    }
    this.queue.enqueue(this.makeEvent(draft.name, draft.timestamp, draft.properties, draft.id));
  }
  async autoInit() {
    try {
      const state = await loadState();
      if (state?.config?.appKey && !this.initStarted) {
        debugLog(state.config.debug, "debug", "Auto-initializing from stored config.");
        this.init(state.config);
      }
    } catch {
    }
  }
  async flush() {
    if (!this.queue) return;
    if (this.bootstrapped && this.drafts.length) this.flushDrafts();
    await this.queue.flush();
  }
  async shutdown() {
    if (!this.queue) return;
    if (this.bootstrapped && this.drafts.length) this.flushDrafts();
    await this.queue.shutdown();
  }
  isInitialized() {
    return this.initStarted;
  }
  async bootstrap() {
    if (!this.config || !this.queue) return;
    debugLog(this.config.debug, "debug", "Bootstrap starting\u2026");
    this.state = await loadState();
    debugLog(this.config.debug, "debug", `  \u21B3 Loaded state from chrome.storage.local.`);
    const identity = ensureUserId(this.state);
    this.userId = identity.userId;
    this.state = identity.state;
    debugLog(this.config.debug, "debug", `  \u21B3 User ID: ${this.userId} (${identity.isNew ? "new" : "existing"})`);
    this.context = collectContext();
    debugLog(this.config.debug, "debug", `  \u21B3 Context: ${this.context.browser} ${this.context.browserVersion}, ${this.context.os}, source=${this.context.source}`);
    this.queue.recover(this.state.pendingEvents ?? []);
    if (identity.isNew) {
      this.queue.enqueue(this.makeEvent("__first_open", Date.now()));
    }
    const today = utcDateStamp(Date.now());
    if (this.state.lastPingDate !== today) {
      this.state.lastPingDate = today;
      this.queue.enqueue(this.makeEvent("__daily_ping", Date.now()));
    }
    this.bootstrapped = true;
    debugLog(this.config.debug, "debug", "Bootstrap complete.");
    if (this.pendingLifecycle) {
      this.handleLifecycle(this.pendingLifecycle);
      this.pendingLifecycle = null;
    }
    this.flushDrafts();
    this.state.config = this.config;
    this.state.pendingEvents = this.queue.snapshot();
    await saveState(this.state);
    if (this.config.trackUninstalls && typeof chrome !== "undefined" && chrome.runtime?.setUninstallURL) {
      const url = buildUninstallUrl(this.config, this.userId);
      if (!url) {
        debugLog(this.config.debug, "warn", "Invalid endpoint; could not build uninstall URL.");
      } else if (url.length > 1023) {
        debugLog(this.config.debug, "warn", "Uninstall URL too long.");
      } else {
        chrome.runtime.setUninstallURL(url);
      }
    }
    if (this.queue.size) {
      void this.queue.flush();
    }
  }
  flushDrafts() {
    if (!this.queue || !this.bootstrapped) return;
    for (const draft of this.drafts.splice(0)) {
      this.queue.enqueue(this.makeEvent(draft.name, draft.timestamp, draft.properties, draft.id));
    }
  }
  handleLifecycle(details) {
    if (!this.queue) return;
    if (details.reason === "install") {
      this.queue.enqueue(this.makeEvent("__install", Date.now()));
      return;
    }
    if (details.reason === "update") {
      const properties = details.previousVersion ? { previousVersion: details.previousVersion } : void 0;
      this.queue.enqueue(this.makeEvent("__update", Date.now(), properties));
    }
  }
  makeEvent(name, timestamp, properties, id) {
    return {
      id: id ?? createUuid(),
      name,
      properties,
      timestamp,
      userId: this.userId,
      context: this.context
    };
  }
};
var client = new ModerokClient();
var Moderok = {
  init: (config) => client.init(config),
  track: (name, properties) => client.track(name, properties),
  flush: () => client.flush(),
  shutdown: () => client.shutdown(),
  isInitialized: () => client.isInitialized()
};
export {
  Moderok,
  buildUninstallUrl,
  normalizeConfig,
  sanitizeProperties,
  utcDateStamp
};
