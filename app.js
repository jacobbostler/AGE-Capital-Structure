/* app.js — reads the CSV files in data/, asks capstruct.js for the numbers,
 * and puts them on the page. All the finance math lives in capstruct.js;
 * this file only fetches, formats, renders and handles the levers.
 *
 * capstruct.js is loaded first, so its functions (parseCSV, roundHalfUp,
 * firmSeries, cdssCaseMethod, ...) are available here by name.
 */

/* ---------- formatting (display only) ---------- */

const NA = { text: "n/a", na: true };

function group(x, d) {
  return roundHalfUp(x, d).toLocaleString("en-US",
    { minimumFractionDigits: d, maximumFractionDigits: d });
}
function money(x) { return x === null ? NA : "$" + group(x, 0); }
function moneyParen(x) {
  if (x === null) return NA;
  return x === 0 ? "$0" : "(" + group(x, 0) + ")";
}
function cents(x) { return x === null ? NA : "$" + group(x, 2); }
function pct(x, d) { return x === null ? NA : group(x * 100, d === undefined ? 2 : d) + "%"; }
function mult(x) { return x === null ? NA : group(x, 2) + "×"; }
function shares(x) { return x === null ? NA : group(x, 2); }
/* plain text versions, for notes and readouts */
function moneyText(x) { return "$" + group(x, 0); }
function centsText(x) { return "$" + group(x, 2); }

/* ---------- tiny DOM helpers ---------- */

function $(id) { return document.getElementById(id); }

function cell(tag, value, label) {
  const td = document.createElement(tag);
  if (value && typeof value === "object" && value.na) {
    td.textContent = value.text;
    td.className = "na";
  } else {
    td.textContent = value;
  }
  if (label) td.setAttribute("data-label", label);
  return td;
}

/* Build a table from a list of header labels and a list of row arrays.
 * opts.stack turns each row into a card on a phone.
 * opts.rowHeader makes the first cell of every row a <th>. */
function buildTable(table, headers, rows, opts) {
  opts = opts || {};
  table.innerHTML = "";
  table.className = opts.stack ? "stack" : "";
  const thead = table.createTHead();
  const htr = thead.insertRow();
  headers.forEach((h) => {
    const th = cell("th", h);
    th.scope = "col";
    htr.appendChild(th);
  });
  const tbody = table.createTBody();
  rows.forEach((row) => {
    const tr = tbody.insertRow();
    if (row.className) tr.className = row.className;
    const values = row.values || row;
    values.forEach((v, i) => {
      const isHeadCell = i === 0 && opts.rowHeader;
      const td = cell(isHeadCell ? "th" : "td", v, headers[i]);
      if (isHeadCell) td.scope = "row";
      if (i === 0 && !opts.rowHeader) td.className += " label";
      if (row.flags && row.flags[i]) td.className += " flag";
      tr.appendChild(td);
    });
  });
}

function findings(ul, items) {
  ul.innerHTML = "";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = item.kind || "ok";
    li.textContent = item.text;
    ul.appendChild(li);
  });
}

function alert_(message) {
  const box = $("alerts");
  box.hidden = false;
  const p = document.createElement("p");
  p.textContent = message;
  box.appendChild(p);
}

/* ---------- loading the data ---------- */

async function readCSV(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(path + " (" + response.status + ")");
  return parseCSV(await response.text());
}

function toLookup(rows, keyField, valueField) {
  const out = {};
  rows.forEach((r) => { out[r[keyField]] = num(r[valueField]); });
  return out;
}

async function load() {
  const [assumptions, cdssRows, schedRows, exampleRows, scenarioRows] =
    await Promise.all([
      readCSV("data/assumptions.csv"),
      readCSV("data/cdss.csv"),
      readCSV("data/banker_schedule.csv"),
      readCSV("data/example_firms.csv"),
      readCSV("data/ebit_scenarios.csv"),
    ]);
  return {
    taxRate: toLookup(assumptions, "assumption", "value").tax_rate,
    cdss: toLookup(cdssRows, "item", "value"),
    example: toLookup(exampleRows, "item", "value"),
    schedule: schedRows.map((r) => ({
      debt: num(r.debt),
      cost_of_debt: num(r.cost_of_debt),
      cost_of_equity: num(r.cost_of_equity),
    })),
    scenarios: scenarioRows.map((r) => ({
      probability: num(r.probability),
      sales: num(r.sales),
      operatingCosts: num(r.operating_costs),
    })),
  };
}

