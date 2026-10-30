import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'dist/', 'test-results/', 'playwright-report/', 'web-ext-artifacts/', '.firefox-profile/'] },
  js.configs.recommended,
  {
    // Content scripts are classic scripts sharing globalThis.DealsAnalyzer.
    files: ['extension/src/content/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions }
    }
  },
  {
    files: ['extension/src/background/**/*.js', 'extension/src/options/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions }
    }
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },
  {
    // Playwright's evaluate() callbacks run inside the browser.
    files: ['test/e2e/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions }
    }
  }
];
