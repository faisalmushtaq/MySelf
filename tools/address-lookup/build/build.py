"""Build a West Yorkshire postcode and address lookup from open data.

Inputs (paths passed on the command line):
  cpo_dir  OS Code-Point Open folder (contains Data/CSV and Doc/Codelist.xlsx)
  pp_csv   HM Land Registry Price Paid rows already filtered to WEST YORKSHIRE
  --no-addresses (optional, last) leaves the addresses out of the site files

Outputs (in out_dir):
  wy_postcodes.csv   every live postcode with coordinates, district and ward
  wy_addresses.csv   one row per distinct address
  wy.sqlite          both tables, indexed by postcode
  site/data/pc/<OUTCODE>.json   small shards the survey widget fetches
  site/data/index.json          outcode list and build stats
"""
import csv, json, os, re, sqlite3, sys
from collections import defaultdict
import pandas as pd
from pyproj import Transformer

cpo_dir, pp_csv, out_dir = sys.argv[1:4]
# --no-addresses: the site files carry postcodes only (all open data), for hosting publicly.
# The Land Registry addresses are still written to wy_addresses.csv for local use.
OPEN_ONLY = "--no-addresses" in sys.argv[4:]
WY_DISTRICTS = {
    "E08000032": "Bradford", "E08000033": "Calderdale", "E08000034": "Kirklees",
    "E08000035": "Leeds", "E08000036": "Wakefield",
}

# ---------- Postcodes ----------
codes = pd.read_excel(os.path.join(cpo_dir, "Doc/Codelist.xlsx"), sheet_name="MTW", header=None)
ward_names = {c: re.sub(r"\s+Ward$", "", n) for n, c in codes.values}
to_wgs84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)

cols = ["pc", "pq", "e", "n", "ctry", "rh", "lh", "cty", "dc", "wc"]
frames = []
for area in ["bd", "hd", "hx", "ls", "wf", "ol", "s", "hg", "yo", "dn", "bb", "ll"]:
    p = os.path.join(cpo_dir, "Data/CSV", f"{area}.csv")
    if os.path.exists(p):
        frames.append(pd.read_csv(p, header=None, names=cols, dtype=str))
pcs = pd.concat(frames)
pcs = pcs[pcs.dc.isin(WY_DISTRICTS)].copy()
pcs["e"], pcs["n"] = pcs.e.astype(int), pcs.n.astype(int)
lon, lat = to_wgs84.transform(pcs.e.values, pcs.n.values)
pcs["lat"], pcs["lon"] = [round(v, 6) for v in lat], [round(v, 6) for v in lon]
pcs["district"] = pcs.dc.map(WY_DISTRICTS)
pcs["ward"] = pcs.wc.map(ward_names).fillna("")
pcs["pc"] = pcs.pc.str.replace(r"\s+", " ", regex=True).str.strip()
pcs["outcode"] = pcs.pc.str.split(" ").str[0]
live = set(pcs.pc)

# ---------- Addresses ----------
NUM = re.compile(r"^\d+[A-Z]?(\s*-\s*\d+[A-Z]?)?$")
SMALL = {"of", "the", "and", "on", "in", "upon", "at", "by"}

def tc(s):
    """Title-case an upper-case address fragment, keeping things like 12A and O'Brien tidy."""
    out = []
    for i, w in enumerate(s.lower().split()):
        if i and w in SMALL:
            out.append(w); continue
        w = "-".join(p[:1].upper() + p[1:] for p in w.split("-"))
        w = re.sub(r"'([a-z])\b", lambda m: "'" + m.group(1), w)            # Mary's
        w = re.sub(r"^(o')([a-z])", lambda m: "O'" + m.group(2).upper(), w, flags=re.I)
        w = re.sub(r"^(mc)([a-z])", lambda m: "Mc" + m.group(2).upper(), w, flags=re.I)
        w = re.sub(r"^(\d+)([a-z])$", lambda m: m.group(1) + m.group(2).upper(), w)
        out.append(w)
    return " ".join(out)

