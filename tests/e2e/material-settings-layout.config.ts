import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'.',testMatch:'material-settings-layout.spec.ts',workers:1,timeout:30000,reporter:'line',outputDir:'../../test-results/round9-material-layout',use:{browserName:'chromium',baseURL:'http://127.0.0.1:4189',deviceScaleFactor:1.5}})
