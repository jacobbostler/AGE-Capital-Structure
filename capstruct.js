/* capstruct.js — the finance math for the AGE capital structure lab.
 *
 * Every function here is a plain function: it takes numbers in and gives
 * numbers back, and it never touches the web page. That way the same code
 * runs in the browser and under Node, so the numbers can be checked with
 * `node -e "..."` before anything is pushed.
 */

/* ---------- rounding and parsing helpers ---------- */

/* Round half up on the DECIMAL value of x, to d decimal places.
 * JavaScript's toFixed rounds the binary value, which gets some of this
 * lab's numbers wrong: 0.14025 (the book-weight WACC at $500,000) must
 * show as 14.03%, and 3.495 (the new-price EPS at $500,000) must show as
 * $3.50. toPrecision(12) first drops the tiny binary error, so
 * Math.round then rounds the number a person would see. */
function roundHalfUp(x, d) {
  if (!isFinite(x)) return x;
  const f = Math.pow(10, d);
  return Math.round(Number((x * f).toPrecision(12))) / f;
}

/* Turn CSV text into an array of plain objects, one per row.
 * Empty cells (like the $0 row's cost of debt) come back as null. */
function parseCSV(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => {
      const cell = (cells[i] === undefined ? "" : cells[i]).trim();
      row[h] = cell === "" ? null : cell;
    });
    return row;
  });
}

/* A CSV cell as a number, or null when the cell is empty. */
function num(cell) {
  if (cell === null || cell === undefined || cell === "") return null;
  const v = Number(String(cell).replace(/[$,%\s]/g, ""));
  return isFinite(v) ? v : null;
}

/* ---------- probability statistics ---------- */

/* Expected value: the probability-weighted average. */
function expectedValue(probs, values) {
  return probs.reduce((sum, p, i) => sum + p * values[i], 0);
}

/* Standard deviation: the square root of the probability-weighted
 * squared deviations from the expected value. */
function stdDev(probs, values) {
  const mean = expectedValue(probs, values);
  const variance = probs.reduce(
    (sum, p, i) => sum + p * Math.pow(values[i] - mean, 2), 0);
  return Math.sqrt(variance);
}

/* Coefficient of variation: risk per unit of expected return. */
function coefficientOfVariation(probs, values) {
  const mean = expectedValue(probs, values);
  if (mean === 0) return null;
  return stdDev(probs, values) / mean;
}

/* ---------- Firm U and Firm L (question c) ---------- */

/* One column of a firm's income statement, for one EBIT scenario.
 * debt = 0 makes this Firm U. ROE uses BOOK equity = assets - debt. */
function firmScenario(opts) {
  const { totalAssets, debt, interestRate, taxRate, sales, operatingCosts } = opts;
  const ebit = sales - operatingCosts;
  const interest = interestRate * debt;
  const ebt = ebit - interest;
  const taxes = taxRate * ebt;
  const netIncome = ebt - taxes;
  const equity = totalAssets - debt;
  return {
    sales, operatingCosts, ebit, interest, ebt, taxes, netIncome,
    assets: totalAssets,
    equity,
    roe: equity === 0 ? null : netIncome / equity,
    /* No debt means no interest, so TIE has no meaning: show "n/a". */
    tie: interest === 0 ? null : ebit / interest,
  };
}

/* A whole firm: one column per scenario, plus the summary statistics. */
function firmSeries(opts) {
  const { scenarios } = opts;
  const probs = scenarios.map((s) => s.probability);
  const columns = scenarios.map((s) => firmScenario(Object.assign({}, opts, {
    sales: s.sales, operatingCosts: s.operatingCosts,
  })));
  const roes = columns.map((c) => c.roe);
  const ties = columns.map((c) => c.tie);
  const leveraged = columns.some((c) => c.tie !== null);
  return {
    columns,
    probabilities: probs,
    expectedROE: expectedValue(probs, roes),
    sigmaROE: stdDev(probs, roes),
    cvROE: coefficientOfVariation(probs, roes),
    /* n/a for an all-equity firm rather than a number. */
    expectedTIE: leveraged ? expectedValue(probs, ties) : null,
    sigmaTIE: leveraged ? stdDev(probs, ties) : null,
    cvTIE: leveraged ? coefficientOfVariation(probs, ties) : null,
  };
}

/* ---------- CDSS ---------- */

/* EBIT = sales x (1 - variable cost rate) - fixed costs.
 * The case says EBIT is constant, so it is the same at every debt level. */
function cdssEBIT(opts) {
  const { sales, variableCostRate, fixedCosts } = opts;
  return sales * (1 - variableCostRate) - fixedCosts;
}

/* Management's stake after the buyback. Management does not sell, so it
 * keeps mgmtShare x n shares while the share count shrinks. */
function managementStake(opts) {
  const { managementShare, sharesBefore, sharesRemaining } = opts;
  const mgmtShares = managementShare * sharesBefore;
  const outsideShares = sharesBefore - mgmtShares;
  const repurchased = sharesBefore - sharesRemaining;
  const result = { mgmtShares, outsideShares, stake: mgmtShares / sharesRemaining };
  if (repurchased > outsideShares + 1e-6) {
    result.stake = null;
    result.warning = "Impossible: the buyback needs more shares than outside "
      + "investors own, so management would have to sell some of its own.";
  } else if (Math.abs(repurchased - outsideShares) <= 1e-6) {
    result.note = "No outside shareholders would be left — management would "
      + "own the whole firm.";
  }
  return result;
}

