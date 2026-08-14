import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'pwa-192.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Financial Habit',
        short_name: 'Financial Habit',
        description: '个人 Financial Habit 养成助手：冲动预警、冷静决策、负债管理与净资产追踪',
        theme_color: '#0040FF',
        background_color: '#FFFFFF',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'zh-CN',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,woff,ico}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/api\.deepseek\.com\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
})
