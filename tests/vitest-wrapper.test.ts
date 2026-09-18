import { describe, expect, it } from 'vitest';
import { normalizeVitestArgs } from '../scripts/run-vitest.mjs';

describe('normalizeVitestArgs', () => {
  it('drops Jest-only runInBand flag without breaking the default vitest run', () => {
    expect(normalizeVitestArgs(['--runInBand'])).toEqual(['run']);
  });

  it('keeps watch mode when explicitly requested', () => {
    expect(normalizeVitestArgs(['--watch'])).toEqual(['--watch']);
  });

  it('removes watchAll aliases that are not supported by Vitest', () => {
    expect(normalizeVitestArgs(['--watchAll', '--runInBand'])).toEqual(['run']);
  });
});
