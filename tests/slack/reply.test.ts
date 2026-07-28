import { describe, expect, it } from 'vitest';

import { formatPassbotLine } from '../../src/mrz/format.js';
import { parseTd3 } from '../../src/mrz/td3.js';
import { successBlocks } from '../../src/slack/reply.js';
import type { ExtractionSuccess } from '../../src/types.js';
import { SPECIMEN_EXPECTED_OUTPUT, SPECIMEN_LINE_1, SPECIMEN_LINE_2 } from '../fixtures/specimen.js';

function build(line2: string, format: ExtractionSuccess['format'] = 'TD3'): ExtractionSuccess {
  const parsed = parseTd3(SPECIMEN_LINE_1, line2);
  return {
    ok: true,
    fields: parsed.fields,
    validation: parsed.validation,
    format,
    anomalies: [],
    source: 'tesseract',
    edits: 0,
    formatted: formatPassbotLine(parsed.fields),
  };
}

/** Flattens every piece of text in the blocks so assertions can be simple. */
function textOf(blocks: ReturnType<typeof successBlocks>): string {
  return JSON.stringify(blocks);
}

const VERIFIED = build(SPECIMEN_LINE_2);
// Stated expiry check digit altered: no substitution can reconcile it, so the
// expiry is unverifiable while everything else still proves out.
const PARTIAL = build(SPECIMEN_LINE_2.slice(0, 27) + '1' + SPECIMEN_LINE_2.slice(28));

describe('successBlocks on a fully verified reading', () => {
  it('carries no warning', () => {
    expect(textOf(successBlocks(VERIFIED))).not.toContain(':warning:');
  });

  it('reports every check digit as verified', () => {
    expect(textOf(successBlocks(VERIFIED))).toContain('All check digits verified');
  });

  it('still says the name is not check-digit protected', () => {
    // True even of a perfect read: no MRZ format gives the name a check digit.
    expect(textOf(successBlocks(VERIFIED))).toContain('name never check-digit protected');
  });

  it('includes the delivery string', () => {
    expect(textOf(successBlocks(VERIFIED))).toContain(SPECIMEN_EXPECTED_OUTPUT);
  });
});

describe('successBlocks on a partly verified reading', () => {
  const blocks = successBlocks(PARTIAL);

  it('still delivers the reading rather than refusing', () => {
    expect(PARTIAL.validation.allValid).toBe(false);
    expect(textOf(blocks)).toContain('TKACHENKO');
  });

  it('leads with the warning, before the result', () => {
    // Someone copying the string out of the code block must not miss it.
    expect(textOf(blocks[0] ? [blocks[0]] : [])).toContain(':warning:');
  });

  it('names the checks that failed', () => {
    expect(textOf(blocks)).toContain('date of expiry');
  });

  it('names the checks that held, so partial trust is possible', () => {
    const text = textOf(blocks);
    expect(text).toContain('Check digits confirmed for');
    expect(text).toContain('document number');
    expect(text).toContain('date of birth');
  });

  it('does not claim full verification', () => {
    expect(textOf(blocks)).not.toContain('All check digits verified');
  });
});

describe('successBlocks for TD1', () => {
  it('omits the personal number, which TD1 does not check-digit', () => {
    // Claiming it verified would assert a guarantee the format never makes.
    const partialTd1 = build(
      SPECIMEN_LINE_2.slice(0, 27) + '1' + SPECIMEN_LINE_2.slice(28),
      'TD1',
    );
    expect(textOf(successBlocks(partialTd1))).not.toContain('personal number');
  });
});
