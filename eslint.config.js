import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        crypto: 'readonly',
        alert: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        Uint8Array: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        WebAssembly: 'readonly',
        DecompressionStream: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
      }],
    },
  },
  {
    ignores: ['dist/**', 'drafts/**'],
  },
];
