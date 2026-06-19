#!/usr/bin/env python3
"""
fetch-nba-data.py — Fetch NBA player per-season stats from nba_api,
estimate salaries based on NBA salary cap data, and output nba-data.js.

Data coverage: 2000-01 through 2024-25 (25 seasons)
"""

import json
import time
import random
import os
import re
import sys

# ─── NBA Salary Cap Data (millions USD, public) ───
SALARY_CAP_M = {
    "2000-01": 35.5, "2001-02": 42.5, "2002-03": 40.3, "2003-04": 43.8,
    "2004-05": 43.9, "2005-06": 49.5, "2006-07": 53.1, "2007-08": 55.6,
    "2008-09": 58.7, "2009-10": 57.7, "2010-11": 58.0, "2011-12": 58.0,
    "2012-13": 58.0, "2013-14": 58.7, "2014-15": 63.1, "2015-16": 70.0,
    "2016-17": 94.1, "2017-18": 99.1, "2018-19": 101.9, "2019-20": 109.1,
    "2020-21": 109.1, "2021-22": 112.4, "2022-23": 123.7, "2023-24": 136.0,
    "2024-25": 140.6,
}

# ─── Seasons to fetch ───
SEASONS = [
    "2000-01", "2001-02", "2002-03", "2003-04", "2004-05",
    "2005-06", "2006-07", "2007-08", "2008-09", "2009-10",
    "2010-11", "2011-12", "2012-13", "2013-14", "2014-15",
    "2015-16", "2016-17", "2017-18", "2018-19", "2019-20",
    "2020-21", "2021-22", "2022-23", "2023-24", "2024-25",
]

# ─── Salary tier thresholds ───
SALARY_TIERS = [
    (0.01, 0.32),   # Top 1%: max contract
    (0.05, 0.25),   # Top 5%
    (0.10, 0.20),   # Top 10%
    (0.25, 0.12),   # Top 25%
    (0.50, 0.07),   # Top 50%
    (1.00, 0.03),   # Rest: minimum
]

# ─── Position inference from API position strings ───
POSITION_MAP = {
    "G":   ["PG", "SG"],
    "F":   ["SF", "PF"],
    "C":   ["C"],
    "G-F": ["PG", "SG", "SF"],
    "F-G": ["SF", "PF", "SG"],
    "F-C": ["SF", "PF", "C"],
    "C-F": ["C", "PF", "SF"],
    "GF":  ["PG", "SG", "SF"],
    "FC":  ["SF", "PF", "C"],
    "CG":  ["PG", "SG", "C"],
    "PG":  ["PG"],
    "SG":  ["SG"],
    "SF":  ["SF"],
    "PF":  ["PF"],
    "C":   ["C"],
}

# ─── Composite score for salary ranking ───
def composite_score(pts, reb, ast, stl, blk):
    return pts * 0.45 + reb * 0.2 + ast * 0.2 + stl * 0.08 + blk * 0.07


def infer_positions_from_stats(pts, reb, ast, stl, blk):
    """Infer likely position from statistical profile using heuristics."""
    # Ratios relative to typical positional averages
    ast_ratio = ast / max(pts, 0.1)
    reb_ratio = reb / max(pts, 0.1)
    blk_ratio = blk / max(pts, 0.1)
    stl_ratio = stl / max(pts, 0.1)

    if reb >= 10 and blk >= 1.5:
        return ["C"], "C"
    elif reb >= 9 and blk >= 1.0:
        return ["C", "PF"], "C"
    elif reb >= 8 and ast <= 4:
        return ["PF", "C"], "PF"
    elif reb >= 7 and ast <= 5 and pts >= 15:
        return ["PF", "SF"], "PF"
    elif ast >= 7 and reb <= 6:
        return ["PG"], "PG"
    elif ast >= 6 and reb <= 5:
        return ["PG", "SG"], "PG"
    elif ast >= 5.5 and reb <= 5:
        return ["PG", "SG"], "PG"
    elif ast >= 5 and stl >= 1.5:
        return ["PG", "SG"], "PG"
    elif pts >= 18 and reb <= 5 and ast <= 5 and stl >= 1.2:
        return ["SG", "SF"], "SG"
    elif reb >= 6 and ast <= 4 and blk >= 0.8:
        return ["PF", "SF"], "PF"
    elif reb >= 5 and ast <= 3.5 and blk >= 0.7:
        return ["PF"], "PF"
    elif pts >= 15 and ast <= 4 and reb <= 6 and reb >= 4:
        return ["SF", "SG"], "SF"
    elif ast <= 3 and reb <= 4:
        return ["SG"], "SG"
    elif reb >= 5 and ast >= 4:
        return ["SF", "PF"], "SF"
    else:
        return ["SF"], "SF"


