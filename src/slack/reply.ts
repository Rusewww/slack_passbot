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
  check_digits_failed:
    'I read the MRZ but the check digits did not verify, so I will not report a result I cannot prove is correct. Please retake the photo straight-on, with the whole bottom strip in focus.',
  unsupported_format: 'That file type is not supported. Send a JPEG, PNG or HEIC photo.',
  too_large: 'That image is larger than I accept. Send a photo under 10 MB.',
  ocr_unavailable: 'The recognition service is not responding. This has been logged — try again shortly.',
  timeout: 'Processing took too long and was stopped. Please try again.',
};

export function successBlocks(result: ExtractionSuccess): KnownBlock[] {
  const f = result.fields;
  const details = [
    `*Document code*  \`${f.documentCode}\``,
    `*Issuing state*  \`${f.issuingState}\``,
    `*Document no.*  \`${f.documentNumber}\``,
    `*Nationality*  \`${f.nationality}\``,
    `*Sex*  \`${f.sex}\``,
  ].join('\n');

  const context = [
    `All check digits verified · ${SOURCE_LABEL[result.source]}`,
    result.edits > 0 ? `${result.edits} character(s) corrected` : null,
    'Not stored — this message is the only copy.',
  ]
    .filter(Boolean)
    .join(' · ');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${result.formatted}\n\`\`\`` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: details } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
  ];
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
