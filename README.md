# Climbfinder Ranking Aggregator

A web application that lets you search climbing regions, scrape multi-page rankings from Climbfinder, and export the data to Excel (.xlsx), CSV, or Google Sheets.

## Features

- **Region Discovery** — Country dropdown + autocomplete search across 15+ countries and 120+ regions. Enter a custom region ID for unlisted areas.
- **Multi-Page Scraper** — Fetch 1–20 pages of rankings per request. The scraper uses User-Agent rotation, retry logic with exponential backoff, and polite delays between pages.
- **Interactive DataTable** — Sort, search, and paginate results with DataTables.js. Difficulty and gradient values are color-coded.
- **One-Click Exports** — Export to Excel (.xlsx) with numbers as numbers (not text), CSV, Google Sheets CSV (UTF-8 BOM), or copy tab-separated values directly to clipboard for pasting into Sheets.

## Tech Stack

| Layer    | Technology                        |
|----------|-----------------------------------|
| Backend  | Python 3, Flask, requests, BeautifulSoup4 |
| Frontend | HTML5, custom CSS, jQuery, DataTables.js + Buttons extension |
| Parser   | lxml (falls back to html.parser)  |

## Launch in GitHub Codespaces

### 1. Open the Codespace

Click **Code → Codespaces → Create codespace on main** from the GitHub repo page (or open an existing one).

### 2. Install dependencies

In the Codespace terminal:

```bash
pip install -r requirements.txt
```

### 3. Run the app

```bash
python app.py
```

Flask will start on `http://0.0.0.0:5000`. Codespaces will detect the open port and show a notification — click **Open in Browser** (or find port 5000 in the **Ports** tab and click the globe icon).

### 4. Use the app

1. **Select a country** from the dropdown to narrow your search, or type directly in the region search box.
2. **Pick a region** from the autocomplete list, or enter a numeric region ID manually.
3. **Set the page range** (e.g., 1 to 5).
4. Click **Fetch Rankings** and wait for the scraper to finish.
5. **Export** using the Excel/CSV buttons above the table, download a Google Sheets CSV, or click **Copy for Sheets** to paste directly.

## Project Structure

```
.
├── app.py              # Flask backend: API routes + scraper logic
├── requirements.txt    # Python dependencies
├── templates/
│   └── index.html      # Single-page frontend (HTML + CSS + JS)
└── README.md
```

## API Endpoints

| Method | Path                | Description                        |
|--------|---------------------|------------------------------------|
| GET    | `/`                 | Serve the frontend                 |
| GET    | `/api/countries`    | List all countries (sorted)        |
| GET    | `/api/regions`      | List all regions (flat, sorted)    |
| GET    | `/api/regions/search?q=&country=` | Search/filter regions |
| POST   | `/api/scrape`       | Scrape rankings (JSON body: `region_id`, `start_page`, `end_page`) |
