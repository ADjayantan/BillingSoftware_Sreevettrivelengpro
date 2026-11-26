import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  // CommonJS by necessity: Forge loads forge.config.js with require, Electron runs the icon script as CJS.
  { files: ['desktop/forge.config.js', 'desktop/scripts/**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  // .claude: other sessions' working copies of this project, with builds of their own.
  // handoff/practice-copy: try-out tools for a PC, not the app (its README says what they do).
  // desktop/dist and desktop/out: what the PC app's build writes (desktop/README.md).
  globalIgnores(['.next/**', 'out/**', 'coverage/**', 'next-env.d.ts', '.claude/**', 'handoff/practice-copy/**', 'desktop/dist/**', 'desktop/out/**']),
]);
