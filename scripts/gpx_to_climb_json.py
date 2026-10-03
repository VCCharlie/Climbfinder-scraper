#!/usr/bin/env python3
"""
Convert a GPX track (or track segment) into one climb JSON object (schema v1).

Usage:
  python scripts/gpx_to_climb_json.py ride.gpx --name "Cauberg" --region "Zuid-Limburg" --country NL
"""

from __future__ import annotations

import argparse
import json
import math
import re
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any


def slugify(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p = math.pi / 180.0
    a = (
        math.sin((lat2 - lat1) * p / 2) ** 2
        + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def parse_gpx_points(path: str) -> list[tuple[float, float, float | None]]:
    tree = ET.parse(path)
    root = tree.getroot()
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    points: list[tuple[float, float, float | None]] = []
    for trkpt in root.findall(f".//{ns}trkpt"):
        lat = float(trkpt.get("lat", "0"))
        lon = float(trkpt.get("lon", "0"))
        ele_el = trkpt.find(f"{ns}ele")
        ele = float(ele_el.text) if ele_el is not None and ele_el.text else None
        points.append((lon, lat, ele))

    if not points:
        for rtept in root.findall(f".//{ns}rtept"):
            lat = float(rtept.get("lat", "0"))
            lon = float(rtept.get("lon", "0"))
            ele_el = rtept.find(f"{ns}ele")
            ele = float(ele_el.text) if ele_el is not None and ele_el.text else None
            points.append((lon, lat, ele))

    if len(points) < 2:
        raise SystemExit("GPX contains fewer than 2 track points.")
    return points


def fetch_elevations(coords: list[list[float]]) -> list[float]:
    elevs: list[float] = []
    batch = 100
    for i in range(0, len(coords), batch):
        chunk = coords[i : i + batch]
        lats = ",".join(str(c[1]) for c in chunk)
        lons = ",".join(str(c[0]) for c in chunk)
        url = f"https://api.open-meteo.com/v1/elevation?latitude={lats}&longitude={lons}"
        with urllib.request.urlopen(url, timeout=60) as resp:
            data = json.load(resp)
        elevs.extend(float(x) for x in data["elevation"])
    return elevs


def downsample(points: list[tuple[float, float, float | None]], max_points: int = 400):
    n = len(points)
    if n <= max_points:
        return points
    step = max(1, n // max_points)
    return points[::step]


def build_from_gpx(
    path: str,
    name: str,
    region: str,
    country: str,
    climb_id: str | None = None,
) -> dict[str, Any]:
    raw = parse_gpx_points(path)
    raw = downsample(raw)
    coords = [[p[0], p[1]] for p in raw]
    elevs = [p[2] for p in raw]
    if any(e is None for e in elevs):
        elevs = fetch_elevations(coords)
    else:
        elevs = [float(e) for e in elevs]  # type: ignore[arg-type]

    distances = [0.0]
    for i in range(1, len(coords)):
        lon1, lat1 = coords[i - 1]
        lon2, lat2 = coords[i]
        distances.append(distances[-1] + haversine_m(lon1, lat1, lon2, lat2))

    gain = sum(max(0.0, elevs[i] - elevs[i - 1]) for i in range(1, len(elevs)))
    loss = sum(max(0.0, elevs[i - 1] - elevs[i]) for i in range(1, len(elevs)))
    length_m = distances[-1]
    avg_grad = (100.0 * gain / length_m) if length_m > 0 else 0.0
    gradients = []
    for i in range(1, len(elevs)):
        d = distances[i] - distances[i - 1]
        if d > 0:
            gradients.append(100.0 * (elevs[i] - elevs[i - 1]) / d)

    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]

    return {
        "id": climb_id or slugify(name),
        "name": name,
        "region": region,
        "country": country,
        "stats": {
            "length_m": round(length_m),
            "elevation_gain_m": round(gain),
            "elevation_loss_m": round(loss),
            "avg_gradient_pct": round(avg_grad, 1),
            "max_gradient_pct": round(max(gradients), 1) if gradients else 0.0,
        },
        "geometry": {"type": "LineString", "coordinates": coords},
        "profile": {
            "distances_m": [round(d) for d in distances],
            "elevations_m": [round(e, 1) for e in elevs],
        },
        "bbox": [min(lons), min(lats), max(lons), max(lats)],
        "start": {"lng": coords[0][0], "lat": coords[0][1]},
        "summit": {"lng": coords[-1][0], "lat": coords[-1][1]},
        "tags": [],
        "sources": [{"name": "gpx", "path": path}],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("gpx", help="Input GPX file")
    parser.add_argument("--name", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--country", default="NL")
    parser.add_argument("--id", default=None)
    parser.add_argument("--out", default="-", help="Output file or - for stdout")
    args = parser.parse_args()

    climb = build_from_gpx(args.gpx, args.name, args.region, args.country, args.id)
    text = json.dumps(climb, ensure_ascii=False, indent=2) + "\n"
    if args.out == "-":
        print(text, end="")
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)


if __name__ == "__main__":
    main()
