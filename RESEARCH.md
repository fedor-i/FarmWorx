# FarmWorx research notes

Researched November 2026. Most hardware prices come from vendor blogs and the legal points from secondary
sources, so treat them as a starting point. Get real quotes and legal advice before relying on them.

## What this changed in the design

| Finding | Decision |
|---|---|
| Web NFC is effectively Chrome on Android only. iPhones (XS and later) read a URL stored on a tag in the background and open it in Safari. | Every NFC tag stores a URL (`/t/<id>`). Android can scan inside the app, and both phone types work from a tap. |
| Phones read NFC (13.56 MHz) only. UHF RFID needs a Bluetooth sled at about $800 to $2,500, and livestock EID tags (134.2 kHz) need their own reader. | All non-phone hardware posts to one endpoint, `POST /api/readings`. The app doesn't care which technology made the read. |
| A web app cannot get location once it is closed or the screen is off, on iPhone especially. | The prototype is a web app for speed. Reliable background geofencing needs a native wrapper. This is the main limit to resolve. |
| Field connectivity can't be assumed. A farm-tool comparison also lists offline use as a key requirement. | Offline first: every action goes to a queue on the phone, keeps the time it happened and can be resent safely. |
| Pictograms are often misunderstood, even safety ones. Studies with farm workers find comprehension is poor without training and better when workers help design the symbols. | Pictures never stand alone: each is paired with spoken words, a voice clip from the supervisor, and colour-and-shape field signs. Emoji are a stand-in. |
| Bilingual farm labour apps exist, with piece rate and crew scanning. The search found none built around pictures for people who can't read. | Pictures and voice are this project's differentiator. Don't compete on payroll. |
| A Cornell-documented grower dropped a system that needed one person per crew and went back to time cards. | Workers act for themselves. A shared gate device covers crew with no phone. |
| Employee location rules vary by state and vendor advice is to limit capture. Crews push back on tracking. | People are located only while clocked in, enforced on the server. Workers can say no and still use the clock, and see a spoken explanation first. |
| MSPA requires payroll records to be kept for three years, and H-2A has its own earnings record rules. | Punches are append-only. Corrections are new rows with who entered them, plus both device and server time. |
| Pesticide re-entry rules (REI) require keeping people out of treated areas, with posted or oral warnings depending on the label. | Added a no-entry field: red screen with voice, blocked tasks, supervisor alert. It supplements signs and warnings and does not replace them. |

## Tag technology

| Tech | Tag cost | Read by | Range | Best for |
|---|---|---|---|---|
| NFC | Under $1 to a few dollars (general knowledge, confirm) | Most phones | Touch | Worker badges, tool check-out, field signs |
| QR sticker | Almost free | Any camera | Close | Fallback for phones with no NFC. Not built yet |
| UHF RFID (passive) | $0.10 to $5 | Fixed reader or $800 to $2,500 sled | Metres | Bins, or tools through a gate |
| BLE tag | $10 to $50 | Gateways, or phones via a native app | Tens of metres | Pumps, trailers, generators |
| Cellular GPS | $50 to $200 plus $10 to $30 a month | Self-reporting | Anywhere with signal | Tractors, high-value machines |
| LoRaWAN GPS | No pricing found | Your own gateway | Kilometres | Large farms with poor cell cover |
| Livestock EID (134.2 kHz) | Not priced | Dedicated reader, such as a £1,250+ race reader | About 25 cm handheld | Animals only |

**Suggested starting kit:** NFC for people, tools and field signs, plus GPS trackers on the few machines worth
protecting. Add UHF or BLE only when a specific loss justifies the readers. One farm equipment lender chose
UHF RFID over GPS on cost, so check this against what you actually need to find.

## Open questions to answer with a real farm

1. Do workers carry their own phones, or will the farm provide shared ones? This decides how much the gate matters.
2. Which languages does the crew speak? Phones may have no voice for Indigenous languages such as Mixteco, so recorded clips would have to carry them.
3. Which pictures are understood? Test each with real workers and redraw the ones that fail. Two of the first icons here were already wrong: a wastebasket for bins and a shower for watering.
4. Is pay hourly, piece rate or both? Piece rate would change the data model.
5. Which state? It sets break rules and location notice rules. The 5-hour, 30-minute break flag is a placeholder check and needs confirming.

## Sources

Phones and tags: [MDN Web NFC](https://developer.mozilla.org/docs/Web/API/Web_NFC_API),
[Apple background tag reading](https://developer.apple.com/documentation/corenfc/adding-support-for-background-tag-reading.md),
[WebKit background location bug](https://bugs.webkit.org/show_bug.cgi?id=193946),
[W3C geolocation discussion](https://lists.w3.org/Archives/Public/public-device-apis-log/2025Nov/0012.html),
[AirPinpoint BLE guide](https://airpinpoint.com/blog/ble-tracking-guide),
[AirPinpoint tag comparison](https://airpinpoint.com/asset-tracking/tags),
[RFID Journal farm equipment case](https://www.rfidjournal.com/?p=81352),
[mobile sled readers](https://rfid-me.pages.dev/readers/mobile-sled-reader/),
[CSL CS710S sled](https://www.atlasrfidstore.com/csl-cs710s-bluetooth-uhf-rfid-handheld-sled-reader/),
[Allflex APR250](https://wiid.org/store/allflex-readers/allflex-apr250-handheld-reader/),
[Shearwell SDL150S](https://www.milldairyservice.co.uk/sdl150s-small-race-reader/).

Farm labour software: [FieldClock](https://fieldclock.com/features),
[Good Fruit Grower](https://www.goodfruit.com/phone-apps-automate-labor-management/),
[Cornell extension notes](https://rvpadmin.cce.cornell.edu/uploads/doc_1207.pdf),
[Agricultural Data Systems](https://bouncewatch.com/company/agricultural-data-systems),
[Timeero farm geofences](https://timeero.com/post/polygon-geofences-farms),
[Workyard on crew pushback](https://www.workyard.com/blog-articles/how-to-handle-crew-pushback-on-gps-time-tracking).

Pictograms: [PubMed 33400115](https://www.pubmed.gov/33400115/),
[PMC8207002](https://pmc.ncbi.nlm.nih.gov/articles/PMC8207002),
[pictographs with Mexican farmworkers in California](https://informahealthcare.com/doi/full/10.1080/09670878809371253),
[farmworker-designed symbols](https://springerlink.bibliotecabuap.elogim.com/content/pdf/10.1007/s10903-012-9685-4.pdf).

Rules: [DOL H-2A records fact sheet](https://www.dol.gov/agencies/whd/fact-sheets/26c-records-retention-requirements-H-2A),
[20 CFR 655.167](https://www.law.cornell.edu/cfr/text/20/655.167),
[29 CFR 500.80](https://codes.findlaw.com/cfr/title-29-labor/cfr-sect-29-500-80/),
[MSU Worker Protection Standard](https://www.canr.msu.edu/research/centers/worker-protection-standards),
[Purdue WPS guide](https://ag.purdue.edu/department/extension/ppp/resources/ppp-publications/mobile/ppp-131/_docs/wps.pdf),
[Fisher Phillips on GPS monitoring](https://www.fisherphillips.com/en/insights/publication/the-fine-line-of-monitoring-workers-via-gps),
[Seyfarth on employee GPS monitoring](https://jdsupra.com/legalnews/somebody-s-watching-me-considerations-93406).
