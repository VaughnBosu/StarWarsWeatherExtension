# Star Wars Weather Privacy Policy

Last updated: October 18, 2026

Star Wars Weather turns your browser's new-tab page into a weather display. This policy explains what information the extension and its supporting service process, why they process it, and the choices you have.

## The short version

- Your current or selected location is used to retrieve weather and a readable place name.
- Most preferences, progress, and recent results stay in your browser.
- Optional shortcuts and history suggestions are generated in your browser. We do not receive your browsing history, visited URLs, or search text.
- We collect limited, pseudonymous usage and reliability data. We do not use it for advertising.
- We do not sell personal information.

## Information we process

### Location and weather

If you choose **Use My Location**, your browser asks for permission and provides current coordinates. Depending on your browser, device, and settings, those coordinates may be precise or approximate. If you choose a city manually, the city search and the coordinates, name, region, and country of the place you select are processed instead.

Location information is sent over an encrypted connection to our supporting service. The service uses third-party providers to return current conditions, sunrise and sunset times, and a readable place name. Only the information needed for that request is sent. Coordinates are reduced to an approximate area before they leave the extension, and the service may temporarily reuse a recent result for other requests in that area. A persistent analytics identifier is not attached to weather or location requests.

To keep new tabs responsive, a recent automatic weather result may be displayed immediately while the extension checks location and freshness in the background. The initial location request favors a fast response. If the browser reports that result as unusually imprecise, the extension may make one bounded, non-blocking request for a more accurate position; it does not continuously monitor location.

We do not use location information to build a movement history, advertise to you, or profile you.

### Information stored in your browser

The extension stores information needed to provide its features, including:

- your selected manual location, including its coordinates and display name;
- recent and last-known weather, an approximate automatic-location area used for refresh checks, place-name lookups, and recent city-search results;
- a short wait time recorded when the weather service reports an outage or asks clients to slow down;
- language, temperature unit, new-tab feature choices, and onboarding status;
- planets you have seen for Passport progress; and
- local counters and queued events used for usage telemetry.

Most of this information uses extension-local browser storage. A random pseudonymous installation identifier and delivery state may also use your browser's extension storage and, when supported, its sync feature. Browser sync is controlled by your browser account and settings.

### Optional browser features

Shortcuts, history suggestions, and browser search require optional browser permissions or a setting you enable. When enabled:

- top-site titles and URLs are read locally to create shortcut tiles;
- matching browser-history entries are read locally while you type a suggestion; and
- a submitted search is handed to your browser's configured search provider.

We do not receive or include the contents of your browsing history, visited URLs, or search text in analytics. To display an icon for a shortcut or suggestion, the site's hostname may be sent to a third-party favicon provider. That provider also receives ordinary request data such as your IP address. Clicking a shortcut or submitting a search sends information to the destination or search provider under its own privacy practices.

### Usage, diagnostics, and service logs

The extension sends limited, sometimes sampled telemetry associated with a random pseudonymous identifier. This may include:

- install, update, daily-use, and uninstall events;
- extension and browser version, browser family, operating system, language, and page type;
- counts of new tabs, cache hits, weather or place lookups, errors, and offline fallbacks;
- feature settings and interactions;
- the matched planet and day/night state; and
- error categories or status codes and, when a manual location is selected, its country.

Telemetry does not include exact coordinates, city-search text, browsing history, visited URLs, or submitted search text. If you uninstall, your browser may open an optional feedback page carrying the pseudonymous installation identifier; providing feedback is voluntary.

Our infrastructure and third-party providers also receive ordinary network and security information such as IP address, request time, route, response status, and user-agent information. To prevent one source from consuming the shared upstream allowance, the supporting service may count cache-miss requests under one-way network-address fingerprints that rotate with each counting window (five minutes and one UTC day). The raw address is not placed in the application cache or application logs. Operational and security logs are designed not to include coordinates, city queries, browsing history, or persistent extension identifiers.

## How we use information

We use the information described above to:

- provide weather, place search, localization, shortcuts, and other requested features;
- make the extension faster and keep limited offline behavior working;
- measure feature usage and understand whether a release works correctly;
- troubleshoot failures, prevent abuse, enforce rate limits, and protect the service; and
- comply with applicable law and enforce our rights.

We do not use this information for targeted advertising or sell it.

## When information is shared

We share only what is needed with these categories of recipients:

- **Weather and location providers** receive coordinates or city-search text needed to return weather or place results.
- **Infrastructure and security providers** process requests, caching, rate limiting, and operational logs for the supporting service.
- **Analytics and diagnostics providers** process the limited pseudonymous events described above.
- **Favicon and search providers** receive information only when the related optional feature loads an icon or you submit a search.

These providers process information under their own terms and privacy practices. We may also disclose information when reasonably necessary to comply with law, protect users or the service, investigate abuse, or complete a project transfer subject to this policy.

## Retention

- A recent weather result may remain in the extension's local cache for up to one hour and can be replaced sooner after a background location check, or after 15 minutes when the service marked it as stale. The last-known result remains until it is replaced or you clear the extension's data.
- Successful local place-name and city-search entries generally expire after 30 days. Unsuccessful lookups generally expire after one day. These caches also have fixed entry limits.
- A manual location, preferences, Passport progress, and onboarding state remain until you change them, clear extension data, or uninstall the extension.
- Shared weather results are fresh for no more than 20 minutes. If a refresh fails or is temporarily limited, an older result may be used as an outage fallback for up to six hours and is identified to the extension as stale. Place search and reverse-location results may be cached for up to 30 days, and unsuccessful lookups for up to one day.
- One-way abuse-control fingerprints change with every counting window (five minutes, and separately each UTC day), become eligible for automatic deletion about one hour after that window closes, and are not used to identify or track extension installations. Automatic deletion may occur later.
- Supporting-service operational and security logs are normally retained for up to 30 days. They may be kept longer when required to investigate abuse, resolve a security incident, or meet a legal obligation.
- Pseudonymous analytics may be kept longer to compare reliability and usage across releases, then deleted or aggregated when it is no longer needed.

Third-party providers may keep information according to their own retention rules.

## Your choices

You can deny or revoke location permission and select a city manually instead. You can leave shortcuts, history suggestions, and browser search disabled, or revoke their optional permissions in your browser. You can clear the extension's local data through your browser or uninstall the extension; your browser's sync controls may need to be managed separately.

The current version does not provide a separate switch for limited usage telemetry. Clearing extension data resets its local telemetry state and pseudonymous identifier, although browser sync may restore synced extension data.

## Security

We use encrypted connections, data minimization, access controls, short-lived caches, rate limits, and monitoring intended to protect information. No internet service can guarantee perfect security.

## Children

Star Wars Weather is not directed to children under 13, and we do not knowingly collect personal information from children under 13. If you believe a child has provided personal information, contact us so we can review the report.

## Changes to this policy

We may update this policy as the extension changes. We will update the date above and use release notes or store-facing notices when a change is material.

## Contact and source

Questions or privacy requests can be submitted through the project's [public issue tracker](https://github.com/vaughnbosu/StarWarsWeatherExtension/issues). Please do not post private information in a public issue; ask for a private contact method if your request contains sensitive details.

The extension's [source code is publicly available](https://github.com/vaughnbosu/StarWarsWeatherExtension).
