# StarWarsWeather
Open a new tab page display a star wars background based on the weather!
This extension is for Firefox and Chrome

## Background
A while back there was a website by Tom Scott that would get the weather in an area and compare it to a Star Wars planet. This website has since stopped working due to reasons listed [here](https://www.tomscott.com/weather/starwars/). My project revives and expands on this idea, there are now 10 planets, and each one has 2 images for day and night. This also uses more data about the climate like humidity, wind speeds and elevation. This extension has options for Fahrenheit and Celsius.

## How does it work?
1. This extension gets the user's location (or uses a saved manual city if you've configured one in the popup/options).
2. Get the time and deterime day or night.
3. Gives the location info to a [Weather API](https://openweathermap.org/).
4. This API gather the following data temperature, conditions, humidity, wind.
5. It use these parameters to deterime the planet. See exact details below.
6. It gets the image (depending on time of day), description and message and edits the HTML to display them.

## How it Determines which Planet
Each planet has specific reasons for when it will be used here they are:  

**Hoth**: used when snow, hail, ice or a blizzard is present. Or if temps are below freezing  
**Endor**: used when it is misty or foggy  
**Dagobah**: used when humidity is above 80%  
**Bespin**: used when wind speeds are at or above 35mph  
**Kamino**: used when it is raining or there is a storm  
**Naboo** used when temps are between 33-49F  
**Coruscant** used when temps are between 50-69F  
**Scariff** used when temps are between 70-84F  
**Tatooine** used when temps are between 85-96F  
**Mustafar** used when temps are above 96F  

## Privacy
Privacy is incredibly important, that's why this project is open source. This extension is ran on the machine which installed it. This extension does NOT store any location data. Any stored data is on the users machine and not accessible anywhere else.

## Development

### Prerequisites
- [Bun](https://bun.sh/) - Fast JavaScript runtime & package manager

### Installation
```bash
bun install  # Install dependencies
```

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
Pushes to `main` automatically upload and publish the extension to the Chrome Web Store via a GitHub Actions workflow using [cws-cli](https://github.com/vaughnbosu/cws-cli).

## Contributing
Like the project? Please consider contributing to this project, lots of improvements and optimizations can be made.

[![Available in the Chrome Web Store](https://user-images.githubusercontent.com/19192015/132961666-64cf372a-ad35-47ad-b378-4de4b4a07d6d.png)](https://chrome.google.com/webstore/detail/star-wars-weather/hjphhbgleggdljkdlmlblbamlnkmdgag)

## Mozilla Add-on Store Status: APPROVED
Working [Link](https://addons.mozilla.org/en-US/firefox/addon/star-wars-weather/)