/* ---------- what the page is currently showing ---------- */

const state = {
  data: null,        /* everything read from data/ */
  cdssRows: null,    /* case method, one row per amount in the schedule */
  newRows: null,     /* new-price method, same order */
  debtIndex: 0,      /* which row of the banker's schedule the slider is on */
  firmLDebt: 0,      /* Firm L's debt, in dollars */
};

/* ---------- question c: Firm U and Firm L ---------- */

function buildFirmRows(firm, taxRate) {
  const c = firm.columns;
  return [
    { values: ["Probability"].concat(firm.probabilities.map((p) => pct(p, 0))) },
    { values: ["Assets"].concat(c.map((x) => money(x.assets))) },
    { values: ["Equity (book)"].concat(c.map((x) => money(x.equity))) },
    { values: ["Sales"].concat(c.map((x) => money(x.sales))), className: "rule" },
    { values: ["Oper. costs"].concat(c.map((x) => moneyParen(x.operatingCosts))) },
    { values: ["EBIT"].concat(c.map((x) => money(x.ebit))), className: "sub-total" },
    { values: ["Interest"].concat(c.map((x) => moneyParen(x.interest))) },
    { values: ["EBT"].concat(c.map((x) => money(x.ebt))), className: "sub-total" },
    { values: ["Taxes (" + pct(taxRate, 0) + ")"].concat(c.map((x) => moneyParen(x.taxes))) },
    { values: ["Net income"].concat(c.map((x) => money(x.netIncome))), className: "sub-total" },
    { values: ["ROE"].concat(c.map((x) => pct(x.roe))), className: "rule" },
    { values: ["TIE"].concat(c.map((x) => mult(x.tie))) },
  ];
}

const FIRM_HEADERS = ["", "Bad year", "Average year", "Good year"];

/* Firm U never changes; only Firm L moves with its slider. */
function renderFirmU() {
  const { example, scenarios, taxRate } = state.data;
  const firmU = firmSeries({
    totalAssets: example.total_assets, debt: 0,
    interestRate: example.interest_rate, taxRate, scenarios,
  });
  buildTable($("firm-u-table"), FIRM_HEADERS, buildFirmRows(firmU, taxRate),
    { rowHeader: true });
  return firmU;
}

function renderFirmL() {
  const { example, scenarios, taxRate } = state.data;
  const debt = state.firmLDebt;
  const firmU = renderFirmU();
  const firmL = firmSeries({
    totalAssets: example.total_assets, debt,
    interestRate: example.interest_rate, taxRate, scenarios,
  });

  buildTable($("firm-l-table"), FIRM_HEADERS, buildFirmRows(firmL, taxRate),
    { rowHeader: true });

  $("firm-l-tag").textContent = debt === 0
    ? "no debt"
    : moneyText(debt) + " of " + pct(example.interest_rate, 0) + " debt";
  $("firm-l-readout").textContent = moneyText(debt)
    + " of debt · interest " + moneyText(example.interest_rate * debt)
    + " · book equity " + moneyText(example.total_assets - debt)
    + (debt === example.firm_l_debt ? " · the case's Firm L" : "");

  buildTable($("firm-stats-table"),
    ["", "Firm U (no debt)", "Firm L (" + (debt === 0 ? "no debt" : moneyText(debt) + " of debt") + ")"],
    [
      { values: ["Expected ROE", pct(firmU.expectedROE), pct(firmL.expectedROE)] },
      { values: ["σ(ROE)", pct(firmU.sigmaROE), pct(firmL.sigmaROE)] },
      { values: ["CV of ROE", mult(firmU.cvROE).replace("×", ""), mult(firmL.cvROE).replace("×", "")] },
      { values: ["ROE in the bad year", pct(firmU.columns[0].roe), pct(firmL.columns[0].roe)] },
      { values: ["Expected TIE", mult(firmU.expectedTIE), mult(firmL.expectedTIE)], className: "rule" },
      { values: ["σ(TIE)", mult(firmU.sigmaTIE), mult(firmL.sigmaTIE)] },
    ],
    { rowHeader: true });

  $("firm-stats-note").textContent =
    "Firm U has no interest to cover, so its TIE, E(TIE) and σ(TIE) are n/a "
    + "rather than numbers (the case's printed table shows 0× for σ(TIE)). "
    + "The case also prints σ(ROE) rounded to one decimal, "
    + pct(firmU.sigmaROE, 1) + " for Firm U; this page shows two decimals everywhere.";
}

