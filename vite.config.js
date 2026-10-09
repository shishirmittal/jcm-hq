import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// react() only affects .jsx/.tsx files — Control Centre is the sole React
// island in an otherwise vanilla-JS app; every other page is untouched by it.
export default defineConfig({
  plugins: [react()]
})
