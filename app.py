import pandas as pd
import requests
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

@app.route("/")
def index():
    # Laad jouw bestaande (maar aangepaste) frontend
    return render_template("index.html")

@app.route("/api/scrape", methods=["POST"])
def api_scrape():
    data = request.get_json(force=True)
    url = data.get("url", "").strip()
    is_dutch = data.get("is_dutch", True)

    if not url:
        return jsonify({"status": "error", "message": "Geen URL opgegeven"}), 400

    try:
        # Doe alsof we een normale browser zijn
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        
        # Zorg voor de juiste encoding (belangrijk voor letters als é, à)
        resp.encoding = resp.apparent_encoding

        # Magie: Pandas leest álle HTML tabellen uit de pagina
        if is_dutch:
            tables = pd.read_html(resp.text, decimal=',', thousands='.')
        else:
            tables = pd.read_html(resp.text)

        if not tables:
            return jsonify({"status": "error", "message": "Geen HTML-tabellen (<table>) gevonden op deze pagina."}), 404

        # We gaan ervan uit dat de hoofdranglijst de grootste tabel is
        df = max(tables, key=len)
        
        # Gooi compleet lege kolommen weg
        df.dropna(axis=1, how='all', inplace=True)
        
        # Converteer kolomnamen netjes naar strings (voorkomt fouten bij multi-level headers)
        df.columns = ["_".join(str(c) for c in col).strip() if isinstance(col, tuple) else str(col) for col in df.columns]
        
        # Vervang lege cellen (NaN) door lege strings voor JSON compatibiliteit
        df = df.fillna("")

        records = df.to_dict(orient='records')
        columns = list(df.columns)

        return jsonify({
            "status": "success",
            "count": len(records),
            "columns": columns,
            "data": records
        })

    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", debug=True, port=5000)
