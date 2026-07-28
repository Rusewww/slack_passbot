export { charValue, computeCheckDigit, isMrzAlphabet, verifyCheckDigit } from './checkDigit.js';
export { formatMrzDate, formatPassbotLine, resolveYear, OUTPUT_SEPARATOR } from './format.js';
export {
  buildLine1,
  chooseLine1Fields,
  extractLine1,
  scoreLine1,
  type Line1Fields,
} from './line1.js';
export {
  confusionVariants,
  repairField,
  repairLine2,
  repairTd3,
  type Line2Repair,
  type RepairResult,
} from './repair.js';
export {
  extractTd3Lines,
  normaliseLine,
  parseTd3,
  Td3FormatError,
  TD3_LINE_LENGTH,
  TD3_OFFSETS,
  type Sex,
  type Td3Fields,
  type Td3ParseResult,
  type Td3Validation,
} from './td3.js';
