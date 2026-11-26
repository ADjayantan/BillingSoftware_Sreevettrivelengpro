import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  // .claude: other sessions' working copies of this project, with builds of their own.
  // handoff/practice-copy: try-out tools for a PC, not the app (its README says what they do).
  globalIgnores(['.next/**', 'out/**', 'coverage/**', 'next-env.d.ts', '.claude/**', 'handoff/practice-copy/**']),
]);
