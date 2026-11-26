import { defineConfig } from '@rspress/core';

export default defineConfig({
  description: 'Port range allocator for Git worktrees',
  root: 'docs',
  siteOrigin: 'https://porto.b12k.com',
  themeConfig: { socialLinks: [{ content: 'https://github.com/b12k/porto', icon: 'github', mode: 'link' }] },
  title: 'Porto',
});
