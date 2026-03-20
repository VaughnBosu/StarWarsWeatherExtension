import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const localePaths = [
  join(import.meta.dir, '..', '..', '_locales', 'en', 'messages.json'),
  join(import.meta.dir, '..', '..', '_locales', 'es', 'messages.json')
];

const requiredKeys = [
  'alert_geolocation_error',
  'center_heading_prefix',
  'center_heading_suffix',
  'error_weather_unavailable',
  'last_updated_date_time',
  'last_updated_placeholder',
  'last_updated_time',
  'location_display',
  'location_display_unknown',
  'time_of_day_afternoon',
  'time_of_day_evening',
  'time_of_day_morning',
  'time_of_day_night',
  'time_of_day_pre_dawn',
  'planet_hoth_name',
  'planet_hoth_summary',
  'planet_hoth_description',
  'planet_kamino_name',
  'planet_kamino_summary',
  'planet_kamino_description',
  'planet_endor_name',
  'planet_endor_summary',
  'planet_endor_description',
  'planet_bespin_name',
  'planet_bespin_summary',
  'planet_bespin_description',
  'planet_scarif_name',
  'planet_scarif_summary',
  'planet_scarif_description',
  'planet_dagobah_name',
  'planet_dagobah_summary',
  'planet_dagobah_description',
  'planet_naboo_name',
  'planet_naboo_summary',
  'planet_naboo_description',
  'planet_coruscant_name',
  'planet_coruscant_summary',
  'planet_coruscant_description',
  'planet_tatooine_name',
  'planet_tatooine_summary',
  'planet_tatooine_description',
  'planet_mustafar_name',
  'planet_mustafar_summary',
  'planet_mustafar_description',
  'popup_title',
  'popup_subtitle',
  'popup_units_title',
  'popup_units_hint',
  'units_fahrenheit_label',
  'units_celsius_label',
  'popup_language_title',
  'popup_language_hint',
  'language_english_label',
  'language_spanish_label',
  'popup_links_title',
  'popup_manual_location_title',
  'popup_manual_location_hint',
  'popup_manual_location_placeholder',
  'popup_manual_location_search',
  'popup_manual_location_clear',
  'popup_manual_location_searching',
  'popup_manual_location_no_results',
  'popup_manual_location_error',
  'popup_manual_location_selected',
  'popup_manual_location_auto',
  'popup_link_rate',
  'popup_link_bug',
  'popup_link_source',
  'popup_link_author',
  'popup_link_survey'
];

describe('i18n keys', () => {
  test('required keys exist in each locale', () => {
    localePaths.forEach((path) => {
      const raw = readFileSync(path, 'utf8');
      const messages = JSON.parse(raw);
      requiredKeys.forEach((key) => {
        expect(messages[key]).toBeTruthy();
      });
    });
  });
});