function setUpFirmLSlider() {
  const { example } = state.data;
  const slider = $("firm-l-slider");
  slider.min = 0;
  slider.max = example.slider_max;
  slider.step = example.slider_step;
  slider.value = example.firm_l_debt;
  state.firmLDebt = example.firm_l_debt;

  $("firm-l-rate-note").textContent =
    "The rate is held at " + pct(example.interest_rate, 0) + " at every amount on "
    + "this slider, the case's rate for Firm L. So the slider shows what debt does "
    + "to Firm L's return and risk — not how lenders would respond to it. "
    + "(CDSS's slider below does the opposite: there the banker re-prices both debt "
    + "and equity at every amount.) ROE uses book equity = assets − debt, so "
    + "borrowing more shrinks the equity the same profit is measured against.";

  slider.addEventListener("input", () => {
    state.firmLDebt = Number(slider.value);
    renderFirmL();
  });
  $("firm-l-case").addEventListener("click", () => {
    slider.value = example.firm_l_debt;
    state.firmLDebt = example.firm_l_debt;
    renderFirmL();
  });
}

function renderExampleSetup() {
  const { example, taxRate } = state.data;
  $("example-setup").textContent =
    "Both firms have " + moneyText(example.total_assets) + " of assets and pay tax at "
    + pct(taxRate) + ". In the case, Firm L borrows " + moneyText(example.firm_l_debt)
    + " at " + pct(example.interest_rate, 0) + ", so its interest is "
    + moneyText(example.interest_rate * example.firm_l_debt) + " every year, "
    + "whatever EBIT turns out to be.";
}

/* ---------- question d: CDSS ---------- */

const CDSS_HEADERS = ["Debt", "r_d", "r_s", "Interest", "Net income",
  "Shares repurchased", "Shares remaining", "EPS", "Div./share", "TIE",
  "Share price", "WACC", "Mgmt stake"];

function mgmtText(mgmt) {
  if (mgmt.stake === null) return "would have to sell";
  return pct(mgmt.stake) + (mgmt.note ? " ⚠" : "");
}

function cdssRow(r, opts) {
  const values = [
    moneyText(r.debt) + (opts.isBestPrice ? " ★" : ""),
    r.costOfDebt === null ? { text: "—", na: true } : pct(r.costOfDebt),
    pct(r.costOfEquity),
    money(r.interest),
    money(r.netIncome),
    shares(r.sharesRepurchased),
    shares(r.sharesRemaining),
    cents(r.eps),
    cents(r.dividendsPerShare),
    mult(r.tie),
    cents(r.price),
    pct(r.wacc),
    mgmtText(r.management),
  ];
  const flags = [];
  if (r.management.stake === null) flags[12] = true;
  return { values, flags, className: opts.selected ? "highlight" : "" };
}

/* The panel beside the slider: one method, at the selected amount of debt. */
function renderPanel(tableId, noteId, r, waccLabel) {
  buildTable($(tableId), ["", "At " + moneyText(r.debt) + " of debt"], [
    { values: ["Share price", cents(r.price)], className: "sub-total" },
    { values: ["Shares repurchased", shares(r.sharesRepurchased)] },
    { values: ["Shares remaining", shares(r.sharesRemaining)] },
    { values: ["EPS", cents(r.eps)], className: "rule" },
    { values: ["Dividends per share", cents(r.dividendsPerShare)] },
    { values: ["TIE", mult(r.tie)] },
    { values: [waccLabel, pct(r.wacc)], className: "rule" },
    { values: ["Management's stake", mgmtText(r.management)] },
  ], { rowHeader: true });

  const note = $(noteId);
  if (r.management.warning) {
    note.textContent = r.management.warning;
    note.className = "note bad-note";
  } else if (r.management.note) {
    note.textContent = "Management's stake is " + pct(r.management.stake) + ". "
      + r.management.note;
    note.className = "note warn-note";
  } else {
    note.textContent = "Management keeps its "
      + shares(r.management.mgmtShares) + " shares and sells none, so its stake "
      + "rises as the share count falls.";
    note.className = "note";
  }
}

