/**
 * Single source of truth for the public site URL and core SEO metadata.
 *
 * The production domain has NOT been configured yet, so `SITE_URL` intentionally
 * points at a clearly marked placeholder. When the domain is ready:
 *   1. Set the `VITE_SITE_URL` environment variable (e.g. in your hosting
 *      provider or a local `.env` file: `VITE_SITE_URL=https://example.com`),
 *      OR update `SITE_URL` below directly.
 *   2. Rebuild. `vite.config.ts` injects the resolved URL into `index.html`
 *      (`__SITE_URL__` placeholders) for canonical / Open Graph URLs, and
 *      into `public/robots.txt` / `public/sitemap.xml` copies in dist.
 *
 * Do not hardcode the site URL anywhere else — always import from here or rely
 * on the build-time injection in `index.html`.
 */

// TODO: Replace with the production domain (e.g. "https://sanklean.com").
export const SITE_URL = 'https://example.com';

export const SITE_NAME = 'SanKlean';

export const SITE_TITLE = 'SanKlean — Job Application Tracker & Sankey Diagram Maker';

export const SITE_DESCRIPTION =
  'SanKlean is a free visual job application tracker. Map job and internship applications, replies, interviews, and offers as a clear Sankey-style flow.';

/** Light-theme page background; mirrors `--bg` in `src/index.css`. */
export const SITE_THEME_COLOR = '#f8fafc';

/** Existing SanKlean branding, reused for favicon + social preview. */
export const SITE_OG_IMAGE_PATH = '/sk-logo.png';
