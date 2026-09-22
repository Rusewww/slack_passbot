/**
 * Slack message construction.
 *
 * Every reply produced here is delivered privately to the person who uploaded
 * the image. Nothing in this module is ever posted where a channel can see it.
 */

import type { KnownBlock } from '@slack/types';

import { buildLabel } from '../buildInfo.js';
import type { ExtractionFailureReason, ExtractionSuccess } from '../types.js';

const SOURCE_LABEL: Record<ExtractionSuccess['source'], string> = {
  tesseract: 'звичайне зчитування',
  'tesseract+repair': 'зчитано з автоматичним виправленням',
  'ai-fallback': 'зчитано за допомогою ШІ',
};

const FAILURE_MESSAGE: Record<ExtractionFailureReason, string> = {
  no_mrz_found:
    'Не вдалося знайти спеціальну зону з даними на цьому фото. Переконайтеся, що два рядки MRZ внизу документа повністю потрапили в кадр.',
  unreadable:
    'Рядки з даними знайдено, але зчитати їх не вдалося. Спробуйте інше фото за наявності або ж скопіюйте дані вручну.',
  // Failing check digits do not cause a refusal; a partial reading goes out
  // with a warning instead. This reason means the recogniser could not
  // assemble a reading at all, usually because the name line was too damaged
  // to identify.
  check_digits_failed:
    'MRZ знайдено, але розібрати їх не вдалося (особливо рядок з іменем). Спробуйте інше фото за наявності або ж скопіюйте дані вручну.',
  name_unreadable:
    "Номер документа та дати зчитано, але ім'я розібрати складно. Щоб не видати помилковий результат, процес зупинено. Спробуйте інше фото за наявності або ж скопіюйте дані вручну.",
  unsupported_mrz:
    'Машинозчитувану зону знайдено, але цей формат поки не підтримується. Я вмію читати паспорти (два рядки по 44 символи) та ID-картки (три рядки по 30). Візи та старі формати документів наразі не підтримуються.',
  unsupported_format: 'Цей тип файлу не підтримується. Надішліть фото у форматі JPEG, PNG або HEIC.',
  too_large: 'Це фото завелике. Надішліть файл розміром до 10 МБ.',
  ocr_unavailable: 'Сервіс розпізнавання тимчасово не працює. Спробуйте пізніше.',
  timeout: 'Обробка тривала надто довго й була зупинена. Спробуйте ще раз.',
};

/** Check digits, in the order they are worth reading about. */
const CHECKS: ReadonlyArray<{ key: keyof ExtractionSuccess['validation']; label: string }> = [
  { key: 'documentNumber', label: 'номер документа' },
  { key: 'birthDate', label: 'дата народження' },
  { key: 'expiryDate', label: 'дата завершення строку дії' },
  { key: 'personalNumber', label: 'особистий номер' },
  { key: 'composite', label: 'загальна перевірка' },
];

/**
 * Which fields a reading proves, and which it merely guesses.
 *
 * `personalNumber` is skipped for TD1, which defines no such check digit.
 * Reporting it as "verified" there would claim a guarantee that does not
 * exist.
 */
function verificationBreakdown(result: ExtractionSuccess): { verified: string[]; failed: string[] } {
  const verified: string[] = [];
  const failed: string[] = [];

  for (const { key, label } of CHECKS) {
    if (key === 'personalNumber' && result.format === 'TD1') continue;
    // An issuer that does not use the personal number leaves it as filler
    // with a `<` check digit. That is "not present", and listing it as
    // verified would claim a check that never ran.
    if (key === 'personalNumber' && result.fields.personalNumber === '') continue;
    (result.validation[key] ? verified : failed).push(label);
  }

  return { verified, failed };
}

export function successBlocks(result: ExtractionSuccess): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const { verified, failed } = verificationBreakdown(result);

  // Anomalies come first: an issuer-format mismatch means a field is wrong in
  // a way the check digits are structurally unable to detect, which is more
  // serious than a check digit that simply failed.
  if (result.anomalies.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          ':rotating_light: Здається, дані зчиталися з помилкою, яку не вдалося виправити автоматично. Перевірте перед використанням.',
          ...result.anomalies.map((anomaly) => `• ${anomaly}`),
        ].join('\n'),
      },
    });
  }

  // The warning goes next, so it cannot be missed by someone who copies the
  // string straight out of the code block.
  if (!result.validation.allValid) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          ":warning: Деякі дані не пройшли перевірку. Обов'язково перевірте результат самостійно.",
          `Не пройшли перевірку: *${failed.join(', ')}*. Звірте ці поля з документом, перш ніж використовувати їх.`,
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
          text: `Успішно перевірено: ${verified.join(', ')}. Ці дані зчитано коректно.`,
        },
      ],
    });
  }

  // Deliberately precise about the limit of the guarantee: no MRZ format gives
  // the holder's name a check digit, so it is a best reading even when every
  // other field verifies.
  const status = result.validation.allValid
    ? 'Усі дані успішно перевірено'
    : 'Перевірено частково';

  const context = [
    `${status} · ім'я не перевіряється автоматично · ${SOURCE_LABEL[result.source]}`,
    // Phrased as "corrected characters: N" rather than "N characters
    // corrected" on purpose: Ukrainian has three plural forms (1 / 2-4 / 5+),
    // and this word order is correct for every number without plural logic.
    result.edits > 0 ? `автоматично виправлено символів: ${result.edits}` : null,
    'Не зберігається — це повідомлення є єдиною копією.',
    // So a stale binary announces itself instead of being blamed on the code.
    `версія ${buildLabel()}`,
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
        text: 'Ви надсилаєте фото занадто швидко. Зачекайте хвилинку і спробуйте ще раз.',
      },
    },
  ];
}

export const HELP_TEXT = [
  'passbot допомагає зчитувати дані з фотографій паспортів.',
  '',
  'Надішліть фото сюди, в особисті повідомлення. Переконайтеся, що камера розташована рівно,',
  'текст у фокусі, а два нижні рядки із символами MRZ повністю потрапили в кадр.',
  '',
  'У відповідь ви отримаєте лише зчитаний текст: фото обробляється миттєво,',
  'ніде не зберігається і не залишається на сервері.',
].join('\n');
