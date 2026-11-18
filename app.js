/* app.js — reads the CSV files in data/, asks capstruct.js for the numbers,
 * and puts them on the page. All the finance math lives in capstruct.js;
 * this file only fetches, formats and renders.
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

/* ---------- tiny DOM helpers ---------- */

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
 * `opts.stack` turns each row into a card on a phone.
 * `opts.rowHeader` makes the first cell of every row a <th>. */
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
  const box = document.getElementById("alerts");
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

/* Rows of item,value into a plain object of numbers. */
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

/* ---------- question c: Firm U and Firm L ---------- */

function renderExampleFirms(data) {
  const { example, scenarios, taxRate } = data;
  const firmU = firmSeries({
    totalAssets: example.total_assets, debt: 0,
    interestRate: example.interest_rate, taxRate, scenarios,
  });
  const firmL = firmSeries({
    totalAssets: example.total_assets, debt: example.firm_l_debt,
    interestRate: example.interest_rate, taxRate, scenarios,
  });

  document.getElementById("example-setup").textContent =
    "Both firms have " + money(example.total_assets) + " of assets and pay tax at "
    + pct(taxRate) + ". Firm L borrows " + money(example.firm_l_debt) + " at "
    + pct(example.interest_rate) + ", so its interest is "
    + money(example.interest_rate * example.firm_l_debt) + " every year, "
    + "whatever EBIT turns out to be.";
  document.getElementById("firm-l-tag").textContent =
    money(example.firm_l_debt) + " of " + pct(example.interest_rate, 0) + " debt";

  const taxLabel = "Taxes (" + pct(taxRate, 0) + ")";
  function firmRows(firm) {
    const c = firm.columns;
    const head = ["", "Bad year", "Average year", "Good year"];
    const rows = [
      { values: ["Probability"].concat(firm.probabilities.map((p) => pct(p, 0))) },
      { values: ["Assets"].concat(c.map((x) => money(x.assets))) },
      { values: ["Equity (book)"].concat(c.map((x) => money(x.equity))) },
      { values: ["Sales"].concat(c.map((x) => money(x.sales))), className: "rule" },
      { values: ["Oper. costs"].concat(c.map((x) => moneyParen(x.operatingCosts))) },
      { values: ["EBIT"].concat(c.map((x) => money(x.ebit))), className: "sub-total" },
      { values: ["Interest"].concat(c.map((x) => moneyParen(x.interest))) },
      { values: ["EBT"].concat(c.map((x) => money(x.ebt))), className: "sub-total" },
      { values: [taxLabel].concat(c.map((x) => moneyParen(x.taxes))) },
      { values: ["Net income"].concat(c.map((x) => money(x.netIncome))), className: "sub-total" },
      { values: ["ROE"].concat(c.map((x) => pct(x.roe))), className: "rule" },
      { values: ["TIE"].concat(c.map((x) => mult(x.tie))) },
    ];
    return { head, rows };
  }

  const u = firmRows(firmU);
  buildTable(document.getElementById("firm-u-table"), u.head, u.rows, { rowHeader: true });
  const l = firmRows(firmL);
  buildTable(document.getElementById("firm-l-table"), l.head, l.rows, { rowHeader: true });

  buildTable(
    document.getElementById("firm-stats-table"),
    ["", "Firm U (no debt)", "Firm L (half debt)"],
    [
      { values: ["Expected ROE", pct(firmU.expectedROE), pct(firmL.expectedROE)] },
      { values: ["σ(ROE)", pct(firmU.sigmaROE), pct(firmL.sigmaROE)] },
      { values: ["CV of ROE", mult(firmU.cvROE).replace("×", ""), mult(firmL.cvROE).replace("×", "")] },
      { values: ["ROE in the bad year", pct(firmU.columns[0].roe), pct(firmL.columns[0].roe)] },
      { values: ["Expected TIE", mult(firmU.expectedTIE), mult(firmL.expectedTIE)], className: "rule" },
      { values: ["σ(TIE)", mult(firmU.sigmaTIE), mult(firmL.sigmaTIE)] },
    ],
    { rowHeader: true }
  );

  document.getElementById("firm-stats-note").textContent =
    "Firm U has no interest to cover, so its TIE, E(TIE) and σ(TIE) are n/a "
    + "rather than numbers (the case's printed table shows 0× for σ(TIE)). "
    + "The case also prints σ(ROE) rounded to one decimal, "
    + pct(firmU.sigmaROE, 1) + " for Firm U; this page shows two decimals everywhere.";

  return { firmU, firmL };
}

