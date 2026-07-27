import { describe, expect, it } from 'vitest';

import { formatMrzDate, formatPassbotLine, resolveYear } from '../../src/mrz/format.js';
import { parseTd3 } from '../../src/mrz/td3.js';
import {
  SPECIMEN_EXPECTED_OUTPUT,
  SPECIMEN_LINE_1,
  SPECIMEN_LINE_2,
} from '../fixtures/specimen.js';

describe('formatMrzDate', () => {
  it('converts YYMMDD to DDMONYY', () => {
    expect(formatMrzDate('910824')).toBe('24AUG91');
    expect(formatMrzDate('230925')).toBe('25SEP23');
    expect(formatMrzDate('000101')).toBe('01JAN00');
    expect(formatMrzDate('991231')).toBe('31DEC99');
  });

  it('rejects malformed input', () => {
    expect(() => formatMrzDate('91082')).toThrow();
    expect(() => formatMrzDate('91AUG4')).toThrow();
    expect(() => formatMrzDate('911324')).toThrow(); // month 13
  });
});

describe('resolveYear', () => {
  const now = new Date('2026-07-27T00:00:00Z');

  it('places a birth year that would be in the future into the last century', () => {
    expect(resolveYear('91', 'birth', now)).toBe(1991);
    expect(resolveYear('05', 'birth', now)).toBe(2005);
  });

  it('allows expiry dates inside a forward window', () => {
    expect(resolveYear('23', 'expiry', now)).toBe(2023);
    expect(resolveYear('35', 'expiry', now)).toBe(2035);
    expect(resolveYear('99', 'expiry', now)).toBe(1999);
  });
});

describe('formatPassbotLine', () => {
  it('produces the exact delivery format from the specimen document', () => {
    const { fields } = parseTd3(SPECIMEN_LINE_1, SPECIMEN_LINE_2);
    expect(formatPassbotLine(fields)).toBe(SPECIMEN_EXPECTED_OUTPUT);
  });

  it('emits nine slash-separated fields', () => {
    const { fields } = parseTd3(SPECIMEN_LINE_1, SPECIMEN_LINE_2);
    expect(formatPassbotLine(fields).split('/')).toHaveLength(9);
  });
});
