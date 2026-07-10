import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // react-grid-layout gibi bazı kütüphaneler tarayıcıda var olmayan `process.env`'i
    // referans alan debug kodu içeriyor — burada boş bir obje ile polyfill ediyoruz.
    'process.env': {}
  },
})
