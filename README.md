# Climbfinder Ranking Aggregator

A web application that lets you search climbing regions, scrape multi-page rankings from Climbfinder, and export the data to Excel (.xlsx), CSV, or Google Sheets.

**Two deployment options:**
- **GitHub Pages** (static, zero-backend) — visit the URL, scrape from your browser
- **Codespaces / local** (Flask + Playwright) — headless browser for maximum reliability

## Features

- **Region Discovery** — Country dropdown + autocomplete search across 15+ countries and 120+ regions. Enter a custom region ID for unlisted areas.
- **Multi-Page Scraper** — Fetch 1–20 pages of rankings per request with polite delays between pages.
- **Interactive DataTable** — Sort, search, and paginate results with DataTables.js. Difficulty and gradient values are color-coded.
- **One-Click Exports** — Export to Excel (.xlsx) with numbers as numbers (not text), CSV, Google Sheets CSV (UTF-8 BOM), or copy tab-separated values directly to clipboard for pasting into Sheets.

## Option 1: GitHub Pages (recommended for quick use)

The static version in `docs/` runs entirely in the browser — no backend, no install.

### Setup

1. Go to **Settings → Pages** in your GitHub repo
2. Under **Source**, select **Deploy from a branch**
3. Set branch to `main` and folder to `/docs`
4. Click **Save**

Your site will be live at: `https://<username>.github.io/Climbfinder-scraper/`

### How it works

The static version uses a CORS proxy to fetch Climbfinder pages client-side, then parses the `__NEXT_DATA__` JSON (Next.js server-side rendered data) or the HTML directly in the browser. No server needed.

## Option 2: GitHub Codespaces / Local (Flask + Playwright)

For maximum reliability, the Flask backend uses **Playwright** (headless Chromium) to fully render the JavaScript-heavy Climbfinder pages.

### Launch in Codespaces

1. Click **Code → Codespaces → Create codespace on main**
2. In the terminal:

```bash
pip install -r requirements.txt
playwright install chromium
playwright install-deps chromium
python app.py
```

3. Open port 5000 in the **Ports** tab

### Launch locally

```bash
pip install -r requirements.txt
playwright install chromium
python app.py
```

Visit `http://localhost:5000`.

## Usage

1. **Select a country** from the dropdown to narrow your search, or type directly in the region search box
2. **Pick a region** from the autocomplete list, or enter a numeric region ID manually
3. **Set the page range** (e.g., 1 to 3)
4. Click **Fetch Rankings** and wait for the scraper to finish
5. **Export** using Excel/CSV buttons, download a Google Sheets CSV, or click **Copy for Sheets** to paste directly

## Why Playwright?

Climbfinder is a **Next.js app** that renders its ranking table with JavaScript. Plain HTTP requests (`requests` + BeautifulSoup) only get the empty HTML shell — the table doesn't exist until JS runs. Playwright launches a real headless Chromium browser to execute the JavaScript and extract the fully rendered data.

The GitHub Pages version works around this by parsing `__NEXT_DATA__` (the JSON blob Next.js embeds for server-side rendering) or by extracting data from the rendered HTML via a CORS proxy.

## Project Structure

```
.
├── app.py                 # Flask backend: Playwright scraper + API routes
├── requirements.txt       # Python dependencies (Flask, Playwright, etc.)
├── templates/
│   └── index.html         # Frontend for Flask version
├── docs/
│   └── index.html         # Self-contained static version for GitHub Pages
└── README.md
```

## API Endpoints (Flask version)

| Method | Path                | Description                        |
|--------|---------------------|------------------------------------|
| GET    | `/`                 | Serve the frontend                 |
| GET    | `/api/countries`    | List all countries (sorted)        |
| GET    | `/api/regions`      | List all regions (flat, sorted)    |
| GET    | `/api/regions/search?q=&country=` | Search/filter regions |
| POST   | `/api/scrape`       | Scrape rankings (JSON body: `region_id`, `start_page`, `end_page`) |
