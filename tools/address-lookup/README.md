# West Yorkshire address finder (for web surveys)

A drop-in address box for surveys run in a browser, such as Qualtrics. Respondents start typing a street, a number and street ("12 manor drive headingley"), a house name or a postcode, and suggestions appear as they type. When an Ideal Postcodes key is given, Ideal Postcodes is used first; if it fails for any reason (bad key, no credit, a daily or per-IP limit, a server error or no reply within four seconds), the box switches to its own West Yorkshire data for the rest of that respondent's session without showing an error.

This is separate from the participant app. The app's home-address question already checks postcodes and streets offline on the device (`packages/engine/src/postcodes.ts` and `streets.ts`, D-52 and D-53), so nothing a participant types leaves the iPad, and this tool does not change that.

## What each answer records

`postcode`, `line1`, `line2`, `locality`, `town`, `district`, `ward`, `lat`, `lon`, `uprn` and `udprn` (Ideal Postcodes only), `source` (`ideal`, `local` or `manual`) and `fallback_reason` (blank, or Ideal's error code such as 4021, or `timeout`). District and ward always come from the open postcode data where the postcode is in West Yorkshire, so area coding is consistent whichever source found the address.

## Building the data

```
curl -L -o cpo.zip "https://api.os.uk/downloads/v1/products/CodePointOpen/downloads?area=GB&format=CSV&redirect" && unzip cpo.zip -d cpo
curl -L -o on.zip "https://api.os.uk/downloads/v1/products/OpenNames/downloads?area=GB&format=CSV&redirect" && unzip on.zip -d on
curl -L https://price-paid-data.publicdata.landregistry.gov.uk/pp-complete.csv | grep '"WEST YORKSHIRE"' > pp_wy.csv
pip install pandas pyproj openpyxl
python3 build/build.py cpo pp_wy.csv out --no-addresses
python3 build/build_streets.py on out
cp -R out/site/data site/data
```

That gives every live postcode in the five districts with its ward and district (OS Code-Point Open) and about 44,800 streets with their likely postcodes (OS Open Names), about 10 MB in all. Everything in it is open data under the Open Government Licence, so `site/` can be hosted publicly, for example on GitHub Pages. With this data the backup finds the respondent's street and postcode, and they type their house number.

Leaving out `--no-addresses` adds about 635,000 addresses from HM Land Registry Price Paid Data, so most respondents can pick their full address. Those addresses carry Royal Mail and Ordnance Survey rights: HM Land Registry permits their use "for personal and/or non-commercial use", and other uses need Royal Mail's agreement (https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads). Because a browser widget has to download its data, hosting that build on a public site amounts to publishing the address list, so keep the full build off public hosting unless Royal Mail has agreed. The MyPhone/MyBrain site keeps the same full data in a private bucket behind its own function, which only ever returns the few addresses matching what was typed (see `consent-app/docs/address-lookup.md` in that repository).

The data is not committed here; rebuild it every few months to pick up new postcodes and streets.

## Putting it in Qualtrics

Host `site/` with its `data` folder, then paste `site/qualtrics.js` into the JavaScript of a Text/Graphic question and set `BASE` to the hosted address. Add the embedded data fields listed at the top of that file to the Survey Flow. The Next button stays disabled until an address is complete. For other platforms, load `postcode-lookup.js` and call `WYLookup.mount(element, { dataUrl, idealKey, onChange })`.

## The Ideal Postcodes key

A key used in a web page can be read by anyone who opens the page, which is how Ideal Postcodes' browser tools are designed to work. To keep it safe:

1. Use a separate key for the survey, not the one the MyPhone/MyBrain server uses.
2. In the Ideal Postcodes dashboard, under the key's settings, add your survey's address to **Allowed URLs** (for example your institution's Qualtrics domain), so the key is refused on any other site.
3. Set a **daily limit** and an **individual (per-IP) limit**, so a misused key can only spend a small amount. When a limit is hit, respondents move to the backup.
4. Set the usage history redaction period to 0 days, so search terms are not kept in the usage log.
5. Put the key only in the Qualtrics question's JavaScript (`IDEAL_KEY`), never in this repository.

Leave `IDEAL_KEY` empty to use only the open data.

## Licensing and attribution

Contains OS data © Crown copyright and database right 2026. Contains Royal Mail data © Royal Mail copyright and database right 2026. Contains National Statistics data © Crown copyright and database right 2026. This data is licensed under the Open Government Licence v3.0. If the Land Registry addresses are used, add: Contains HM Land Registry data © Crown copyright and database right 2021, licensed under the Open Government Licence v3.0; Price Paid address data has been processed against Ordnance Survey's AddressBase Premium product, which incorporates Royal Mail's PAF® database.
