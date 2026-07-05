// Node unit tests for the data layer + What-if engine.
// Run:  node tests/engine.test.js
// Extracts the engine from src/App.jsx (single source of truth) and asserts BRD-anchored invariants.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
const a = src.indexOf("const BRD =");
const b = src.indexOf("const I18N =");
if (a < 0 || b < 0) { console.error("Could not locate engine block in App.jsx"); process.exit(1); }
const engine = src.slice(a, b);

let pass = 0, fail = 0;
function approx(x, lo, hi, msg) {
  const ok = x >= lo && x <= hi;
  console.log((ok ? "✓" : "✗") + " " + msg + "  (" + (Math.round(x * 1000) / 1000) + " ∈ [" + lo + "," + hi + "])");
  ok ? pass++ : fail++;
}

const harness = `
  var R = {};
  R.avg = BASELINE.avgPerContract;
  R.fgBase = BASELINE.FG;
  R.hbrBase = BASELINE.HBR;
  R.cShareSum = BASELINE.rows.reduce((s,r)=>s+r.cShare,0);
  R.popSum = BANDS.reduce((s,b)=>s+b.popShare,0);
  R.aboveShare = BASELINE.rows.filter(r=>!r.below).reduce((s,r)=>s+r.cShare,0);
  R.regionSum = REGIONS.reduce((s,r)=>s+r.w,0);
  R.recoSavings = scenarioSavings(computeAllocation({reallocatePct:0.20,capHighPct:0.25,boostLowPct:0.08,offPlanPct:0.10})).phase;
  R.recoFG = computeAllocation({reallocatePct:0.20,capHighPct:0.25,boostLowPct:0.08,offPlanPct:0.10}).FG;
  R.fairFG = computeAllocation({reallocatePct:0.30,capHighPct:0.20,boostLowPct:0.15}).FG;
  R.lowHBR = computeAllocation({boostLowPct:0.45,capHighPct:0.10}).HBR;
  R.maxSavings = scenarioSavings(computeAllocation({reallocatePct:0.30,capHighPct:0.35,offPlanPct:0.20})).phase;
  return R;
`;
const results = eval("(function(){ " + engine + "\n" + harness + " })()");

approx(results.avg, 17000, 20000, "baseline avg support/contract in phase-3 frame");
approx(results.fgBase, 0.50, 0.80, "baseline Fairness Gap < 1.0");
approx(results.hbrBase, 0.40, 0.41, "baseline HBR ≈ 40-41%");
approx(results.cShareSum, 0.999, 1.001, "contract shares sum to 1");
approx(results.popSum, 0.999, 1.001, "population shares sum to 1");
approx(results.aboveShare, 0.635, 0.645, "~64% of contracts to >10k");
approx(results.regionSum, 0.999, 1.001, "region weights sum to 1");
approx(results.recoSavings, 1.6e9, 2.6e9, "recommended scenario savings (~2.1B)");
approx(results.recoFG, 0.95, 1.05, "recommended scenario is win-win: FG at/near target (>=0.95)");
approx(results.fairFG, 1.0, 1.2, "fairness scenario reaches FG >= 1.0");
approx(results.lowHBR, 0.32, 0.36, "burden scenario brings HBR toward 30-35%");
approx(results.maxSavings, 3.0e9, 3.7e9, "max scenario savings near BRD ceiling (~3.4B)");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
