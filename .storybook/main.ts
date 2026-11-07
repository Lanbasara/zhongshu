import type { StorybookConfig } from '@storybook/react-vite';
const config: StorybookConfig = {
  stories: ['../design/stories/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: { builder: { viteConfigPath: '.storybook/vite.config.ts' } } },
  typescript: { reactDocgen: false },
  core: { disableTelemetry: true },
};
export default config;