def slugify(name):
    """Convert player name to a URL-like slug."""
    name = name.lower().strip()
    name = re.sub(r"[^.a-z0-9]", "_", name)
    name = re.sub(r"_+", "_", name)
    name = name.strip("_")
    return name


def estimate_salary(composite, rank, total_players, season_cap):
    """Estimate salary based on percentile within season."""
    percentile = rank / total_players
    tier_fraction = 0.03  # default: minimum
    for threshold, fraction in SALARY_TIERS:
        if percentile <= threshold:
            tier_fraction = fraction
            break
    base_salary = season_cap * tier_fraction
    # Add randomization ±15%
    random_factor = 1 + random.uniform(-0.15, 0.15)
    salary = base_salary * random_factor
    return round(salary, 1)


def infer_positions(pos_str):
    """Infer position array from API position string."""
    if not pos_str:
        return ["SF"]  # default fallback
    pos_str = pos_str.strip().upper()
    # Try direct match
    if pos_str in POSITION_MAP:
        return POSITION_MAP[pos_str]
    # Try hyphenated combinations
    parts = pos_str.replace("-", "-").replace("/", "-").split("-")
    result = []
    for part in parts:
        part = part.strip()
        if part in POSITION_MAP:
            result.extend(POSITION_MAP[part])
        elif part in ["PG", "SG", "SF", "PF", "C"]:
            result.append(part)
    if not result:
        return ["SF"]
    # Deduplicate while preserving order
    seen = set()
    unique = []
    for p in result:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # ─── Load existing name/position mappings ───
    name_map_path = os.path.join(script_dir, "name_map.json")
    pos_map_path = os.path.join(script_dir, "pos_map.json")

    cname_map = {}
    pos_lookup = {}

    if os.path.exists(name_map_path):
        with open(name_map_path, "r", encoding="utf-8") as f:
            cname_map = json.load(f)
        print(f"Loaded {len(cname_map)} Chinese name mappings")

    if os.path.exists(pos_map_path):
        with open(pos_map_path, "r", encoding="utf-8") as f:
            pos_lookup = json.load(f)
        print(f"Loaded {len(pos_lookup)} position mappings")

    # ─── Fetch data from nba_api ───
    from nba_api.stats.endpoints.leaguedashplayerstats import LeagueDashPlayerStats

    all_players = []
    total_fetched = 0

    for season in SEASONS:
        print(f"Fetching {season}...")
        retries = 0
        max_retries = 3

        while retries < max_retries:
            try:
                stats = LeagueDashPlayerStats(
                    season=season,
                    per_mode_detailed="PerGame",
                    season_type_all_star="Regular Season"
                )
                df = stats.get_data_frames()[0]
                break
            except Exception as e:
                retries += 1
                print(f"  Error fetching {season} (retry {retries}): {e}")
                if retries < max_retries:
                    time.sleep(5)
                else:
                    print(f"  Skipping {season} after {max_retries} retries")
                    continue

        if retries >= max_retries:
            continue

        # ─── Process each player in this season ───
        season_players = []

        for _, row in df.iterrows():
            player_name = row.get("PLAYER_NAME", "")
            team = row.get("TEAM_ABBREVIATION", "")
            gp = row.get("GP", 0)
            pts = row.get("PTS", 0)
            reb = row.get("REB", 0)
            ast = row.get("AST", 0)
            stl = row.get("STL", 0)
            blk = row.get("BLK", 0)

            # Filter: minimum 10 games played
            if gp < 10 or not player_name or not team:
                continue

            # Skip NaN values
            try:
                pts = float(pts) if pts and str(pts) != "nan" else 0
                reb = float(reb) if reb and str(reb) != "nan" else 0
                ast = float(ast) if ast and str(ast) != "nan" else 0
                stl = float(stl) if stl and str(stl) != "nan" else 0
                blk = float(blk) if blk and str(blk) != "nan" else 0
            except (ValueError, TypeError):
                continue

            base_slug = slugify(player_name)

            # ─── Chinese name lookup ───
            cname = cname_map.get(base_slug, "")

            # ─── Position lookup ───
            pos_info = pos_lookup.get(base_slug, None)
            if pos_info:
                pos = pos_info.get("pos", "SF")
                positions = pos_info.get("positions", [pos])
            else:
                # Infer from statistical profile
                positions, pos = infer_positions_from_stats(pts, reb, ast, stl, blk)

            # ─── Build ID ───
            player_id = f"{base_slug}_{team.lower()}_{season}"

            season_players.append({
                "team": team,
                "player": player_name,
                "pos": pos,
                "ppg": round(pts, 2),
                "rpg": round(reb, 2),
                "apg": round(ast, 2),
                "spg": round(stl, 2),
                "bpg": round(blk, 2),
                "positions": positions,
                "id": player_id,
                "baseSlug": base_slug,
                "season": season,
                "salary": 0,  # placeholder, computed below
                "cname": cname,
                "composite": composite_score(pts, reb, ast, stl, blk),
            })

        # ─── Compute salaries for this season ───
        season_cap = SALARY_CAP_M.get(season, 58.0)

        # Sort by composite score descending
        season_players.sort(key=lambda p: p["composite"], reverse=True)
        total = len(season_players)

        for rank, player in enumerate(season_players, 1):
            player["salary"] = estimate_salary(
                player["composite"], rank, total, season_cap
            )

        all_players.extend(season_players)
        total_fetched += len(season_players)
        print(f"  {season}: {len(season_players)} players (GP>=10)")

        # Rate limiting
        time.sleep(1.5)

    print(f"\nTotal players across all seasons: {len(all_players)}")

    # ─── Remove composite field (not needed in output) ───
    for p in all_players:
        del p["composite"]

    # ─── Output nba-data.js ───
    output_path = os.path.join(script_dir, "nba-data.js")

    # Format as compact but readable JSON
    json_str = json.dumps(all_players, ensure_ascii=False, separators=(",", ":"))

    # Write as JavaScript file
    header = "// Auto-generated by fetch-nba-data.py\n"
    header += "// Data source: nba_api LeagueDashPlayerStats (PerGame mode)\n"
    header += "// Seasons: 2000-01 through 2024-25, filtered GP>=10\n"
    header += "// Salary estimated from NBA salary cap + percentile ranking\n"

    content = header + "const NBA_DATA_RAW = " + json_str + ";\n"

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"\nWritten to {output_path}")
    print(f"File size: {os.path.getsize(output_path) / 1024:.0f} KB")

    # ─── Validation summary ───
    season_counts = {}
    for p in all_players:
        s = p["season"]
        season_counts[s] = season_counts.get(s, 0) + 1

    print("\nPer-season player counts:")
    for season in SEASONS:
        count = season_counts.get(season, 0)
        print(f"  {season}: {count} players")

    # Check salary ranges
    salaries = [p["salary"] for p in all_players]
    print(f"\nSalary range: $${min(salaries):.1f}M - $${max(salaries):.1f}M")

    # Check Chinese name coverage
    with_cname = sum(1 for p in all_players if p["cname"])
    print(f"Chinese name coverage: {with_cname}/{len(all_players)} ({with_cname*100//len(all_players)}%)")


if __name__ == "__main__":
    main()
