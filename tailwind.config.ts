import type { Config } from 'tailwindcss';

/**
 * Tailwind CSS v4 Configuration
 *
 * Note: Most theme configuration is done in src/styles/index.css using @theme.
 * This file only specifies content paths for class detection.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
};

export default config;
