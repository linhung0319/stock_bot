import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', '.wrangler', 'fixtures'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 網站的前端（public/js）：在瀏覽器裡跑，沒有經過打包
    files: ['public/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'navigator', 'fetch', 'URLSearchParams', 'Node', 'Event', 'setTimeout', 'clearTimeout', 'setInterval', 'requestAnimationFrame', 'ResizeObserver', 'matchMedia'].map((g) => [g, 'readonly']),
      ),
    },
  },
);
