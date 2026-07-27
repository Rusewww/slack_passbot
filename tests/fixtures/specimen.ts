/**
 * Test fixtures.
 *
 * The only document data in this repository is the ICAO/Wikipedia specimen
 * passport — a published sample with the reserved document number `XX000000`.
 * Real documents must never be committed; see docs/SECURITY.md.
 */

export const SPECIMEN_LINE_1 = 'P<UKRTKACHENKO<<MARIANA<<<<<<<<<<<<<<<<<<<<<';
export const SPECIMEN_LINE_2 = 'XX000000<0UKR9108242F23092571234567890<<<<70';

export const SPECIMEN_EXPECTED_OUTPUT =
  'P/UKR/XX000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA';
