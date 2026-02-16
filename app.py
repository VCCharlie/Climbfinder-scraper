import time
import random
import requests
from flask import Flask, render_template, request, jsonify
from bs4 import BeautifulSoup

app = Flask(__name__)

# Pre-defined dictionary of popular regions and their Climbfinder IDs.
# This helps with the "Region Discovery" requirement.
POPULAR_REGIONS = {
    "Haute-Savoie (France)": "288",
    "Savoie (France)": "957",
    "Dolomites (Italy)": "123",
    "Limburg (Netherlands)": "233",
    "Vosges (France)": "295",
    "Tyrol (Austria)": "358",
    "Gelderland (Netherlands)": "230",
    "Ardennes (Belgium)": "239",
    "Mallorca (Spain)": "153",
    "Tenerife (Spain)": "156",
    "Hautes Alpes (France)": "192",
    "Alpes-de-Haute-Provence (France)": "290",
    "Alpes-Maritimes (France)": "379",
    "Valais (Switzerland)": "365",
    "Aosta Valley (Italy)": "317"
}

def clean_number(text):
    """
    Cleans text strings to return proper integer or float values for Excel.
    Removes units like 'km', 'm', '%', and handles thousands separators.
    """
    if not text:
        return 0
    
    # Remove common units and whitespace
    clean_text = text.lower().replace('km', '').replace('m', '').replace('%', '').strip()
    
    # Remove thousands separators (assuming European style might use dots, 
    # but Climbfinder English usually uses commas for thousands or dots for decimals).
    # We assume standard float format: 1,200.50 or 1200.50
    clean_text = clean_text.replace(',', '') 
    
    try:
        if '.' in clean_text:
            return float(clean_text)
        else:
            return int(clean_text)
    except ValueError:
        return 0

def scrape_page(region_id, page_number):
    """
    Scrapes a single page of the Climbfinder ranking.
    """
    url = f"https://climbfinder.com/en/ranking?l={region_id}&p={page_number}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://climbfinder.com/'
    }

    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.content, 'html.parser')
        
        climbs = []
        
        # Locating the table. Climbfinder tables are usually standard HTML tables.
        # We look for the main ranking table.
        table = soup.find('table')
        if not table:
            return []

        rows = table.find_all('tr')
        
        # Skip header row
        for row in rows[1:]:
            cols = row.find_all('td')
            if len(cols) < 5:
                continue
            
            # The structure of Climbfinder ranking columns is typically:
            # 0: Rank, 1: Name/Link, 2: Region (sometimes), 3: Difficulty, 4: Length, 5: Ascent, 6: Gradient
            # We must adapt based on the specific columns present.
            
            try:
                # Extracting raw text
                rank_text = cols[0].get_text(strip=True).replace('.', '')
                
                # Name often contains the link
                name_tag = cols[1].find('a')
                name = name_tag.get_text(strip=True) if name_tag else cols[1].get_text(strip=True)
                
                # Difficulty points (Climbfinder difficulty score)
                # Sometimes column indexes shift depending on the view, looking for specific attributes is safer
                # but for this aggregation we assume standard layout.
                difficulty_text = cols[2].get_text(strip=True)
                
                length_text = cols[3].get_text(strip=True)
                ascent_text = cols[4].get_text(strip=True)
                gradient_text = cols[5].get_text(strip=True)

                climb_data = {
                    "rank": clean_number(rank_text),
                    "name": name,
                    "difficulty_points": clean_number(difficulty_text),
                    "length_km": clean_number(length_text),
                    "elevation_gain_m": clean_number(ascent_text),
                    "avg_gradient_pct": clean_number(gradient_text)
                }
                climbs.append(climb_data)
            except (IndexError, AttributeError):
                continue
                
        return climbs

    except Exception as e:
        print(f"Error scraping page {page_number}: {e}")
        return []

@app.route('/')
def index():
    return render_template('index.html', regions=POPULAR_REGIONS)

@app.route('/scrape', methods=['POST'])
def scrape():
    data = request.json
    region_id = data.get('region_id')
    start_page = int(data.get('start_page', 1))
    end_page = int(data.get('end_page', 1))
    
    all_results = []
    
    # Loop through the requested page range
    for page in range(start_page, end_page + 1):
        print(f"Scraping Page {page} for Region {region_id}...")
        page_data = scrape_page(region_id, page)
        
        if not page_data:
            # Stop if a page returns no data (end of list reached)
            break
            
        all_results.extend(page_data)
        
        # Polite delay to prevent IP blocking
        time.sleep(random.uniform(0.5, 1.5))
        
    return jsonify({
        "status": "success",
        "count": len(all_results),
        "data": all_results
    })

if __name__ == '__main__':
    app.run(debug=True, port=5000)
              
