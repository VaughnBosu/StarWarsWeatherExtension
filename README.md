# StarWarsWeather
Open a new tab page display a star wars background based on the weather!
This extension is for Firefox and Chrome

## Background
A while back there was a website by Tom Scott that would get the weather in an area and compare it to a Star Wars planet. This website has since stopped working due to reasons listed [here](https://www.tomscott.com/weather/starwars/). My project revives and expands on this idea, there are now 13 planets, and each one has 2 images for day and night. This also uses more data about the climate like humidity, wind speeds and elevation. This extension has options for Fahrenheit and Celsius.

## How does it work?
1. Get the user's location, or use a city selected in settings.
2. Fetch the current weather and sunrise/sunset times (data from [OpenWeather](https://openweathermap.org/)).
3. Match the conditions to a Star Wars planet.
4. Show the day or night artwork for that planet.

## How it Determines which Planet
The rules in `src/planets.js` are checked **in order**, and the first one that matches wins.

| # | Planet | Matches when |
|---|--------|--------------|
| 1 | **Hoth** | Snow, or temps at or below 32°F |
| 2 | **Kamino** | Rain, drizzle, or thunderstorms |
| 3 | **Endor** | Fog or mist |
| 4 | **Ahch-To** | Squalls |
| 5 | **Bespin** | Wind at or above 35 mph |
| 6 | **Geonosis** | Sand or dust storms |
| 7 | **Scarif** | 70–85°F with clear skies or few clouds |
| 8 | **Dagobah** | Humidity at or above 93% and temps at or above 80°F |
| 9 | **Nevarro** | Volcanic ash, smoke, or haze |
| 10 | **Naboo** | 33–54°F |
| 11 | **Coruscant** | 55–79°F |
| 12 | **Tatooine** | 80–95°F |
| 13 | **Mustafar** | 96°F and hotter |

Coruscant is also the fallback when nothing matches.

## Development

### Prerequisites
- [Bun](https://bun.sh/) - Fast JavaScript runtime & package manager

### Installation
```bash
bun install  # Install dependencies
cp src/env.example.js src/env.js
```
CI generates `src/env.js` from the `BACKEND_BASE_URL` repository variable (the backend stack's `ApiBaseUrl` output); update it whenever the API host changes.

### Running the Extension
No build step required - load the unpacked extension directly:
- **Chrome**: `chrome://extensions` → "Load unpacked" → select project root
- **Firefox**: `about:debugging` → "Load Temporary Add-on" → select manifest.json

### Testing
```bash
bun test  # Run tests with Bun's built-in test runner
```

### Scripts
- `bun install` - Install dependencies
- `bun test` - Run tests
- `bun run dev` - Run with watch mode for development

### CI/CD
Pushes to `main` run the tests and publish a staged Chrome Web Store release.

## Contributing
Like the project? Please consider contributing to this project, lots of improvements and optimizations can be made.

[![Available in the Chrome Web Store](https://user-images.githubusercontent.com/19192015/132961666-64cf372a-ad35-47ad-b378-4de4b4a07d6d.png)](https://chrome.google.com/webstore/detail/star-wars-weather/hjphhbgleggdljkdlmlblbamlnkmdgag)

## Mozilla Add-on Store Status: APPROVED
Working [Link](https://addons.mozilla.org/en-US/firefox/addon/star-wars-weather/)
