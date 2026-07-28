/**
 * Rendering of parsed MRZ fields into the delivery format required by the
 * product spec:
 *
 *   P/UKR/XX000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA
 *
 * Field 4 is the ICAO `nationality` field. The spec document calls it "country
 * of birth"; the MRZ does not encode place of birth at all (it appears only in
 * the visual inspection zone). The value is emitted as-is; only the label
 * differs.
 */

import type { Td3Fields } from './td3.js';

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

export const OUTPUT_SEPARATOR = '/';

/** `910824` (YYMMDD) -> `24AUG91` (DDMONYY). */
export function formatMrzDate(yymmdd: string): string {
  if (!/^\d{6}$/.test(yymmdd)) {
    throw new Error(`Not a YYMMDD MRZ date: ${JSON.stringify(yymmdd)}`);
  }
  const yy = yymmdd.slice(0, 2);
  const monthIndex = Number(yymmdd.slice(2, 4)) - 1;
  const dd = yymmdd.slice(4, 6);
  const month = MONTHS[monthIndex];
  if (month === undefined) {
    throw new Error(`Month out of range in MRZ date: ${JSON.stringify(yymmdd)}`);
  }
  return `${dd}${month}${yy}`;
}

/**
 * Resolves the two-digit MRZ year to a full year.
 *
 * ICAO leaves the century implicit. Birth dates cannot be in the future, so a
 * year that would be yet to come belongs to the previous century. Expiry dates
 * use a forward-looking window instead — passports are issued for at most ~10
 * years but may have expired long ago, so we keep the sliding rule symmetric
 * around the reference date.
 */
export function resolveYear(
  yy: string,
  kind: 'birth' | 'expiry',
  now: Date = new Date(),
): number {
  const currentYear = now.getUTCFullYear();
  const century = Math.floor(currentYear / 100) * 100;
  const candidate = century + Number(yy);
  if (kind === 'birth') {
    return candidate > currentYear ? candidate - 100 : candidate;
  }
  // Expiry: allow up to 20 years ahead before assuming the previous century.
  return candidate > currentYear + 20 ? candidate - 100 : candidate;
}

/**
 * Formats a date, falling back to the raw characters when they are not a
 * usable YYMMDD.
 *
 * A reading whose date check digit did not verify can contain anything the
 * recogniser saw. Reporting those characters verbatim is honest and lets the
 * reader compare them against the document; throwing would take down the whole
 * reply over one unreadable field.
 */
function formatMrzDateOrRaw(yymmdd: string): string {
  try {
    return formatMrzDate(yymmdd);
  } catch {
    return yymmdd;
  }
}

/**
 * Produces the single-line delivery string.
 *
 * Order: documentCode / issuingState / documentNumber / nationality /
 *        birthDate / sex / expiryDate / surname / givenNames
 *
 * Never throws: it is also used for partially-verified readings, where any
 * individual field may be garbage. Whether a field can be trusted is carried
 * separately, in the validation flags.
 */
export function formatPassbotLine(fields: Td3Fields): string {
  return [
    fields.documentCode,
    fields.issuingState,
    fields.documentNumber,
    fields.nationality,
    formatMrzDateOrRaw(fields.birthDate),
    fields.sex,
    formatMrzDateOrRaw(fields.expiryDate),
    fields.primaryIdentifier,
    fields.secondaryIdentifier,
  ].join(OUTPUT_SEPARATOR);
}
