/*
 * Qualtrics: paste into the JavaScript of a "Text/Graphic" question.
 *
 * 1. Set BASE to wherever you host the site folder (e.g. GitHub Pages).
 * 2. Set IDEAL_KEY to your Ideal Postcodes key, or leave it "" to use only our own data.
 *    In the Ideal Postcodes dashboard, restrict the key to your Qualtrics domain (Allowed URLs)
 *    and set daily and per-IP limits, because a key used in a web page is visible to respondents.
 *    When a limit is hit, the widget quietly switches to our own data.
 * 3. In Survey Flow, add an Embedded Data element ABOVE this block with these fields
 *    (leave values blank): addr_postcode, addr_line1, addr_line2, addr_locality, addr_town,
 *    addr_district, addr_ward, addr_lat, addr_lon, addr_uprn, addr_udprn, addr_source,
 *    addr_fallback_reason
 *    If your survey uses the "Simple" layout, also add the same names with a __js_ prefix
 *    (e.g. __js_addr_postcode), because that layout stores JavaScript values under that prefix.
 * 4. The Next button stays disabled until a full address is chosen or typed.
 *
 * addr_source is "ideal", "local" (our backup data) or "manual" (typed by the respondent).
 * addr_fallback_reason is blank unless Ideal failed for that respondent, in which case it holds
 * Ideal's error code (e.g. 4020 no credit, 4021 limit reached, 4010 bad key) or "timeout"/"network".
 */
Qualtrics.SurveyEngine.addOnload(function () {
  var BASE = "https://YOUR-HOST/wy-postcodes";
  var IDEAL_KEY = "";
  var q = this;
  var box = document.createElement("div");
  q.getQuestionContainer().appendChild(box);
  q.disableNextButton();

  var FIELDS = ["postcode", "line1", "line2", "locality", "town", "district", "ward", "lat", "lon",
                "uprn", "udprn", "source", "fallback_reason"];
  function save(r) {
    r = r || {};
    FIELDS.forEach(function (k) {
      var name = "addr_" + k, v = r[k] == null ? "" : String(r[k]);
      Qualtrics.SurveyEngine.setEmbeddedData(name, v);              // classic layouts
      if (Qualtrics.SurveyEngine.setJSEmbeddedData)                   // Simple layout saves as __js_<name>
        Qualtrics.SurveyEngine.setJSEmbeddedData(name, v);
    });
    if (r.complete) q.enableNextButton(); else q.disableNextButton();
  }

  var s = document.createElement("script");
  s.src = BASE + "/postcode-lookup.js";
  s.onload = function () {
    WYLookup.mount(box, { dataUrl: BASE + "/data", idealKey: IDEAL_KEY || null, onChange: save });
  };
  s.onerror = function () {
    box.textContent = "The address finder couldn't load. Please type your full address in the next question.";
    q.enableNextButton();
  };
  document.head.appendChild(s);
});
