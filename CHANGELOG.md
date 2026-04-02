# v1.0
- intial release
 
# v1.1
- minor bug fixes
- speed improvements

# v1.2
- minor sytle adustments
- added loading screen

# v1.2.1
- started using local storage to improve speed
- removed elevation API due to frequent down time
- other minor speed improvements

# v1.2.5
- added celsius temperature option
- file size reduction
- UI improvements
- new tab message changed from "Star Wars Weather" to "New Tab"

# v1.2.6
- changed weather API to OpenWeatherMap
- changed Kamino night photo
- celcius option rounds to nearest .5 rather than .1

# v1.2.7
- added "Last Updated" text to the bottom of the page
- changed some of the arguements for the planets
- other minor UI changes

# v1.2.9
- adjusted time parameters
- adjusted temp parameters

# v1.3.0 
- added support for Spanish

# v1.3.1
- bug fixes for switching between Fahrenheit and Celsius
- bug fixes for switching between Spanish and English

# v1.3.2
- Translation fixes, thanks to @Mrsvaca for reporting the issue

# v1.3.3
- now automatically sets the language to the browser's language
- bug fixes for dealing with errors in getting location

# v1.3.4
- added options page, now you can change the language and unit on the pop up or the options page
- added env.js to hide API keys (env.js is not included in the repo)
- fixed support for firefox, firefox users can download the extension from the firefox addon store 
- updated the readme
- changed the popup css

# v1.3.5
- Created offical new logo/icon for the extension!
- onboarding page added (opens when you first install the extension)
- added a link to the FAQ page on the popup
- changed png images to webp images to reduce file sizes
- now redirects to a survey when extension is uninstalled

# v1.3.6
- adjusted planet parameters
- updated the FAQ page
- updated the onboarding page
- updated the options page


# v1.3.6.1
- fixed typo in code

# v1.3.6.2
- thanks to @martinedelman for fixing spanish translations

# v2.0.0
- adopted Chrome-standard i18n localization with locale packs for English and Spanish
- refactored weather workflow (caching, error handling, debug override)
- refreshed popup/options UI with responsive styling and translation support
- updated new-tab background overlay and text contrast
- added manual location search with suggestions and a persistent location display indicator

# v2.0.1
- fixed error message

# v2.0.2
- updated Scarif summary localization strings to avoid mismatched time-of-day phrases
- made the hyperspace loading scene responsive and full-screen on ultrawide displays

# v2.1
- added search bar and top-sites shortcuts to the new tab page
- added popup/options toggles for new tab elements and hyperspace visibility
- settings now apply instantly without needing to refresh
- extracted shared constants and eliminated code duplication across modules
- refactored core modules to be testable with full test suite (136 tests)
- switched from npm to Bun
- updated localization strings (EN + ES), minor typo and FAQ fixes
- added github actions workflow for pushing to chrome web store using [cws-cli](https://github.com/vaughnbosu/cws-cli)

# v2.2
- redesigned onboarding into an interactive 4-step setup wizard
- users now choose between automatic and manual location during setup
- added unit, search bar, and shortcuts preferences to onboarding
- live location detection with city name confirmation
- location troubleshooting guide built into onboarding
- fixed permission handling race condition
- FAQ improvements and deep linking

# v2.2.1
- fixed new-tab shortcuts so they only render as many tiles as fit in a single row under the search bar
- improved new-tab search/shortcuts layout responsiveness
- reviewed and refined Spanish translations across weather, popup, and onboarding copy
- added Moderok analytics tracking
