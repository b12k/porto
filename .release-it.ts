/* oxlint-disable no-template-curly-in-string */
import type { Config } from 'release-it';

const { RELEASE_IT_PUSH_REPO = '' } = process.env;

const config: Config = {
  git: { commitMessage: 'feat: release ${version} [no ci]', pushArgs: ['--no-verify'], pushRepo: RELEASE_IT_PUSH_REPO },
  github: {
    comments: {
      issue:
        ':rocket: _This issue has been resolved in  ${version}. See [${releaseName}](${releaseUrl}) for release notes._',
      pr: ':rocket: _This pull request is included in  ${version}. See [${releaseName}](${releaseUrl}) for release notes._',
      submit: true,
    },
    release: true,
  },
  npm: {
    publishArgs: ['--provenance', '--no-git-checks'],
    publishPackageManager: 'pnpm',
    skipChecks: true,
    tag: 'latest',
  },
  plugins: { '@release-it/conventional-changelog': { preset: 'conventionalcommits' } },
};

export default config;
