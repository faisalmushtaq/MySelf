"""Build the street index used for type-ahead search.

Every named road in West Yorkshire from OS Open Names is linked to its postcodes, using
the postcodes of Land Registry addresses on that street plus any postcode whose centre
falls within 60 m of the road's bounding box in the same postcode district. Streets that
appear only in the Land Registry data are added as well.

Usage: python3 build_streets.py <open_names_dir> <output_dir>
(output_dir must already hold wy_postcodes.csv and wy_addresses.csv from build.py)
"""
import glob, json, os, sys
from collections import defaultdict
import pandas as pd

on_dir, out_dir = sys.argv[1:3]
BUF = 60
DISTRICTS = {"Bradford", "Calderdale", "Kirklees", "Leeds", "Wakefield"}

pcs = pd.read_csv(os.path.join(out_dir, "wy_postcodes.csv"), dtype={"postcode": str})
pc_district = dict(zip(pcs.postcode, pcs.district))
pc_ward = dict(zip(pcs.postcode, pcs.ward.fillna("")))
by_oc = defaultdict(list)
for r in pcs.itertuples():
    by_oc[r.outcode].append((r.easting, r.northing, r.postcode))

addr = pd.read_csv(os.path.join(out_dir, "wy_addresses.csv"), dtype=str, keep_default_na=False)
addr = addr[addr.street != ""]
lr = defaultdict(lambda: {"pcs": {}, "place": "", "areas": set()})
for r in addr.itertuples():
    oc = r.postcode.split(" ")[0]
    k = (" ".join(r.street.lower().split()), oc)
    lr[k]["pcs"][r.postcode] = lr[k]["pcs"].get(r.postcode, 0) + 1
    lr[k]["place"] = lr[k]["place"] or r.locality or r.town
    lr[k]["town"] = r.town
    lr[k]["areas"].update(x for x in (r.locality, r.town) if x)

hdr = pd.read_csv(os.path.join(on_dir, "Doc/OS_Open_Names_Header.csv"), encoding="utf-8-sig").columns.tolist()
roads = []
for f in glob.glob(os.path.join(on_dir, "Data/*.csv")):
    d = pd.read_csv(f, header=None, names=hdr, dtype=str, keep_default_na=False,
                    usecols=["NAME1", "LOCAL_TYPE", "MBR_XMIN", "MBR_YMIN", "MBR_XMAX", "MBR_YMAX",
                             "POSTCODE_DISTRICT", "POPULATED_PLACE", "DISTRICT_BOROUGH"])
    d = d[(d.LOCAL_TYPE == "Named Road") & d.DISTRICT_BOROUGH.isin(DISTRICTS)]
    if len(d):
        roads.append(d)
roads = pd.concat(roads)

entries = {}
for r in roads.itertuples():
    oc = r.POSTCODE_DISTRICT
    x0, y0, x1, y1 = (float(r.MBR_XMIN) - BUF, float(r.MBR_YMIN) - BUF,
                      float(r.MBR_XMAX) + BUF, float(r.MBR_YMAX) + BUF)
    near = [pc for e, n, pc in by_oc.get(oc, []) if x0 <= e <= x1 and y0 <= n <= y1]
    k = (" ".join(r.NAME1.lower().split()), oc)
    if k in entries:                       # same road split into several OS segments
        entries[k]["near"].update(near)
        continue
    entries[k] = {"name": r.NAME1, "place": r.POPULATED_PLACE, "district": r.DISTRICT_BOROUGH,
                  "oc": oc, "near": set(near)}

added_from_lr = 0
for k, v in lr.items():
    if k not in entries:
        any_pc = next(iter(v["pcs"]))
        entries[k] = {"name": " ".join(w.capitalize() if w.islower() else w for w in k[0].split()),
                      "place": v["place"], "district": pc_district[any_pc], "oc": k[1], "near": set()}
        added_from_lr += 1

rows = []
for k, e in entries.items():
    known = sorted(lr[k]["pcs"], key=lambda p: -lr[k]["pcs"][p]) if k in lr else []
    # Nearby postcodes are only needed as suggestions when no address on the street is known
    rest = [] if known else sorted(e["near"])[:15]
    pcl = (known + rest)[:40]
    if not pcl:
        continue
    place = e["place"] if e["place"] and e["place"] != e["district"] else ""
    if not place and k in lr and lr[k]["place"] not in ("", e["district"]):
        place = lr[k]["place"]
    # Extra area words people may type: Land Registry localities and towns, and ward names
    areas = set(lr[k]["areas"]) if k in lr else set()
    areas.update(pc_ward.get(p, "") for p in pcl)
    shown = (e["name"] + " " + place + " " + e["district"]).lower()
    extra = sorted({w for a in areas for w in a.replace("&", " ").replace(",", " ").split()
                    if len(w) > 2 and w.lower() not in shown and w.lower() not in ("and", "the", "with")})
    rows.append([e["name"], place, e["district"], e["oc"],
                 " ".join(p.split(" ")[1] for p in pcl), len(known), " ".join(extra)])
rows.sort(key=lambda r: (r[0].lower(), r[3]))

# Split by the first letter of each significant word, so the widget only loads the
# slice matching the first letter typed ("manor dr" loads m.json).
GENERIC = {"the", "road", "street", "lane", "avenue", "drive", "close", "court", "crescent", "grove",
           "terrace", "place", "way", "gardens", "view", "walk", "mount", "rise", "square", "fold",
           "garth", "green", "hill", "park", "row", "vale", "bank", "croft", "mews", "approach", "of", "and"}
shards = defaultdict(list)
for row in rows:
    words = [w for w in row[0].lower().replace("-", " ").split() if w[:1].isalnum()]
    keys = {w[0] for w in words if w not in GENERIC} or {w[0] for w in words}
    for k in keys:
        shards[k if k.isalpha() else "0"].append(row)
sd = os.path.join(out_dir, "site/data/st")
os.makedirs(sd, exist_ok=True)
for f in glob.glob(os.path.join(sd, "*.json")):
    os.remove(f)
for k, v in shards.items():
    with open(os.path.join(sd, f"{k}.json"), "w") as f:
        json.dump(v, f, separators=(",", ":"))
old = os.path.join(out_dir, "site/data/streets.json")
if os.path.exists(old):
    os.remove(old)
print(f"{len(rows)} street entries ({added_from_lr} only in Land Registry); "
      f"{sum(1 for r in rows if r[5] == 0)} with no listed addresses")