/* Redraw everything that depends on where the CDSS slider is. */
function renderCDSSAtIndex(index) {
  state.debtIndex = index;
  const caseRow = state.cdssRows[index];
  const newRow = state.newRows[index];
  const slider = $("cdss-slider");
  slider.value = index;

  $("cdss-readout").textContent = moneyText(caseRow.debt) + " of debt · r_d "
    + (caseRow.costOfDebt === null ? "—" : pct(caseRow.costOfDebt))
    + " · r_s " + pct(caseRow.costOfEquity);

  renderPanel("case-panel", "case-panel-note", caseRow, "WACC (book weights)");
  renderPanel("newprice-panel", "newprice-panel-note", newRow, "WACC (market weights)");

  /* highlight the selected row in the full tables */
  const bestCase = bestBy(state.cdssRows, "price");
  const bestNew = bestBy(state.newRows, "price");
  buildTable($("case-table"), CDSS_HEADERS, state.cdssRows.map((r, i) =>
    cdssRow(r, { selected: i === index, isBestPrice: r.debt === bestCase.debt })),
    { stack: true });
  buildTable($("newprice-table"), CDSS_HEADERS, state.newRows.map((r, i) =>
    cdssRow(r, { selected: i === index, isBestPrice: r.debt === bestNew.debt })),
    { stack: true });
  buildTable($("compare-table"),
    ["Debt", "Price: $20 buyback", "Price: new price", "Difference",
      "Shares remaining: $20", "Shares remaining: new price", "WACC: book", "WACC: market"],
    state.cdssRows.map((r, i) => ({
      values: [
        moneyText(r.debt), cents(r.price), cents(state.newRows[i].price),
        cents(r.price - state.newRows[i].price),
        shares(r.sharesRemaining), shares(state.newRows[i].sharesRemaining),
        pct(r.wacc), pct(state.newRows[i].wacc),
      ],
      className: i === index ? "highlight" : "",
    })), { stack: true });
}

function indexOfDebt(debt) {
  return state.data.schedule.findIndex((row) => row.debt === debt);
}

/* Both buttons work the same way: find the best amount under each method.
 * Same amount -> go there. Different amounts -> go to the CASE method's
 * amount (the case's own assumption) and say what the other method picked.
 * bestBy already breaks an exact tie toward the smaller amount of debt. */
function jumpToBest(key, label) {
  const a = bestBy(state.cdssRows, key);
  const b = bestBy(state.newRows, key);
  renderCDSSAtIndex(indexOfDebt(a.debt));
  const fmt = key === "price" ? cents : cents;
  const note = $("cdss-slider-note");
  if (a.debt === b.debt) {
    note.textContent = "Both buyback methods give their " + label + " at "
      + moneyText(a.debt) + " of debt (" + fmt(a[key]) + " with the $20 buyback, "
      + fmt(b[key]) + " at the new price).";
  } else {
    note.textContent = "The two methods disagree: the $20 buyback gives its "
      + label + " at " + moneyText(a.debt) + " (" + fmt(a[key]) + "), while buying "
      + "back at the new price gives its " + label + " at " + moneyText(b.debt)
      + " (" + fmt(b[key]) + "). The slider is on " + moneyText(a.debt)
      + ", the case method's amount.";
  }
}

