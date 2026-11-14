import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // 打包成 .ehpk 時用相對路徑
  server: { host: true, port: 5173 }, // 讓手機可以從區網連進來
  define: { __BUILD__: JSON.stringify('本機開發版') }, // 頁面上顯示的版本
});
