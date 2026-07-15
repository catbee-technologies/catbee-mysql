import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import nodePlugin from 'eslint-plugin-n';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'ignore files',
    ignores: ['dist/', 'reports/', 'data/']
  },
  {
    name: 'include files',
    files: ['**/*.{js,mjs,cjs,ts}']
  },
  {
    name: 'globals for node',
    files: ['**/*.{mjs,cjs,ts}'],
    languageOptions: { globals: globals.node }
  },
  {
    ...pluginJs.configs.recommended,
    name: 'plugin-js recommended',
    files: ['**/*.{js,mjs,cjs}']
  },
  {
    ...nodePlugin.configs['flat/recommended-module'],
    name: 'custom eslint-plugin-n plugin config',
    files: ['**/*.ts'],
    rules: {
      'n/no-process-env': 'error',
      'n/no-missing-import': [
        'off', // eslint-plugin-n fails to resolve index.ts files
        {
          tryExtensions: ['.ts', '.d.ts']
        }
      ]
    },
    languageOptions: {
      globals: {
        ...globals.node,
        NodeJS: true
      }
    }
  },
  {
    ...nodePlugin.configs['flat/recommended-module'],
    name: 'custom eslint-plugin-n plugin config for tests',
    files: ['tests*/**/*.ts'],
    // eslint-plugin-n rules
    rules: {
      'n/no-process-env': 'off'
    },
    languageOptions: {
      globals: {
        ...globals.jest
      }
    }
  },
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['**/*.ts'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  })),
  {
    // eslint core rules
    rules: {
      // complexity: ['error', 10],
      'no-console': 'error',
      eqeqeq: ['error', 'smart']
    }
  },
  {
    name: 'scripts that run in the browser',
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser
      }
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          vars: 'local'
        }
      ]
    }
  },
  pluginPrettierRecommended
];
