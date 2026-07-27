import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // No document data ever reaches a reporter artefact.
    reporters: ['default'],
  },
});