latest = {}
with open(pp_csv, newline="") as f:
    for r in csv.reader(f):
        _, _, date, pc, ptype, _, _, paon, saon, street, loc, town, dist, county, *_ = r
        pc = " ".join(pc.split())
        if pc not in live:
            continue
        key = (pc, saon.strip(), paon.strip(), street.strip())
        if key not in latest or date > latest[key][0]:
            latest[key] = (date, ptype, loc.strip(), town.strip())

def natkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s or "")]

addr_rows = []
for (pc, saon, paon, street), (date, ptype, loc, town) in latest.items():
    if NUM.match(paon) and street:
        l1, l2 = f"{paon} {tc(street)}", ""
    else:
        l1, l2 = tc(paon), tc(street)
    if saon:
        l1 = f"{tc(saon)}, {l1}" if l1 else tc(saon)
    if not l1:
        l1, l2 = l2, ""
    locality = tc(loc) if loc and loc != town else ""
    addr_rows.append({
        "postcode": pc, "line1": l1, "line2": l2, "locality": locality, "town": tc(town),
        "saon": saon, "paon": paon, "street": street,
        "property_type": {"D": "Detached", "S": "Semi-detached", "T": "Terraced",
                          "F": "Flat/maisonette", "O": "Other"}.get(ptype, ""),
        "last_sale_year": date[:4],
    })
addr_rows.sort(key=lambda a: (a["postcode"], natkey(a["street"]), natkey(a["paon"]), natkey(a["saon"])))

# ---------- Write outputs ----------
os.makedirs(out_dir, exist_ok=True)
pc_cols = ["pc", "outcode", "lat", "lon", "e", "n", "pq", "district", "dc", "ward", "wc"]
pcs.sort_values("pc")[pc_cols].rename(columns={
    "pc": "postcode", "e": "easting", "n": "northing", "pq": "positional_quality",
    "dc": "district_code", "wc": "ward_code"}).to_csv(os.path.join(out_dir, "wy_postcodes.csv"), index=False)
adf = pd.DataFrame(addr_rows)
adf.to_csv(os.path.join(out_dir, "wy_addresses.csv"), index=False)

db = os.path.join(out_dir, "wy.sqlite")
if os.path.exists(db):
    os.remove(db)
con = sqlite3.connect(db)
pd.read_csv(os.path.join(out_dir, "wy_postcodes.csv")).to_sql("postcodes", con, index=False)
adf.to_sql("addresses", con, index=False)
con.execute("CREATE UNIQUE INDEX ix_pc ON postcodes(postcode)")
con.execute("CREATE INDEX ix_addr_pc ON addresses(postcode)")
con.commit(); con.close()

by_pc = defaultdict(list)
for a in addr_rows:
    by_pc[a["postcode"]].append([a["line1"], a["line2"], a["locality"], a["town"]])
shard_dir = os.path.join(out_dir, "site/data/pc")
os.makedirs(shard_dir, exist_ok=True)
outcodes = {}
for oc, g in pcs.groupby("outcode"):
    shard = {r.pc: {"lat": r.lat, "lon": r.lon, "d": r.district, "w": r.ward, "a": [] if OPEN_ONLY else by_pc.get(r.pc, [])}
             for r in g.itertuples()}
    with open(os.path.join(shard_dir, f"{oc}.json"), "w") as f:
        json.dump(shard, f, separators=(",", ":"))
    outcodes[oc] = len(shard)

stats = {
    "postcodes": len(pcs), "addresses": len(addr_rows),
    "postcodes_with_addresses": len(by_pc),
    "by_district": {d: {"postcodes": int((pcs.district == d).sum()),
                        "addresses": 0}
                    for d in WY_DISTRICTS.values()},
}
pc_district = dict(zip(pcs.pc, pcs.district))
for d in stats["by_district"]:
    stats["by_district"][d]["addresses"] = sum(1 for a in addr_rows if pc_district[a["postcode"]] == d)
with open(os.path.join(out_dir, "site/data/index.json"), "w") as f:
    json.dump({"outcodes": outcodes, "stats": stats}, f, indent=1)
print(json.dumps(stats, indent=1))
