/**
 * Test fixtures.
 *
 * The only document data in this repository is the ICAO/Wikipedia specimen
 * passport, a published sample with the reserved document number `XX000000`.
 * Real documents must never be committed; see docs/SECURITY.md.
 */

export const SPECIMEN_LINE_1 = 'P<UKRTKACHENKO<<MARIANA<<<<<<<<<<<<<<<<<<<<<';
export const SPECIMEN_LINE_2 = 'XX000000<0UKR9108242F23092571234567890<<<<70';

export const SPECIMEN_EXPECTED_OUTPUT =
  'P/UKR/XX000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA';

/**
 * A TD1 identity card for the same fictional holder: three lines of 30.
 *
 * Constructed rather than transcribed. The check digits were computed from the
 * field values, not copied from a real card, and `XX0000000` mirrors the
 * reserved specimen document number.
 */
export const TD1_UPPER = 'IDUKRXX000000000000000000000<<';
export const TD1_MIDDLE = '9108242F2309257UKR<<<<<<<<<<<6';
export const TD1_NAMES = 'TKACHENKO<<MARIANA<<<<<<<<<<<<';

export const TD1_EXPECTED_OUTPUT =
  'ID/UKR/XX0000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA';
