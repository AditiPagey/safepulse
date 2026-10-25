import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react';
export default defineConfig({ plugins:[react()], base:'./',
  server:{ port:5173, proxy:{ '/api':{ target:process.env.API_TARGET||'http://localhost:8081', changeOrigin:true } } } });