/* ---------- question d: CDSS ---------- */

const CDSS_HEADERS = ["Debt", "r_d", "r_s", "Interest", "Net income",
  "Shares repurchased", "Shares remaining", "EPS", "Div./share", "TIE",
  "Share price", "WACC", "Mgmt stake"];

function cdssRow(r, best) {
  const mgmt = r.management;
  const mgmtText = mgmt.stake === null
    ? "would have to sell"
    : pct(mgmt.stake) + (mgmt.note ? " ⚠" : "");
  const values = [
    money(r.debt),
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
    mgmtText,
  ];
  const flags = [];
  if (mgmt.stake === null) flags[12] = true;
  return {
    values, flags,
    className: best && r.debt === best.debt ? "highlight" : "",
  };
}

function renderCDSS(data) {
  const { cdss, schedule, taxRate } = data;
  const ebit = cdssEBIT({
    sales: cdss.sales,
    variableCostRate: cdss.variable_cost_rate,
    fixedCosts: cdss.fixed_costs,
  });

  document.getElementById("cdss-setup").textContent =
    "EBIT = sales × (1 − variable cost rate) − fixed costs = "
    + money(cdss.sales) + " × (1 − " + group(cdss.variable_cost_rate, 2) + ") − "
    + money(cdss.fixed_costs) + " = " + money(ebit) + ". The case says EBIT stays "
    + "constant, so it is the same at every amount of debt. CDSS starts with "
    + group(cdss.shares_outstanding, 0) + " shares at " + cents(cdss.share_price)
    + ", " + money(cdss.total_assets) + " of book assets, no debt, a tax rate of "
    + pct(taxRate) + ", and management owning " + pct(cdss.management_share) + ".";

  const base = {
    ebit, taxRate,
    sharesBefore: cdss.shares_outstanding,
    priceBefore: cdss.share_price,
    totalAssets: cdss.total_assets,
    managementShare: cdss.management_share,
  };
  const caseRows = buildSchedule(cdssCaseMethod, schedule, base);
  const newRows = buildSchedule(cdssNewPriceMethod, schedule, base);

  /* --- case method table --- */
  const caseBestPrice = bestBy(caseRows, "price");
  const caseBestEPS = bestBy(caseRows, "eps");
  const caseLowWACC = lowestBy(caseRows, "wacc");
  buildTable(document.getElementById("case-table"), CDSS_HEADERS,
    caseRows.map((r) => cdssRow(r, caseBestPrice)), { stack: true });

  const rounded = caseRows.filter((r) =>
    roundHalfUp(r.price, 2) !== roundHalfUp(r.priceFromRoundedEPS, 2));
  document.getElementById("case-rounding-note").textContent =
    "Prices here divide the unrounded EPS by r_s. The AGE solution rounds EPS "
    + "to the cent first, which gives "
    + rounded.map((r) => cents(r.priceFromRoundedEPS) + " at " + money(r.debt)).join(" and ")
    + " instead. Both are right; the difference is only when you round.";

  const caseItems = [
    { text: "Highest share price: " + cents(caseBestPrice.price) + " at "
        + money(caseBestPrice.debt) + " of debt." },
    { text: "Highest EPS: " + cents(caseBestEPS.eps) + " at " + money(caseBestEPS.debt)
        + " of debt — EPS keeps climbing past the price-maximizing amount, "
        + "because EPS ignores the risk that r_s is charging for." },
    { text: "Lowest WACC on book weights: " + pct(caseLowWACC.wacc) + " at "
        + money(caseLowWACC.debt) + " of debt." },
    caseBestPrice.debt === caseLowWACC.debt
      ? { text: "The highest price and the lowest book-weight WACC are at the same "
          + "amount of debt, " + money(caseBestPrice.debt) + "." }
      : { kind: "warn", text: "The highest price (" + money(caseBestPrice.debt)
          + ") and the lowest book-weight WACC (" + money(caseLowWACC.debt)
          + ") are at different amounts of debt, so they disagree here." },
  ];
  caseRows.forEach((r) => {
    if (r.management.note) {
      caseItems.push({ kind: "warn", text: "At " + money(r.debt) + " of debt, "
        + "management's stake reaches " + pct(r.management.stake) + ": "
        + r.management.note });
    }
    if (r.management.warning) {
      caseItems.push({ kind: "bad", text: "At " + money(r.debt) + " of debt: "
        + r.management.warning });
    }
  });
  findings(document.getElementById("case-findings"), caseItems);

  /* --- new-price method table --- */
  const newBestPrice = bestBy(newRows, "price");
  const newBestEPS = bestBy(newRows, "eps");
  const newLowWACC = lowestBy(newRows, "wacc");
  buildTable(document.getElementById("newprice-table"), CDSS_HEADERS,
    newRows.map((r) => cdssRow(r, newBestPrice)), { stack: true });

  const newItems = [
    { text: "Highest share price: " + cents(newBestPrice.price) + " at "
        + money(newBestPrice.debt) + " of debt (firm value V = "
        + money(newBestPrice.firmValue) + ", equity S = " + money(newBestPrice.equityValue) + ")." },
    { text: "Highest EPS: " + cents(newBestEPS.eps) + " at " + money(newBestEPS.debt) + " of debt." },
    { text: "Lowest WACC on market weights: " + pct(newLowWACC.wacc) + " at "
        + money(newLowWACC.debt) + " of debt." },
    newBestPrice.debt === newLowWACC.debt
      ? { text: "Buying back at the new price puts the highest share price and the "
          + "lowest market-weight WACC at the same amount of debt, "
          + money(newBestPrice.debt) + " — the point the AGE solution's own note makes." }
      : { kind: "warn", text: "The highest price (" + money(newBestPrice.debt)
          + ") and the lowest market-weight WACC (" + money(newLowWACC.debt)
          + ") are at different amounts of debt." },
  ];
  newRows.forEach((r) => {
    if (r.management.note) {
      newItems.push({ kind: "warn", text: "At " + money(r.debt) + " of debt, "
        + "management's stake reaches " + pct(r.management.stake) + ": " + r.management.note });
    }
    if (r.management.warning) {
      newItems.push({ kind: "bad", text: "At " + money(r.debt) + " of debt: "
        + r.management.warning });
    }
  });
  findings(document.getElementById("newprice-findings"), newItems);

  /* --- side by side --- */
  buildTable(document.getElementById("compare-table"),
    ["Debt", "Price: $20 buyback", "Price: new price", "Difference",
      "Shares remaining: $20", "Shares remaining: new price", "WACC: book", "WACC: market"],
    caseRows.map((r, i) => ({
      values: [
        money(r.debt), cents(r.price), cents(newRows[i].price),
        cents(r.price - newRows[i].price),
        shares(r.sharesRemaining), shares(newRows[i].sharesRemaining),
        pct(r.wacc), pct(newRows[i].wacc),
      ],
      className: r.debt === caseBestPrice.debt ? "highlight" : "",
    })), { stack: true });

  document.getElementById("compare-note").textContent =
    "The $20 buyback shows a higher price at every amount of debt because the "
    + "shareholders who sell are paid " + cents(cdss.share_price) + " even though "
    + "the shares are already worth more once the recapitalization is announced. "
    + "The value that those sellers give up lands on the shares that stay "
    + "outstanding. Under the new-price method nobody gains at anybody else's "
    + "expense, which is why it is the method whose WACC minimum and price "
    + "maximum line up.";

  return { ebit, caseRows, newRows, base };
}

/* ---------- checks ---------- */

function renderChecks(data, cdssResult) {
  const { cdss } = data;
  const { caseRows, newRows } = cdssResult;
  const items = [];

  const zero = caseRows.find((r) => r.debt === 0);
  const priceOK = Math.abs(zero.price - cdss.share_price) < 0.005;
  items.push({
    kind: priceOK ? "ok" : "bad",
    text: (priceOK ? "Passes: " : "FAILS: ")
      + "with no debt, EPS / r_s = " + cents(zero.eps) + " / " + pct(zero.costOfEquity)
      + " = " + cents(zero.price) + ", against the " + cents(cdss.share_price)
      + " in data/cdss.csv.",
  });

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

  findings(document.getElementById("check-list"), items);
}

/* ---------- start ---------- */

async function main() {
  const status = document.getElementById("status");
  try {
    const data = await load();
    renderExampleFirms(data);
    const cdssResult = renderCDSS(data);
    renderChecks(data, cdssResult);
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
