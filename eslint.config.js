import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Keeping `any` out of the codebase is what makes the redaction and
      // validation guarantees checkable rather than aspirational.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off', // used in tests only
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'ocr/'],
  },
);
