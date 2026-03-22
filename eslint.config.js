import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Our additions
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Numbers in template literals are fine: `Round ${n}` is idiomatic
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // + with numbers is fine: we don't mix types
      '@typescript-eslint/restrict-plus-operands': ['error', { allowNumberAndString: true }],
      'eqeqeq': 'error',
      'no-var': 'error',

      // Disabled: fires on defensive runtime guards that the type system can't model
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Disabled: we intentionally use `any` in WebSocket message handling; covered by no-explicit-any
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Disabled: we use ! assertions deliberately where we know the value is set
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Disabled: opposite concern to no-non-null-assertion, conflicts with above
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      // Disabled: delete obj[key] is fine for a small state dictionary
      '@typescript-eslint/no-dynamic-delete': 'off',
      // Disabled: () => voidFn() arrow shorthand is idiomatic in event listeners
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Disabled: defensive casts are intentional in several places
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
