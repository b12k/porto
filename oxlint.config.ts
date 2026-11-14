import type { OxlintConfig } from 'oxlint';

import { configs } from 'eslint-plugin-perfectionist';

const MAX_FUNCTION_LINES = 150;
const MAX_STATEMENTS = 50;
const MAX_PARAMETERS = 4;

export default {
  categories: {
    correctness: 'error',
    nursery: 'error',
    pedantic: 'error',
    perf: 'error',
    restriction: 'error',
    style: 'error',
    suspicious: 'error',
  },
  env: { node: true },
  ignorePatterns: ['dist', 'node_modules'],
  jsPlugins: ['eslint-plugin-perfectionist'],
  options: { denyWarnings: true, reportUnusedDisableDirectives: 'error', typeAware: true },
  overrides: [
    {
      files: ['**/*.config.ts', '.release-it.ts'],
      rules: { 'import/no-anonymous-default-export': 'off', 'import/no-default-export': 'off' },
    },
  ],
  plugins: ['typescript', 'oxc', 'import', 'node', 'promise', 'unicorn'],
  rules: {
    ...configs['recommended-natural'].rules,
    curly: ['error', 'multi-line'],
    'func-style': ['error', 'declaration'],
    'id-length': ['error', { exceptions: ['_', 'z', 'T'] }],
    'import/no-named-export': 'off',
    'import/no-nodejs-modules': 'off',
    'import/no-relative-parent-imports': 'off',
    'import/prefer-default-export': 'off',
    'init-declarations': 'off',
    'max-lines-per-function': ['error', { max: MAX_FUNCTION_LINES, skipBlankLines: true, skipComments: true }],
    'max-params': ['error', MAX_PARAMETERS],
    'max-statements': ['error', MAX_STATEMENTS],
    'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
    'no-magic-numbers': 'off',
    'no-negated-condition': 'off',
    'no-nested-ternary': 'off',
    'no-ternary': 'off',
    'no-undefined': 'off',
    'no-use-before-define': ['error', { functions: true }],
    'node/no-process-env': 'off',
    'node/no-top-level-await': 'off',
    'one-var': ['error', 'never'],
    'oxc/no-async-await': 'off',
    'oxc/no-barrel-file': 'off',
    'oxc/no-optional-chaining': 'off',
    'oxc/no-rest-spread-properties': 'off',
    'perfectionist/sort-modules': [
      'error',
      {
        customGroups: [
          { fallbackSort: { type: 'natural' }, groupName: 'function', selector: 'function', type: 'usage' },
        ],
        type: 'natural',
      },
    ],
    'promise/prefer-await-to-callbacks': 'off',
    'promise/prefer-await-to-then': 'off',
    'sort-imports': 'off',
    'sort-keys': 'off',
    'sort-vars': 'off',
    'typescript/array-type': ['error', { default: 'generic' }],
    'typescript/explicit-function-return-type': 'off',
    'typescript/explicit-module-boundary-types': 'off',
    'typescript/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    'typescript/no-unnecessary-condition': ['error', { checkTypePredicates: true }],
    'typescript/prefer-readonly-parameter-types': 'off',
    'typescript/promise-function-async': 'off',
    'typescript/strict-boolean-expressions': 'off',
    'typescript/strict-void-return': 'off',
  },
} satisfies OxlintConfig;
