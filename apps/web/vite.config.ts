import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  // opencascade.js is a ~30MB ES module consumed inside a worker; esbuild
  // prebundling would scan/rewrite it for no benefit and slow cold starts.
  optimizeDeps: {
    exclude: ['opencascade.js', '@voltcad/geometry-worker'],
  },
  worker: {
    format: 'es',
  },
})

export default config
