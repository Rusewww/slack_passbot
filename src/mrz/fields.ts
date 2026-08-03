/**
 * The field set shared by every supported MRZ format.
 *
 * TD1 (identity cards, 3x30) and TD3 (passports, 2x44) place these values at
 * different offsets and split them across a different number of lines, but the
 * decoded result is the same set of fields, so everything downstream of
 * parsing (validation reporting, formatting, the Slack reply) is written once
 * against this type.
 */

export type Sex = 'M' | 'F' | 'X';

export interface MrzFields {
  documentCode: string;
  issuingState: string;
  /** Surname. */
  primaryIdentifier: string;
  /** Given names, space-separated when the MRZ holds several. */
  secondaryIdentifier: string;
  documentNumber: string;
  /** ICAO calls this "nationality". It is not the country of birth; no MRZ
   *  format encodes place of birth. */
  nationality: string;
  /** Raw `YYMMDD` as printed in the MRZ. */
  birthDate: string;
  /** `X` means unspecified (`<` in the MRZ). */
  sex: Sex;
  /** Raw `YYMMDD` as printed in the MRZ. */
  expiryDate: string;
  /** TD3 personal number; TD1 optional data. */
  personalNumber: string;
}

export interface MrzValidation {
  documentNumber: boolean;
  birthDate: boolean;
  expiryDate: boolean;
  /** TD3 only; always true for TD1, which has no such check digit. */
  personalNumber: boolean;
  composite: boolean;
  /** True only when every check digit the format defines holds. */
  allValid: boolean;
}

/** Which MRZ layout a reading came from. */
export type MrzFormat = 'TD1' | 'TD3';
