import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { ResolvedConfig } from 'vite'
import { SITE_URL as FALLBACK_SITE_URL } from './src/site.js'

function normalizeSiteUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  return trimmed === '' ? FALLBACK_SITE_URL.replace(/\/+$/, '') : trimmed
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Single source of truth for the canonical domain lives in `src/site.ts`.
  // `VITE_SITE_URL` (env / hosting provider / `.env` file) wins when set so
  // the domain can be configured without a code change.
  const env = loadEnv(mode, process.cwd(), '')
  const siteUrl = normalizeSiteUrl(env.VITE_SITE_URL ?? process.env.VITE_SITE_URL)
  let outDir = 'dist'

  return {
    plugins: [
      react(),
      {
        name: 'sanklean-site-url',
        transformIndexHtml(html: string): string {
          return html.replaceAll('__SITE_URL__', siteUrl)
        },
        configResolved(config: ResolvedConfig): void {
          outDir = config.build.outDir
        },
        // Files under `public/` are copied to dist verbatim, so the
        // `__SITE_URL__` placeholders in robots.txt / sitemap.xml are
        // resolved here to the same URL as the canonical tag above.
        closeBundle(): void {
          for (const file of ['robots.txt', 'sitemap.xml']) {
            const filePath = join(process.cwd(), outDir, file)
            try {
              const content = readFileSync(filePath, 'utf8')
              if (content.includes('__SITE_URL__')) {
                writeFileSync(filePath, content.replaceAll('__SITE_URL__', siteUrl))
              }
            } catch {
              // Non-fatal: index.html injection above still applies.
            }
          }
        },
      },
    ],
  }
})
