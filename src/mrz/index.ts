export { charValue, computeCheckDigit, isMrzAlphabet, verifyCheckDigit } from './checkDigit.js';
export { formatMrzDate, formatPassbotLine, resolveYear, OUTPUT_SEPARATOR } from './format.js';
export { confusionVariants, repairField, repairTd3, type RepairResult } from './repair.js';
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
