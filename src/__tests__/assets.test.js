import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { PLANET_RULES } from '../planets.js';

const ASSET_DIR = join(import.meta.dir, '..', '..', 'public', 'assets');
const PASSPORT_DIR = join(ASSET_DIR, 'passport');

function readWebPSize(path) {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;

    if (chunkType === 'VP8 ') {
      return {
        width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff
      };
    }

    if (chunkType === 'VP8L') {
      const packed = bytes.readUInt32LE(dataOffset + 1);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1
      };
    }

    if (chunkType === 'VP8X') {
      return {
        width: bytes.readUIntLE(dataOffset + 4, 3) + 1,
        height: bytes.readUIntLE(dataOffset + 7, 3) + 1
      };
    }

    offset = dataOffset + chunkLength + (chunkLength % 2);
  }

  throw new Error(`${path} has no WebP image chunk`);
}

describe('optimized bundled assets', () => {
  test('every top-level .webp asset is genuine WebP and no wider than 2560px', () => {
    const files = readdirSync(ASSET_DIR).filter((name) => name.endsWith('.webp'));
    expect(files.length).toBeGreaterThan(0);

    files.forEach((name) => {
      const dimensions = readWebPSize(join(ASSET_DIR, name));
      expect(dimensions.width).toBeGreaterThan(0);
      expect(dimensions.height).toBeGreaterThan(0);
      expect(dimensions.width).toBeLessThanOrEqual(2560);
    });
  });

  test('Passport has one compact day-art thumbnail per planet', () => {
    const expected = PLANET_RULES
      .map((planet) => `${planet.backgrounds?.day || planet.id}.webp`)
      .sort();
    const actual = readdirSync(PASSPORT_DIR).filter((name) => name.endsWith('.webp')).sort();

    expect(actual).toEqual(expected);

    let totalBytes = 0;
    actual.forEach((name) => {
      const path = join(PASSPORT_DIR, name);
      const dimensions = readWebPSize(path);
      totalBytes += statSync(path).size;
      expect(dimensions.width).toBeLessThanOrEqual(320);
    });

    expect(totalBytes).toBeLessThan(150 * 1024);
  });

  test('the optimized hyperspace clip stays below its package budget', () => {
    const path = join(ASSET_DIR, 'hyperspace.mp4');
    const header = readFileSync(path).subarray(0, 12);
    const indexHtml = readFileSync(join(ASSET_DIR, '..', 'index.html'), 'utf8');

    expect(header.subarray(4, 8).toString('ascii')).toBe('ftyp');
    expect(statSync(path).size).toBeLessThan(6 * 1024 * 1024);
    expect(indexHtml).not.toMatch(/<video\b/i);
    expect(indexHtml).not.toContain('hyperspace.mp4');
  });
});
