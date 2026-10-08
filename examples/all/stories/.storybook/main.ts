import type { StorybookConfig } from "@storybook/svelte-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const config: StorybookConfig = {
  stories: ["../Button.stories.ts"],
  framework: "@storybook/svelte-vite",
  viteFinal: (config) => ({ ...config, plugins: [...svelte(), ...(config.plugins ?? [])] }),
};
export default config;