/* CASE METHOD (question d(3) and d(4)): shares are bought back at today's
 * $20 price. Price afterwards = EPS / r_s, because CDSS pays out all its
 * earnings (dividends per share = EPS) and so g = 0. */
function cdssCaseMethod(opts) {
  const { ebit, taxRate, debt, costOfDebt, costOfEquity, sharesBefore,
    priceBefore, totalAssets, managementShare } = opts;
  const rd = costOfDebt === null || costOfDebt === undefined ? 0 : costOfDebt;
  const interest = rd * debt;
  const netIncome = (ebit - interest) * (1 - taxRate);
  const sharesRepurchased = debt / priceBefore;
  const sharesRemaining = sharesBefore - sharesRepurchased;
  const eps = netIncome / sharesRemaining;
  const price = eps / costOfEquity;
  /* WACC on BOOK weights — the AGE solution's method for d(7). */
  const wacc = (debt / totalAssets) * rd * (1 - taxRate)
    + ((totalAssets - debt) / totalAssets) * costOfEquity;
  return {
    debt, costOfDebt: costOfDebt === null ? null : rd, costOfEquity,
    interest, netIncome, sharesRepurchased, sharesRemaining,
    eps,
    dividendsPerShare: eps, /* all earnings are paid out */
    tie: interest === 0 ? null : ebit / interest,
    price,
    /* The AGE solution rounds EPS to the cent before dividing by r_s, which
     * moves the price a few cents at some debt levels. Kept separately so
     * the page can show both without rounding anything along the way. */
    priceFromRoundedEPS: roundHalfUp(eps, 2) / costOfEquity,
    wacc,
    equityValue: sharesRemaining * price,
    firmValue: sharesRemaining * price + debt,
    management: managementStake({ managementShare, sharesBefore, sharesRemaining }),
  };
}

/* NEW-PRICE METHOD: shares are bought back at the price that holds after
 * the announcement. Value the equity first (S = net income / r_s), add the
 * debt to get the whole firm (V = S + D), and divide by the ORIGINAL share
 * count for the price every shareholder sees once the plan is known. */
function cdssNewPriceMethod(opts) {
  const { ebit, taxRate, debt, costOfDebt, costOfEquity, sharesBefore,
    managementShare } = opts;
  const rd = costOfDebt === null || costOfDebt === undefined ? 0 : costOfDebt;
  const interest = rd * debt;
  const netIncome = (ebit - interest) * (1 - taxRate);
  const equityValue = netIncome / costOfEquity;      /* S */
  const firmValue = equityValue + debt;              /* V */
  const price = firmValue / sharesBefore;            /* P */
  const sharesRepurchased = debt / price;
  const sharesRemaining = sharesBefore - sharesRepurchased;
  const eps = netIncome / sharesRemaining;
  /* WACC on MARKET weights. */
  const wacc = (debt / firmValue) * rd * (1 - taxRate)
    + (equityValue / firmValue) * costOfEquity;
  return {
    debt, costOfDebt: costOfDebt === null ? null : rd, costOfEquity,
    interest, netIncome, equityValue, firmValue,
    sharesRepurchased, sharesRemaining,
    eps,
    dividendsPerShare: eps,
    tie: interest === 0 ? null : ebit / interest,
    price,
    wacc,
    /* Two identities that must hold; the page shows them as checks. */
    epsCheck: costOfEquity * price,
    waccCheck: ebit * (1 - taxRate) / firmValue,
    management: managementStake({ managementShare, sharesBefore, sharesRemaining }),
  };
}

/* Run a whole banker's schedule through one method. */
function buildSchedule(method, schedule, base) {
  return schedule.map((row) => method(Object.assign({}, base, {
    debt: row.debt, costOfDebt: row.cost_of_debt, costOfEquity: row.cost_of_equity,
  })));
}

/* The row with the largest value of `key`. Ties go to the SMALLER debt. */
function bestBy(rows, key) {
  let best = null;
  rows.forEach((r) => {
    const v = r[key];
    if (v === null || v === undefined || !isFinite(v)) return;
    if (best === null || v > best[key] + 1e-9
      || (Math.abs(v - best[key]) <= 1e-9 && r.debt < best.debt)) best = r;
  });
  return best;
}

/* The row with the smallest value of `key`. Ties go to the SMALLER debt. */
function lowestBy(rows, key) {
  let best = null;
  rows.forEach((r) => {
    const v = r[key];
    if (v === null || v === undefined || !isFinite(v)) return;
    if (best === null || v < best[key] - 1e-9
      || (Math.abs(v - best[key]) <= 1e-9 && r.debt < best.debt)) best = r;
  });
  return best;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    roundHalfUp, parseCSV, num,
    expectedValue, stdDev, coefficientOfVariation,
    firmScenario, firmSeries,
    cdssEBIT, managementStake, cdssCaseMethod, cdssNewPriceMethod,
    buildSchedule, bestBy, lowestBy,
  };
}