function renderCDSS() {
  const { cdss, schedule, taxRate } = state.data;
  const ebit = cdssEBIT({
    sales: cdss.sales,
    variableCostRate: cdss.variable_cost_rate,
    fixedCosts: cdss.fixed_costs,
  });

  $("cdss-setup").textContent =
    "EBIT = sales × (1 − variable cost rate) − fixed costs = "
    + moneyText(cdss.sales) + " × (1 − " + group(cdss.variable_cost_rate, 2)
    + ") − " + moneyText(cdss.fixed_costs) + " = " + moneyText(ebit)
    + ". The case says EBIT stays constant, so it is the same at every amount of "
    + "debt. CDSS starts with " + group(cdss.shares_outstanding, 0) + " shares at "
    + centsText(cdss.share_price) + ", " + moneyText(cdss.total_assets)
    + " of book assets, no debt, a tax rate of " + pct(taxRate)
    + ", and management owning " + pct(cdss.management_share) + ". The slider stops "
    + "only at the banker's amounts, because those are the only amounts we have a "
    + "cost of debt and a cost of equity for.";

  const base = {
    ebit, taxRate,
    sharesBefore: cdss.shares_outstanding,
    priceBefore: cdss.share_price,
    totalAssets: cdss.total_assets,
    managementShare: cdss.management_share,
  };
  state.cdssRows = buildSchedule(cdssCaseMethod, schedule, base);
  state.newRows = buildSchedule(cdssNewPriceMethod, schedule, base);

  const slider = $("cdss-slider");
  slider.min = 0;
  slider.max = schedule.length - 1;
  slider.step = 1;
  slider.addEventListener("input", () => {
    $("cdss-slider-note").textContent = "";
    renderCDSSAtIndex(Number(slider.value));
  });
  $("btn-best-price").addEventListener("click",
    () => jumpToBest("price", "highest share price"));
  $("btn-best-eps").addEventListener("click",
    () => jumpToBest("eps", "highest EPS"));

  renderCDSSAtIndex(0);
  renderCDSSFindings();
  return { ebit };
}

function renderCDSSFindings() {
  const { cdss } = state.data;
  const caseRows = state.cdssRows;
  const newRows = state.newRows;

  function items(rows, waccLabel, extra) {
    const bestPrice = bestBy(rows, "price");
    const bestEPS = bestBy(rows, "eps");
    const lowWACC = lowestBy(rows, "wacc");
    const list = [
      { text: "Highest share price: " + centsText(bestPrice.price) + " at "
          + moneyText(bestPrice.debt) + " of debt." },
      { text: "Highest EPS: " + centsText(bestEPS.eps) + " at "
          + moneyText(bestEPS.debt) + " of debt." },
      { text: "Lowest WACC on " + waccLabel + ": " + pct(lowWACC.wacc) + " at "
          + moneyText(lowWACC.debt) + " of debt." },
      bestPrice.debt === lowWACC.debt
        ? { text: extra.agree(bestPrice) }
        : { kind: "warn", text: "The highest price (" + moneyText(bestPrice.debt)
            + ") and the lowest WACC on " + waccLabel + " (" + moneyText(lowWACC.debt)
            + ") are at different amounts of debt, so they disagree here." },
    ];
    rows.forEach((r) => {
      if (r.management.note) {
        list.push({ kind: "warn", text: "At " + moneyText(r.debt) + " of debt, "
          + "management's stake reaches " + pct(r.management.stake) + ": "
          + r.management.note });
      }
      if (r.management.warning) {
        list.push({ kind: "bad", text: "At " + moneyText(r.debt) + " of debt: "
          + r.management.warning });
      }
    });
    return list;
  }

  findings($("case-findings"), items(caseRows, "book weights", {
    agree: (b) => "The highest price and the lowest book-weight WACC are at the "
      + "same amount of debt, " + moneyText(b.debt) + ".",
  }).concat([
    { text: "EPS keeps climbing past the price-maximizing amount, because EPS "
      + "ignores the risk that r_s is charging for — that is question d(6)." },
  ]));

  findings($("newprice-findings"), items(newRows, "market weights", {
    agree: (b) => "Buying back at the new price puts the highest share price and "
      + "the lowest market-weight WACC at the same amount of debt, "
      + moneyText(b.debt) + " — the point the AGE solution's own note makes "
      + "(firm value V = " + moneyText(b.firmValue) + ", equity S = "
      + moneyText(b.equityValue) + ").",
  }));

  const rounded = caseRows.filter((r) =>
    roundHalfUp(r.price, 2) !== roundHalfUp(r.priceFromRoundedEPS, 2));
  $("case-rounding-note").textContent = rounded.length === 0
    ? "Prices here divide the unrounded EPS by r_s, which matches the AGE "
      + "solution at every amount on this schedule."
    : "Prices here divide the unrounded EPS by r_s. The AGE solution rounds EPS "
      + "to the cent first, which gives "
      + rounded.map((r) => centsText(r.priceFromRoundedEPS) + " at " + moneyText(r.debt)).join(" and ")
      + " instead. Both are right; the difference is only when you round.";

  $("compare-note").textContent =
    "The $20 buyback shows a higher price at every amount of debt because the "
    + "shareholders who sell are paid " + centsText(cdss.share_price) + " even though "
    + "the shares are already worth more once the recapitalization is announced. "
    + "The value that those sellers give up lands on the shares that stay "
    + "outstanding. Under the new-price method nobody gains at anybody else's "
    + "expense, which is why it is the method whose WACC minimum and price "
    + "maximum line up.";
}

