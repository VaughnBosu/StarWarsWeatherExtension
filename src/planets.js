const PLANET_RULES = [
  {
    id: 'hoth',
    name: 'Hoth',
    backgrounds: { day: 'hoth', night: 'hothNight' },
    predicate: ({ tempF, weatherMain }) => weatherMain === 'Snow' || tempF <= 32
  },
  {
    id: 'kamino',
    name: 'Kamino',
    backgrounds: { day: 'kamino', night: 'kaminoNight' },
    predicate: ({ weatherMain }) => ['Rain', 'Drizzle', 'Thunderstorm'].includes(weatherMain)
  },
  {
    id: 'endor',
    name: 'Endor',
    backgrounds: { day: 'endor', night: 'endorNight' },
    predicate: ({ weatherMain }) => ['Fog', 'Mist'].includes(weatherMain)
  },
  {
    id: 'bespin',
    name: 'Bespin',
    backgrounds: { day: 'bespin', night: 'bespinNight' },
    predicate: ({ windSpeedMph }) => windSpeedMph >= 35
  },
  {
    id: 'scarif',
    name: 'Scarif',
    backgrounds: { day: 'scarif', night: 'scarifNight' },
    predicate: ({ tempF, weatherMain, weatherDescription }) => {
      const normalizedDescription = weatherDescription.toLowerCase();
      return tempF >= 70 && tempF <= 85 && (weatherMain === 'Clear' || normalizedDescription.includes('few clouds'));
    }
  },
  {
    id: 'dagobah',
    name: 'Dagobah',
    backgrounds: { day: 'dagobah', night: 'dagobahNight' },
    predicate: ({ humidity, tempF }) => humidity >= 93 && tempF >= 80
  },
  {
    id: 'naboo',
    name: 'Naboo',
    backgrounds: { day: 'naboo', night: 'nabooNight' },
    predicate: ({ tempF }) => tempF >= 33 && tempF <= 54
  },
  {
    id: 'coruscant',
    name: 'Coruscant',
    backgrounds: { day: 'coruscant', night: 'coruscantNight' },
    predicate: ({ tempF }) => tempF >= 55 && tempF < 80
  },
  {
    id: 'tatooine',
    name: 'Tatooine',
    backgrounds: { day: 'tatooine', night: 'tatooineNight' },
    predicate: ({ tempF }) => tempF >= 80 && tempF <= 95
  },
  {
    id: 'mustafar',
    name: 'Mustafar',
    backgrounds: { day: 'mustafar', night: 'mustafarNight' },
    predicate: ({ tempF }) => tempF >= 96
  }
];

const DEFAULT_PLANET_RULE = {
  id: 'coruscant',
  name: 'Coruscant',
  backgrounds: { day: 'coruscant', night: 'coruscantNight' }
};

export { PLANET_RULES, DEFAULT_PLANET_RULE };
