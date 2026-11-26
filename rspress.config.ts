import { defineConfig } from '@rspress/core';

export default defineConfig({
  base: '/porto/',
  description: 'Port range allocator for Git worktrees',
  root: 'docs',
  themeConfig: { socialLinks: [{ content: 'https://github.com/b12k/porto', icon: 'github', mode: 'link' }] },
  title: 'Porto',
});
