// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      // Пари само с Decimal: забраняваме parseFloat/Number() и Math.round в бизнес логиката.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Use Decimal (decimal.js) for money, never float.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'round', message: 'Round only via rounding.ts.' },
        { object: 'Number', property: 'parseFloat', message: 'Use Decimal for money.' },
        { object: 'Number', property: 'parseInt', message: 'Use Decimal for money.' },
      ],
    },
  },
);
