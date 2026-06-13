# Sudaan Geo-Analytics

A premium, engineering-grade marketing website for **Sudaan Geo-Analytics**, a
geospatial data processing and surveying company that transforms raw drone and
survey data into engineering-ready deliverables (orthomosaics, DSM/DTM, contours,
point clouds and GIS analytics).

> The company sells **data, analytics, mapping, insights and engineering
> deliverables**, not drones, hardware, or training.

Built with **Next.js 15 (App Router)**, **TypeScript**, **Tailwind CSS** and
**Framer Motion**. Premium, warm, engineering-consultancy design language
(off-white / soft-orange palette), technical and data-focused.

---

## ✨ Highlights

- **Animated drone-scan hero**, a drone sweeps across the panel emitting a scan
  while the surface below transforms through the pipeline and loops:
  Raw imagery → Point cloud → DSM → Contours → Intelligence dashboard.
- **Animated statistic counters** that count up on scroll.
- **Data Insights page (the centrepiece)** with:
  - Five interactive **before/after comparison sliders** (Raw → Ortho,
    Ortho → DSM, DSM → DTM, Ortho → Contours, LiDAR cloud → Surface model)
  - **NDVI vegetation analysis** with analytics cards
  - **Application examples**, Forest mapping, Solar plant, Transmission line
  - An **interactive 3D point cloud viewer** (custom canvas renderer, rotate,
    zoom, auto-rotate; no heavy 3D dependency)
  - **Downloadable sample PDF reports**
- **Procedural geospatial visuals**, every orthomosaic / DSM / DTM / contour /
  NDVI / forest / solar / transmission layer is generated as deterministic SVG
  (no binary image assets needed).
- **Categorised service catalogue**, Field Survey, Advanced Data Processing,
  Utility & Infrastructure and Environmental services, each with icons.
- **Projects** case-study grid with animated industry filtering.
- **About** with company positioning, Mission / Vision / Values cards and a
  technical leadership section.
- **Services**, **Blog** (with article pages) and a **Contact** form.
- **Fully SEO-optimised**, metadata, Open Graph (dynamic OG image), Twitter
  cards, JSON-LD structured data, `robots.txt`, `sitemap.xml`, web manifest.
- Responsive, accessible (keyboard-operable slider, reduced-motion support).

---

## 🧱 Tech Stack

| Layer       | Choice                              |
| ----------- | ----------------------------------- |
| Framework   | Next.js 15 (App Router)             |
| Language    | TypeScript                          |
| Styling     | Tailwind CSS 3                      |
| Animation   | Framer Motion 11                    |
| Deployment  | Vercel                              |

---

## 📁 Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout, fonts, global metadata, JSON-LD
│   ├── page.tsx                # Home
│   ├── globals.css            # Tailwind layers + design tokens
│   ├── sitemap.ts             # /sitemap.xml
│   ├── robots.ts              # /robots.txt
│   ├── manifest.ts            # /manifest.webmanifest
│   ├── opengraph-image.tsx    # Dynamic OG image
│   ├── icon.svg               # Favicon
│   ├── not-found.tsx          # 404
│   ├── services/page.tsx
│   ├── data-insights/page.tsx # ⭐ flagship page
│   ├── projects/page.tsx
│   ├── about/page.tsx
│   ├── blog/page.tsx
│   ├── blog/[slug]/page.tsx
│   └── contact/page.tsx
├── components/
│   ├── Navbar.tsx  Footer.tsx  Logo.tsx
│   ├── Hero.tsx  StatsCounter.tsx
│   ├── SectionHeading.tsx  PageHeader.tsx  CTASection.tsx
│   ├── Reveal.tsx                 # scroll-reveal + stagger helpers
│   ├── ServiceCard.tsx  ServiceIcon.tsx
│   ├── CompareSlider.tsx          # before/after slider
│   ├── PointCloudViewer.tsx       # canvas 3D point cloud
│   ├── ProjectsExplorer.tsx       # filterable case studies
│   ├── ContactForm.tsx
│   └── visuals/
│       ├── scene.ts              # deterministic procedural "site"
│       ├── GeoLayers.tsx         # Ortho/DSM/DTM/Contour/NDVI/Raw SVG layers
│       └── ProjectThumb.tsx      # per-project map thumbnail
├── data/
│   ├── services.ts  projects.ts  blog.ts   # dummy showcase datasets
└── lib/
    └── site.ts                   # site config, nav, stats
public/
└── reports/*.pdf                 # generated sample deliverables
scripts/
└── generate-reports.mjs          # regenerates the sample PDFs
```

---

## 🚀 Getting Started

```bash
npm install
npm run dev          # http://localhost:3000
```

Other scripts:

```bash
npm run build        # production build
npm run start        # serve the production build
npm run lint         # eslint
node scripts/generate-reports.mjs   # regenerate sample PDF reports
```

Requires Node 18.18+ (developed on Node 20+).

---

## ☁️ Deploying to Vercel

1. Push this repository to GitHub/GitLab/Bitbucket.
2. In [Vercel](https://vercel.com/new), **Import** the repository.
3. Vercel auto-detects Next.js, no configuration needed. Click **Deploy**.

CLI alternative:

```bash
npm i -g vercel
vercel          # preview deploy
vercel --prod   # production deploy
```

### After deploying

- Set the production domain, then update `siteConfig.url` in
  [`src/lib/site.ts`](src/lib/site.ts) so canonical URLs, the sitemap, robots and
  Open Graph tags point at your real domain.
- Update contact details (email/phone/address/socials) in the same file.

---

## 🔧 Customising

- **Brand colours / theme** → [`tailwind.config.ts`](tailwind.config.ts)
  (`abyss`, `navy`, `accent`, `signal`) and tokens in `globals.css`.
- **Content** → edit the dummy datasets in `src/data/*` and copy in `src/lib/site.ts`.
- **Contact form** → posts to the `POST /api/contact` Route Handler
  ([`src/app/api/contact/route.ts`](src/app/api/contact/route.ts)), which
  validates input and logs the lead. Set `RESEND_API_KEY` (and optional
  `CONTACT_TO`) to forward leads by email in production.
- **Sectors** → edit the `sectors` list in [`src/lib/site.ts`](src/lib/site.ts);
  it drives the home, footer and contact sector options.
- **Real imagery** → the comparison sliders accept any `ReactNode`, so you can
  swap the procedural SVG layers for real `<Image>` tiles when available.

---

## ♿ Accessibility & Performance

- Comparison slider is keyboard operable (arrow keys) with ARIA `slider` role.
- `prefers-reduced-motion` disables animations.
- Static generation for all content pages; lightweight client JS (~150 kB first
  load) and no external image dependencies.

---

© Sudaan Geo-Analytics. Engineering-grade geospatial analytics.
