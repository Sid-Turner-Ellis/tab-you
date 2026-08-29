import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'TabYou — New Tab Organizer',
    description: 'A focused home for your tabs, bookmarks, and sessions.',
    permissions: ['tabs', 'sessions', 'storage', 'favicon', 'bookmarks'],
  },
});
