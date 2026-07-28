/**
 * Slack message construction.
 *
 * Every reply produced here is delivered privately to the person who uploaded
 * the image. Nothing in this module is ever posted where a channel can see it.
 */

import type { KnownBlock } from '@slack/types';

import type { ExtractionFailureReason, ExtractionSuccess } from '../types.js';

const SOURCE_LABEL: Record<ExtractionSuccess['source'], string> = {
  tesseract: 'direct read',
  'tesseract+repair': 'read with check-digit correction',
  'ai-fallback': 'read via vision fallback',
};

const FAILURE_MESSAGE: Record<ExtractionFailureReason, string> = {
  no_mrz_found:
    'I could not find a machine readable zone in that image. Make sure the two lines of `<<<` characters along the bottom of the document are fully inside the frame.',
  unreadable:
    'I found the MRZ but could not read it reliably. A flatter angle and more even lighting usually fixes this.',
  // Failing check digits no longer cause a refusal — a partial reading is
  // returned with a warning instead. This reason now means the recogniser
  // could not assemble a reading at all, usually because the name line was
  // too damaged to identify.
  check_digits_failed:
    'I found the MRZ but could not make out enough of it to report anything — the name line in particular was unreadable. Please retake the photo straight-on, with the whole bottom strip in focus.',
  unsupported_mrz:
    'I found a machine readable zone, but not in a layout I decode. I read passports (TD3: two lines of 44 characters) and identity cards (TD1: three lines of 30). Visas and older card formats are not supported yet.',
  unsupported_format: 'That file type is not supported. Send a JPEG, PNG or HEIC photo.',
  too_large: 'That image is larger than I accept. Send a photo under 10 MB.',
  ocr_unavailable: 'The recognition service is not responding. This has been logged — try again shortly.',
  timeout: 'Processing took too long and was stopped. Please try again.',
};

/** Check digits, in the order they are worth reading about. */
const CHECKS: ReadonlyArray<{ key: keyof ExtractionSuccess['validation']; label: string }> = [
  { key: 'documentNumber', label: 'document number' },
  { key: 'birthDate', label: 'date of birth' },
  { key: 'expiryDate', label: 'date of expiry' },
  { key: 'personalNumber', label: 'personal number' },
  { key: 'composite', label: 'composite' },
];

/**
 * Which fields a reading proves, and which it merely guesses.
 *
 * `personalNumber` is skipped for TD1, which defines no such check digit —
 * reporting it as "verified" there would be claiming a guarantee that does not
 * exist.
 */
function verificationBreakdown(result: ExtractionSuccess): { verified: string[]; failed: string[] } {
  const verified: string[] = [];
  const failed: string[] = [];

  for (const { key, label } of CHECKS) {
    if (key === 'personalNumber' && result.format === 'TD1') continue;
    (result.validation[key] ? verified : failed).push(label);
  }

  return { verified, failed };
}

export function successBlocks(result: ExtractionSuccess): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const { verified, failed } = verificationBreakdown(result);

  // The warning goes first, so it cannot be missed by someone who copies the
  // string straight out of the code block.
  if (!result.validation.allValid) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          ':warning: *Some check digits did not verify — treat this reading as unconfirmed.*',
          `Failed: *${failed.join(', ')}*. Compare those fields against the document before using them.`,
        ].join('\n'),
      },
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `\`\`\`\n${result.formatted}\n\`\`\`` },
  });

  if (!result.validation.allValid && verified.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Check digits confirmed for: ${verified.join(', ')}. A confirmed field is exact.`,
        },
      ],
    });
  }

  // Deliberately precise about the limit of the guarantee: no MRZ format gives
  // the holder's name a check digit, so it is a best reading even when every
  // other field verifies.
  const status = result.validation.allValid
    ? 'All check digits verified'
    : 'Partly verified';

  const context = [
    `${status} · name never check-digit protected · ${SOURCE_LABEL[result.source]}`,
    result.edits > 0 ? `${result.edits} character(s) corrected` : null,
    'Not stored — this message is the only copy.',
  ]
    .filter(Boolean)
    .join(' · ');

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context }] });

  return blocks;
}

export function failureBlocks(reason: ExtractionFailureReason): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: FAILURE_MESSAGE[reason] },
    },
  ];
}

export function rateLimitedBlocks(): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'You are sending images faster than I can process them. Give it a minute and try again.',
      },
    },
  ];
}

export const HELP_TEXT = [
  '*passbot* reads the machine readable zone from a passport photo.',
  '',
  'Send me a photo *in this direct message* — include the two lines of `<<<` characters',
  'along the bottom of the document, shot straight-on and in focus.',
  '',
  'I reply with the decoded string and nothing else: the image is processed in memory,',
  'never written to disk, and never stored or logged.',
].join('\n');