/* ---------- checks ---------- */

function renderChecks() {
  const { cdss } = state.data;
  const caseRows = state.cdssRows;
  const newRows = state.newRows;
  const items = [];

  const zero = caseRows.find((r) => r.debt === 0);
  if (zero) {
    const priceOK = Math.abs(zero.price - cdss.share_price) < 0.005;
    items.push({
      kind: priceOK ? "ok" : "bad",
      text: (priceOK ? "Passes: " : "FAILS: ")
        + "with no debt, EPS / r_s = " + centsText(zero.eps) + " / " + pct(zero.costOfEquity)
        + " = " + centsText(zero.price) + ", against the " + centsText(cdss.share_price)
        + " in data/cdss.csv.",
    });
  }

  const epsBad = newRows.filter((r) => Math.abs(r.eps - r.epsCheck) > 1e-9);
  items.push({
    kind: epsBad.length === 0 ? "ok" : "bad",
    text: epsBad.length === 0
      ? "Passes: under the new-price method EPS equals r_s × price at every "
        + "amount of debt, so the buyback price and the share count agree."
      : "FAILS: EPS does not equal r_s × price at " + epsBad.length + " debt level(s).",
  });

  const waccBad = newRows.filter((r) => Math.abs(r.wacc - r.waccCheck) > 1e-9);
  items.push({
    kind: waccBad.length === 0 ? "ok" : "bad",
    text: waccBad.length === 0
      ? "Passes: the market-weight WACC equals EBIT × (1 − T) / V at every "
        + "amount of debt."
      : "FAILS: the market-weight WACC does not equal EBIT × (1 − T) / V at "
        + waccBad.length + " debt level(s).",
  });

  const roundOK = roundHalfUp(14.025, 2) === 14.03 && roundHalfUp(3.495, 2) === 3.5;
  items.push({
    kind: roundOK ? "ok" : "bad",
    text: (roundOK ? "Passes: " : "FAILS: ")
      + "rounding is half up on the decimal value, so 14.025% shows as 14.03% and "
      + "$3.495 shows as $3.50 (JavaScript's toFixed gets both of those wrong).",
  });

  findings($("check-list"), items);
}

/* ---------- start ---------- */

async function main() {
  const status = $("status");
  try {
    state.data = await load();
    renderExampleSetup();
    setUpFirmLSlider();
    renderFirmL();
    renderCDSS();
    renderChecks();
    status.hidden = true;
  } catch (err) {
    status.hidden = true;
    alert_("Could not read the data files: " + err.message
      + ". The page has to be served over http(s) — opening index.html straight "
      + "from the file system blocks fetch. Use the published GitHub Pages address.");
    throw err;
  }
}

document.addEventListener("DOMContentLoaded", main);

/* ---------- make it installable and able to open offline ---------- */

/* The service worker (sw.js) keeps a copy of the page and the CSVs, so the
 * app opens without a connection. "sw.js" is relative, so it resolves under
 * https://<username>.github.io/<repository>/ as well as on a local server.
 * Registering after load keeps it from competing with the first paint. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      /* Not fatal: without it the app still works, just not offline. */
      console.warn("Service worker did not register:", err.message);
    });
  });
}
