import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";
import * as RC from "recharts";

/* =========================================================================
   DATA LAYER  — all figures anchored to BRD V0.5.1 and internally consistent.
   See README.md for the rigor notes / sources.
   ========================================================================= */
const BRD = {
  eligibleFamilies: 1400000,          // >1.4M families passed eligibility
  baseline: { contracts:127952, spendSAR:18098000000, avgPerContract:141444 }, // 2024–2025/07
  phase3BudgetSAR: 7900000000,        // ~7.9B over 5y
  phase3Years: 5,
  targetContractsTotal: 510000,       // 2026–2030
  targetBreakdown: { redf:310000, zatca:150000, devHousing:50000 },
  hbrBaseline: 0.405,                 // 40–41%
  hbrTarget2030: 0.325,               // 30–35%
  ownershipNow: 0.6624, ownershipTarget: 0.70,
  fairnessThreshold: 1.0,
};
const ANNUAL_CONTRACTS = Math.round(BRD.targetContractsTotal / BRD.phase3Years); // 102000

// Income bands. NOTE: this engine works in the PHASE-3 FLEXIBLE-BUDGET frame
// (7.9B / 510k contracts ⇒ avg support ≈ 15.5k/contract). The historical 141,444/contract
// (18.098B / 127,952) is a *different basis* (total support incl. package/loan) and is shown
// only as a historical context card — never mixed into the optimization math.
// Calibration targets: ~64% of contracts to >10k · weighted avg support ≈ 17.4k · FG_base ≈ 0.70 · HBR_base ≈ 0.405.
// Above-10k bands are deliberately OVER-subsidised (BRD pain point: budget diverted to the less needy),
// so rationalising/reallocating them yields genuine savings.
// Two support instruments per BRD (kept as separate, documented sub-models):
//   subsidyBase – the FLEXIBLE-budget line (drives spend / savings / fairness), avg ≈ 17.4k
//   pkgBase     – the PACKAGE / effective buy-down support (drives HBR), avg ≈ 130k
// >10k bands are over-served on both instruments (BRD pain point).
const BANDS = [
  { id:"b1", key:"lt5",    below:true,  incomeAvg:4200,  popShare:0.15, cShareBase:0.08, subsidyBase:15000, pkgBase:95000,  homePrice:470000 },
  { id:"b2", key:"5to8",   below:true,  incomeAvg:6600,  popShare:0.20, cShareBase:0.14, subsidyBase:15800, pkgBase:105000, homePrice:560000 },
  { id:"b3", key:"8to10",  below:true,  incomeAvg:9000,  popShare:0.18, cShareBase:0.14, subsidyBase:16500, pkgBase:115000, homePrice:650000 },
  { id:"b4", key:"10to13", below:false, incomeAvg:11500, popShare:0.20, cShareBase:0.26, subsidyBase:18800, pkgBase:150000, homePrice:790000 },
  { id:"b5", key:"13to16", below:false, incomeAvg:14500, popShare:0.15, cShareBase:0.22, subsidyBase:20500, pkgBase:160000, homePrice:930000 },
  { id:"b6", key:"gt16",   below:false, incomeAvg:18500, popShare:0.12, cShareBase:0.16, subsidyBase:22500, pkgBase:170000, homePrice:1180000 },
];
// HBR (mortgage-burden) model: monthly payment on (price − downpayment − package buy-down) / income.
const MORT = { rate:0.073/12, n:300, down:0.10 };   // 7.3% APR, 25y, 10% down (calibrated to HBR_base≈40.5%)
const HBR_LEV = { boost:2.5, cap:0.6 };             // leverage of boost/cap on package support
function monthlyPayment(P, rate, nper){ const r=rate||MORT.rate, np=nper||MORT.n; return P<=0?0:P*r/(1-Math.pow(1+r,-np)); }

// 13 administrative regions of Saudi Arabia (eligible-base weights sum to 1; FG varies by region).
const REGIONS = [
  { key:"riyadh",   w:0.255, priceIdx:1.18, fg:0.74 },
  { key:"makkah",   w:0.210, priceIdx:1.22, fg:0.69 },
  { key:"eastern",  w:0.155, priceIdx:1.10, fg:0.81 },
  { key:"madinah",  w:0.075, priceIdx:1.02, fg:0.88 },
  { key:"asir",     w:0.058, priceIdx:0.90, fg:1.04 },
  { key:"qassim",   w:0.045, priceIdx:0.94, fg:0.97 },
  { key:"tabuk",    w:0.030, priceIdx:0.88, fg:1.08 },
  { key:"hail",     w:0.026, priceIdx:0.86, fg:1.11 },
  { key:"jazan",    w:0.043, priceIdx:0.84, fg:1.06 },
  { key:"najran",   w:0.020, priceIdx:0.85, fg:1.09 },
  { key:"bahah",    w:0.016, priceIdx:0.83, fg:1.12 },
  { key:"jawf",     w:0.017, priceIdx:0.84, fg:1.10 },
  { key:"northern", w:0.050, priceIdx:0.87, fg:1.05 },
];

const DATA_SOURCES = [
  { key:"sakani",  status:"ok",      freq:"daily",     records:1402360, exc:2.1, completeness:98, updated:"Today 06:00" },
  { key:"redf",    status:"ok",      freq:"daily",     records:318540,  exc:3.4, completeness:95, updated:"Today 05:30" },
  { key:"nhc",     status:"ok",      freq:"weekly",    records:84210,   exc:6.2, completeness:91, updated:"2 days ago" },
  { key:"rega",    status:"ok",      freq:"monthly",   records:51300,   exc:8.5, completeness:88, updated:"Last month" },
  { key:"ncsi",    status:"delayed", freq:"quarterly", records:540000,  exc:9.3, completeness:86, updated:"1 quarter ago" },
  { key:"sama",    status:"ok",      freq:"daily",     records:1250,    exc:0.4, completeness:99, updated:"Today 06:00" },
];

/* =========================================================================
   WHAT-IF / FORMULA ENGINE
   params:
     reallocatePct  – fraction of >10k contract share shifted to <10k bands (0..0.30)
     capHighPct     – reduction applied to subsidy of top two bands (0..0.20)
     boostLowPct    – uplift applied to subsidy of <10k bands (0..0.20)
   ========================================================================= */
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

function computeAllocation(params, mortOverrides){
  const p = Object.assign({ reallocatePct:0, capHighPct:0, boostLowPct:0, offPlanPct:0 }, params||{});
  // Build dynamic mortgage parameters: override from formula params if provided, otherwise use global defaults
  const mort = {
    rate: mortOverrides?.rate != null ? mortOverrides.rate/100/12 : MORT.rate,
    n:    mortOverrides?.dur  != null ? mortOverrides.dur*12    : MORT.n,
    down: mortOverrides?.ded  != null ? mortOverrides.ded/100   : MORT.down,
  };
  const belowIdx = BANDS.map((b,i)=>b.below?i:-1).filter(i=>i>=0);
  const aboveIdx = BANDS.map((b,i)=>!b.below?i:-1).filter(i=>i>=0);

  // Total annual contracts kept constant (the 510k/5y target is non-negotiable).
  // reallocatePct shifts that fraction of the >10k contract share down to <10k bands, pro-rata.
  const baseAboveTotal = aboveIdx.reduce((s,i)=>s+BANDS[i].cShareBase,0);
  const moved = baseAboveTotal * p.reallocatePct;
  const belowBaseTotal = belowIdx.reduce((s,i)=>s+BANDS[i].cShareBase,0);

  const rows = BANDS.map((b)=>{
    let cShare = b.cShareBase;
    if(b.below)  cShare = b.cShareBase + moved*(b.cShareBase/belowBaseTotal);
    else         cShare = b.cShareBase*(1 - p.reallocatePct);
    let subsidy = b.subsidyBase;
    if(b.below) subsidy = b.subsidyBase*(1+p.boostLowPct);
    else        subsidy = subsidy*(1-p.capHighPct);          // cap applies to all >10k bands
    subsidy = subsidy*(1 - p.offPlanPct);                    // off-plan / in-kind restriction (flat — savings lever, FG/HBR neutral)
    return Object.assign({}, b, { cShare, subsidy });
  });

  const contractsTotal = ANNUAL_CONTRACTS;
  let spend=0, subsidyBelow=0, subsidyTotal=0;
  let hbrNum=0, hbrDen=0;
  rows.forEach(r=>{
    const contracts = contractsTotal*r.cShare;
    const bandSpend = contracts*r.subsidy;
    spend += bandSpend; subsidyTotal += bandSpend;
    if(r.below) subsidyBelow += bandSpend;
    r.contracts = contracts; r.bandSpend = bandSpend;
    // HBR: package buy-down reduces mortgage principal → lowers monthly payment → lowers burden.
    let pkg = r.pkgBase;
    if(r.below) pkg = r.pkgBase*(1 + p.boostLowPct*HBR_LEV.boost);
    else        pkg = r.pkgBase*(1 - p.capHighPct*HBR_LEV.cap);
    const principal = r.homePrice*(1-mort.down) - pkg;
    const hbr = clamp(monthlyPayment(principal, mort.rate, mort.n)/r.incomeAvg, 0.08, 0.70);
    r.hbr = hbr; r.pkg = pkg;
    hbrNum += hbr*r.popShare; hbrDen += r.popShare;
  });

  return { rows, spend, avgPerContract:spend/contractsTotal, FG:(subsidyBelow/subsidyTotal)/(belowIdx.reduce((s,i)=>s+BANDS[i].popShare,0)/BANDS.reduce((s,b)=>s+b.popShare,0)), HBR:hbrNum/hbrDen,
           subsidyBelow, subsidyTotal, contractsTotal,
           fgShareBelow:subsidyBelow/subsidyTotal, popShareBelow:belowIdx.reduce((s,i)=>s+BANDS[i].popShare,0)/BANDS.reduce((s,b)=>s+b.popShare,0), mort };
}

const BASELINE_V0 = computeAllocation({}); // v1.0 reference (unchanged by formula)

// Savings are measured against the current matrix (BASELINE). BRD frames savings as
// 1.37–3.4B over the 5-year phase (≈17–43% of the 7.9B budget).
function scenarioSavings(scn, baselineSpend){
  const annual = (baselineSpend ?? BASELINE_V0.spend) - scn.spend;
  return { annual, phase: annual*BRD.phase3Years,
           pctOfBudget: (annual*BRD.phase3Years)/BRD.phase3BudgetSAR };
}

function fgByRegion(globalFG, baselineFG){
  // scale each region's baseline FG by the same ratio the global FG moved
  const ratio = globalFG / (baselineFG ?? BASELINE_V0.FG);
  return REGIONS.map(r=>({ key:r.key, fg:+(r.fg*ratio).toFixed(3), w:r.w, priceIdx:r.priceIdx }));
}

/* =========================================================================
   FORECAST (12-month spend projection with budget ceiling + alert)
   ========================================================================= */
// Seasonal weights (Jan contract surge, mid-year / post-Ramadan dip, year-end push).
const FC_SEASON=[1.18,1.06,0.99,0.96,0.92,0.86,0.80,0.78,0.95,1.06,1.12,1.20];
function buildForecast(scn, alertThreshold){
  const annualCeiling = BRD.phase3BudgetSAR / BRD.phase3Years; // 1.58B
  const monthlyCeiling = annualCeiling/12;
  const monthlyAvg = scn.spend/12;
  const months=[]; let cum=0;
  for(let m=1;m<=12;m++){
    const projected = monthlyAvg*FC_SEASON[m-1];
    cum += projected;
    months.push({ m, projected:Math.round(projected), cumulative:Math.round(cum), ceiling:Math.round(monthlyCeiling*m) });
  }
  // 3-month OLS-style continuation from the last quarter slope, with ±12% CI.
  const slope=(months[11].projected-months[8].projected)/3;
  const fc=[]; let last=months[11].projected, fcum=cum;
  for(let k=1;k<=3;k++){ const proj=Math.round(last+slope*k); fcum+=proj;
    fc.push({ m:12+k, proj, lo:Math.round(proj*0.88), hi:Math.round(proj*1.12), cumulative:Math.round(fcum), ceiling:Math.round(monthlyCeiling*(12+k)) }); }
  const thr = (alertThreshold ?? 70) / 100;
  const alertMonth = months.find(x=>x.cumulative > monthlyCeiling*x.m*thr);
  return { months, fc, annualCeiling, monthlyCeiling, alertMonth: alertMonth? alertMonth.m : null };
}

/* =========================================================================
   i18n  (English + Arabic).  Switching AR flips the whole app to RTL.
   ========================================================================= */
const I18N = {
  en:{
    appName:"Dynamic Subsidy Allocation & Optimization",
    sso_title:"MoMAH Single Sign-On", sso_sub:"Unified national access to the Ministry of Municipalities & Housing digital services.", identity:"Identity",
    signInTitle:"Sign In", forgotPwd:"Forgot password?", securityCode:"Security code", or_:"or",
    nafath:"Nafath national access", noAccount:"Don't have an account?", createAccount:"Create New Account",
    nic1:"NIC", nic2:"National Identity Card", identityPh:"Select identity",
    copyright:"© 2026 — Ministry of Municipalities & Housing · Housing Support Agency", brandLine:"Dynamic Subsidy Allocation", login_btn:"Login",
    ministry:"Ministry of Municipalities & Housing", agency:"Housing Support Agency",
    syntheticData:"Synthetic demo data — not real beneficiaries",
    login:"Sign in", username:"Username", password:"Password", chooseRole:"Select a demo identity",
    loginHint:"Password is pre-filled for the demo (no real authentication).", enter:"Enter",
    logout:"Sign out", language:"Language", currency:"Currency", resetDemo:"Reset demo",
    // roles
    analyst:"Analyst", owner:"Business Owner", minister:"Minister",
    analyst_full:"Analyst", owner_full:"Business Owner", minister_full:"Minister",
    analyst_desc:"Runs analyses, What-if, assembles & submits decision packages.",
    owner_desc:"Reviews and approves tactical recommendations.",
    minister_desc:"Adjudicates strategic items (caps / internal regulations).",
    // nav
    nav_home:"Dashboard", nav_data:"Data Readiness", nav_alloc:"Allocation Plan", nav_forecast:"Spend Forecast", back:"Back",
    nav_whatif:"What-if Simulation", nav_packages:"Decision Packages", nav_approvals:"Approvals",
    nav_audit:"Audit Trail", act_version:"Version change", act_threshold:"Threshold change", act_refer:"Referral", act_report:"Leakage report", audit_worm:"Append-only · Cannot be deleted or modified · All decisions and actions are permanently recorded",
    audit_catAll:"All", audit_catPkg:"Decisions", audit_catFormula:"Formula", audit_catThreshold:"Threshold", audit_catRef:"Beneficiary", audit_catFair:"Fairness/Leakage", audit_catWhatif:"What-if", audit_catConfig:"Config",
    nav_copilot:"Housing Copilot", nav_cockpit:"Strategic Cockpit", nav_decisions:"Strategic Decisions", nav_fairness:"Fairness & Leakage", nav_orchestration:"Orchestration", nav_dash360:"Beneficiary 360°",
    // KPIs
    kpi_savings:"Projected savings (5-yr)", kpi_fairness:"Fairness Gap", kpi_hbr:"Housing Burden (HBR)",
    kpi_budget:"Budget utilisation", kpi_contracts:"Contracts to target", kpi_pending:"Pending decisions",
    kpi_forecastErr:"Forecast error", kpi_dataReady:"Data readiness", kpi_adoption:"Adoption rate",
    of_budget:"of 7.9B budget", target:"target", baseline:"baseline", current:"current",
    fair_if:"Fair when ≥ 1.0", toTarget:"to 2030 target 30–35%",
    // common
    explain:"View rationale", impact:"Projected impact", submit:"Assemble & submit package", approve:"Approve",
    reject:"Reject & feedback", escalate:"Escalate to Minister", adjudicate:"Adjudicate", view:"View",
    run:"Run", running:"Running…", done:"Done", apply:"Apply", todo:"To-do", status:"Status",
    region:"Region", incomeBand:"Income band", contracts:"Contracts", subsidy:"Avg support", share:"Share",
    before:"Before", after:"After", delta:"Change", scenario:"Scenario", recommended:"Recommended",
    notifTitle:"Decision package submitted", noItems:"Nothing here yet.",
    // data sources
    src_sakani:"Sakani Platform", src_redf:"Real Estate Dev. Fund (REDF)", src_nhc:"National Housing Co. (NHC)",
    src_rega:"Real Estate Authority (Rega)", src_ncsi:"Statistics Authority (NCSI)", src_sama:"Central Bank (SAMA)",
    st_ok:"Updated", st_pending:"Pending approval", st_delayed:"Delayed 3–6 mo", quality:"Quality", freq:"Frequency",
    // bands
    bl_lt5:"< 5,000", bl_5to8:"5,000–8,000", bl_8to10:"8,000–10,000",
    bl_10to13:"10,000–13,000", bl_13to16:"13,000–16,000", bl_gt16:"> 16,000",
    below10k:"Below 10,000", above10k:"Above 10,000",
    // regions
    rg_riyadh:"Riyadh", rg_makkah:"Makkah", rg_eastern:"Eastern Province", rg_madinah:"Madinah", rg_asir:"Asir",
    rg_qassim:"Qassim", rg_tabuk:"Tabuk", rg_hail:"Hail", rg_jazan:"Jazan", rg_najran:"Najran",
    rg_bahah:"Al-Bahah", rg_jawf:"Al-Jawf", rg_northern:"Northern Borders",
    rg_national:"National (all regions)",
    // pages text
    home_hello:"Welcome", monthlyCycle:"Monthly allocation review",
    data_sub:"Daily automated cycle cleans data and writes prices & budget to BIDSC.",
    runCycle:"Run daily data cycle", writingBidsc:"Writing to BIDSC", bidscDone:"BIDSC updated",
    alloc_sub:"Explainable proposed distribution within the approved policy matrix.",
    forecast_sub:"12-month spend projection with budget ceiling, plus multi-dimensional Fairness Gap & leakage.",
  fc_stressTitle:"Stress Scenario Analysis", fc_stressSub:"3 automatic stress scenarios", fc_stressTip:"Forecast engine automatically produces 3 stress scenarios",
  fc_stressScenario:"Scenario", fc_stressImpact:"Impact", fc_stressNote:"Note", fc_stressBr:"System auto-generates 3 stress scenarios",
  supportType:"Support Type", st_monthly:"Monthly", st_package:"Package", st_mix:"Mix",
  fc_stressRate:"Rate +2%", fc_stressRateNote:"Higher rates increase long-term liabilities",
  fc_stressExit:"Exits -30%", fc_stressExitNote:"Lower early exits free part of budget",
  fc_stressNew:"New Contracts +20%", fc_stressNewNote:"New contracts increase future commitments",
  fc_base:"Baseline", fc_stress:"Scenario",
  fc_alertRules:"Alert Rules", fc_alertTip:"70% / 90% alert thresholds",
  fc_alertType:"Alert Type", fc_alertThreshold:"Threshold", fc_alertAction:"Response",
  fc_earlyWarn:"Early Warning", fc_earlyWarnAction:"Notify P-01/P-02 · Trigger reallocation assessment",
  fc_depletion:"Imminent Depletion", fc_depletionAction:"Direct to P-02 & Minister",
  fc_liability2050:"Elevated 2050 Liabilities", fc_liabilityAction:"Rate change triggers · Stimulate what-if evaluation",
  fc_demandShort:"Demand Shortfall", fc_demandAction:"Signing rate<80% · Trigger reallocation",
  fc_annualBudget:"Annual Budget", fc_ratePlus:"Rate rise", fc_contractRate:"Signing rate",
  fc_alertBr:"Alert does not stop disbursement — always refers to human decision",
  fc_portfolioTitle:"Investment Portfolio Obligations Table", fc_portfolioTip:"Commitments, liabilities, early-exit rate, stress scenarios", fc_portField:"Field", fc_portRateCommit:"Interest support commitments", fc_portRateCommitNote:"Difference × Remaining loan balance (amortizing) — from Formula Engine + BIDSC",
  fc_portInterestCommit:"Interest support commitments (SAR)", fc_portInterestCommitNote:"From Formula Engine + BIDSC",
  fc_portInkindCommit:"In-kind support commitments", fc_portInkindCommitNote:"Approved off-plan sales — one-time commitment upon delivery",
  fc_portAnnualCommit:"Total annual commitment", fc_portAnnualCommitNote:"Fields 14+15+16 — highlighted red if exceeded approved budget",
  fc_portCumulative:"Cumulative liability (SAR)", fc_portCumulativeNote:"Cumulative total from current year up to 2050",
  fc_portEarlyExit:"Expected early discharge rate (%)", fc_portEarlyExitNote:"From outcome tracking — applied as reduction factor on obligations",
  fc_portStress20:"Stress Scenario — Interest Rate +2% impact", fc_portStress20Note:"Rate rise increases interest support commitments by ~9.4%",
  fc_portStress21:"Stress Scenario — Early Exit -30% impact", fc_portStress21Note:"Lower early exits increase active contract obligations by ~6.8%",
  fc_portStress22:"Stress Scenario — New Contracts +20% impact", fc_portStress22Note:"New contracts expand total commitment by ~17.4%",
  fc_portWarn:"Annual commitment exceeds approved budget ceiling — highlighted red (field 17). Warning issued.",
  rejectWithNote:"Reject with modification note (e.g. 'Recalculate with lower budget ceiling')", feedbackLoopHint:"On reject, Decision Routing returns recommendation to issuing engine with modified constraints. If rejected again — escalated to Minister.",
  savingsIndex:"Combined Savings Index", savingsIndexSub:"Target range:", contractsTargetSub:"Target: 510,000 contracts (2026-2030) · 310K REDF · 150K ZATCA · 50K Dev. Housing",
    spendForecast:"Spend forecast (12 months)", budgetCeiling:"Budget ceiling", alert:"Alert",
    alertMsg:"Cumulative spend exceeds 70% of the monthly ceiling — early warning raised.",
    fairnessByRegion:"Fairness Gap by region", leakage:"Leakage & undue-benefit signals", fairness_sub:"Multi-dimensional Fairness Gap analysis and leakage detection with escalation workflow.",
    whatif_sub:"Ask in plain language or move the levers — the orchestration layer calls the agents and the KPIs update live.",
    nlPlaceholder:"e.g. Boost support to families under 10,000 by 10% and assess the impact",
    nlTestTip:"test the formula impact → adjust levers below",
    orchestration:"Agent orchestration", levers:"Policy levers",
    lv_realloc:"Reallocate >10k → <10k", lv_cap:"Cap >10k support", lv_boost:"Boost <10k support", lv_offplan:"Restrict off-plan",
    runWhatif:"Run simulation", compare:"Baseline vs scenario", assembleFromHere:"Assemble decision package from this scenario",
    pkg_sub:"Assemble the explained package and submit it up the decision chain.",
    approvals_sub:"Review tactical recommendations submitted by analysts.",
    cockpit_sub:"Strategic KPIs and items requiring ministerial adjudication.",
    decisions_sub:"Items escalated for strategic adjudication (caps / internal regulations).",
    audit_sub:"Every submission, approval, rejection and adjudication is recorded.", audit_type:"Type", auditDetail:"Audit trail detail", openHint:"Click a work order # to view details",
    copilot_btn:"Deliver to Housing Copilot", copilot_sub:"Approved outputs are delivered to Housing Copilot via the API Contract.",
    deliver:"Deliver to Housing Copilot", opening:"Opening Housing Copilot…",
    redline:"The system only recommends. It never auto-approves, never auto-suspends support, never edits regulations.",
    scenarios:"Business Scenarios",
    scenario_cycle_title:"Monthly Allocation Cycle",
    scenario_cycle_desc:"Run the end-to-end monthly allocation: data → formula → allocation → forecast.",
    scenario_cycle_start:"Start allocation cycle",
    scenario_policy_title:"Policy Simulation & Decision",
    scenario_policy_desc:"Test policy levers in the What-if sandbox, assemble decision packages, and route for approval.",
    scenario_policy_start:"Start policy simulation",
    scenario_monitor_title:"Allocation Monitoring",
    scenario_monitor_desc:"Track beneficiary improvements, monitor fairness and leakage, and analyse policy market impact.",
    scenario_monitor_start:"Start monitoring",
    navGroup_sim:"Simulation & Decision", navGroup_alloc:"Monthly Allocation",
    navGroup_monitor:"Monitor & Respond", navGroup_tools:"Special Topics",
    navGroup_approve:"Approvals", navGroup_observe:"Global Monitor", navGroup_sys:"System",
    navTab_overview:"Overview", navTab_data:"Data", navTab_allocation:"Allocation",
    navTab_simulation:"Simulation", navTab_governance:"Governance", navTab_settings:"Settings",
    pkgStatus_draft:"Draft", pkgStatus_submitted:"Awaiting Business Owner", pkgStatus_approved:"Approved (tactical)",
    pkgStatus_escalated:"Awaiting Minister", pkgStatus_adjudicated:"Adjudicated", pkgStatus_rejected:"Rejected",
    needsMinister:"Exceeds tactical authority — affects support cap. Escalate to Minister.",
    by:"by", at:"at", level:"Level", agentChain:"Orchestration chain",
    ag_uc01:"Subsidy Formula", ag_uc03:"Optimization", ag_uc04:"Forecast", ag_uc08:"Fairness",
    deliveredItems:"Recommendation · HBR · Fairness Gap · What-if result",
    annualSavings:"Annual savings", phaseSavings:"5-year savings", reviewRun:"Review & run What-if",
    contractsTarget:"Contract target 2026–2030", ownership:"Ownership rate",
    more:"More", workOrder:"Work order", colStatus:"Status", records:"Records", vsPrev:"vs last cycle",
    completeness:"Completeness", lastUpdate:"Last update", leversUsed:"Levers used", expectedImpact:"Expected impact",
    alertTitle:"Budget alert", quickActions:"Quick actions", action:"Action", time:"Time", note:"Note", noLevers:"No change (baseline)",
    td_alloc:"Review this month's allocation plan", td_forecast:"Resolve spending alerts",
    td_whatif:"Run What-if for the interest-rate scenario", td_packages:"Submit assembled decision packages",
    td_copilot:"Deliver approved outputs to Housing Copilot",
    due_today:"Due today", due_3:"3 open", due_2:"2 ready", due_soon:"This week", due_1:"1 pending",
    svc_section:"Key Services", btn_details:"Details", btn_open:"Open", aiWorking:"Agents orchestrating…", cycleDone:"Cycle complete — sources refreshed",
    tag_auto:"Automated daily", tag_monthly:"Monthly cycle", tag_ai:"AI · live", tag_explain:"Explainable", tag_audit:"Audit-logged", tag_api:"API contract",
    pkg_type:"Type", pkg_rationale:"Purpose", pkg_impact:"Expected impact",
    pkg_affected:"Households affected", pkg_reclassified:"Contracts reclassified",
    pkg_chain:"Approval chain", pkg_chainSubmitted:"Submitted", pkg_chainApproving:"Approving", pkg_chainAdjudicating:"Adjudicating",
    pkg_formulaChange:"Formula change", pkg_noFormulaChange:"No formula change",
  },
  ar:{
    appName:"التخصيص الديناميكي للدعم وتحسينه",
    sso_title:"النفاذ الموحد", sso_sub:"النفاذ الوطني الموحد إلى الخدمات الرقمية لوزارة البلديات والإسكان.", identity:"الهوية",
    signInTitle:"تسجيل الدخول", forgotPwd:"نسيت كلمة المرور؟", securityCode:"الرمز المرئي", or_:"أو",
    nafath:"الدخول عبر نفاذ", noAccount:"ليس لديك حساب؟", createAccount:"إنشاء حساب جديد",
    nic1:"الهوية", nic2:"بطاقة الهوية الوطنية", identityPh:"اختر الهوية",
    copyright:"© ٢٠٢٦ — وزارة البلديات والإسكان · هيئة الدعم السكني", brandLine:"التخصيص الديناميكي للدعم", login_btn:"دخول",
    ministry:"وزارة البلديات والإسكان", agency:"هيئة الدعم السكني",
    syntheticData:"بيانات تجريبية اصطناعية — ليست مستفيدين حقيقيين",
    login:"تسجيل الدخول", username:"اسم المستخدم", password:"كلمة المرور", chooseRole:"اختر هوية تجريبية",
    loginHint:"كلمة المرور مُعبّأة للعرض (بدون مصادقة فعلية).", enter:"دخول",
    logout:"تسجيل الخروج", language:"اللغة", currency:"العملة", resetDemo:"إعادة ضبط العرض",
    analyst:"محلل", owner:"مالك الأعمال", minister:"الوزير",
    analyst_full:"محلل", owner_full:"مالك الأعمال", minister_full:"الوزير",
    analyst_desc:"يشغّل التحليلات والمحاكاة ويُجمّع حزم القرار ويرفعها.",
    owner_desc:"يراجع ويعتمد التوصيات التكتيكية.",
    minister_desc:"يبتّ في البنود الاستراتيجية (السقوف / اللوائح الداخلية).",
    nav_home:"لوحة المعلومات", nav_data:"جاهزية البيانات", nav_alloc:"خطة التخصيص", nav_forecast:"التنبؤ بالإنفاق", back:"عودة",
    nav_whatif:"محاكاة الافتراضات", nav_packages:"حزم القرار", nav_approvals:"الاعتمادات",
    nav_audit:"سجل التدقيق", act_version:"تغيير الإصدار", act_threshold:"تغيير الحد", act_refer:"إحالة", act_report:"الإبلاغ عن تسرب", audit_worm:"إلحاق فقط · لا يمكن حذفه أو تعديله · جميع القرارات والإجراءات مسجلة بشكل دائم",
    audit_catAll:"الكل", audit_catPkg:"القرارات", audit_catFormula:"الصيغة", audit_catThreshold:"الحدود", audit_catRef:"المستفيدين", audit_catFair:"العدالة/التسرب", audit_catWhatif:"ماذا-لو",
    nav_copilot:"مساعد الإسكان", nav_cockpit:"لوحة القيادة", nav_decisions:"القرارات الاستراتيجية", nav_fairness:"العدالة والتسرب", nav_orch:"التنسيق", nav_dash360:"ملف المستفيد 360°",
    kpi_savings:"الوفورات المتوقعة (٥ سنوات)", kpi_fairness:"فجوة العدالة", kpi_hbr:"عبء السكن (HBR)",
    kpi_budget:"استخدام الميزانية", kpi_contracts:"العقود مقابل المستهدف", kpi_pending:"قرارات معلّقة",
    kpi_forecastErr:"خطأ التنبؤ", kpi_dataReady:"جاهزية البيانات", kpi_adoption:"معدل التبني",
    of_budget:"من ميزانية ٧٫٩ مليار", target:"المستهدف", baseline:"الأساس", current:"الحالي",
    fair_if:"عادلة عند ≥ ١٫٠", toTarget:"نحو مستهدف ٢٠٣٠: ٣٠–٣٥٪",
    explain:"عرض المبرر", impact:"الأثر المتوقع", submit:"تجميع ورفع الحزمة", approve:"اعتماد",
    reject:"رفض مع ملاحظات", escalate:"رفع للوزير", adjudicate:"البتّ", view:"عرض",
    run:"تشغيل", running:"جارٍ…", done:"تم", apply:"تطبيق", todo:"المهام", status:"الحالة",
    region:"المنطقة", incomeBand:"شريحة الدخل", contracts:"العقود", subsidy:"متوسط الدعم", share:"الحصة",
    before:"قبل", after:"بعد", delta:"التغير", scenario:"السيناريو", recommended:"موصى به",
    notifTitle:"تم رفع حزمة القرار", noItems:"لا يوجد بعد.",
    src_sakani:"منصة سكني", src_redf:"صندوق التنمية العقارية", src_nhc:"الشركة الوطنية للإسكان",
    src_rega:"الهيئة العامة للعقار", src_ncsi:"الهيئة العامة للإحصاء", src_sama:"البنك المركزي",
    st_ok:"محدّث", st_pending:"بانتظار الاعتماد", st_delayed:"متأخر ٣–٦ أشهر", quality:"الجودة", freq:"التحديث",
    bl_lt5:"أقل من ٥٬٠٠٠", bl_5to8:"٥٬٠٠٠–٨٬٠٠٠", bl_8to10:"٨٬٠٠٠–١٠٬٠٠٠",
    bl_10to13:"١٠٬٠٠٠–١٣٬٠٠٠", bl_13to16:"١٣٬٠٠٠–١٦٬٠٠٠", bl_gt16:"أكثر من ١٦٬٠٠٠",
    below10k:"أقل من ١٠٬٠٠٠", above10k:"أكثر من ١٠٬٠٠٠",
    rg_riyadh:"الرياض", rg_makkah:"مكة المكرمة", rg_eastern:"المنطقة الشرقية", rg_madinah:"المدينة المنورة", rg_asir:"عسير",
    rg_qassim:"القصيم", rg_tabuk:"تبوك", rg_hail:"حائل", rg_jazan:"جازان", rg_najran:"نجران",
    rg_bahah:"الباحة", rg_jawf:"الجوف", rg_northern:"الحدود الشمالية",
    rg_national:"الوطنية (جميع المناطق)",
    home_hello:"مرحباً", monthlyCycle:"مراجعة التخصيص الشهرية",
    data_sub:"دورة يومية آلية تنظّف البيانات وتكتب الأسعار والميزانية إلى BIDSC.",
    runCycle:"تشغيل الدورة اليومية", writingBidsc:"الكتابة إلى BIDSC", bidscDone:"تم تحديث BIDSC",
    alloc_sub:"خطة توزيع مقترحة قابلة للتفسير ضمن مصفوفة السياسة المعتمدة.",
    forecast_sub:"تنبؤ إنفاق ١٢ شهراً مع سقف الميزانية، وفجوة عدالة متعددة الأبعاد ورصد التسرب.",
  fc_stressTitle:"تحليل سيناريوهات الضغط", fc_stressSub:"3 سيناريوهات ضغط تلقائية", fc_stressTip:"محرك التنبؤ ينتج 3 سيناريوهات ضغط تلقائياً",
  fc_stressScenario:"السيناريو", fc_stressImpact:"الأثر", fc_stressNote:"ملاحظة", fc_stressBr:"يولد النظام تلقائياً 3 سيناريوهات ضغط",
  supportType:"نوع الدعم", st_monthly:"شهري", st_package:"حزمة", st_mix:"مزيج",
  fc_stressRate:"سعر الفائدة +2%", fc_stressRateNote:"ارتفاع الفائدة يزيد الالتزامات طويلة الأجل",
  fc_stressExit:"الخروج -30%", fc_stressExitNote:"انخفاض الخروج المبكر يحرر جزءاً من الميزانية",
  fc_stressNew:"العقود الجديدة +20%", fc_stressNewNote:"العقود الجديدة تزيد الالتزامات المستقبلية",
  fc_base:"الخط الأساسي", fc_stress:"السيناريو",
  fc_alertRules:"قواعد التنبيه", fc_alertTip:"عتبة التنبيه 70% / 90%",
  fc_alertType:"نوع التنبيه", fc_alertThreshold:"العتبة", fc_alertAction:"الإجراء",
  fc_earlyWarn:"إنذار مبكر", fc_earlyWarnAction:"إخطار P-01/P-02 · تشغيل إعادة التقييم",
  fc_depletion:"خطر النضوب", fc_depletionAction:"مباشرة إلى P-02 والوزير",
  fc_liability2050:"ارتفاع التزامات 2050", fc_liabilityAction:"تغير سعر الفائدة · تحفيز تقييم What-if",
  fc_demandShort:"نقص الطلب", fc_demandAction:"معدل التوقيع <80% · تشغيل إعادة التوازن",
  fc_annualBudget:"الميزانية السنوية", fc_ratePlus:"ارتفاع السعر", fc_contractRate:"معدل التوقيع",
  fc_alertBr:"التنبيه لا يوقف الصرف — يحول دائماً للقرار البشري",
  fc_portfolioTitle:"جدول التزامات المحفظة الاستثمارية", fc_portfolioTip:"الالتزامات والخصوم ومعدل الخروج المبكر وسيناريوهات الضغط",
  fc_portField:"الحقل", fc_portRateCommit:"التزامات دعم الفائدة", fc_portRateCommitNote:"الفرق × رصيد القرض المتبقي (استهلاك) — من محرك الصيغة + BIDSC",
  fc_portInterestCommit:"التزامات دعم الفائدة (SAR)", fc_portInterestCommitNote:"من محرك الصيغة + BIDSC",
  fc_portInkindCommit:"التزامات الدعم العيني", fc_portInkindCommitNote:"مشاريع البيع على الخارطة المعتمدة — التزام لمرة واحدة عند التسليم",
  fc_portAnnualCommit:"إجمالي الالتزام السنوي", fc_portAnnualCommitNote:"الحقول 14+15+16 — يُعلم بالأحمر إذا تجاوز الميزانية المعتمدة",
  fc_portCumulative:"الخصم التراكمي (SAR)", fc_portCumulativeNote:"الإجمالي التراكمي من العام الحالي حتى 2050",
  fc_portEarlyExit:"معدل الخروج المبكر المتوقع (%)", fc_portEarlyExitNote:"من تتبع النتائج — يُطبق كعامل تخفيض على الالتزامات",
  fc_portStress20:"سيناريو الضغط — تأثير ارتفاع الفائدة +2%", fc_portStress20Note:"ارتفاع الفائدة يزيد التزامات دعم الفائدة بنحو 9.4%",
  fc_portStress21:"سيناريو الضغط — تأثير الخروج المبكر -30%", fc_portStress21Note:"انخفاض الخروج المبكر يزيد التزامات العقود النشطة بنحو 6.8%",
  fc_portStress22:"سيناريو الضغط — تأثير العقود الجديدة +20%", fc_portStress22Note:"العقود الجديدة تزيد إجمالي الالتزام بنحو 17.4%",
  fc_portWarn:"الالتزام السنوي يتجاوز سقف الميزانية المعتمد — مُعلّم بالأحمر (الحقل 17). تم إصدار تحذير.",
  rejectWithNote:"رفض مع ملاحظة تعديل", feedbackLoopHint:"عند الرفض، توجيه القرار يعيد التوصية لمحرك الإصدار مع قيود معدلة. إذا رُفض مرة أخرى — يُرفع للوزير.",
  savingsIndex:"مؤشر الادخار التراكمي", savingsIndexSub:"النطاق المستهدف:", contractsTargetSub:"الهدف: 510,000 عقد (2026-2030) · 310K REDF · 150K ZATCA · 50K إسكان تنموي",
    spendForecast:"تنبؤ الإنفاق (١٢ شهراً)", budgetCeiling:"سقف الميزانية", alert:"تنبيه",
    alertMsg:"تجاوز الإنفاق التراكمي ٧٠٪ من السقف الشهري — تم رفع إنذار مبكر.",
    fairnessByRegion:"فجوة العدالة حسب المنطقة", leakage:"إشارات التسرب والاستفادة غير المستحقة", fairness_sub:"تحليل فجوة العدالة متعددة الأبعاد وكشف التسرب مع سير عمل التصعيد.",
    whatif_sub:"اسأل بلغة طبيعية أو حرّك المؤشرات — تستدعي طبقة التنسيق الوكلاء وتتحدث المؤشرات فوراً.",
    nlPlaceholder:"مثال: ارفع الدعم للأسر أقل من ١٠٬٠٠٠ بنسبة ١٠٪ وقيّم الأثر",
    nlTestTip:"اختبار تأثير الصيغة → اضبط الروافع أدناه",
    orchestration:"تنسيق الوكلاء", levers:"روافع السياسة",
    lv_realloc:"إعادة التوزيع >١٠ك ← <١٠ك", lv_cap:"تقييد دعم >١٠ك", lv_boost:"رفع دعم <١٠ك", lv_offplan:"تقييد البيع على الخارطة",
    runWhatif:"تشغيل المحاكاة", compare:"الأساس مقابل السيناريو", assembleFromHere:"تجميع حزمة قرار من هذا السيناريو",
    pkg_sub:"جمّع الحزمة المفسّرة وارفعها في سلسلة القرار.",
    approvals_sub:"راجع التوصيات التكتيكية المرفوعة من المحللين.",
    cockpit_sub:"مؤشرات استراتيجية وبنود تتطلب بتّ الوزير.",
    decisions_sub:"بنود مرفوعة للبتّ الاستراتيجي (السقوف / اللوائح الداخلية).",
    audit_sub:"يُسجّل كل رفع واعتماد ورفض وبتّ.", audit_type:"النوع", auditDetail:"تفاصيل سجل التدقيق", openHint:"اضغط رقم أمر العمل لعرض التفاصيل",
    copilot_btn:"التسليم لمساعد الإسكان", copilot_sub:"تُسلَّم المخرجات المعتمدة إلى مساعد الإسكان عبر عقد الـ API.",
    deliver:"التسليم إلى مساعد الإسكان", opening:"جارٍ فتح مساعد الإسكان…",
    redline:"النظام يوصي فقط: لا يعتمد آلياً، ولا يوقف الدعم آلياً، ولا يعدّل اللوائح.",
    scenarios:"سيناريوهات الأعمال",
    scenario_cycle_title:"الدورة الشهرية للتخصيص",
    scenario_cycle_desc:"تشغيل دورة التخصيص الشهرية: البيانات ← الصيغة ← التخصيص ← التنبؤ.",
    scenario_cycle_start:"بدء دورة التخصيص",
    scenario_policy_title:"محاكاة السياسات واتخاذ القرار",
    scenario_policy_desc:"اختبار روافع السياسات في صندوق الرمل، تجميع حزم القرار، ورفعها للاعتماد.",
    scenario_policy_start:"بدء محاكاة السياسات",
    scenario_monitor_title:"مراقبة التخصيص",
    scenario_monitor_desc:"تتبع تحسن المستفيدين، مراقبة العدالة والتسرب، تحليل أثر السياسات.",
    scenario_monitor_start:"بدء المراقبة",
    navGroup_sim:"المحاكاة والقرار", navGroup_alloc:"التخصيص الشهري",
    navGroup_monitor:"المراقبة والاستجابة", navGroup_tools:"أدوات متخصصة",
    navGroup_approve:"الموافقات", navGroup_observe:"المراقبة الشاملة", navGroup_sys:"النظام",
    navTab_overview:"نظرة عامة", navTab_data:"البيانات", navTab_allocation:"التخصيص",
    navTab_simulation:"المحاكاة", navTab_governance:"الحوكمة", navTab_settings:"الإعدادات",
    pkgStatus_draft:"مسودة", pkgStatus_submitted:"بانتظار مالك الأعمال", pkgStatus_approved:"معتمد (تكتيكي)",
    pkgStatus_escalated:"بانتظار الوزير", pkgStatus_adjudicated:"تم البتّ", pkgStatus_rejected:"مرفوض",
    needsMinister:"يتجاوز الصلاحية التكتيكية — يمسّ سقف الدعم. يُرفع للوزير.",
    by:"بواسطة", at:"في", level:"المستوى", agentChain:"سلسلة التنسيق",
    ag_uc01:"صيغة الدعم", ag_uc03:"التحسين", ag_uc04:"التنبؤ", ag_uc08:"العدالة",
    deliveredItems:"توصية · HBR · فجوة العدالة · نتيجة المحاكاة",
    annualSavings:"الوفورات السنوية", phaseSavings:"وفورات ٥ سنوات", reviewRun:"المراجعة وتشغيل المحاكاة",
    contractsTarget:"مستهدف العقود ٢٠٢٦–٢٠٣٠", ownership:"معدل التملك",
    more:"المزيد", workOrder:"أمر العمل", colStatus:"الحالة", records:"السجلات", vsPrev:"مقابل الدورة السابقة",
    completeness:"اكتمال الحقول", lastUpdate:"آخر تحديث", leversUsed:"الروافع المستخدمة", expectedImpact:"الأثر المتوقع",
    alertTitle:"تنبيه الميزانية", quickActions:"إجراءات سريعة", action:"الإجراء", time:"الوقت", note:"ملاحظة", noLevers:"دون تغيير (الأساس)",
    td_alloc:"مراجعة خطة التخصيص لهذا الشهر", td_forecast:"معالجة تنبيهات الإنفاق",
    td_whatif:"تشغيل محاكاة لسيناريو سعر الفائدة", td_packages:"رفع حزم القرار المُجمّعة",
    td_copilot:"تسليم المخرجات المعتمدة إلى مساعد الإسكان",
    due_today:"مستحق اليوم", due_3:"٣ مفتوحة", due_2:"٢ جاهزة", due_soon:"هذا الأسبوع", due_1:"١ معلّق",
    svc_section:"الخدمات الرئيسية", btn_details:"تفاصيل", btn_open:"فتح", aiWorking:"الوكلاء يعملون…", cycleDone:"اكتملت الدورة — تم تحديث المصادر",
    tag_auto:"آلي يومي", tag_monthly:"دورة شهرية", tag_ai:"ذكاء · مباشر", tag_explain:"قابل للتفسير", tag_audit:"مُسجّل", tag_api:"عقد API",
    pkg_type:"النوع", pkg_rationale:"الغرض", pkg_impact:"الأثر المتوقّع",
    pkg_affected:"الأسر المتأثرة", pkg_reclassified:"العقود المعاد تصنيفها",
    pkg_chain:"سلسلة الاعتماد", pkg_chainSubmitted:"تم الرفع", pkg_chainApproving:"في الانتظار", pkg_chainAdjudicating:"في الانتظار",
    pkg_formulaChange:"تغيير الصيغة", pkg_noFormulaChange:"لا تغيير في الصيغة",
  }
};

/* =========================================================================
   Store / context
   ========================================================================= */
const Ctx = createContext(null);
const useStore = () => useContext(Ctx);

function statusToText(t,s){ return s==="ok"?t("st_ok"):s==="pending"?t("st_pending"):t("st_delayed"); }
const n0 = v => Math.round(v).toLocaleString("en-US");
const pct1 = v => (v*100).toFixed(1)+"%";
function abbr(v){ const a=Math.abs(v);
  if(a>=1e9) return (v/1e9).toFixed(2)+"B";
  if(a>=1e6) return (v/1e6).toFixed(0)+"M";
  if(a>=1e3) return (v/1e3).toFixed(0)+"K";
  return n0(v); }
function useMoney(){ const {currency}=useStore(); const pre = currency==="symbol" ? "⃁ " : "SAR ";
  return { money:(v)=>pre+abbr(v), moneyFull:(v)=>pre+n0(v) }; }

/* =========================================================================
   UI atoms
   ========================================================================= */
const GlobeIcon = (<svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z"/></svg>);
const ArrowIcon = (<svg className="ic-svg ic-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>);
const UserIcon = (<svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7"/></svg>);
const BellIcon = (<svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>);
const GearIcon = (<img className="ic-gear" src="/assets/gear2.svg" alt="" onError={e=>{const im=e.currentTarget,f=im.dataset.f||"0"; if(f==="0"){im.dataset.f="1";im.src="public/assets/gear2.svg";} else if(f==="1"){im.dataset.f="2";im.src="assets/gear2.svg";} else im.style.display="none";}}/>);

/* =========================================================================
   Monochrome icon system — all icons are 24×24, stroke-only, currentColor.
   ========================================================================= */
const S24 = {fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round",strokeLinejoin:"round",viewBox:"0 0 24 24"};
function S(p,...kids){ return <svg {...S24} {...p}>{kids.map((k,i)=>React.cloneElement(k,{key:i}))}</svg>; }
function P(d){ return <path d={d}/>; }
function R(p){ return <rect {...p}/>; }
function C(p){ return <circle {...p}/>; }
function L(p){ return <line {...p}/>; }
function PL(p){ return <polyline points={p}/>; }
function E(p){ return <ellipse {...p}/>; }

const ICON_MAP = {
  // Navigation icons
  home:   S({},P("M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"),PL("9 22 9 12 15 12 15 22")),
  data:   S({},E({cx:12,cy:5,rx:9,ry:3}),P("M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"),P("M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5")),
  formula:S({},P("M4 6h16M4 12h12M4 18h8")),
  alloc:  S({},R({x:3,y:3,width:8,height:8,rx:1}),R({x:13,y:3,width:8,height:8,rx:1}),R({x:3,y:13,width:8,height:8,rx:1}),R({x:13,y:13,width:8,height:8,rx:1})),
  mortgage:S({},P("M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"),PL("9 22 9 12 15 12 15 22")),
  forecast:S({},PL("23 6 13.5 15.5 8.5 10.5 1 18"),PL("17 6 23 6 23 12")),
  fairness:S({},P("M12 2v4M6 6h12"),P("M8 18c0 2.2 1.8 4 4 4s4-1.8 4-4"),L({x1:2,y1:22,x2:22,y2:22})),
  referrals:S({},P("M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"),C({cx:9,cy:7,r:4}),P("M23 21v-2a4 4 0 00-3-3.87"),P("M16 3.13a4 4 0 010 7.75")),
  dash360:S({},C({cx:12,cy:12,r:10}),C({cx:12,cy:12,r:3})),
  impact: S({},C({cx:12,cy:12,r:10}),P("M12 2v4M12 18v4M2 12h4M18 12h4")),
  whatif: S({},P("M5 3l14 9-14 9V3z")),
  benchmark:S({},C({cx:12,cy:12,r:9}),P("M3 12h18"),P("M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z")),
  inventory:S({},P("M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"),PL("9 22 9 12 15 12 15 22")),
  packages:S({},P("M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"),PL("3.27 6.96 12 12.01 20.73 6.96"),L({x1:12,y1:22.08,x2:12,y2:12})),
  orchestration:S({},P("M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"),C({cx:12,cy:12,r:3})),
  audit:  S({},C({cx:12,cy:12,r:10}),PL("12 6 12 12 16 14")),
  copilot:S({},P("M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z")),
  settings:S({},C({cx:12,cy:12,r:3}),P("M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z")),
  approvals:S({},PL("20 6 9 17 4 12")),
  // Tab icons (some reuse nav icons)
  overview:S({},R({x:3,y:3,width:8,height:8,rx:1}),R({x:13,y:3,width:8,height:8,rx:1}),R({x:3,y:13,width:8,height:8,rx:1}),R({x:13,y:13,width:8,height:8,rx:1})),
  simulation:S({},P("M5 3l14 9-14 9V3z")),
  governance:S({},P("M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z")),
  cycle:  S({},PL("17 1 21 5 17 9"),P("M3 11V9a4 4 0 014-4h14"),PL("7 23 3 19 7 15"),P("M21 13v2a4 4 0 01-4 4H3")),
  monitor:S({},P("M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"),C({cx:9,cy:7,r:4}),P("M23 21v-2a4 4 0 00-3-3.87"),P("M16 3.13a4 4 0 010 7.75")),
  cockpit:S({},P("M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"),PL("9 22 9 12 15 12 15 22")),
  decisions:S({},C({cx:12,cy:12,r:10}),PL("12 6 12 12 16 14")),
  // Small utility icons
  check:  S({},PL("20 6 9 17 4 12")),
  arrow:  S({},P("M9 6l6 6-6 6")),
  // Fallback
  _empty: S(),
};

function Icon({name,className}){
  const svg = ICON_MAP[name];
  if(!svg) return <span className={"ico "+(className||"")} style={{visibility:"hidden"}}/>;
  return <span className={"ico "+(className||"")}>{svg}</span>;
}
function AgentBadge({name,lvl}){ const {t}=useStore(); return (<span className="agent-badge">{GearIcon}<span>{name}{lvl?(" · "+lvl):""} · {t("agent_auto")}</span></span>); }
function InfoTip({text}){ return (<span className="tip" tabIndex={0} aria-label="formula">?<span className="tip-pop">{text}</span></span>); }
const SEED_NOTIFS = [{id:1,k:"ntf_sla",tone:"amber",ts:"2h ago"},{id:2,k:"ntf_leak",tone:"danger",ts:"5h ago"},{id:3,k:"ntf_budget",tone:"amber",ts:"1d ago"},{id:4,k:"ntf_sync",tone:"info",ts:"Today 06:00"}];
function NotifBell(){
  const {t}=useStore(); const [open,setOpen]=useState(false);
  const list=SEED_NOTIFS;
  return (<div className="usermenu">
    <button className="tbtn" onClick={()=>setOpen(o=>!o)} style={{position:"relative"}} aria-label={t("notifications")}>
      {BellIcon}{list.length>0&&<span className="notif-badge">{list.length}</span>}
    </button>
    {open&&<div className="panel" onMouseLeave={()=>setOpen(false)} style={{minWidth:312}}>
      <div style={{fontWeight:700,padding:"4px 8px 8px"}}>{t("notifications")}</div>
      {list.length===0? <div className="muted" style={{padding:8}}>{t("noNotifs")}</div>
        : list.map(n=>(<div key={n.id} className="notif-row">
            <span className="dot" style={{background:n.tone==="danger"?"var(--danger)":n.tone==="amber"?"var(--amber)":"var(--primary)",marginTop:5}}/>
            <div style={{flex:1}}><div style={{fontSize:12.5,lineHeight:1.4}}>{t(n.k)}</div><div className="muted" style={{fontSize:11,marginTop:2}}>{n.ts}</div></div>
          </div>))}
    </div>}
  </div>);
}
function KPI({label,value,sub,tone,onClick}){
  const {t}=useStore();
  const color = tone==="good"?"var(--primary)":tone==="bad"?"var(--danger)":tone==="warn"?"var(--amber)":"var(--ink)";
  return (<div className={"kpi"+(tone?" kpi-"+tone:"")+(onClick?" kpi-click":"")} onClick={onClick}>
    <div className="label">{label}</div>
    <div className="value" style={{color}}>{value}</div>{sub&&<div className="sub">{sub}</div>}
    {onClick&&<div className="kpi-more">{t("viewTrend")} ↗</div>}</div>);
}
function Section({title,sub,right,children,className}){
  return (<div className={"card pad acc"+(className?" "+className:"")} style={{marginBottom:16}}>
    <div className="page-h" style={{marginBottom:sub?12:8}}>
      <div><h2 style={{fontSize:16}}>{title}</h2>{sub&&<div className="sub muted">{sub}</div>}</div>{right}</div>
    {children}</div>);
}
function Progress({v,color}){ return (<div className="progress"><span style={{width:Math.min(100,v*100)+"%",background:color||"var(--primary)"}}/></div>); }
function Bar({label,v,max,color}){ return (<div style={{marginBottom:8}}>
  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span>{label}</span><span className="mono">{(v).toFixed(2)}</span></div>
  <div className="progress"><span style={{width:Math.min(100,(v/max)*100)+"%",background:color}}/></div></div>); }

/* =========================================================================
   Login
   ========================================================================= */
const ROLE_KEYS = ["analyst","owner","minister"];
const Skyline = (
  <svg viewBox="0 0 1440 700" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="bldsky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#13796a"/><stop offset="0.55" stopColor="#0d5a4f"/><stop offset="1" stopColor="#093b35"/>
      </linearGradient>
    </defs>
    <rect width="1440" height="700" fill="url(#bldsky)"/>
    <circle cx="1180" cy="150" r="60" fill="#1aa07f" opacity="0.25"/>
    <g fill="#0c4a40">
      <rect x="40" y="420" width="120" height="280"/><rect x="200" y="360" width="90" height="340"/>
      <rect x="330" y="300" width="70" height="400"/><rect x="430" y="440" width="110" height="260"/>
      <rect x="580" y="250" width="60" height="450"/><rect x="660" y="330" width="100" height="370"/>
      <rect x="800" y="280" width="80" height="420"/><rect x="900" y="420" width="120" height="280"/>
      <rect x="1060" y="320" width="80" height="380"/><rect x="1170" y="380" width="100" height="320"/>
      <rect x="1300" y="300" width="90" height="400"/>
    </g>
    <g fill="#0f5a4c">
      <rect x="150" y="470" width="70" height="230"/><rect x="290" y="410" width="50" height="290"/>
      <rect x="520" y="380" width="70" height="320"/><rect x="760" y="440" width="60" height="260"/>
      <rect x="1010" y="470" width="60" height="230"/><rect x="1250" y="440" width="60" height="260"/>
    </g>
    <g fill="#f8c630" opacity="0.16">
      <rect x="350" y="330" width="8" height="12"/><rect x="368" y="330" width="8" height="12"/><rect x="350" y="360" width="8" height="12"/>
      <rect x="598" y="290" width="8" height="12"/><rect x="598" y="320" width="8" height="12"/><rect x="616" y="290" width="8" height="12"/>
      <rect x="820" y="320" width="8" height="12"/><rect x="838" y="320" width="8" height="12"/><rect x="820" y="350" width="8" height="12"/>
      <rect x="1078" y="360" width="8" height="12"/><rect x="1078" y="390" width="8" height="12"/><rect x="1318" y="340" width="8" height="12"/>
    </g>
  </svg>
);
function genCode(){ const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s=""; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function Login(){
  const {t,setUser,lang,setLang}=useStore();
  const [role,setRole]=useState("analyst");
  const [code,setCode]=useState(genCode);
  const [showPwd,setShowPwd]=useState(false);
  return (<div className="bld-login">
    <div className="bld-bg">{Skyline}</div>
    <img className="bld-photo" src="/MOMAH-housingsubsidy/assets/HeroSection.png" alt="" data-i="0"
      onError={e=>{const im=e.currentTarget; const c=["/MOMAH-housingsubsidy/assets/building.jpg","public/assets/HeroSection.png","public/assets/building.jpg","assets/HeroSection.png","assets/building.jpg"]; const i=+(im.dataset.i||0); if(i<c.length){im.dataset.i=i+1; im.src=c[i];} else im.style.display="none";}}/>
    <div className="bld-overlay"/>
    <div className="bld-center">
      <div className="bld-wrap">
        <div className="bld-row2">
          <div className="bld-brand-area">
            <div className="bld-logo">
              <img className="bld-logo-img" src="/assets/logo.png" alt="MoMaH"
                   onError={e=>{const im=e.currentTarget,f=im.dataset.f||"0"; if(f==="0"){im.dataset.f="1";im.src="public/assets/logo.png";} else if(f==="1"){im.dataset.f="2";im.src="assets/logo.png";} else im.style.display="none";}}/>
              <span className="bld-logo-cap">{t("brandLine")}</span>
            </div>
            <h3 style={{color:"#fff"}}>{t("sso_title")}</h3>
            <p>{t("sso_sub")}</p>
          </div>
          <div className="bld-card-col">
            <div className="bld-card fade">
              <h2>{t("signInTitle")}</h2>
              <div className="bld-fg">
                <label>{t("identity")}</label>
                <div className="bld-inp">
                  <span className="ic">👤</span>
                  <select value={role} onChange={e=>setRole(e.target.value)}>
                    {ROLE_KEYS.map(rk=><option key={rk} value={rk}>{t(rk+"_full")}</option>)}
                  </select>
                  <span className="caret">▾</span>
                </div>
              </div>
              <div className="bld-fg">
                <label>{t("password")}</label>
                <div className="bld-inp has-eye">
                  <span className="ic">🔒</span>
                  <input type={showPwd?"text":"password"} value="********" readOnly/>
                  <span className="eye" onClick={()=>setShowPwd(s=>!s)} title="Show/Hide">👁</span>
                </div>
              </div>
              <div className="bld-hint">{t("loginHint")}</div>
              <div className="bld-captcha">
                <div className="bld-code"><span>{code}</span></div>
                <button className="bld-refresh" onClick={()=>setCode(genCode())} title="Refresh">⟳</button>
                <input placeholder={t("securityCode")} maxLength={6}/>
              </div>
              <button className="bld-btn" onClick={()=>setUser(role)}>{t("login_btn")}</button>
              <div className="bld-or">{t("or_")}</div>
              <button className="bld-nic" onClick={()=>setUser(role)}>
                <div className="bld-nic-grid">
                  <i className="g"/><i className="k"/><i className="o"/>
                  <i className="k"/><i className="g"/><i className="k"/>
                  <i className="o"/><i className="k"/><i className="g"/>
                </div>
                <div><div className="l1">{t("nic1")}</div><div className="l2">{t("nic2")}</div></div>
              </button>
              <div className="bld-create">{t("noAccount")} <button>{t("createAccount")}</button></div>
              <div className="bld-langrow">
                <div className="lang-picker" style={{width:160}}><select value={lang} onChange={e=>setLang(e.target.value)}>
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                  <option value="zh">中文</option>
                </select></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div className="bld-copy">{t("copyright")} · {t("syntheticData")}</div>
  </div>);
}

/* =========================================================================
   Shell: top bar + sidebar
   ========================================================================= */
function TopBar(){
  const {t,lang,setLang,currency,setCurrency,user,setUser,reset}=useStore();
  const [open,setOpen]=useState(false);
  return (<div className="topbar">
    <div className="brand">
      <img className="topbar-logo" src="/assets/logo.png" alt="MoMaH" onError={e=>{const im=e.currentTarget,f=im.dataset.f||"0"; if(f==="0"){im.dataset.f="1";im.src="public/assets/logo.png";} else if(f==="1"){im.dataset.f="2";im.src="assets/logo.png";} else im.style.display="none";}}/>
      <span className="topbar-sep"/>
      <span className="topbar-app">{t("appName")}</span>
    </div>
    <div className="right">
      <div className="lang-picker"><select value={lang} onChange={e=>setLang(e.target.value)}>
        <option value="en">English</option>
        <option value="ar">العربية</option>
        <option value="zh">中文</option>
      </select></div>
      <button className="tbtn" onClick={()=>setCurrency(currency==="SAR"?"symbol":"SAR")}>{currency==="SAR"?"SAR":"⃁"}</button>
      <NotifBell/>
      <div className="usermenu">
        <button className="tbtn" onClick={()=>setOpen(o=>!o)}>{UserIcon} {t(user)} ▾</button>
        {open&&<div className="panel" onMouseLeave={()=>setOpen(false)}>
          <div style={{padding:"6px 8px",fontWeight:700}}>{t(user+"_full")}</div>
          <div style={{padding:"2px 8px 10px",fontSize:12}} className="muted">{t(user+"_desc")}</div>
          <div className="divider" style={{margin:"6px 0"}}/>
          <button className="btn ghost sm" style={{width:"100%",marginBottom:6}} onClick={()=>{reset();setOpen(false);}}>↺ {t("resetDemo")}</button>
          <button className="btn danger sm" style={{width:"100%"}} onClick={()=>setUser(null)}>⎋ {t("logout")}</button>
        </div>}
      </div>
    </div>
  </div>);
}

const NAV = {
  analyst:[["nav_home","home"],["nav_data","data"],["nav_formula","formula"],["nav_alloc","alloc"],["nav_mortgage","mortgage"],["nav_forecast","forecast"],["nav_fairness","fairness"],["nav_referrals","monitor"],["nav_impact","impact"],["nav_whatif","whatif"],["nav_packages","packages"],["nav_inventory","inventory"],["nav_benchmark","benchmark"],["nav_audit","audit"],["nav_settings","settings"]],
  owner:[["nav_home","home"],["nav_data","data"],["nav_alloc","alloc"],["nav_forecast","forecast"],["nav_fairness","fairness"],["nav_referrals","monitor"],["nav_impact","impact"],["nav_inventory","inventory"],["nav_benchmark","benchmark"],["nav_approvals","approvals"],["nav_audit","audit"],["nav_settings","settings"]],
  minister:[["nav_cockpit","home"],["nav_decisions","decisions"],["nav_forecast","forecast"],["nav_fairness","fairness"],["nav_impact","impact"],["nav_benchmark","benchmark"],["nav_audit","audit"],["nav_settings","settings"]],
};

const NAV_GROUPS = {
  analyst:[
    {label:"navGroup_alloc", items:[["nav_data","data"],["nav_alloc","alloc"],["nav_forecast","forecast"],["nav_mortgage","mortgage"]]},
    {label:"navGroup_sim", items:[["nav_formula","formula"],["nav_whatif","whatif"],["nav_packages","packages"],["nav_audit","audit"]]},
    {label:"navGroup_monitor", items:[["nav_referrals","monitor"],["nav_fairness","fairness"],["nav_impact","impact"]]},
    {label:"navGroup_tools", items:[["nav_benchmark","benchmark"],["nav_inventory","inventory"]]},
    {label:"navGroup_sys", items:[["nav_settings","settings"]]},
  ],
  owner:[
    {label:"navGroup_approve", items:[["nav_approvals","approvals"],["nav_audit","audit"]]},
    {label:"navGroup_alloc", items:[["nav_data","data"],["nav_alloc","alloc"],["nav_forecast","forecast"]]},
    {label:"navGroup_monitor", items:[["nav_referrals","monitor"],["nav_fairness","fairness"],["nav_impact","impact"]]},
    {label:"navGroup_tools", items:[["nav_inventory","inventory"],["nav_benchmark","benchmark"]]},
    {label:"navGroup_sys", items:[["nav_settings","settings"]]},
  ],
  minister:[
    {label:"navGroup_approve", items:[["nav_decisions","decisions"],["nav_audit","audit"]]},
    {label:"navGroup_observe", items:[["nav_forecast","forecast"],["nav_fairness","fairness"],["nav_impact","impact"],["nav_benchmark","benchmark"]]},
    {label:"navGroup_sys", items:[["nav_settings","settings"]]},
  ],
};
// Release timestamps are in Saudi Arabia Standard Time (AST, UTC+3).
const RELEASES=[
  {ver:"v1.10", date:"2026-06-24 13:34",
    en:["Dashboard: 4 operational KPIs added (Contract Coverage, Monthly Budget Used, Projected Annual Spend, Contract Target)"],
    zh:["仪表盘:新增 4 个运营 KPI(签约覆盖率、当月预算使用、预测全年支出、年度签约达成)"]},
  {ver:"v1.9", date:"2026-06-24 13:20",
    en:["Subsidy Formula: live parameter controls (sliders/dropdown) + preview table + Activate/Rollback","Forecast: seasonal curve + 3-month OLS forecast with ±12% CI, 70/90 alert lines, Monthly/Cumulative toggle","Allocation: structured detail (How / Why / Impact), clearer vs-last-month, annotation"],
    zh:["补贴公式:实时参数控件(滑块/下拉)+ 预览表 + 激活/回滚","预测:季节性曲线 + 3 月 OLS 预测(±12% 置信)、70/90 警戒线、月/累计切换","分配:结构化展开(如何算/为何/影响)、环比说清、加注释"]},
  {ver:"v1.8", date:"2026-06-24 11:58",
    en:["Dashboard KPIs as visuals: radial gauge, mini-area, multi-bar, stacked bar","Data Readiness: data-lineage strip with completeness gate (GO/HOLD)"],
    zh:["仪表盘 KPI 可视化:环形仪表、面积图、多档柱、堆叠条","数据就绪:数据血缘条 + 完整度门控(GO/HOLD)"]},
  {ver:"v1.7", date:"2026-06-24 11:34",
    en:["Benchmarking: KSA/OECD/best bars + colour-coded reference programs","Fairness: region heatmap view (bar / heatmap toggle)","Formula: version timeline + Test-in-What-if","Allocation: submit checklist gate"],
    zh:["国际对标:沙特/OECD/最佳 对比条 + 参照项目颜色编码卡","公平:区域热力图视图(柱状 / 热力 切换)","公式:版本时间线 + 在 What-if 中测试","分配:提交前 Checklist 门控"]},
  {ver:"v1.6", date:"2026-06-24 11:10",
    en:["Dashboard: KPIs are clickable → 12-month trend + income-bracket drill-down","\"Home\" renamed to \"Dashboard\"","Allocation: vs-last-month column, Run What-if per row, agent trace (Show trace)"],
    zh:["仪表盘:KPI 可点击 → 12 个月趋势 + 收入档下钻","\"首页\"改名为\"仪表盘\"","分配:环比上月列、每行跑 What-if、agent 链路(Show trace)"]},
  {ver:"v1.5", date:"2026-06-24 10:46",
    en:["Settings center and Subsidy Formula pages added","Agent Architecture overview (L1/L2/L3 + scope)","AI insight cards on the dashboard; What-if sandbox notice + scenario type","Fairness drill-down by region / income / loan term / age"],
    zh:["新增设置中心与补贴公式页","智能体架构总览(L1/L2/L3 + 职责)","首页 AI 洞察卡片;What-if 沙箱声明 + 情景类型","公平性多维下钻:地区 / 收入 / 贷款期限 / 年龄"]},
  {ver:"v1.4", date:"2026-06-21 10:08",
    en:["Beneficiary tracking, support-type optimizer, benchmarking, inventory & policy-impact pages — full BRD coverage","Data-flow funnel on Data Readiness (6 sources → BIDSC)","Internal use-case codes removed from the UI","Login title fixed to MoMAH"],
    zh:["新增受益方追踪、补贴类型优选、国际对标、库存去化、政策影响等页 —— BRD 全覆盖","Data Readiness 数据流向漏斗(6 源 → BIDSC)","移除界面中的用例编号","登录标题修正为 MoMAH"]},
  {ver:"v1.3", date:"2026-06-20 18:30",
    en:["What-if AI assessment bubble + Apply AI suggestion","Orchestration nodes: progress-fill, agent-purple","Startup crash fixed (classic JSX runtime)"],
    zh:["What-if AI 评估气泡 + 应用 AI 建议","编排节点:进度条填充、agent 紫色","启动崩溃修复(经典 JSX runtime)"]},
  {ver:"v1.2", date:"2026-06-18 14:15",
    en:["Decision packages with SLA + clickable audit trail","Leakage escalation: analyst → BO → minister","Housing Copilot delivery briefs"],
    zh:["决策包 SLA + 可点工单审计","漏损升级:分析师 → 业务负责人 → 部长","Housing Copilot 交付简报"]},
  {ver:"v1.1", date:"2026-06-15 09:40",
    en:["Single sign-on + 3 roles","Data Readiness, Allocation approval flow","Forecast & Fairness, What-if engine"],
    zh:["单点登录 + 三角色","Data Readiness、配分审批流","Forecast & Fairness、What-if 引擎"]},
];
const APP_VER=RELEASES[0].ver;
function ReleaseNotes({onClose}){
  const {t,lang}=useStore(); const pick=(r)=> r[lang]||r.en;
  return (<Modal title={<span className="rel-mtitle">📦 {t("rel_title")}</span>} onClose={onClose}>
    <div className="muted" style={{fontSize:12,marginBottom:14}}>🕓 {t("rel_tz")}</div>
    <div className="rel-time">
      {RELEASES.map((r,i)=>(<div key={r.ver} className={"rel-item"+(i===0?" cur":"")}>
        <span className="rel-dot"/>
        <div className="rel-head"><b>{r.ver}</b> <span className="muted" style={{fontSize:12}}>· {r.date} AST</span>{i===0?<span className="chip" style={{marginInlineStart:8}}>{t("rel_current")}</span>:null}</div>
        <ul className="rel-list">{pick(r).map((x,j)=>(<li key={j}>{x}</li>))}</ul>
      </div>))}
    </div>
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:6}}>
      <button className="btn secondary" onClick={onClose}>{t("rel_close")}</button>
    </div>
  </Modal>);
}
function Sidebar(){
  const {t,user,route,setRoute,packages,configChanges}=useStore();
  const [rel,setRel]=useState(false);
  const groups = NAV_GROUPS[user]||[];
  const pendingForOwner = packages.filter(p=>p.status==="submitted").length;
  const pendingForMin = packages.filter(p=>p.status==="escalated").length;
  const pendingConfigForOwner = configChanges.filter(c=>c.status==="pending"&&!c.p03Required).length;
  const pendingConfigForMin = configChanges.filter(c=>c.status==="pending"&&c.p03Required).length;
  // Dashboard route differs by role
  const dashRoute = user==="minister" ? "cockpit" : "home";
  const dashLabel = user==="minister" ? "nav_cockpit" : "nav_home";
  const dashIcon = user==="minister" ? "home" : "home";
  return (<div className="sidebar">
    <div className="sidebar-scroll">
      {/* Dashboard — standalone, outside groups */}
      <div className={"navitem navitem-dash"+(route===dashRoute?" active":"")} onClick={()=>setRoute(dashRoute)}>
        <Icon name={dashIcon}/><span style={{flex:1}}>{t(dashLabel)}</span></div>
      <div className="sidebar-divider"/>
      {/* Nav groups */}
      {groups.map((g,gi)=>(<div key={gi} style={{marginBottom:4}}>
        <div className="sidebar-section-title">{t(g.label)}</div>
        {g.items.map(([k,ic])=>{
          const key=k.replace("nav_","");
          const badge = (user==="owner"&&k==="nav_approvals"&&(pendingForOwner+pendingConfigForOwner))||(user==="minister"&&k==="nav_decisions"&&(pendingForMin+pendingConfigForMin));
          return (<div key={k} className={"navitem"+(route===key?" active":"")} onClick={()=>setRoute(key)}>
            <Icon name={ic}/><span style={{flex:1}}>{t(k)}</span>
            {badge?<span className="badge-count">{badge}</span>:null}</div>);
        })}
      </div>))}
    </div>
    <div className="side-foot">
      <div className="hardboundary-footer">{t("hardboundary")}</div>
      <div className="side-foot-row">
        <button className="side-foot-btn" onClick={()=>setRoute("permissions")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          {t("permissionMatrix")}
        </button>
        <button className="side-foot-btn" onClick={()=>setRel(true)} title={t("rel_title")}>
          <span className="ver-dot"/> {APP_VER}
        </button>
      </div>
    </div>
    {rel&&<ReleaseNotes onClose={()=>setRel(false)}/>}
  </div>);
}

const RECO_PARAMS = { reallocatePct:0.20, capHighPct:0.25, boostLowPct:0.08, offPlanPct:0.10 };
// BRD 3.5: 5-yr savings expected range 1.37B–3.4B of the 7.9B Phase-3 budget; 3.4B is the upper bound.
const SAVINGS_CEIL = 3.4e9;

function PageHeader({title,sub,right}){
  return (<div className="page-h"><div><h1>{title}</h1>{sub&&<div className="sub">{sub}</div>}</div>{right}</div>);
}
function bandLabel(t,key){ return t("bl_"+key); }

/* ---- Analyst home ---- */
function AnalystHome(){
  const {t,setRoute,packages,baseline}=useStore(); const {money}=useMoney();
  const [kd,setKd]=useState(null);
  const reco=useMemo(()=>computeAllocation(RECO_PARAMS),[]);
  const sv=scenarioSavings(reco, baseline.spend);
  const myPending=packages.filter(p=>p.status==="submitted").length;
  const SCENARIOS=[
    {icon:"cycle", title:t("scenario_cycle_title"), desc:t("scenario_cycle_desc"), tag:t("tag_monthly"),
      steps:[["nav_data","data"],["nav_formula","formula"],["nav_alloc","alloc"],["nav_forecast","forecast"]], start:"data", btn:t("scenario_cycle_start")},
    {icon:"whatif", title:t("scenario_policy_title"), desc:t("scenario_policy_desc"), tag:t("tag_ai"),
      steps:[["nav_whatif","whatif"],["nav_packages","packages"],["nav_audit","audit"],["nav_copilot","copilot"]], start:"whatif", btn:t("scenario_policy_start")},
    {icon:"monitor", title:t("scenario_monitor_title"), desc:t("scenario_monitor_desc"), tag:t("tag_auto"),
      steps:[["nav_referrals","monitor"],["nav_fairness","fairness"],["nav_impact","impact"],["nav_dash360","dash360"]], start:"referrals", btn:t("scenario_monitor_start")},
  ];
  return (<div className="fade">
    <PageHeader title={t("home_hello")+" · "+t("analyst_full")} sub={t("monthlyCycle")}/>
    <div className="cols-4" style={{marginBottom:16}}>
      <MegaKpi title={t("kpi_ownership")} delta="▲ +0.8pp" onClick={()=>setKd("ownership")}>
        <RadialGauge value={66.24} target={70} max={100} unit="%"/></MegaKpi>
      <MegaKpi title={t("kpi_hbr")} value={pct1(baseline.HBR)} delta="▼ −0.6pp" onClick={()=>setKd("hbr")}>
        <MiniArea series={KPI_DETAIL.hbr.series} thr={38} min={34} max={42}/></MegaKpi>
      <MegaKpi title={t("kpi_fairness")} value={baseline.FG.toFixed(2)} delta="▲ +0.04" onClick={()=>setKd("fairness")}>
        <MiniBars data={KPI_DETAIL.fairness.drill} thr={1.0}/></MegaKpi>
      <MegaKpi title={t("kpi_budget")} value={(baseline.spend/(BRD.phase3BudgetSAR/BRD.phase3Years)*100).toFixed(0)+"%"} delta="▼ −2.1pp" onClick={()=>setKd("budget")}>
        <StackedBar segments={[{v:54,c:"var(--primary)"},{v:22,c:"#5aa6e0"},{v:13,c:"#f0a91e"}]} marks={[70,90]} total={100}/></MegaKpi>
    </div>
    {kd&&<KpiDetailModal kpi={kd} onClose={()=>setKd(null)}/>}
    <div className="cols-4" style={{marginBottom:16}}>
      <KPI label={t("kpi_coverage")} value="82%" sub="6,950 / 8,500" tone="warn"/>
      <KPI label={t("kpi_mbudget")} value="⃁ 121M" sub={"92% "+t("of_monthly")} tone="warn"/>
      <KPI label={t("kpi_projAnnual")} value="⃁ 1.49B" sub={"94% "+t("of_ceiling")} tone="warn"/>
      <KPI label={t("kpi_target")} value="90%" sub="332K / 367K" tone="good"/>
    </div>
    <AIInsights/>
    <Section title={t("scenarios")}>
      <div className="cols-3">
        {SCENARIOS.map((s,i)=>(<div key={i} className="card pad" style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{width:20,height:20,display:"inline-flex",alignItems:"center"}}><Icon name={s.icon}/></span>
            <strong style={{fontSize:14}}>{s.title}</strong>
            <span className="chip gray" style={{marginInlineStart:"auto",fontSize:10}}>{s.tag}</span>
          </div>
          <div className="muted" style={{fontSize:12}}>{s.desc}</div>
          <div style={{display:"flex",gap:5,alignItems:"center",fontSize:11,flexWrap:"wrap"}}>
            {s.steps.map(([k,ic],j)=>(<React.Fragment key={k}>
              {j>0&&<span style={{color:"var(--muted)",fontSize:10}}>→</span>}
              <span className="chip gray" style={{fontSize:10.5,display:"inline-flex",alignItems:"center",gap:4}}><Icon name={ic}/> {t(k)}</span>
            </React.Fragment>))}
          </div>
          <button className="btn sm" style={{alignSelf:"flex-start"}} onClick={()=>setRoute(s.start)}>{s.btn} {ArrowIcon}</button>
        </div>))}
      </div>
    </Section>
    <Section title={t("agent_status")} sub={t("agent_status_sub")}>
      <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
        {[["L1 · Allocation","var(--primary)"],["L1 · Forecasting","var(--primary)"],["L1 · Beneficiary","var(--primary)"],
          ["L2 · Benchmarking","var(--primary)"],["L2 · Impact","var(--primary)"],
          ["L3 · Orchestrator","#6d5ae6"],["L3 · Route","#6d5ae6"],["L3 · Handoff","#6d5ae6"]].map(([n,c],i)=>
          <span key={i} style={{display:"flex",alignItems:"center",gap:4,fontSize:12}}>
            <span className="agent-dot" style={{width:7,height:7,borderRadius:"50%",background:c,boxShadow:"0 0 6px "+c}}/>
            <span className="muted">{n}</span>
          </span>)}
      </div>
    </Section>
  </div>);
}

/* ---- Data readiness ---- */
// Particle burst fired from the "Run" button centre — palm-green dots floating up & fading.
function ParticleBurst(){
  const parts=Array.from({length:16},()=>({dx:(Math.random()-.5)*140, dy:-30-Math.random()*90, d:(Math.random()*0.25).toFixed(2)}));
  return <span className="burst" aria-hidden="true">{parts.map((p,i)=><i key={i} style={{"--dx":p.dx+"px","--dy":p.dy+"px","--d":p.d+"s"}}/>)}</span>;
}
function DataReadiness(){
  const {t,user,budget,saveBudget,lang,currency}=useStore();
  const cur=currency==="symbol"?"⃁":"SAR";
  const [sources,setSources]=useState(DATA_SOURCES);
  const [running,setRunning]=useState(false); const [prog,setProg]=useState(100); const [done,setDone]=useState(true);
  const [flash,setFlash]=useState(false); const [ranOnce,setRanOnce]=useState(false);
  const [burst,setBurst]=useState(0); const [shake,setShake]=useState(false);
  const [exc,setExc]=useState(4.2); const [uploaded,setUploaded]=useState(null);
  const [bform,setBform]=useState({cash:budget.cash, inkind:budget.inkind, ceiling:budget.ceiling}); const [saved,setSaved]=useState(false);
  const [syncTime,setSyncTime]=useState("2026-06-15 06:00"); const [syncOk]=useState(true);
  const [showUp,setShowUp]=useState(false); const [file,setFile]=useState(null); const [checking,setChecking]=useState(false); const [chk,setChk]=useState(null); const [over,setOver]=useState(false);
  const fileRef=useRef(null);
  function run(){
    setRunning(true); setDone(false); setProg(0); setFlash(false);
    setBurst(Date.now()); setShake(true); setTimeout(()=>setShake(false),450);
    let p=0; const id=setInterval(()=>{ p+=10; setProg(p);
      if(p>=100){ clearInterval(id); setRunning(false); setDone(true); setRanOnce(true);
        setSources(prev=>prev.map(s=>({
          ...s,
          records: s.records + Math.max(1, Math.round(s.records*(0.001+Math.random()*0.004))),
          completeness: Math.min(99, s.completeness + 1 + Math.floor(Math.random()*2)),
          exc: +(1+Math.random()*8).toFixed(1),
          updated: s.status==="ok" ? "Just now" : s.updated,
        })));
        setExc(+(3+Math.random()*3).toFixed(1)); setSyncTime(nowStr(lang));
        setFlash(true); setTimeout(()=>setFlash(false), 1300);
      }
    },110);
  }
  function pickFile(name){ setFile(name); setChk(null); setChecking(true);
    setTimeout(()=>{ const comp=86+Math.floor(Math.random()*12); const ex=+(2+Math.random()*9).toFixed(1); const recs=8000+Math.floor(Math.random()*4000); setChk({comp,ex,recs,valid:comp>=90&&ex<=10}); setChecking(false); },1100);
  }
  function doImport(){ setUploaded(file+" · "+nowStr("en")); setShowUp(false); setFile(null); setChk(null); }
  const totalRecords=sources.reduce((s,x)=>s+x.records,0);
  const avgComp=Math.round(sources.reduce((s,x)=>s+x.completeness,0)/sources.length);
  const qkey=exc>10?"qExc":avgComp<90?"qBelow":"qOk";
  const qtone=qkey==="qOk"?"good":qkey==="qBelow"?"warn":"bad";
  const opStatus = avgComp>=90&&exc<=5 ? "qPass" : exc>10 ? "qFail" : "qPartial";
  const opTone = opStatus==="qPass"?"good":opStatus==="qFail"?"danger":"amber";
  const todayStr=nowStr(lang);
  return (<div className={"fade"+(shake?" page-shake":"")}>
    <PageHeader title={t("nav_data")} sub={<span style={{color:syncOk?"var(--primary)":"var(--danger)",fontWeight:700}}>{(syncOk?"✓ ":"✕ ")+t(syncOk?"syncOk":"syncFail")+" · "+t("lastSyncAt")+": "+syncTime}</span>}
      right={<div style={{display:"flex",gap:8,alignItems:"center"}}>
        {user==="analyst"&&<button className="btn secondary sm" onClick={()=>setShowUp(true)}><svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/></svg> {t("uploadBidsc")}</button>}
        <span className="btn-burst-wrap">
          <button className="btn" onClick={run} disabled={running}>{running?t("running"):t("runCycle")}</button>
          {burst?<ParticleBurst key={burst}/>:null}
        </span>
      </div>}/>
    {user==="analyst"&&uploaded&&<div className="banner" style={{marginBottom:14}}>✓ {uploaded} — {t("uploadedOk")} · <span className="muted">{t("uploadHint")}</span></div>}
    <Section title={<span className="sect-right">{t("qreport")} · <span className={"chip "+(qtone==="good"?"":qtone==="warn"?"amber":"danger")}>{t(qkey)}</span></span>}
      sub={<span style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span className={"chip "+opTone}>● {t(opStatus)}</span>
        <span className="muted">{t("dl_session")}: {todayStr} · {t("totalRecords")}: {n0(totalRecords)}</span>
      </span>}
      right={<span className="sect-right">{t("dl_balance")}<span className="chip">{t("budgetBalance")}</span></span>}>
      <div className="dr-strip">
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("totalRecords")}</div><div className="v">{n0(totalRecords)}</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("avgCompleteness")}</div><div className="v" style={{color:avgComp>=90?"var(--primary)":"var(--amber)"}}>{avgComp}%</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("exceptions")}</div><div className="v" style={{color:exc>10?"var(--danger)":"var(--primary)"}}>{exc}%</div></div>
        {[["cash","bud_cash"],["inkind","bud_inkind"],["ceiling","bud_ceiling"]].map(([f,lk])=>(
          <div key={f} className="mini-kpi">
            <div className="muted" style={{fontSize:11.5}}>{t(lk)} <span style={{opacity:.7}}>({cur} · M)</span></div>
            {user==="owner"
              ? <input className="input mono" style={{height:30,padding:"0 8px",marginTop:4,fontSize:14,width:"100%"}} type="number" value={bform[f]} onChange={e=>{setBform({...bform,[f]:e.target.value});setSaved(false);}}/>
              : <div className="v">{cur} {n0(budget[f])}<span className="muted" style={{fontSize:11,fontWeight:400}}> M</span></div>}
          </div>))}
      </div>
      {user==="owner"&&<div style={{display:"flex",alignItems:"center",gap:12,marginTop:12,flexWrap:"wrap"}}>
        <button className="btn sm" onClick={()=>{saveBudget({cash:+bform.cash,inkind:+bform.inkind,ceiling:+bform.ceiling});setSaved(true);}}>💾 {t("saveBalance")}</button>
        {saved&&<span className="chip">✓ {t("done")}</span>}
        <span className="muted" style={{fontSize:12}}>{t("enteredBy")}: {t(budget.enteredBy)} · {budget.enteredAt}</span>
      </div>}
      {budget.daysSince>30&&<div className="banner" style={{marginTop:12,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("budStale")}</div>}
    </Section>
    <Section title="BIDSC" right={<AgentBadge name={t("agent_data")} lvl="L1"/>}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:6}}>
        <div style={{flex:1}}><Progress v={prog/100}/></div>
        <span className="chip">{running?(t("writingBidsc")+" "+prog+"%"):("✓ "+t("bidscDone"))}</span>
      </div>
      {ranOnce&&done&&<div className="muted" style={{fontSize:12,marginTop:8}}>✓ {t("cycleDone")}</div>}
    </Section>
    {running&&<div className="skel-area">
      <div className="cols-3">
        {[0,1,2].map(i=>(<div key={i} className="skel-card">
          <div className="skel-bar w50"/><div className="skel-bar w85"/><div className="skel-bar w65"/><div className="skel-bar w40"/>
        </div>))}
      </div>
    </div>}
    <div className="dr-funnel" aria-hidden="true">
      <svg className="dr-funnel-svg" viewBox="0 0 200 56" width="160" height="44">
        <defs><linearGradient id="fnlG" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.10"/><stop offset="100%" stopColor="var(--primary)" stopOpacity="0.34"/>
        </linearGradient></defs>
        <path d="M20 54 L180 54 L116 26 L84 26 Z" fill="url(#fnlG)" stroke="var(--primary)" strokeOpacity="0.22"/>
        <path className="fnl-arrow" d="M72 28 L100 4 L128 28 Z" fill="var(--primary)"/>
      </svg>
      <span className="dr-funnel-cap">{t("srcFlowCap")}</span>
    </div>
    <div className="src-group">
      <div className="src-group-head"><strong>{t("srcGroup")}</strong><span className="chip">● {sources.length} {t("connected")}</span></div>
      <div className={"cols-3"+(flash?" flash-sources":"")}>
      {sources.map(s=>{
        const tone=s.status==="ok"?"var(--primary)":"var(--amber)";
        const excHigh=s.exc>10; const excCol=excHigh?"var(--danger)":"var(--primary)";
        return (<div key={s.key} className="card pad">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <strong>{t("src_"+s.key)}</strong>
            <span className="chip" style={{background:tone+"22",color:tone}}>● {statusToText(t,s.status)}</span></div>
          <div className="kv">
            <div className="kv-row"><span className="muted">{t("records")}</span><span className="mono">{n0(s.records)}</span></div>
            <div className="kv-row"><span className="muted">{t("freq")}</span><span>{s.freq}</span></div>
            <div className="kv-row"><span className="muted">{t("lastUpdate")}</span><span>{s.updated}</span></div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,margin:"10px 0 4px"}}>
            <span className="muted">{t("completeness")}</span><span className="mono">{s.completeness}%</span></div>
          <Progress v={s.completeness/100} color="var(--primary)"/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,margin:"8px 0 4px"}}>
            <span className="muted">{t("exceptions")} <span style={{opacity:.7}}>(≤ 10%)</span></span><span className="mono" style={{color:excCol,fontWeight:700}}>{s.exc}%</span></div>
          <Progress v={Math.min(1,s.exc/15)} color={excCol}/>
          {excHigh&&<div className="muted" style={{fontSize:11,marginTop:6,color:"var(--danger)"}}>⚠ {t("qExc")}</div>}
        </div>);
      })}
      </div>
    </div>
    <Section title={t("dl_title")}>
      <div className="lineage">
        <div className="ln-node">BIDSC</div>
        <span className="ln-arrow">→</span>
        <span className={"chip "+(avgComp>=90?"":"amber")} style={{flex:"0 0 auto"}}>{avgComp>=90?("● "+t("dl_go")):("● "+t("dl_hold"))}</span>
        <span className="ln-arrow">→</span>
        <div className="ln-node">{t("dl_opt")}</div>
        <div className="ln-node">{t("dl_fc")}</div>
        <div className="ln-node">{t("dl_track")}</div>
      </div>
    </Section>
    {showUp&&<Modal title={t("importTitle")} onClose={()=>{setShowUp(false);setFile(null);setChk(null);}}>
      <div className={"dropzone"+(over?" over":"")}
        onDragOver={e=>{e.preventDefault();setOver(true);}}
        onDragLeave={()=>setOver(false)}
        onDrop={e=>{e.preventDefault();setOver(false);const f=e.dataTransfer.files&&e.dataTransfer.files[0];if(f)pickFile(f.name);}}
        onClick={()=>fileRef.current&&fileRef.current.click()}>
        <div className="di">⬆</div>
        <div style={{fontWeight:700}}>{t("dropHint")}</div>
        <input ref={fileRef} type="file" style={{display:"none"}} onChange={e=>{const f=e.target.files&&e.target.files[0];if(f)pickFile(f.name);}}/>
      </div>
      {file&&<div style={{marginTop:16}}>
        <div style={{fontSize:13,marginBottom:10}}><b>{t("fileLabel")}:</b> {file}</div>
        {checking ? <div className="ai-working">⟳ {t("validating")}</div>
          : chk && <div>
            <div className="cols-3" style={{marginBottom:12}}>
              <div className="mini-kpi"><div className="muted">{t("records")}</div><div className="v">{n0(chk.recs)}</div></div>
              <div className="mini-kpi"><div className="muted">{t("completeness")}</div><div className="v" style={{color:chk.comp>=90?"var(--primary)":"var(--danger)"}}>{chk.comp}%</div></div>
              <div className="mini-kpi"><div className="muted">{t("exceptions")}</div><div className="v" style={{color:chk.ex<=10?"var(--primary)":"var(--danger)"}}>{chk.ex}%</div></div>
            </div>
            <div className="banner" style={chk.valid?{}:{background:"var(--danger-50)",borderColor:"#f0b4ad",color:"#7a241d"}}>{chk.valid?("✓ "+t("checkPass")):("✕ "+t("checkFail"))}</div>
            {chk.valid && <button className="btn" style={{marginTop:12,width:"100%",justifyContent:"center"}} onClick={doImport}>⬆ {t("importBtn")}</button>}
          </div>}
      </div>}
    </Modal>}
    {/* BR-09 Segment Trend Report */}
    <Section title={<span className="sect-right">{t("bt_segTrend")}<InfoTip text={t("bt_segTrendTip")}/></span>} sub={t("bt_segTrendSub")}>
      <div className="cols-3" style={{marginBottom:10}}>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_segExpected")}</div><div className="v">42</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_segMobile")}</div><div className="v">{t("bt_band_low")}</div><div className="muted" style={{fontSize:11}}>Asir · Riyadh</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_segBudgetImpact")}</div><div className="v" style={{color:"var(--amber)"}}>-183K/mo</div></div>
      </div>
      <div className="muted" style={{fontSize:12}}>{t("bt_segMore")}</div>
    </Section>
    {/* BR-10 Outcome Scorecard */}
    <Section title={<span className="sect-right">{t("bt_scorecard")}<InfoTip text={t("bt_scorecardTip")}/></span>} sub={t("bt_scorecardSub")}>
      <div className="cols-4" style={{marginBottom:10}}>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreOwn")}</div><div className="v" style={{color:"var(--primary)"}}>18%</div></div>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreStable")}</div><div className="v" style={{color:"var(--primary)"}}>42%</div></div>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreDefault")}</div><div className="v" style={{color:"var(--danger)"}}>11%</div></div>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreExit")}</div><div className="v" style={{color:"var(--amber)"}}>29%</div></div>
      </div>
      <table className="tbl"><thead><tr><th>{t("bt_band")}</th><th>{t("bt_scoreOwn")}</th><th>{t("bt_scoreStable")}</th><th>{t("bt_scoreDefault")}</th><th>{t("bt_scoreExit")}</th><th>{t("cmp_notes")}</th></tr></thead>
        <tbody>
          {[["band_urgent","8%","31%","18%","43%",t("bt_scoreUrgentNote")],["band_low","21%","47%","8%","24%",t("bt_scoreLowNote")],["band_mid","25%","42%","10%","23%",t("bt_scoreMidNote")]].map(r=>
            <tr key={r[0]}><td>{t(r[0])}</td><td className="mono">{r[1]}</td><td className="mono">{r[2]}</td><td className="mono">{r[3]}</td><td className="mono">{r[4]}</td><td className="muted">{r[5]}</td></tr>)}
      </tbody></table>
      <div className="muted" style={{fontSize:12,marginTop:8}}>{t("bt_scorecardNote")}</div>
    </Section>
  </div>);
}

/* ---- Allocation ---- */
const ALLOC_VSPREV=[82,58,-21,-34,12,-8,15];
function computeRegionAlloc(src, region){
  if(!region||region==="all") return src;
  const r=REGIONS.find(x=>x.key===region); if(!r) return src;
  const w=r.w, pi=r.priceIdx;
  const rows=src.rows.map(b=>{
    const contracts=Math.round(b.contracts*w);
    const subsidy=Math.round(b.subsidy*pi);
    const homePrice=Math.round(b.homePrice>0?b.homePrice*pi:0);
    const pkg=Math.round(b.pkg*pi);
    const principal=Math.max(0, homePrice*(1-(b.homePrice>0?0.1:0))-pkg);
    const hbr=homePrice>0?monthlyPayment(principal)/b.incomeAvg:0;
    return {...b, contracts, subsidy, homePrice, pkg, hbr, cShare:0};
  });
  const tot=rows.reduce((s,x)=>s+x.contracts,0);
  if(tot>0) rows.forEach(x=>{x.cShare=x.contracts/tot;});
  const spend=rows.reduce((s,x)=>s+x.contracts*x.subsidy,0);
  const avgHbr=rows.reduce((s,x)=>s+x.hbr*x.contracts,0)/(tot||1);
  return { rows, spend, FG:r.fg, HBR:avgHbr, totContracts:tot };
}
function Allocation(){
  const {t,user,allocation,recalcAlloc,submitAlloc,actAlloc,setRoute,baseline,settingsVals,setWhatifContext}=useStore(); const {moneyFull}=useMoney();
  const fgMin = settingsVals.set_fgMin ?? 1.0;
  const hbrCeil = (settingsVals.set_hbrCeil ?? 38) / 100;
  const annualBudgetSetting = settingsVals.set_annual ?? 1580;
  const [open,setOpen]=useState(null);
  const [busy,setBusy]=useState(false); const [note,setNote]=useState(""); const [err,setErr]=useState(false);
  const [gateDataChecked,setGateDataChecked]=useState(false);
  const [annoOpen,setAnnoOpen]=useState(null);
  const [selRegion,setSelRegion]=useState("all");
  const a=allocation||{lastSync:"—",recalcAt:null,status:"draft",rejectNote:""};
  const data=useMemo(()=>computeRegionAlloc(baseline,selRegion),[baseline,selRegion]);
  const rgInfo=selRegion==="all"?null:REGIONS.find(x=>x.key===selRegion);
  const annualBudget = (annualBudgetSetting * 1e6) || (BRD.phase3BudgetSAR / BRD.phase3Years);
  const regionBudget=rgInfo?annualBudget*rgInfo.w:annualBudget;
  function doRecalc(){ setBusy(true); setTimeout(()=>{ recalcAlloc&&recalcAlloc(); setBusy(false); },900); }
  function doReject(){ if(!note.trim()){ setErr(true); return; } actAlloc&&actAlloc("reject",note.trim()); setNote(""); setErr(false); }
  const cmap={draft:"gray",submitted:"info",approved:"",rejected:"danger"};
  const statusChip=<span className={"chip "+(cmap[a.status]||"")}>{t("allocStatus_"+a.status)}</span>;
  return (<div className="fade">
    <PageHeader title={t("nav_alloc")} sub={t("alloc_sub")} right={statusChip}/>
    <div className="dr-strip" style={{marginBottom:16}}>
      <div className={"mini-kpi"+(data.spend<=regionBudget?"":" alert-mini")}><div className="muted" style={{fontSize:11.5}}>Budget Ceiling</div><div className="v" style={{color:data.spend<=regionBudget?"var(--primary)":"var(--amber)"}}>{data.spend<=regionBudget?"✅ Within":"⚠️ Over"}</div></div>
      <div className={"mini-kpi"+(data.FG>=fgMin?"":" alert-mini")}><div className="muted" style={{fontSize:11.5}}>Fairness Gap ≥ {fgMin.toFixed(1)}</div><div className="v" style={{color:data.FG>=fgMin?"var(--primary)":"var(--amber)"}}>{data.FG>=fgMin?"✅ "+data.FG.toFixed(2):"⚠️ "+data.FG.toFixed(2)}</div></div>
      <div className={"mini-kpi"+(data.HBR<=hbrCeil?"":" alert-mini")}><div className="muted" style={{fontSize:11.5}}>HBR ≤ {pct1(hbrCeil)}</div><div className="v" style={{color:data.HBR<=hbrCeil?"var(--primary)":"var(--amber)"}}>{data.HBR<=hbrCeil?"✅ "+pct1(data.HBR):"⚠️ "+pct1(data.HBR)}</div></div>
      <div className="region-picker"><select value={selRegion} onChange={e=>setSelRegion(e.target.value)}>
        <option value="all">{t("rg_national")}</option>
        <option disabled>──────────</option>
        {REGIONS.map(r=><option key={r.key} value={r.key}>{t("rg_"+r.key)}</option>)}
      </select></div>
    </div>
    <Section title={t("alloc_autosync")}>
      <div className="cols-3" style={{marginBottom:14}}>
        <div><div className="muted" style={{fontSize:12}}>{t("lastSyncAt")}</div><div style={{fontWeight:700,marginTop:3}}>{a.lastSync}</div></div>
        <div><div className="muted" style={{fontSize:12}}>{t("lastRecalc")}</div><div style={{fontWeight:700,marginTop:3}}>{a.recalcAt||"—"}</div></div>
        <div><div className="muted" style={{fontSize:12}}>{t("status")}</div><div style={{marginTop:5}}><span className={"chip "+(cmap[a.status]||"")}>{t("allocStatus_"+a.status)}</span></div></div>
      </div>
      {a.status==="rejected"&&a.rejectNote&&<div className="banner" style={{marginBottom:12,background:"var(--danger-50)",borderColor:"#f0b4ad",color:"#7a241d"}}>✕ {t("rejectReason")}: {a.rejectNote}</div>}
      {user==="analyst"&&(a.status==="draft"||a.status==="rejected")&&<div className="gate-box">
        <label className="gate-row"><input type="checkbox" checked={gateDataChecked} onChange={e=>setGateDataChecked(e.target.checked)}/> {t("al_gateAll")}</label>
      </div>}
      {user==="analyst"&&<div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <button className="btn secondary sm" onClick={doRecalc} disabled={busy}>{busy?t("recalculating"):("↻ "+t("recalc"))}</button>
        {(a.status==="draft"||a.status==="rejected")&&<button className="btn sm" onClick={()=>submitAlloc&&submitAlloc()} disabled={!gateDataChecked}>✔ {t("approveSubmit")}</button>}
        {a.status==="submitted"&&<span className="chip info">⏳ {t("allocStatus_submitted")}</span>}
        {a.status==="approved"&&<span className="chip">✓ {t("allocStatus_approved")}</span>}
      </div>}
      {user==="owner"&&(a.status==="submitted"?<div>
        <input className="input" placeholder={t("rejectReasonPh")} value={note} onChange={e=>{setNote(e.target.value);setErr(false);}} style={{marginBottom:err?4:10}}/>
        {err&&<div style={{color:"var(--danger)",fontSize:12,marginBottom:8}}>{t("needReason")}</div>}
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button className="btn sm" onClick={()=>actAlloc&&actAlloc("approve")}>✔ {t("approve")}</button>
          <button className="btn danger sm" onClick={doReject}>✕ {t("reject")}</button>
        </div>
      </div> : a.status==="approved"?<span className="chip">✓ {t("allocStatus_approved")}</span>
        : a.status==="rejected"?<span className="chip danger">✕ {t("allocStatus_rejected")}</span>
        : <div className="muted" style={{fontSize:13}}>{t("notSubmittedYet")}</div>)}
    </Section>
    <Section title={<span className="sect-right">{t("monthlyCycle")}<InfoTip text={t("fml_alloc")}/></span>} right={<span className="sect-right"><span className="chip">{t("kpi_budget")}: {(data.spend/regionBudget*100).toFixed(0)}%</span><AgentBadge name={t("agent_alloc")} lvl="L2"/></span>}>
      <div className="scrollx"><table className="tbl">
        <thead><tr><th>{t("incomeBand")}</th><th className="right-num">{t("contracts")}</th><th className="right-num">{t("subsidy")}</th><th className="right-num">{t("supportType")}</th><th className="right-num">{t("share")}</th><th className="right-num">{t("al_vsPrev")}</th><th></th></tr></thead>
        <tbody>{data.rows.map((r,i)=>{ const dv=r.subsidy>0?ALLOC_VSPREV[i%ALLOC_VSPREV.length]:null; return (<React.Fragment key={r.key}>
          <tr>
            <td>{bandLabel(t,r.key)} {r.below?<span className="chip gray" style={{marginInlineStart:6}}>{t("below10k")}</span>:null}</td>
            <td className="right-num mono">{n0(r.contracts)}</td>
            <td className="right-num mono">{moneyFull(r.subsidy)}</td>
            <td className="right-num"><span className="chip" style={{fontSize:10,whiteSpace:"nowrap"}}>{r.below?t("st_mix"):t("st_monthly")}</span><br/><span className="muted" style={{fontSize:10}}>+{moneyFull(r.pkg)} {t("st_package")}</span></td>
            <td className="right-num mono">{(r.cShare*100).toFixed(1)}%</td>
            <td className="right-num mono" style={{color:dv==null?"var(--muted)":dv>0?"var(--amber)":"var(--primary)",fontSize:12}}>{dv==null?"—":(dv>0?"▲ +":"▼ ")+"⃁ "+Math.abs(dv)}</td>
            <td className="right-num"><button className="btn sm" onClick={()=>setOpen(open===i?null:i)}>{t("explain")}</button></td>
          </tr>
          {open===i&&<tr className="expand-row"><td colSpan={7}>
            <div style={{fontSize:12.5}}>
              <div className="alx-grid">
                <div><div className="alx-h">{t("alx_how")}</div><div className="muted">{t("alx_howT")}<br/><span className="chip gray" style={{marginTop:4}}>FML-v1.0 · Ded. 40% · Dur. 20y</span></div></div>
                <div><div className="alx-h">{t("alx_why")}</div><div className="muted">{bandLabel(t,r.key)} — {r.below?t("below10k"):t("above10k")}<br/>{t("subsidy")}: {moneyFull(r.subsidy)} · HBR {pct1(r.hbr)}</div></div>
                <div><div className="alx-h">{t("alx_impact")}</div><div className="muted">FG→{data.FG.toFixed(2)} · Budget {(data.spend/regionBudget*100).toFixed(0)}%<br/>Share {(r.cShare*100).toFixed(1)}% of {n0(Math.round(ANNUAL_CONTRACTS*(rgInfo?rgInfo.w:1)))} contracts</div></div>
              </div>
              {dv!=null&&<div style={{marginTop:8}}><b>{t("al_vsPrev")}:</b> <span className="mono" style={{color:dv>0?"var(--amber)":"var(--primary)"}}>{(dv>0?"+":"")}⃁ {dv}</span> <span className="muted">— {t("alx_reason")}</span></div>}
              <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
                <button className="btn secondary sm" onClick={()=>{
                  setWhatifContext({ bandKey:r.key, bandLabel:bandLabel(t,r.key), subsidy:r.subsidy, pkg:r.pkg, hbr:r.hbr, cShare:r.cShare, below:r.below, homePrice:r.homePrice });
                  setRoute&&setRoute("whatif");
                }}>✦ {t("wf_runHint")}</button>
                <button className="btn ghost sm" onClick={()=>setAnnoOpen(annoOpen===i?null:i)}>🏷️ {t("alx_annotate")}</button>
              </div>
              {annoOpen===i&&<textarea className="input" placeholder={t("alx_annoPh")} style={{marginTop:8,minHeight:54,width:"100%"}}/>}
              <div className="trace">
                <div style={{fontWeight:700,fontSize:12,marginBottom:6}}>▶ {t("al_showTrace")}</div>
                <div className="trace-step"><span className="ts-dot"/><div><b>{t("agent_data")}</b> · L1<br/><span className="muted">{t("tr_data")}</span></div></div>
                <div className="trace-step"><span className="ts-dot"/><div><b>{t("agent_alloc")}</b> · L2<br/><span className="muted">{t("tr_opt")}</span></div></div>
                <div className="trace-step"><span className="ts-dot"/><div><b>{t("agent_alloc")}</b> · L2<br/><span className="muted">{t("tr_type")}</span></div></div>
              </div>
            </div></td></tr>}
        </React.Fragment>);})}</tbody>
      </table></div>
    </Section>
  </div>);
}

/* ---- Forecast & Fairness ---- */
function ForecastFairness(){
  const {t,user,leaks,leakAct,baseline,settingsVals}=useStore(); const {money}=useMoney();
  const scn=baseline; const fc=useMemo(()=>buildForecast(scn, settingsVals.set_earlyAlert||70),[settingsVals.set_earlyAlert]);
  const regions=useMemo(()=>fgByRegion(scn.FG, baseline.FG),[]);
  const [dim,setDim]=useState("region");
  const [view,setView]=useState("bar");
  const dimData={
    region: regions.map(r=>({name:t("rg_"+r.key),fg:r.fg})),
    income: [["<5k",0.51],["5–10k",0.72],["10–15k",1.02],["15–20k",1.18],[">20k",1.25]].map(([n,f])=>({name:n,fg:f})),
    loan: [["<15y",0.83],["15–20y",0.96],["20–25y",1.08],[">25y",1.14]].map(([n,f])=>({name:n,fg:f})),
    age: [["<30",0.74],["30–40",0.91],["40–50",1.05],[">50",1.16]].map(([n,f])=>({name:n,fg:f})),
  };
  const fgData=dimData[dim];
  const [fcView,setFcView]=useState("monthly");
  const mdata=[...fc.months.map(x=>({label:"M"+x.m, mProj:x.projected})), ...fc.fc.map(x=>({label:"M"+x.m, fProj:x.proj, lo:x.lo, hi:x.hi}))];
  mdata[11].fProj=fc.months[11].projected;
  const cdata=[...fc.months.map(x=>({label:"M"+x.m, cum:x.cumulative, ceiling:x.ceiling})), ...fc.fc.map(x=>({label:"M"+x.m, cum:x.cumulative, ceiling:x.ceiling}))];
  const C=RC; const ok=!!RC.ResponsiveContainer;
  const noChart=<div className="muted" style={{padding:20}}>Chart library unavailable (offline). Data is still computed correctly.</div>;
  return (<div className="fade">
    <PageHeader title={t("nav_forecast")} sub={t("forecast_sub")}/>
    {fc.alertMonth&&<div className="alert-strong fade">
      <span className="alert-ico">⚠</span>
      <div style={{flex:1}}>
        <div className="alert-title">{t("alertTitle")} · M{fc.alertMonth}</div>
        <div className="alert-body">{t("alertMsg")}</div>
      </div>
      <span className="alert-pill">{t("alert")}</span>
    </div>}
    <Section title={<span className="sect-right">{t("spendForecast")}<InfoTip text={t("fml_forecast")}/></span>} right={<span className="sect-right">
      <button className={"btn sm "+(fcView==="monthly"?"":"secondary")} onClick={()=>setFcView("monthly")}>{t("fc_monthly")}</button>
      <button className={"btn sm "+(fcView==="cum"?"":"secondary")} onClick={()=>setFcView("cum")}>{t("fc_cumulative")}</button>
      <AgentBadge name={t("agent_forecast")} lvl="L2"/></span>}>
      <div style={{width:"100%",height:280}}>
        {!ok? noChart : fcView==="monthly"?
        <C.ResponsiveContainer>
          <C.LineChart data={mdata} margin={{top:8,right:16,left:8,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="label" tick={{fontSize:10}}/>
            <C.YAxis tickFormatter={abbr} tick={{fontSize:10}} width={48}/>
            <C.Tooltip formatter={(v)=>money(v)}/>
            <C.ReferenceLine y={fc.monthlyCeiling*0.9} stroke="#b3261e" strokeDasharray="5 4" label={{value:"90%",fontSize:10,fill:"#b3261e"}}/>
            <C.ReferenceLine y={fc.monthlyCeiling*0.7} stroke="#9a6b00" strokeDasharray="5 4" label={{value:"70%",fontSize:10,fill:"#9a6b00"}}/>
            <C.Line type="monotone" dataKey="hi" stroke="#b9c4bd" strokeDasharray="2 3" strokeWidth={1} dot={false} name={t("fc_ci")} connectNulls/>
            <C.Line type="monotone" dataKey="lo" stroke="#b9c4bd" strokeDasharray="2 3" strokeWidth={1} dot={false} connectNulls/>
            <C.Line type="monotone" dataKey="mProj" stroke="#006C35" strokeWidth={2.4} dot={false} name={t("fc_actual")} connectNulls/>
            <C.Line type="monotone" dataKey="fProj" stroke="#006C35" strokeDasharray="5 4" strokeWidth={2} dot={false} name={t("fc_forecast")} connectNulls/>
          </C.LineChart>
        </C.ResponsiveContainer> :
        <C.ResponsiveContainer>
          <C.LineChart data={cdata} margin={{top:8,right:16,left:8,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="label" tick={{fontSize:10}}/>
            <C.YAxis tickFormatter={abbr} tick={{fontSize:10}} width={48}/>
            <C.Tooltip formatter={(v)=>money(v)}/>
            <C.ReferenceLine y={fc.annualCeiling*0.9} stroke="#b3261e" strokeDasharray="5 4" label={{value:"90%",fontSize:10,fill:"#b3261e"}}/>
            <C.ReferenceLine y={fc.annualCeiling*0.7} stroke="#9a6b00" strokeDasharray="5 4" label={{value:"70%",fontSize:10,fill:"#9a6b00"}}/>
            <C.Line type="monotone" dataKey="cum" stroke="#006C35" strokeWidth={2.4} dot={false} name={t("kpi_budget")} connectNulls/>
            <C.Line type="monotone" dataKey="ceiling" stroke="#b3261e" strokeDasharray="5 4" strokeWidth={2} dot={false} name={t("budgetCeiling")} connectNulls/>
          </C.LineChart>
        </C.ResponsiveContainer>}
      </div>
    </Section>
    <Section title={<span className="sect-right">{t("fc_stressTitle")}<InfoTip text={t("fc_stressTip")}/></span>} sub={t("fc_stressSub")}>
      <div className="cols-3" style={{marginBottom:12}}>
        {[["fc_stressRate",1.63,1.78],["fc_stressExit",1.58,1.49],["fc_stressNew",1.55,1.82]].map(([k,bv,sv])=>{
          const label=fc.months.reduce((s,x)=>s+x.projected,0);
          return (<div key={k} className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t(k)}</div>
            <div className="v" style={{fontSize:14}}>{t("fc_base")}: {money(bv*1e9)}</div>
            <div className="muted" style={{fontSize:12}}>{t("fc_stress")}: {money(sv*1e9)}</div>
          </div>);
        })}
      </div>
      <table className="tbl"><thead><tr><th>{t("fc_stressScenario")}</th><th className="right-num">{t("fc_stressImpact")}</th><th>{t("fc_stressNote")}</th></tr></thead>
        <tbody>
          <tr><td>{t("fc_stressRate")}</td><td className="right-num mono" style={{color:"var(--danger)"}}>+{((1.78-1.63)/1.63*100).toFixed(0)}%</td><td className="muted">{t("fc_stressRateNote")}</td></tr>
          <tr><td>{t("fc_stressExit")}</td><td className="right-num mono" style={{color:"var(--primary)"}}>{((1.49-1.58)/1.58*100).toFixed(0)}%</td><td className="muted">{t("fc_stressExitNote")}</td></tr>
          <tr><td>{t("fc_stressNew")}</td><td className="right-num mono" style={{color:"var(--danger)"}}>+{((1.82-1.55)/1.55*100).toFixed(0)}%</td><td className="muted">{t("fc_stressNewNote")}</td></tr>
      </tbody></table>
      <div className="muted" style={{fontSize:12,marginTop:8}}>{t("fc_stressBr")}</div>
    </Section>
    <Section title={<span className="sect-right">{t("fc_portfolioTitle")}<InfoTip text={t("fc_portfolioTip")}/></span>}>
      <table className="tbl" style={{fontSize:12.5}}><thead><tr><th>#</th><th>{t("fc_portField")}</th><th className="right-num">{t("current")} (SAR)</th><th>{t("cmp_notes")}</th></tr></thead>
        <tbody>
          <tr><td>14</td><td>{t("fc_portRateCommit")}</td><td className="right-num mono">15,843,000,000</td><td className="muted">{t("fc_portRateCommitNote")}</td></tr>
          <tr><td>15</td><td>{t("fc_portInterestCommit")}</td><td className="right-num mono">11,240,000,000</td><td className="muted">{t("fc_portInterestCommitNote")}</td></tr>
          <tr><td>16</td><td>{t("fc_portInkindCommit")}</td><td className="right-num mono">4,210,000,000</td><td className="muted">{t("fc_portInkindCommitNote")}</td></tr>
          <tr><td>17</td><td><strong>{t("fc_portAnnualCommit")}</strong></td><td className="right-num mono"><strong>31,293,000,000</strong></td><td className="muted">{t("fc_portAnnualCommitNote")}</td></tr>
          <tr><td>18</td><td>{t("fc_portCumulative")}</td><td className="right-num mono" style={{color:"var(--danger)",fontWeight:700}}>184,600,000,000</td><td className="muted">{t("fc_portCumulativeNote")}</td></tr>
          <tr><td>19</td><td>{t("fc_portEarlyExit")}</td><td className="right-num mono">2.8%</td><td className="muted">{t("fc_portEarlyExitNote")}</td></tr>
          <tr><td>20</td><td>{t("fc_portStress20")}</td><td className="right-num mono" style={{color:"var(--danger)"}}>+9.4%</td><td className="muted">{t("fc_portStress20Note")}</td></tr>
          <tr><td>21</td><td>{t("fc_portStress21")}</td><td className="right-num mono" style={{color:"var(--amber)"}}>+6.8%</td><td className="muted">{t("fc_portStress21Note")}</td></tr>
          <tr><td>22</td><td>{t("fc_portStress22")}</td><td className="right-num mono" style={{color:"var(--danger)"}}>+17.4%</td><td className="muted">{t("fc_portStress22Note")}</td></tr>
      </tbody></table>
      <div className="banner" style={{marginTop:8,marginBottom:0,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("fc_portWarn")}</div>
    </Section>
    <Section title={<span className="sect-right">{t("fc_alertRules")}<InfoTip text={t("fc_alertTip")}/></span>}>
      <table className="tbl"><thead><tr><th>{t("fc_alertType")}</th><th>{t("fc_alertThreshold")}</th><th>{t("fc_alertAction")}</th></tr></thead>
        <tbody>
          <tr><td><span className="chip amber">{t("fc_earlyWarn")}</span></td><td className="mono">70% {t("fc_annualBudget")}</td><td className="muted">{t("fc_earlyWarnAction")}</td></tr>
          <tr><td><span className="chip danger">{t("fc_depletion")}</span></td><td className="mono">90% {t("fc_annualBudget")}</td><td className="muted">{t("fc_depletionAction")}</td></tr>
          <tr><td><span className="chip amber">{t("fc_liability2050")}</span></td><td className="mono">{t("fc_ratePlus")} 0.5%</td><td className="muted">{t("fc_liabilityAction")}</td></tr>
          <tr><td><span className="chip info">{t("fc_demandShort")}</span></td><td className="mono">{t("fc_contractRate")} &lt; 80%</td><td className="muted">{t("fc_demandAction")}</td></tr>
      </tbody></table>
      <div className="banner" style={{marginTop:10,marginBottom:0,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("fc_alertBr")}</div>
    </Section>
  </div>);
}

/* ---- Fairness & Leakage (UC-08) — standalone page ---- */
function FairnessLeakage(){
  const {t,user,leaks,leakAct,setRoute,baseline}=useStore(); const {money}=useMoney();
  const scn=baseline;
  const regions=useMemo(()=>fgByRegion(scn.FG, baseline.FG),[]);
  const [dim,setDim]=useState("region");
  const [view,setView]=useState("bar");
  const dimData={
    region: regions.map(r=>({name:t("rg_"+r.key),fg:r.fg})),
    income: [["<5k",0.51],["5–10k",0.72],["10–15k",1.02],["15–20k",1.18],[">20k",1.25]].map(([n,f])=>({name:n,fg:f})),
    loan: [["<15y",0.83],["15–20y",0.96],["20–25y",1.08],[">25y",1.14]].map(([n,f])=>({name:n,fg:f})),
    age: [["<30",0.74],["30–40",0.91],["40–50",1.05],[">50",1.16]].map(([n,f])=>({name:n,fg:f})),
  };
  const fgData=dimData[dim];
  const C=RC; const ok=!!RC.ResponsiveContainer;
  return (<div className="fade">
    <PageHeader title={t("nav_fairness")} sub={t("fairness_sub")} right={<AgentBadge name={t("agent_fair")} lvl="L3"/>}/>
    <div className="cols-4" style={{marginBottom:16}}>
      <KPI label={t("kpi_fairness")} value={scn.FG.toFixed(2)} sub={t("fair_if")} tone={scn.FG>=1?"good":"warn"}/>
      <KPI label={t("kpi_hbr")} value={pct1(scn.HBR)} sub={t("toTarget")} tone="good"/>
      <KPI label={t("kpi_contracts")} value={n0(scn.contractsTotal)} sub={t("target")+" "+n0(BRD.targetContractsTotal)} tone="good"/>
      <KPI label={t("kpi_adoption")} value="65%" sub={t("target")+" 75%"}/>
    </div>
    <Section title={<span className="sect-right">{t("fairnessByRegion")}<InfoTip text={t("fml_fg")}/></span>} right={
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <span className="chip">{t("fair_if")}</span>
        <button className="btn ghost sm" onClick={()=>setRoute("forecast")}>📈 {t("nav_forecast")}</button>
      </div>
    }>
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
        {[["region","fgdim_region"],["income","fgdim_income"],["loan","fgdim_loan"],["age","fgdim_age"]].map(([k,lk])=>(
          <button key={k} className={"btn sm "+(dim===k?"":"secondary")} onClick={()=>setDim(k)}>{t(lk)}</button>))}
        <span style={{flex:1}}/>
        <button className={"btn sm "+(view==="bar"?"":"secondary")} onClick={()=>setView("bar")}>▦ {t("fg_bar")}</button>
        <button className={"btn sm "+(view==="heat"?"":"secondary")} onClick={()=>setView("heat")}>▥ {t("fg_heat")}</button>
      </div>
      {view==="heat"
        ? <div className="fg-heat">{fgData.map((r,i)=>{ const c=r.fg>=1?"var(--primary)":r.fg>=0.9?"var(--amber)":"var(--danger)"; return (
            <div key={i} className="fg-tile" style={{borderColor:c}}><div className="fgt-n">{r.name}</div><div className="fgt-v" style={{color:c}}>{r.fg.toFixed(2)}</div></div>);})}</div>
        : <div style={{width:"100%",height:300}}>
        {!ok? <div className="muted" style={{padding:20}}>Chart library unavailable (offline). Data is still computed correctly.</div> :
        <C.ResponsiveContainer>
          <C.BarChart data={fgData} margin={{top:4,right:8,left:0,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="name" tick={{fontSize:10}} interval={0} angle={-30} textAnchor="end" height={64}/>
            <C.YAxis tick={{fontSize:11}} domain={[0,1.4]}/>
            <C.Tooltip/>
            <C.ReferenceLine y={1.0} stroke="#006C35" strokeDasharray="4 4"/>
            <C.Bar dataKey="fg" radius={[3,3,0,0]}>
              {fgData.map((r,i)=><C.Cell key={i} fill={r.fg>=1?"#006C35":r.fg>=0.9?"#9a6b00":"#b3261e"}/>)}
            </C.Bar>
          </C.BarChart>
        </C.ResponsiveContainer>}
      </div>}
    </Section>
    <Section title={t("leakage")} sub={t("leak_routeHint")} right={<AgentBadge name={t("agent_fair")} lvl="L3"/>}>
      {leaks.length===0? <div className="muted" style={{padding:8}}>{t("noItems")}</div>
        : leaks.map(l=>{
        const big=l.cases>100;
        const canA=user==="analyst"&&l.status==="detected";
        const canO=user==="owner"&&l.status==="submitted";
        const canM=user==="minister"&&l.status==="escalated";
        const sChip={detected:"gray",submitted:"info",adopted:"",escalated:"amber",adjudicated:"",rejected:"danger"};
        return (<div key={l.id} className="leak-card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span className="wo">#{l.id}</span>
              <span className={"chip "+l.sev}>{t("leakSev_"+l.sev)}</span>
              <strong style={{fontSize:13}}>{l.k}</strong>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span className="chip gray">{n0(l.cases)} {t("leak_cases")}</span>
              <span className={"chip "+(sChip[l.status]||"")}>{t("leakStatus_"+l.status)}</span>
            </div>
          </div>
          {big&&(l.status==="detected"||l.status==="submitted")&&<div className="banner" style={{marginTop:8}}>⚖ {t("leak_big")}</div>}
          {(canA||canO||canM)&&<div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
            {canA&&<button className="btn sm" onClick={()=>leakAct(l.id,"report")}>↑ {t("leak_report")}</button>}
            {canO&&big&&<button className="btn sm" onClick={()=>leakAct(l.id,"escalate")}>⚖ {t("escalate")}</button>}
            {canO&&!big&&<button className="btn sm" onClick={()=>leakAct(l.id,"adopt")}>✔ {t("approve")}</button>}
            {canO&&<button className="btn danger sm" onClick={()=>leakAct(l.id,"reject")}>✕ {t("reject")}</button>}
            {canM&&<button className="btn sm" onClick={()=>leakAct(l.id,"adjudicate")}>⚖ {t("adjudicate")}</button>}
            {canM&&<button className="btn danger sm" onClick={()=>leakAct(l.id,"reject")}>✕ {t("reject")}</button>}
          </div>}
          {l.history.length>0&&<div className="timeline" style={{marginTop:12}}>
            {l.history.map((h,i)=>(<div key={i} className="ev"><div style={{fontSize:12.5}}>
              <span className="tag">{t(h.role)}</span> <b>{t(LEAK_KIND_KEY[h.kind])}</b> {h.note?("· "+h.note):""}</div>
              <div className="muted" style={{fontSize:11}}>{h.ts}</div></div>))}
          </div>}
        </div>);
      })}
      <div className="muted" style={{fontSize:12,marginTop:10}}>{t("redline")}</div>
    </Section>
  </div>);
}

/* ---- Orchestration chain ---- */
// Smoothly rolling governmental metric (population / land / budget …). Rolls while active, locks to target otherwise.
function RollingMetric({active,target,format}){
  const [v,setV]=useState(target);
  useEffect(()=>{
    if(!active){ setV(target); return; }
    const id=setInterval(()=>setV(target*(0.35+Math.random()*1.3)),85);
    return ()=>clearInterval(id);
  },[active,target]);
  return <span className="chain-metric mono">{format(v)}</span>;
}
// Canvas particle field: glowing core particles + gravity links; on "converge" they collapse to the centre.
function ParticleField({mode}){
  const ref=useRef(null); const modeRef=useRef(mode);
  useEffect(()=>{ modeRef.current=mode; },[mode]);
  useEffect(()=>{
    const cv=ref.current; if(!cv) return; const ctx=cv.getContext("2d"); if(!ctx) return;
    const dpr=window.devicePixelRatio||1;
    const cw=cv.clientWidth||600, ch=170;
    cv.width=cw*dpr; cv.height=ch*dpr; ctx.scale(dpr,dpr);
    const KPIS=[{l:"Eligible",v:"1.4M"},{l:"Contracts",v:"510K"},{l:"Budget",v:"7.9B"},{l:"Savings",v:"3.4B"},{l:"Fairness",v:"1.05"},{l:"HBR",v:"33%"},{l:"Ownership",v:"70%"}];
    const N=KPIS.length, cx=cw/2, cy=ch/2;
    const P=Array.from({length:N},(_,i)=>({x:Math.random()*cw,y:Math.random()*ch,vx:(Math.random()-.5)*.6,vy:(Math.random()-.5)*.6,r:9+Math.random()*3,glow:.5,bright:0,kpi:KPIS[i]}));
    let raf, lastGrow=0;
    function frame(now){
      const conv=modeRef.current==="converge";
      ctx.clearRect(0,0,cw,ch);
      for(let i=0;i<N;i++)for(let j=i+1;j<N;j++){ const a=P[i],b=P[j]; const d=Math.hypot(a.x-b.x,a.y-b.y);
        if(d<165){ ctx.strokeStyle="rgba(27,131,84,"+(0.20*(1-d/165))+")"; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); } }
      if(!conv && now-lastGrow>650){ lastGrow=now; const p=P[(Math.random()*N)|0]; p.bright=1; p.r=Math.min(13,p.r+1.3); }
      P.forEach((p,i)=>{
        if(conv){ p.x+=(cx-p.x)*0.08; p.y+=(cy-p.y)*0.08; p.glow=Math.min(1,p.glow+0.03); p.r+=(2.5-p.r)*0.05; }
        else{ p.vx+=(cx-p.x)*0.00018+(Math.random()-.5)*0.07; p.vy+=(cy-p.y)*0.00018+(Math.random()-.5)*0.07; p.vx*=0.95; p.vy*=0.95; p.x+=p.vx; p.y+=p.vy;
          if(p.x<10){p.x=10;p.vx*=-1;} if(p.x>cw-10){p.x=cw-10;p.vx*=-1;} if(p.y<10){p.y=10;p.vy*=-1;} if(p.y>ch-10){p.y=ch-10;p.vy*=-1;}
          p.glow=0.5+0.3*Math.sin(now/380+i)+0.4*p.bright; p.bright*=0.96; }
        const r=p.r;
        const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*4.5);
        g.addColorStop(0,"rgba(27,131,84,"+Math.min(0.6,0.5*p.glow)+")"); g.addColorStop(1,"rgba(27,131,84,0)");
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.x,p.y,r*4.5,0,7); ctx.fill();
        ctx.fillStyle="rgba(8,93,58,0.95)"; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,7); ctx.fill();
        if(!conv){ ctx.textAlign="center";
          ctx.fillStyle="#fff"; ctx.font="700 10px Arial"; ctx.fillText(p.kpi.v, p.x, p.y+3);
          ctx.fillStyle="rgba(8,59,52,0.92)"; ctx.font="600 9px Arial"; ctx.fillText(p.kpi.l, p.x, p.y+r+11);
        }
      });
      if(conv){ const g=ctx.createRadialGradient(cx,cy,0,cx,cy,46); g.addColorStop(0,"rgba(248,198,48,0.55)"); g.addColorStop(1,"rgba(248,198,48,0)"); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,46,0,7); ctx.fill(); }
      raf=requestAnimationFrame(frame);
    }
    raf=requestAnimationFrame(frame);
    return ()=>cancelAnimationFrame(raf);
  },[]);
  return <canvas ref={ref} className="pfield"/>;
}
function OrchestrationChain({states}){
  const {t}=useStore(); const {money}=useMoney();
  const nodes=[
    { k:"ag_uc01", labelKey:"budgetCeiling", target:BRD.phase3BudgetSAR/BRD.phase3Years, fmt:money },
    { k:"ag_uc03", labelKey:"contracts",     target:ANNUAL_CONTRACTS,                     fmt:n0 },
    { k:"ag_uc04", labelKey:"kpi_savings",   target:scenarioSavings(computeAllocation(RECO_PARAMS)).phase, fmt:money },
    { k:"ag_uc08", labelKey:"kpi_fairness",  target:1.05,                                 fmt:(v)=>Number(v).toFixed(2) },
  ];
  return (<div className="chain">
    {nodes.map((nd,i)=>{ const s=states[i]||"idle";
      const col=s==="done"?"var(--primary)":s==="run"?"#6d5ae6":null;
      return (<div key={nd.k} className={"node "+(s==="run"?"run":s==="done"?"done":"")}>
        <span className="node-dot" style={{background:col||"#cbd5d0"}}/>
        <span style={{flex:1,fontSize:13,fontWeight:600,color:col||"inherit",transition:"color .3s ease"}}>{t(nd.k)}</span>
        <span className="node-metric"><span className="ml">{t(nd.labelKey)}</span> <RollingMetric active={s==="run"} target={nd.target} format={nd.fmt}/></span>
        <span className="st" style={{color:col||"var(--muted)"}}>
          {s==="run"?t("running"):s==="done"?("✓ "+t("done")):"—"}</span>
      </div>); })}
  </div>);
}

/* ---- What-if — centerpiece ---- */
function WhatIf(){
  const {t,setRoute,addPackage,user,formulaParams,setFormulaParams,formulaVersion,setFormulaVersion,baseline,whatifContext,setWhatifContext,lang,formulaMatrix,setFormulaMatrix}=useStore(); const {money}=useMoney();
  const [p,setP]=useState({reallocatePct:0,capHighPct:0,boostLowPct:0,offPlanPct:0});
  const [nl,setNl]=useState("");
  const [chain,setChain]=useState(["idle","idle","idle","idle"]);
  const [busy,setBusy]=useState(false);
  const [flash,setFlash]=useState(false);
  const [phase,setPhase]=useState(null);
  const [evP,setEvP]=useState(null);
  const [leverFlash,setLeverFlash]=useState(false);
  const [cmpMode,setCmpMode]=useState("dual"); // UC-09: dual = base vs current; triple = +recommended
  const [testingVersionId, setTestingVersionId] = useState(null);
  const [testingVersionParams, setTestingVersionParams] = useState(null);
  // Consume whatifContext from Allocation page or Formula version test
  useEffect(()=>{
    if(whatifContext){
      // Version test from FormulaPage
      if(whatifContext.fromFormula && whatifContext.fromVersion){
        const { ded, dur, ceil, rate, versionId } = whatifContext;
        const text = lang==="zh"
          ? `测试版本 ${versionId}：扣除率 ${ded}%，利率 ${rate}%，周期 ${dur}年 · ${t("nlTestTip")}`
          : lang==="ar"
          ? `اختبار الإصدار ${versionId}: خصم ${ded}%، معدل ${rate}%، مدة ${dur} سنة · ${t("nlTestTip")}`
          : `Testing version ${versionId}: Deduction ${ded}%, Rate ${rate}%, Duration ${dur}y · ${t("nlTestTip")}`;
        setNl(text);
        setTestingVersionId(versionId);
        setTestingVersionParams({ ded, dur, ceil, rate });
        setWhatifContext(null);
        return;
      }
      // Context from Allocation page
      const nlText = lang==="zh"
        ? `针对 "${whatifContext.bandLabel}" 档优化支持方案 · 当前补贴 ${money(whatifContext.subsidy)} · HBR ${(whatifContext.hbr*100).toFixed(0)}%`
        : lang==="ar"
        ? `تحسين دعم الفئة "${whatifContext.bandLabel}" · الدعم الحالي ${money(whatifContext.subsidy)} · HBR ${(whatifContext.hbr*100).toFixed(0)}%`
        : `Optimize support for "${whatifContext.bandLabel}" · Current subsidy ${money(whatifContext.subsidy)} · HBR ${(whatifContext.hbr*100).toFixed(0)}%`;
      setNl(nlText);
      setP(prev=>({...prev, boostLowPct: whatifContext.below?0.08:0, capHighPct: whatifContext.below?0:0.10 }));
      setWhatifContext(null);
    }
  },[whatifContext]);
  // Determine if formula params are modified from default (the key "Test in What-if" use case)
  const formulaModified = formulaParams.ded!==40 || formulaParams.dur!==20 || formulaParams.rate!==4;
  const versionModified = testingVersionParams !== null;
  const effectiveFormulaParams = versionModified ? testingVersionParams : formulaParams;
  // Resolve dimension-specific overrides (region > housingType > incomeBand)
  const {region:dimRegion,housingType:dimHt,incomeBand:dimIb,regions:dimRegions, housingTypes:dimHts, incomeBands:dimIbs}=formulaMatrix;
  const dimEffParams = (()=>{
    const fromRegion = dimRegion!=="all" && dimRegions[dimRegion] ? dimRegions[dimRegion] : null;
    const fromHt = dimHt!=="all" && dimHts[dimHt] ? dimHts[dimHt] : null;
    const fromIb = dimIb!=="all" && dimIbs[dimIb] ? dimIbs[dimIb] : null;
    return { ...(fromRegion||{}), ...(fromHt||{}), ...(fromIb||{}) };
  })();
  const hasDimOverride = dimRegion!=="all" || dimHt!=="all" || dimIb!=="all";
  const finalFormulaParams = hasDimOverride
    ? { ded: dimEffParams.ded??effectiveFormulaParams.ded, dur: dimEffParams.dur??effectiveFormulaParams.dur,
        ceil: dimEffParams.ceil??effectiveFormulaParams.ceil, rate: dimEffParams.rate??effectiveFormulaParams.rate }
    : effectiveFormulaParams;
  const mortOverrides = (formulaModified || versionModified || hasDimOverride) ? finalFormulaParams : null;
  const scn=useMemo(()=>computeAllocation(p, mortOverrides),[p, mortOverrides]);
  const sv=scenarioSavings(scn, baseline.spend);
  const C=RC;
  // Sync formula params into NL input when coming from FormulaPage
  useEffect(()=>{
    if(formulaModified){
      setNl(t("fp_ded")+" "+formulaParams.ded+"%, "+t("fp_rate")+" "+formulaParams.rate+"%, "+t("fp_dur")+" "+formulaParams.dur+t("fp_yrs")+" · "+t("nlTestTip"));
    }
  },[formulaModified]);
  const ev=useMemo(()=>{
    if(!evP) return {tone:"info", text:t("ai_start")};
    const a=computeAllocation(evP, mortOverrides), s=scenarioSavings(a, baseline.spend);
    const fg=a.FG, hbr=a.HBR, save=money(s.phase), pct=Math.round(s.pctOfBudget*100);
    const fmt=(k,v)=>t(k).replace(/\{(\w+)\}/g,(_,x)=>v[x]!==undefined?v[x]:"{"+x+"}");
    if(evP.boostLowPct>0.15 && s.pctOfBudget<0.10) return {tone:"warn", text:fmt("ai_tradeoff",{hbr:pct1(hbr),save})};
    if(fg>=0.95 && s.pctOfBudget>=0.15) return {tone:"good", text:fmt("ai_win",{save,pct,fg:fg.toFixed(2)})};
    if(fg<0.90) return {tone:"warn", text:fmt("ai_fairlow",{fg:fg.toFixed(2)})};
    let txt=fmt("ai_neutral",{save,fg:fg.toFixed(2),hbr:pct1(hbr)});
    if(evP.reallocatePct>0.2) txt+=" "+t("ai_minister");
    return {tone:"info", text:txt};
  },[evP,t,money]);
  function animateChain(then,finalP){
    setBusy(true); setPhase("run");
    [0,1,2,3].forEach((i)=>{
      setTimeout(()=>{ setChain(c=>{const n=[...c];n[i]="run";return n;}); },i*450);
      setTimeout(()=>{ setChain(c=>{const n=[...c];n[i]="done";return n;}); if(i===3){setBusy(false); then&&then(); setEvP(finalP||p); if(formulaModified&&!formulaVersion.validated){setFormulaVersion(prev=>({...prev,validated:true,lastValidated:Date.now()}));} setFlash(true); setPhase("converge"); setTimeout(()=>{setFlash(false); setPhase(null);},1300);} },i*450+380);
    });
  }
  function runSim(){ animateChain(null,p); } function applyReco(){ if(!evP) return; const next={...evP}; setLeverFlash(false); animateChain(()=>{setP(next); setLeverFlash(true); setTimeout(()=>setLeverFlash(false),1100);}, next); }
  function runNL(){
    const next={...p};
    // Parse lever values: keyword + number + % pattern
    const findPct = (kw, def) => { const re=new RegExp("(?:"+kw+")\\s*(\\d+)","i"); const m=nl.match(re); return m?clamp(parseInt(m[1])/100,0,1):def; };
    next.reallocatePct = findPct("re(?:allocate|distrib)|再分配|إعادة", next.reallocatePct ?? RECO_PARAMS.reallocatePct);
    next.capHighPct    = findPct("cap|reduce|封顶|تقييد|خفض", next.capHighPct ?? RECO_PARAMS.capHighPct);
    next.boostLowPct   = findPct("boost|提升|رفع", next.boostLowPct ?? RECO_PARAMS.boostLowPct);
    next.offPlanPct    = findPct("off.?plan|期房|خطط", next.offPlanPct ?? RECO_PARAMS.offPlanPct);
    // If no lever keyword found → apply RECO_PARAMS defaults as AI recommendation
    if(!/re(?:allocate|distrib)|cap|boost|off.?plan|再分配|封顶|提升|期房|إعادة|تقييد|رفع|خطط/i.test(nl)){
      Object.assign(next, RECO_PARAMS);
    }
    // Parse formula params from NL text (ded/rate/dur)
    const dedM=nl.match(/ded(?:uction)?\s*(\d+)|扣除\s*(\d+)|خصم\s*(\d+)/i);
    const rateM=nl.match(/rate\s*(\d+)|比例\s*(\d+)|معدل\s*(\d+)/i);
    const durM=nl.match(/dur(?:ation)?\s*(\d+)|周期\s*(\d+)|مدة\s*(\d+)/i);
    if(dedM||rateM||durM) setFormulaParams(f=>({
      ...f,
      ded: dedM?clamp(parseInt(dedM[1]||dedM[2]||dedM[3]),10,60):f.ded,
      rate: rateM?clamp(parseInt(rateM[1]||rateM[2]||rateM[3]),0,15):f.rate,
      dur: durM?clamp(parseInt(durM[1]||durM[2]||durM[3]),5,20):f.dur,
    }));
    animateChain(()=>{setP(next); setLeverFlash(true); setTimeout(()=>setLeverFlash(false),1100);}, next);
  }
  function assemble(){
    const affectsCap = p.capHighPct>0 || p.reallocatePct>0.20;
    // Auto-classify package type
    const activeLv=Object.entries(p).filter(([,v])=>v>0);
    const type = activeLv.length===1 && activeLv[0][0]==="reallocatePct" ? "reallocation"
               : activeLv.length===1 && activeLv[0][0]==="capHighPct"    ? "cap"
               : activeLv.length===1 && activeLv[0][0]==="offPlanPct"    ? "offplan"
               : activeLv.length===1 && activeLv[0][0]==="boostLowPct"   ? "boost"
               : "comprehensive";
    // Estimate reclassified contracts
    const totalAboveBase = BANDS.filter(b=>!b.below).reduce((s,b)=>s+b.cShareBase,0);
    const movedShare = totalAboveBase * p.reallocatePct;
    const reclassified = Math.round(movedShare * ANNUAL_CONTRACTS);
    const affected = Math.max(Math.round((movedShare>0?movedShare:p.capHighPct*0.5)*ANNUAL_CONTRACTS), Math.round(ANNUAL_CONTRACTS*0.01));
    // Extract regions from NL or fallback
    let regions=[];
    const regM=nl?.match(/(Riyadh|Makkah|Jeddah|Dammam|Medina|全国|الرياض|مكة|جدة|الدمام|المدينة)/i);
    if(regM) regions=[regM[1]];
    addPackage({
      title: t("scenario")+" · "+new Date().toLocaleDateString(),
      params:{...p}, affectsCap, type, regions,
      rationale: (ev?.text&&!ev?.text.startsWith(t("ai_start")))?ev.text:"",
      reclassified, affected,
      ...((formulaModified || versionModified)?{
        containsFormulaChange:true,
        formulaSnapshot:{ ...effectiveFormulaParams, ...(testingVersionId ? {versionId: testingVersionId} : {}) }
      }:{}),
      kpis:{ savingsPhase:sv.phase, pctBudget:sv.pctOfBudget, fg:scn.FG, hbr:scn.HBR },
    });
    setRoute("packages");
  }
  const blowBase=baseline.rows.filter(r=>r.below).reduce((s,r)=>s+r.contracts,0);
  const blowScn=scn.rows.filter(r=>r.below).reduce((s,r)=>s+r.contracts,0);
  const reclassified=Math.round(Math.abs(p.reallocatePct)*8500);
  const cmp=[
    {k:t("kpi_savings"),b:money(0),a:money(sv.phase),tone:"good"},
    {k:t("cmp_contractsLow"),b:n0(blowBase),a:n0(blowScn),tone:"good"},
    {k:t("kpi_fairness"),b:baseline.FG.toFixed(2),a:scn.FG.toFixed(2),tone:scn.FG>=1?"good":"warn"},
    {k:t("kpi_hbr"),b:pct1(baseline.HBR),a:pct1(scn.HBR),tone:"good"},
    {k:t("cmp_commit"),b:money(baseline.spend*15),a:money(scn.spend*15),tone:"good"},
  ];
  // UC-09: recommended scenario for triple comparison
  const recoScn=useMemo(()=>computeAllocation(RECO_PARAMS, mortOverrides),[mortOverrides]);
  const recoSv=scenarioSavings(recoScn, baseline.spend);
  const cmpTriple=[
    {k:t("kpi_savings"),b:money(0),r:money(recoSv.phase),a:money(sv.phase),tone:"good"},
    {k:t("cmp_contractsLow"),b:n0(blowBase),r:n0(recoScn.rows.filter(r=>r.below).reduce((s,r)=>s+r.contracts,0)),a:n0(blowScn),tone:"good"},
    {k:t("kpi_fairness"),b:baseline.FG.toFixed(2),r:recoScn.FG.toFixed(2),a:scn.FG.toFixed(2),tone:scn.FG>=1?"good":"warn"},
    {k:t("kpi_hbr"),b:pct1(baseline.HBR),r:pct1(recoScn.HBR),a:pct1(scn.HBR),tone:"good"},
    {k:t("cmp_commit"),b:money(baseline.spend*15),r:money(recoScn.spend*15),a:money(scn.spend*15),tone:"good"},
  ];
  const leverDefs=[{lk:"lv_realloc",field:"reallocatePct",max:30},{lk:"lv_cap",field:"capHighPct",max:35},{lk:"lv_boost",field:"boostLowPct",max:45},{lk:"lv_offplan",field:"offPlanPct",max:20}];
  const saveOver=sv.phase>SAVINGS_CEIL;
  return (<div className="fade">
    <PageHeader title={t("nav_whatif")} sub={t("whatif_sub")}/>
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      <input className="input" style={{flex:1}} placeholder={t("nlPlaceholder")} value={nl} onChange={e=>setNl(e.target.value)}/>
      <button className="btn btn-ai" style={{flexShrink:0,minWidth:170,justifyContent:"center",textAlign:"center",fontWeight:700}} onClick={runNL} disabled={busy}>✦ {t("askAI")}</button>
    </div>
    {busy&&<div className="ai-working" style={{marginBottom:10}}>✦ {t("aiWorking")}</div>}
    {testingVersionId && <div className="banner" style={{marginBottom:12,background:"var(--info-50)",borderColor:"var(--info)",fontSize:12}}>
      🧪 {t("nav_formula")} · {t("fv_test")}: <b>{testingVersionId}</b>
      {" · "}{t("fp_ded")} {testingVersionParams?.ded}% · {t("fp_rate")} {testingVersionParams?.rate}% · {t("fp_dur")} {testingVersionParams?.dur}{t("fp_yrs")}
      <button className="btn ghost sm" style={{marginInlineStart:12,fontSize:11}} onClick={()=>{setTestingVersionId(null); setTestingVersionParams(null);}}>✕ {t("back")}</button>
    </div>}
    {/* Dimension selectors (same as FormulaPage) */}
    <div className="cols-3" style={{marginBottom:12,gap:8}}>
      <div className="field"><label style={{fontSize:12}}>{t("fp_region")}</label>
        <select className="input" value={dimRegion} onChange={e=>setFormulaMatrix(f=>({...f,region:e.target.value}))} style={{height:34,padding:"4px 8px",fontSize:12}}>
          <option value="all">{t("fp_region_all")}</option>
          {Object.keys(dimRegions).map(k=><option key={k} value={k}>{t("rg_"+k)}</option>)}</select></div>
      <div className="field"><label style={{fontSize:12}}>{t("fp_housing_type")}</label>
        <select className="input" value={dimHt} onChange={e=>setFormulaMatrix(f=>({...f,housingType:e.target.value}))} style={{height:34,padding:"4px 8px",fontSize:12}}>
          <option value="all">{t("fp_ht_all")}</option>
          <option value="offplan">{t("fp_ht_offplan")}</option>
          <option value="ready">{t("fp_ht_ready")}</option>
          <option value="selfbuild">{t("fp_ht_selfbuild")}</option></select></div>
      <div className="field"><label style={{fontSize:12}}>{t("fp_income_band")}</label>
        <select className="input" value={dimIb} onChange={e=>setFormulaMatrix(f=>({...f,incomeBand:e.target.value}))} style={{height:34,padding:"4px 8px",fontSize:12}}>
          <option value="all">{t("fp_ib_all")}</option>
          {BANDS.filter(b=>b.below).map(b=><option key={b.key} value={b.key}>{bandLabel(t,b.key)}</option>)}
          {BANDS.filter(b=>!b.below).map(b=><option key={b.key} value={b.key}>{bandLabel(t,b.key)}</option>)}</select></div>
    </div>
    {hasDimOverride && <div className="muted" style={{fontSize:11.5,marginBottom:12}}>
      {t("fp_ded")}: <b className="mono">{finalFormulaParams.ded}%</b> · {t("fp_dur")}: <b className="mono">{finalFormulaParams.dur}{t("fp_yrs")}</b> · {t("fp_ceil")}: <b className="mono">{n0(finalFormulaParams.ceil)}</b> · {t("fp_rate")}: <b className="mono">{finalFormulaParams.rate}%</b>
    </div>}
    <div className="cols-2">
      <Section className="lever-card" title={t("levers")} right={<button className="btn secondary sm" onClick={runSim} disabled={busy}>{busy?t("running"):t("runLevers")}</button>}>
        {leverDefs.map(d=>(<div key={d.field} className={"field"+(leverFlash?" lever-flash":"")}>
          <label style={{display:"flex",justifyContent:"space-between"}}><span>{t(d.lk)}</span><span className="mono">{Math.round(p[d.field]*100)}%</span></label>
          <input className="range" type="range" min="0" max={d.max} step="1" value={Math.round(p[d.field]*100)}
            onChange={e=>setP({...p,[d.field]:parseInt(e.target.value)/100})}/></div>))}
        <div className={"ai-eval "+ev.tone}>
          <div className="ai-eval-top"><span className="ai-eval-ic">✦</span><span className="ai-eval-h">{t("ai_title")}</span></div>
          <div className="ai-eval-t" style={busy?{color:"#6d5ae6"}:undefined}>{busy?t("aiWorking"):ev.text}</div>
        </div>
      </Section>
      <div>
        <div className={"cols-3"+(flash?" flash-kpis":"")} style={{marginBottom:16}}>
          <KPI label={t("kpi_savings")} value={money(sv.phase)} sub={saveOver?t("save_over"):(sv.pctOfBudget*100).toFixed(0)+"% "+t("of_budget")} tone={saveOver?"warn":"good"}/>
          <KPI label={t("kpi_fairness")} value={scn.FG.toFixed(2)} sub={t("fair_if")} tone={scn.FG>=1?"good":"warn"}/>
          <KPI label={t("kpi_hbr")} value={pct1(scn.HBR)} sub={t("toTarget")} tone="good"/>
        </div>
        <Section title={<span className="sect-right">{t("compare")}<InfoTip text={t("fml_savings")}/></span>} sub={t("compareNote")} right={
          <button className="btn ghost sm" onClick={()=>setCmpMode(m=>m==="dual"?"triple":"dual")}>
            {cmpMode==="dual"?"▶ "+t("cmp_showReco"):"◀ "+t("cmp_hideReco")}
          </button>
        }>
          {cmpMode==="dual"
            ? <table className="tbl"><thead><tr><th></th><th className="right-num">{t("current")}</th><th className="right-num">{t("scenario")}</th></tr></thead>
                <tbody>{cmp.map((r,i)=>(<tr key={i}><td>{r.k}</td><td className="right-num mono muted">{r.b}</td>
                  <td className="right-num mono" style={{fontWeight:700,color:r.tone==="good"?"var(--primary)":"var(--amber)"}}>{r.a}</td></tr>))}</tbody></table>
            : <table className="tbl"><thead><tr><th></th><th className="right-num">{t("current")}</th><th className="right-num">{t("cmp_recommended")}</th><th className="right-num">{t("scenario")}</th></tr></thead>
                <tbody>{cmpTriple.map((r,i)=>(<tr key={i}><td>{r.k}</td><td className="right-num mono muted">{r.b}</td>
                  <td className="right-num mono" style={{fontWeight:700,color:"var(--primary)"}}>{r.r}</td>
                  <td className="right-num mono" style={{fontWeight:700,color:r.tone==="good"?"var(--primary)":"var(--amber)"}}>{r.a}</td></tr>))}</tbody></table>}
          <div className="muted" style={{fontSize:12.5,marginTop:10}}>{t("cmp_recls")}: <b style={{color:"var(--primary)"}}>{n0(reclassified)}</b></div>
        </Section>
      </div>
    </div>
    {user==="analyst"&&<button className="btn" style={{marginTop:4}} onClick={assemble}>📦 {t("assembleFromHere")}</button>}
  </div>);
}

/* ---- Decision packages (role-aware) ---- */
function statusChip(t,s){
  const map={draft:"gray",submitted:"info",approved:"",escalated:"amber",adjudicated:"",rejected:"danger"};
  return <span className={"chip "+(map[s]||"")}>{t("pkgStatus_"+s)}</span>;
}
function leverSummary(t,p){
  const o=[];
  if(p.reallocatePct) o.push([t("lv_realloc"), Math.round(p.reallocatePct*100)+"%"]);
  if(p.capHighPct)    o.push([t("lv_cap"),     Math.round(p.capHighPct*100)+"%"]);
  if(p.boostLowPct)   o.push([t("lv_boost"),   Math.round(p.boostLowPct*100)+"%"]);
  if(p.offPlanPct)    o.push([t("lv_offplan"), Math.round(p.offPlanPct*100)+"%"]);
  return o;
}
function PackageCard({pkg}){
  const {t,user,setRoute,actOnPackage}=useStore(); const {money}=useMoney();
  const [note,setNote]=useState("");
  const canOwner = user==="owner" && pkg.status==="submitted";
  const canMin = user==="minister" && pkg.status==="escalated";
  const levers=leverSummary(t,pkg.params||{});
  const levelMap={draft:"P-01 · Analyst",submitted:"P-02 · Business Owner",escalated:"P-03 · Minister"};
  const levelChip=levelMap[pkg.status]?<span className={"chip "+(pkg.status==="escalated"?"amber":"info")}>{levelMap[pkg.status]}</span>:null;
  // Type tag
  const typeTag = pkg.type ? <span className="chip gray" style={{fontSize:11}}>{t("pkg_type")}: {pkg.type}</span> : null;
  // Region chips
  const regionChips = pkg.regions?.length>0
    ? <span className="chip gray" style={{fontSize:11}}>📍 {pkg.regions.join(", ")}</span>
    : null;
  // Formula diff
  let formulaInfo = null;
  if(pkg.containsFormulaChange && pkg.formulaSnapshot){
    const parts=[];
    if(pkg.formulaSnapshot.ded!==40) parts.push("ded "+(pkg.formulaSnapshot.ded||40)+"%");
    if(pkg.formulaSnapshot.rate!==4) parts.push("rate "+(pkg.formulaSnapshot.rate||4)+"%");
    if(pkg.formulaSnapshot.dur!==20) parts.push("dur "+(pkg.formulaSnapshot.dur||20)+"y");
    formulaInfo = parts.length ? "💡 "+t("pkg_formulaChange")+": "+parts.join("  ") : null;
  } else if(pkg.containsFormulaChange) {
    formulaInfo = "💡 "+t("pkg_noFormulaChange");
  }
  // Approval chain visual
  const steps = [
    {role:"analyst",  label:"Analyst",  done:pkg.history.some(h=>h.role==="analyst")},
    {role:"owner",    label:"Owner",    done:pkg.history.some(h=>h.role==="owner"&&["act_approve","act_escalate"].includes(h.action))},
    {role:"minister", label:"Minister", done:pkg.history.some(h=>h.role==="minister"&&h.action==="act_adjudicate")},
  ];
  const chainStatus = pkg.status==="approved"   ? [true,true,false]
                    : pkg.status==="escalated"   ? [true,true,false]
                    : pkg.status==="adjudicated" ? [true,true,true]
                    : pkg.status==="rejected"    ? [true,true,false]
                    : [true,false,false];
  const chainLabel = pkg.status==="submitted"    ? [t("pkg_chainSubmitted"),t("pkg_chainApproving"),"—"]
                    : pkg.status==="escalated"    ? [t("pkg_chainSubmitted"),t("pkg_chainSubmitted"),t("pkg_chainAdjudicating")]
                    : pkg.status==="adjudicated"  ? [t("pkg_chainSubmitted"),t("pkg_chainSubmitted"),t("pkg_chainSubmitted")]
                    : pkg.status==="rejected"     ? [t("pkg_chainSubmitted"),t("pkg_chainSubmitted"),"—"]
                    : [t("pkg_chainSubmitted"),"—","—"];
  return (<div className="card pad acc" style={{marginBottom:14}}>
    {/* Header: ID + status + level + timestamp */}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
      <div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
          <span className="wo">#{pkg.id}</span>{statusChip(t,pkg.status)}{levelChip}
        </div>
        <strong>{pkg.title}</strong>
      </div>
      <div className="muted" style={{fontSize:11,textAlign:"end",whiteSpace:"nowrap"}}>{pkg.history[0]&&pkg.history[0].ts}</div>
    </div>
    {/* Meta row: type + regions + rationale */}
    <div className="pkg-detail">
      {(typeTag||regionChips)&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:6}}>
        {typeTag}{regionChips}
      </div>}
      {pkg.rationale&&<div style={{fontSize:12.5,marginBottom:6,lineHeight:1.6}}>📝 <b>{t("pkg_rationale")}:</b> {pkg.rationale}</div>}
      {formulaInfo&&<div style={{fontSize:12.5,marginBottom:6,lineHeight:1.6}}>{formulaInfo}</div>}
    </div>
    {/* Parameters */}
    <div className="pkg-detail">
      <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("leversUsed")}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
        {levers.length? levers.map((l,i)=><span key={i} className="chip gray">{l[0]} <b style={{marginInlineStart:4}}>{l[1]}</b></span>)
          : <span className="muted" style={{fontSize:12}}>{t("noLevers")}</span>}
      </div>
    </div>
    {/* Impact KPIs */}
    {pkg.kpis&&<div className="pkg-detail" style={{marginBottom:0}}>
      <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("pkg_impact")}</div>
      <div className="cols-3">
        <div className="mini-kpi"><div className="muted">{t("kpi_savings")}</div><div className="v" style={{color:"var(--primary)"}}>{money(pkg.kpis.savingsPhase)}</div></div>
        <div className="mini-kpi"><div className="muted">{t("kpi_fairness")}</div><div className="v">{pkg.kpis.fg.toFixed(2)}</div></div>
        <div className="mini-kpi"><div className="muted">{t("kpi_hbr")}</div><div className="v">{pct1(pkg.kpis.hbr)}</div></div>
      </div>
      {(pkg.affected||pkg.reclassified)&&<div className="cols-3" style={{marginTop:6}}>
        {pkg.affected?<div className="mini-kpi"><div className="muted">{t("pkg_affected")}</div><div className="v">{n0(pkg.affected)}</div></div>:<div/>}
        {pkg.reclassified?<div className="mini-kpi"><div className="muted">{t("pkg_reclassified")}</div><div className="v">{n0(pkg.reclassified)}</div></div>:<div/>}
        <div/>
      </div>}
    </div>}
    {/* SLA + Minister alert */}
    {(pkg.status==="submitted"||pkg.status==="escalated")&&typeof pkg.sla==="number"&&(()=>{
      const win=pkg.status==="submitted"?48:72; const left=Math.max(0,pkg.sla); const used=Math.min(1,(win-left)/win);
      const col=left<=0?"var(--danger)":left<12?"var(--danger)":left<24?"var(--amber)":"var(--primary)";
      return (<div style={{marginTop:12}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
          <span className="muted">⏱ {t("sla_window")} · {win}h Response Window</span>
          <span className="mono" style={{color:col,fontWeight:700}}>{left<=0?t("sla_overdue"):(left+"h "+t("sla_left"))}</span>
        </div>
        <div className="progress"><span style={{width:(used*100)+"%",background:col}}/></div>
      </div>);
    })()}
    {pkg.affectsCap&&pkg.status!=="adjudicated"&&pkg.status!=="rejected"&&
      <div className="banner" style={{marginTop:10}}>⚖ {t("needsMinister")}</div>}
    {/* Approval buttons */}
    {(canOwner||canMin)&&<div style={{marginTop:12}}>
      <input className="input" placeholder={t("rejectWithNote")} value={note} onChange={e=>setNote(e.target.value)} style={{marginBottom:10}}/>
      <div className="muted" style={{fontSize:11,marginBottom:8}}>{t("feedbackLoopHint")}</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {canOwner&&!pkg.affectsCap&&<button className="btn" onClick={()=>actOnPackage(pkg.id,"approve",note)}>✔ {t("approve")}</button>}
        {canOwner&&pkg.affectsCap&&<button className="btn" onClick={()=>actOnPackage(pkg.id,"escalate",note)}>⚖ {t("escalate")}</button>}
        {canOwner&&<button className="btn danger" onClick={()=>actOnPackage(pkg.id,"reject",note)}>✕ {t("reject")}</button>}
        {canMin&&<button className="btn" onClick={()=>actOnPackage(pkg.id,"adjudicate",note)}>⚖ {t("adjudicate")}</button>}
        {canMin&&<button className="btn danger" onClick={()=>actOnPackage(pkg.id,"reject",note)}>✕ {t("reject")}</button>}
      </div>
    </div>}
    {/* Approval chain visual */}
    {pkg.status!=="draft"&&<div style={{marginTop:14,borderTop:"1px solid var(--line)",paddingTop:10}}>
      <div className="muted" style={{fontSize:12,marginBottom:8}}>{t("pkg_chain")}</div>
      <div style={{display:"flex",alignItems:"center",gap:0}}>
        {steps.map((s,i)=>{
          const isActive = chainStatus[i];
          const isLast = i===steps.length-1;
          return (<React.Fragment key={s.role}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,flex:1,minWidth:0}}>
              <div style={{width:24,height:24,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:11,fontWeight:700,
                background:isActive?"var(--primary)":"var(--line)",
                color:isActive?"#fff":"var(--muted)"}}>
                {chainLabel[i]===t("pkg_chainSubmitted")?"✓":isActive?"●":"○"}
              </div>
              <div style={{fontSize:10,color:isActive?"var(--text)":"var(--muted)",fontWeight:isActive?600:400,whiteSpace:"nowrap"}}>{s.label}</div>
              <div style={{fontSize:9.5,color:"var(--muted)",whiteSpace:"nowrap"}}>{chainLabel[i]}</div>
            </div>
            {!isLast&&<div style={{flex:"0 0 20px",height:1.5,background:chainStatus[i]&&chainStatus[i+1]?"var(--primary)":"var(--line)",marginBottom:28}}/>}
          </React.Fragment>);
        })}
      </div>
    </div>}
    {pkg.status==="approved"&&<div className="muted" style={{marginTop:10}}>
      <button className="btn ghost sm" onClick={()=>setRoute("copilot")}>🤝 {t("copilot_btn")}</button>
    </div>}
    {/* Timeline */}
    <div className="timeline" style={{marginTop:10}}>
      {pkg.history.map((h,i)=>(<div key={i} className="ev"><div style={{fontSize:12.5}}>
        <span className="tag">{t(h.role)}</span> <b>{t(h.action)}</b> {h.note?("· "+h.note):""}</div>
        <div className="muted" style={{fontSize:11}}>{h.ts}</div></div>))}
    </div>
  </div>);
}
function DecisionPackages({filter,showConfig}){
  const {t,packages,configChanges,user,actOnConfigChange}=useStore();
  const list=packages.filter(filter||(()=>true));
  // Config changes pending approval for this role
  const pendingConfigs = showConfig ? configChanges.filter(c=>{
    if(c.status!=="pending") return false;
    if(showConfig==="owner") return !c.p03Required; // P-02 approves non-ministerial
    if(showConfig==="minister") return c.p03Required; // Minister approves P-03 level
    return false;
  }) : [];
  const [confirm,setConfirm]=useState(null);
  function withConfirm(title,msg,fn,label,danger){
    setConfirm({title,message:msg,onConfirm:()=>{setConfirm(null);fn();},confirmLabel:label,confirmDanger:danger});
  }
  return (<div className="fade">
    <PageHeader title={showConfig==="minister"?t("nav_decisions"):t("nav_approvals")}
      sub={showConfig==="minister"?t("cockpit_sub"):t("pkg_sub")}
      right={<AgentBadge name={t("agent_route")} lvl="L3"/>}/>
    {/* Config changes pending approval */}
    {pendingConfigs.length>0 && <Section title={<span className="sect-right">{t("config_pending_config")}<span className="chip info" style={{fontSize:10,marginInlineStart:6}}>{pendingConfigs.length}</span></span>}>
      {pendingConfigs.map(cc=>{
        const statusLabel = cc.p03Required ? t("config_status_pending_short")+" · P-03" : t("config_status_pending_short");
        return (<div key={cc.id} className="card pad" style={{marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
            <div>
              <span className="wo">{cc.id}</span>
              <span className="chip info" style={{marginInlineStart:6,fontSize:10}}>{statusLabel}</span>
            </div>
          </div>
          <div style={{marginTop:6,fontWeight:600,fontSize:14}}>{cc.paramLabel}</div>
          <div className="pkg-detail" style={{marginTop:6}}>
            <div className="muted" style={{fontSize:12}}>{t("config_from_param")} <b>{cc.oldValue}{cc.unit}</b> → {t("config_to_param")} <b style={{color:"var(--primary)"}}>{cc.newValue}{cc.unit}</b></div>
            {cc.reason && <div style={{fontSize:12.5,marginTop:4}}>📝 {cc.reason}</div>}
            {cc.impactPreview && <div style={{fontSize:12,marginTop:2,color:"var(--muted)"}}>💡 {cc.impactPreview}</div>}
            {cc.effectiveFrom && <div style={{fontSize:12,marginTop:2,color:"var(--muted)"}}>⏱ {t("config_effective_from")}: {cc.effectiveFrom}</div>}
          </div>
          <div style={{display:"flex",gap:6,marginTop:10}}>
            <button className="btn sm" onClick={()=>withConfirm(t("config_confirm_approve_title"),t("config_confirm_approve_msg"),()=>actOnConfigChange(cc.id,"approve",window.prompt("Approval note (optional)")||""),t("approve"))}>✔ {t("approve")}</button>
            <button className="btn danger sm" onClick={()=>withConfirm(t("config_confirm_reject_title"),t("config_confirm_reject_msg"),()=>actOnConfigChange(cc.id,"reject",window.prompt("Rejection reason")||""),t("reject"),true)}>✕ {t("reject")}</button>
          </div>
        </div>);
      })}
    </Section>}
    {/* Regular packages */}
    {pendingConfigs.length>0 && list.length>0 && <div className="divider"/>}
    <Section title={t("nav_packages")}>
      {list.length===0? <div className="card pad muted">{t("noItems")}</div>
        : list.map(p=><PackageCard key={p.id} pkg={p}/>)}
    </Section>
    {confirm && <ConfirmModal title={confirm.title} message={confirm.message}
      confirmLabel={confirm.confirmLabel} confirmDanger={confirm.confirmDanger}
      onConfirm={confirm.onConfirm} onCancel={()=>setConfirm(null)}/>}
  </div>);
}

/* ---- Owner home ---- */
function OwnerHome(){
  const {t,packages,budget,configChanges,setRoute,baseline}=useStore(); const {money}=useMoney();
  const pending=packages.filter(p=>p.status==="submitted").length;
  const escalated=packages.filter(p=>p.status==="escalated").length;
  const totalBudget=budget.cash+budget.inkind+(budget.ceiling||0);
  const usedPct=Math.round((totalBudget-(baseline.remainingBudget||0))/totalBudget*100);
  return (<div className="fade">
    <PageHeader title={t("home_hello")+" · "+t("owner_full")} sub={t("approvals_sub")}/>
    <div className="cols-4" style={{marginBottom:16}}>
      <KPI label={t("kpi_pending")} value={pending} sub={escalated>0?("↑ "+escalated+" "+t("nav_approvals")):""} tone={pending?"warn":"good"}/>
      <KPI label={t("kpi_fairness")} value={baseline.FG.toFixed(2)} sub={t("fair_if")} tone={baseline.FG<1.0?"bad":"good"}/>
      <KPI label={t("kpi_hbr")} value={pct1(baseline.HBR)} sub={t("target")+" ≤38%"} tone={baseline.HBR>0.38?"bad":"warn"}/>
      <KPI label={t("kpi_adoption")} value="65%" sub={t("target")+" 75%"}/>
    </div>
    <div className="cols-3" style={{marginBottom:16}}>
      <div className="mini-kpi"><div className="muted">{t("fc_annualBudget")}</div><div className="v">{money(totalBudget)}<span className="muted" style={{fontSize:11,fontWeight:400}}> M</span></div></div>
      <div className="mini-kpi"><div className="muted">{t("kpi_budget")}</div><div className="v" style={{color:usedPct>=90?"var(--danger)":usedPct>=70?"var(--amber)":"var(--primary)"}}>{usedPct}%</div></div>
      <div className="mini-kpi"><div className="muted">{t("budgetBalance")}</div><div className="v">{money(baseline.remainingBudget||0)}<span className="muted" style={{fontSize:11,fontWeight:400}}> M</span></div></div>
    </div>
    <Section title={t("nav_approvals")} right={<button className="btn sm" onClick={()=>setRoute("decisions")}>{t("view")} {ArrowIcon}</button>}>
      {pending? <div>{packages.filter(p=>p.status==="submitted").slice(0,3).map(p=>
        <div key={p.id} className="card pad" style={{marginBottom:8,cursor:"pointer"}} onClick={()=>setRoute("decisions")}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span><span className="wo">#{p.id}</span> <strong>{p.title}</strong></span>
            <span className="muted" style={{fontSize:12}}>{money(p.kpis.savingsPhase)}</span>
          </div>
        </div>)}
        {pending>3 && <div className="muted" style={{fontSize:12}}>+ {pending-3} {t("more")}</div>}
      </div> : <div className="muted">{t("noItems")}</div>}
    </Section>
    {configChanges.filter(c=>c.status==="pending"||c.status==="draft").length>0&&<Section title={<span className="sect-right">{t("config_pending_config")}<span className="chip info" style={{fontSize:10,marginInlineStart:6}}>{configChanges.filter(c=>c.status==="pending").length}</span></span>} right={<button className="btn sm" onClick={()=>setRoute("approvals")}>{t("config_view_all")} {ArrowIcon}</button>}>
      {configChanges.filter(c=>c.status==="pending").slice(0,3).map(cc=>
        <div key={cc.id} className="card pad" style={{marginBottom:8,cursor:"pointer"}} onClick={()=>setRoute("approvals")}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span><span className="wo">{cc.id}</span> <strong>{cc.paramLabel}</strong> <span className="muted" style={{fontSize:12}}>{t("config_from_param")} {cc.oldValue}{cc.unit} → {cc.newValue}{cc.unit}</span></span>
            <span className="chip info" style={{fontSize:10}}>{t("config_status_pending_short")}</span>
          </div>
        </div>)}
    </Section>}
    <Section title={t("scenarios")} right={<span className="chip gray" style={{fontSize:10}}>{t("nav_home")}</span>}>
      <div className="cols-3">
        {[{icon:"cycle",title:t("scenario_cycle_title"),desc:t("scenario_cycle_desc"),tag:t("tag_monthly"),steps:[["nav_data","data"],["nav_alloc","alloc"],["nav_forecast","forecast"]], start:"alloc",btn:t("scenario_cycle_start")},
          {icon:"whatif",title:t("scenario_policy_title"),desc:t("scenario_policy_desc"),tag:t("tag_ai"),steps:[["nav_whatif","whatif"],["nav_packages","packages"],["nav_approvals","approvals"]], start:"approvals",btn:t("scenario_policy_start")},
          {icon:"monitor",title:t("scenario_monitor_title"),desc:t("scenario_monitor_desc"),tag:t("tag_auto"),steps:[["nav_referrals","monitor"],["nav_fairness","fairness"],["nav_impact","impact"]], start:"forecast",btn:t("scenario_monitor_start")},
        ].map((s,i)=>(<div key={i} className="card pad" style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{width:20,height:20,display:"inline-flex",alignItems:"center"}}><Icon name={s.icon}/></span>
            <strong style={{fontSize:14}}>{s.title}</strong>
            <span className="chip gray" style={{marginInlineStart:"auto",fontSize:10}}>{s.tag}</span>
          </div>
          <div className="muted" style={{fontSize:12}}>{s.desc}</div>
          <div style={{display:"flex",gap:5,alignItems:"center",fontSize:11,flexWrap:"wrap"}}>
            {s.steps.map(([k,ic],j)=>(<React.Fragment key={k}>
              {j>0&&<span style={{color:"var(--muted)",fontSize:10}}>→</span>}
              <span className="chip gray" style={{fontSize:10.5,display:"inline-flex",alignItems:"center",gap:4}}><Icon name={ic}/> {t(k)}</span>
            </React.Fragment>))}
          </div>
          <button className="btn sm" style={{alignSelf:"flex-start"}} onClick={()=>setRoute(s.start)}>{s.btn} {ArrowIcon}</button>
        </div>))}
      </div>
    </Section>
  </div>);
}

/* ---- Minister cockpit ---- */
function MinisterHome(){
  const {t,packages,budget,configChanges,setRoute,baseline}=useStore(); const {money}=useMoney();
  const approved=packages.filter(p=>p.status==="approved"||p.status==="adjudicated");
  const totalSavings=approved.reduce((s,p)=>s+p.kpis.savingsPhase,0);
  const pending=packages.filter(p=>p.status==="escalated").length;
  const totalBudget=budget.cash+budget.inkind+(budget.ceiling||0);
  const usedPct=Math.round((totalBudget-(baseline.remainingBudget||0))/totalBudget*100);
  const contractsTargetPct=Math.round(((baseline.year1Contracts||0)/BRD.targetContractsTotal)*100);
  const savingsIndex=+(totalSavings/totalBudget*100).toFixed(1);
  return (<div className="fade">
    <PageHeader title={t("nav_cockpit")+" · "+t("minister_full")} sub={t("cockpit_sub")}/>
    <div className="cols-4" style={{marginBottom:16}}>
      <KPI label={t("phaseSavings")} value={money(totalSavings)} sub={(totalSavings/BRD.phase3BudgetSAR*100).toFixed(0)+"% "+t("of_budget")} tone="good"/>
      <KPI label={t("kpi_fairness")} value={baseline.FG.toFixed(2)} sub={t("fair_if")} tone={baseline.FG<1.0?"bad":"good"}/>
      <KPI label={t("ownership")} value={pct1(BRD.ownershipNow)} sub={t("target")+" "+pct1(BRD.ownershipTarget)}/>
      <KPI label={t("kpi_pending")} value={pending} sub={t("pkgStatus_escalated")} tone={pending?"warn":"good"}/>
    </div>
    <div className="cols-3" style={{marginBottom:16}}>
      <div className="mini-kpi"><div className="muted">{t("savingsIndex")}</div>
        <div className="v" style={{fontSize:16,color:"var(--primary)"}}>{savingsIndex}%</div>
        <div className="muted" style={{fontSize:11}}>{t("savingsIndexSub")} 10-20%</div></div>
      <div className="mini-kpi"><div className="muted">{t("kpi_budget")}</div>
        <div className="v" style={{color:usedPct>=90?"var(--danger)":usedPct>=70?"var(--amber)":"var(--primary)"}}>{usedPct}%</div></div>
      <div className="mini-kpi"><div className="muted">{t("budgetBalance")}</div>
        <div className="v">{money(baseline.remainingBudget||0)}<span className="muted" style={{fontSize:11,fontWeight:400}}> M</span></div></div>
    </div>
    <Section title={t("contractsTarget")}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
        <span className="muted">{n0(BRD.targetContractsTotal)} ({t("target")})</span>
        <span className="mono">{contractsTargetPct}%</span>
      </div>
      <Progress v={contractsTargetPct/100}/>
      <div style={{display:"flex",gap:16,marginTop:10,flexWrap:"wrap"}}>
        <span className="chip">REDF {n0(BRD.targetBreakdown.redf)}</span>
        <span className="chip">ZATCA {n0(BRD.targetBreakdown.zatca)}</span>
        <span className="chip">Dev. {n0(BRD.targetBreakdown.devHousing)}</span>
      </div>
      <div className="muted" style={{fontSize:12,marginTop:8}}>{t("contractsTargetSub")}</div>
    </Section>
    <Section title={t("nav_decisions")} right={<button className="btn sm" onClick={()=>setRoute("decisions")}>{t("view")} {ArrowIcon}</button>}>
      {pending? <div>{packages.filter(p=>p.status==="escalated").slice(0,3).map(p=>
        <div key={p.id} className="card pad" style={{marginBottom:8,cursor:"pointer"}} onClick={()=>setRoute("decisions")}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span><span className="wo">#{p.id}</span> <strong>{p.title}</strong></span>
            <span className="chip amber">{t("pkgStatus_escalated")}</span>
          </div>
        </div>)}
        {pending>3 && <div className="muted" style={{fontSize:12}}>+ {pending-3} {t("more")}</div>}
      </div> : <div className="muted">{t("noItems")}</div>}
    </Section>
    {configChanges.filter(c=>c.p03Required&&c.status==="pending").length>0&&<Section title={<span className="sect-right">{t("config_pending_config")}<span className="chip info" style={{fontSize:10,marginInlineStart:6}}>{configChanges.filter(c=>c.p03Required&&c.status==="pending").length}</span></span>} right={<button className="btn sm" onClick={()=>setRoute("decisions")}>{t("config_view_all")} {ArrowIcon}</button>}>
      {configChanges.filter(c=>c.p03Required&&c.status==="pending").slice(0,3).map(cc=>
        <div key={cc.id} className="card pad" style={{marginBottom:8,cursor:"pointer"}} onClick={()=>setRoute("decisions")}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span><span className="wo">{cc.id}</span> <strong>{cc.paramLabel}</strong> <span className="muted" style={{fontSize:12}}>{t("config_from_param")} {cc.oldValue}{cc.unit} → {cc.newValue}{cc.unit}</span></span>
            <span className="chip info" style={{fontSize:10}}>{t("config_status_pending_short")}</span>
          </div>
        </div>)}
    </Section>}
    <Section title={t("scenarios")} right={<span className="chip gray" style={{fontSize:10}}>{t("nav_home")}</span>}>
      <div className="cols-3">
        {[{icon:"cycle",title:t("scenario_cycle_title"),desc:t("scenario_cycle_desc"),tag:t("tag_monthly"),steps:[["nav_data","data"],["nav_alloc","alloc"],["nav_forecast","forecast"]], start:"forecast",btn:t("scenario_cycle_start")},
          {icon:"whatif",title:t("scenario_policy_title"),desc:t("scenario_policy_desc"),tag:t("tag_ai"),steps:[["nav_whatif","whatif"],["nav_packages","packages"],["nav_decisions","decisions"]], start:"decisions",btn:t("scenario_policy_start")},
          {icon:"monitor",title:t("scenario_monitor_title"),desc:t("scenario_monitor_desc"),tag:t("tag_auto"),steps:[["nav_fairness","fairness"],["nav_impact","impact"],["nav_benchmark","benchmark"]], start:"forecast",btn:t("scenario_monitor_start")},
        ].map((s,i)=>(<div key={i} className="card pad" style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{width:20,height:20,display:"inline-flex",alignItems:"center"}}><Icon name={s.icon}/></span>
            <strong style={{fontSize:14}}>{s.title}</strong>
            <span className="chip gray" style={{marginInlineStart:"auto",fontSize:10}}>{s.tag}</span>
          </div>
          <div className="muted" style={{fontSize:12}}>{s.desc}</div>
          <div style={{display:"flex",gap:5,alignItems:"center",fontSize:11,flexWrap:"wrap"}}>
            {s.steps.map(([k,ic],j)=>(<React.Fragment key={k}>
              {j>0&&<span style={{color:"var(--muted)",fontSize:10}}>→</span>}
              <span className="chip gray" style={{fontSize:10.5,display:"inline-flex",alignItems:"center",gap:4}}><Icon name={ic}/> {t(k)}</span>
            </React.Fragment>))}
          </div>
          <button className="btn sm" style={{alignSelf:"flex-start"}} onClick={()=>setRoute(s.start)}>{s.btn} {ArrowIcon}</button>
        </div>))}
      </div>
    </Section>
  </div>);
}

/* ---- Audit trail ---- */
function Modal({title,onClose,children}){
  return (<div className="modal-ov" onClick={onClose}>
    <div className="modal-box fade" onClick={e=>e.stopPropagation()}>
      <div className="modal-head"><h3>{title}</h3><button className="modal-x" onClick={onClose} aria-label="close">✕</button></div>
      <div className="modal-body">{children}</div>
    </div>
  </div>);
}
function ConfirmModal({title,message,confirmLabel,cancelLabel,onConfirm,onCancel,confirmDanger}){
  const {t}=useStore();
  return (<div className="modal-ov" onClick={onCancel}>
    <div className="modal-box fade" onClick={e=>e.stopPropagation()} style={{width:420}}>
      <div className="modal-head"><h3>{title}</h3><button className="modal-x" onClick={onCancel}>✕</button></div>
      <div className="modal-body">
        <div style={{fontSize:14,lineHeight:1.7,marginBottom:20,color:"var(--ink)"}}>{message}</div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
          <button className="btn secondary" onClick={onCancel}>{cancelLabel||t("back")}</button>
          <button className={confirmDanger?"btn danger":"btn"} onClick={onConfirm}>{confirmLabel||t("approve")}</button>
        </div>
      </div>
    </div>
  </div>);
}
/* ---- Permission Matrix (BRD Appendix A) ---- */
const RACI_ROWS=[
  {uc:"Data import & readiness",          view:"💚", edit:"—", approve:"—", note:"sys"},
  {uc:"Subsidy formula",           view:"💚", edit:"—", approve:"—", note:"read-only"},
  {uc:"Data quality & pipeline",              view:"💚", edit:"💚", approve:"—", note:""},
  {uc:"Allocation algorithm",       view:"💚", edit:"💚", approve:"🟡", note:""},
  {uc:"What-if engine",            view:"💚", edit:"💚", approve:"—", note:""},
  {uc:"Beneficiary tracking",      view:"💚", edit:"—", approve:"—", note:"view only"},
  {uc:"Forecasting & fairness",    view:"💚", edit:"—", approve:"—", note:""},
  {uc:"Decision routing & approval",   view:"💚", edit:"💚", approve:"🟡", note:""},
  {uc:"QC & escalation",           view:"💚", edit:"—", approve:"—", note:""},
  {uc:"Audit trail",               view:"💚", edit:"—", approve:"—", note:""},
  {uc:"Post-decision operations",         view:"—",  edit:"—", approve:"—", note:""},
  {uc:"Mortgage planning",         view:"💚", edit:"💚", approve:"—", note:""},
  {uc:"Benchmarking",              view:"💚", edit:"—", approve:"—", note:""},
  {uc:"Agent handoff",             view:"💚", edit:"💚", approve:"—", note:""},
  {uc:"Impact attribution",        view:"💚", edit:"—", approve:"—", note:""},
];
function PermissionsPage(){
  const {t,setRoute}=useStore();
  const RACI_MAP={"Data import & readiness":"raci_data_import","Subsidy formula":"raci_subsidy_formula","Data quality & pipeline":"raci_data_quality","Allocation algorithm":"raci_allocation_algo","What-if engine":"raci_whatif_engine","Beneficiary tracking":"raci_beneficiary_tracking","Forecasting & fairness":"raci_forecasting","Decision routing & approval":"raci_decision_routing","QC & escalation":"raci_qc","Audit trail":"raci_audit_trail","Post-decision operations":"raci_post_decision","Mortgage planning":"raci_mortgage","Benchmarking":"raci_benchmarking","Agent handoff":"raci_agent_handoff","Impact attribution":"raci_impact"};
  return (<div className="fade">
    <PageHeader title={t("permissionMatrix")} sub={t("perm_mat_desc")} right={<button className="btn secondary sm" onClick={()=>setRoute("home")}>← {t("back")}</button>}/>
    <div className="banner" style={{marginBottom:14}}>💚 Analyst &nbsp;·&nbsp; 🟡 Business Owner &nbsp;·&nbsp; 🔴 Minister</div>
    <div className="scrollx"><table className="tbl">
      <thead><tr><th>{t("uc")}</th><th className="center-cell">{t("perm_view")}</th><th className="center-cell">{t("perm_edit")}</th><th className="center-cell">{t("perm_approve")}</th><th>{t("note")}</th></tr></thead>
      <tbody>{RACI_ROWS.map((r,i)=>
        <tr key={i}><td style={{fontWeight:600}}>{t(RACI_MAP[r.uc])}</td>
          <td className="center-cell" style={{fontSize:16}}>{r.view}</td>
          <td className="center-cell" style={{fontSize:16}}>{r.edit}</td>
          <td className="center-cell" style={{fontSize:16}}>{r.approve}</td>
          <td className="muted" style={{fontSize:12}}>{r.note}</td></tr>)}</tbody>
    </table></div>
    <Section title={t("perm_legend")}>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",fontSize:13}}>
        <span>💚 {t("analyst_full")} · {t("perm_analyst_desc")}</span>
        <span>🟡 {t("owner_full")} · {t("perm_owner_desc")}</span>
        <span>🔴 {t("minister_full")} · {t("perm_minister_desc")}</span>
      </div>
    </Section>
  </div>);
}
function AuditTrailPage(){
  const {t,audit,packages}=useStore(); const {money}=useMoney();
  const [sel,setSel]=useState(null); const [cat,setCat]=useState("all");
  const filtered = cat==="all" ? audit : audit.filter(a=>a.cat===cat);
  const CATS=[["all","audit_catAll"],["pkg","audit_catPkg"],["formula","audit_catFormula"],["threshold","audit_catThreshold"],["ref","audit_catRef"],["fair","audit_catFair"],["whatif","audit_catWhatif"],["config","audit_catConfig"]];
  const auditTarget = sel ? audit.find(a=>a.target===sel) : null;
  const pkg = auditTarget?.cat==="pkg" ? packages.find(p=>p.id===sel) : null;
  const levers = pkg ? leverSummary(t,pkg.params||{}) : [];
  return (<div className="fade">
    <PageHeader title={t("nav_audit")} sub={t("audit_sub")}/>
    <div className="banner" style={{marginBottom:14}}>◈ {t("audit_worm")}</div>
    <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
      {CATS.map(([v,k])=>(<button key={v} className={"chip"+(cat===v?" info":" gray")} style={{cursor:"pointer",border:"none",fontSize:12}} onClick={()=>setCat(v)}>{t(k)}</button>))}
    </div>
    <div className="card pad">
      {filtered.length===0? <div className="muted">{t("noItems")}</div> :
      <div className="scrollx"><table className="tbl">
        <thead><tr>
          <th>{t("workOrder")}</th><th>{t("audit_type")}</th><th>{t("level")}</th><th>{t("action")}</th>
          <th>{t("colStatus")}</th><th>{t("time")}</th><th>{t("note")}</th>
        </tr></thead>
        <tbody>{filtered.map((a,i)=>(<tr key={i}>
          <td className="mono"><button className="wo wo-btn" onClick={()=>setSel(a.target)} title={t("auditDetail")}>{a.cat==="pkg"?"#":"⚬"}{a.target}<svg className="wo-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg></button></td>
          <td><span className="chip gray" style={{fontSize:10}}>{a.cat?t("audit_cat"+a.cat.charAt(0).toUpperCase()+a.cat.slice(1)):"—"}</span></td>
          <td><span className="tag">{t(a.role)}</span></td>
          <td>{t(a.action)}</td>
          <td>{statusChip(t, a.status)}</td>
          <td className="muted" style={{whiteSpace:"nowrap"}}>{a.ts}</td>
          <td className="muted" style={{maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.note||"—"}</td>
        </tr>))}</tbody>
      </table></div>}
      {filtered.length>0&&<div className="muted" style={{fontSize:12,marginTop:10}}>{t("openHint")}</div>}
    </div>
    {sel && <Modal title={t("nav_audit")+" · "+sel} onClose={()=>setSel(null)}>
      {pkg ? <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10}}>
          <span className="wo">#{pkg.id}</span>{statusChip(t,pkg.status)}
        </div>
        <h4 style={{margin:"0 0 14px",fontSize:16}}>{pkg.title}</h4>
        <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("leversUsed")}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
          {levers.length? levers.map((l,i)=><span key={i} className="chip gray">{l[0]} <b style={{marginInlineStart:4}}>{l[1]}</b></span>)
            : <span className="muted" style={{fontSize:12}}>{t("noLevers")}</span>}
        </div>
        <div className="cols-3" style={{marginBottom:16}}>
          <div className="mini-kpi"><div className="muted">{t("kpi_savings")}</div><div className="v" style={{color:"var(--primary)"}}>{money(pkg.kpis.savingsPhase)}</div></div>
          <div className="mini-kpi"><div className="muted">{t("kpi_fairness")}</div><div className="v">{pkg.kpis.fg.toFixed(2)}</div></div>
          <div className="mini-kpi"><div className="muted">{t("kpi_hbr")}</div><div className="v">{pct1(pkg.kpis.hbr)}</div></div>
        </div>
        <div className="divider"/>
        <div className="muted" style={{fontSize:12,marginBottom:10}}>{t("nav_audit")}</div>
        <div className="timeline">
          {pkg.history.map((h,i)=>(<div key={i} className="ev"><div style={{fontSize:12.5}}>
            <span className="tag">{t(h.role)}</span> <b>{t(h.action)}</b> {h.note?("· "+h.note):""}</div>
            <div className="muted" style={{fontSize:11}}>{h.ts}</div></div>))}
        </div>
      </div> : auditTarget ? <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10}}>
          <span className="wo">⚬ {auditTarget.target}</span><span className="chip">{auditTarget.status}</span>
        </div>
        <div className="kv" style={{marginBottom:14}}>
          <div className="kv-row"><span className="muted">{t("level")}</span><span className="tag">{t(auditTarget.role)}</span></div>
          <div className="kv-row"><span className="muted">{t("action")}</span><span>{t(auditTarget.action)}</span></div>
          <div className="kv-row"><span className="muted">{t("time")}</span><span>{auditTarget.ts}</span></div>
          <div className="kv-row"><span className="muted">{t("note")}</span><span>{auditTarget.note||"—"}</span></div>
        </div>
      </div> : null}
    </Modal>}
  </div>);
}

/* ---- Copilot handoff ---- */
function CopilotHandoff(){
  const {t,audit,baseline}=useStore(); const {money}=useMoney();
  const [sent,setSent]=useState(false);
  function deliver(){ setSent(true); setTimeout(()=>{ window.open("http://momah.test.hyrhui.com","_blank"); },700); }
  const recoSave=scenarioSavings(computeAllocation(RECO_PARAMS), baseline.spend).phase;
  return (<div className="fade">
    <PageHeader title={t("nav_copilot")} sub={t("copilot_sub")}/>
    <Section title={t("cop_sumTitle")} right={<AgentBadge name={t("agent_route")} lvl="L3"/>}>
      <div className="cols-2">
        <div className="brief-card"><div className="bh">📄 {t("cop_i1")}</div>
          <div className="bv">Package + Monthly</div>
          <div className="bs muted">5 support types · with rationale</div></div>
        <div className="brief-card"><div className="bh">📉 {t("cop_i2")}</div>
          <div className="bv">{pct1(baseline.HBR)} <span style={{color:"var(--muted)"}}>→</span> 33%</div>
          <div className="bs muted">{t("toTarget")}</div></div>
        <div className="brief-card"><div className="bh">⚖ {t("cop_i3")}</div>
          <div className="bv">{baseline.FG.toFixed(2)} <span style={{color:"var(--muted)"}}>→</span> ≥ 1.0</div>
          <div className="bs muted">multi-dimensional</div></div>
        <div className="brief-card"><div className="bh">✦ {t("cop_i4")}</div>
          <div className="bv">{money(recoSave)}</div>
          <div className="bs muted">latest scenario savings (5-yr)</div></div>
      </div>
      <div className="muted" style={{fontSize:12.5,marginTop:14}}><b>{t("cop_for")}:</b> {t("cop_aud")}</div>
      <div className="banner" style={{marginTop:10}}>● {t("cop_note")}</div>
    </Section>
    <Section title="API Contract → Housing Copilot" right={<span className="chip">🤝 {t("manualPush")}</span>}>
      <div className="muted" style={{marginBottom:12}}>{t("deliveredItems")} · response &lt; 30s</div>
      <button className="btn" onClick={deliver}>{sent?("… "+t("opening")):("🤝 "+t("deliver"))}</button>
      <div className="banner" style={{marginTop:14}}>● {t("redline")}</div>
    </Section>
  </div>);
}
/* ===== UC-10 Beneficiary 360° Dashboard (BRD §UC-10) ===== */
const BEN_360 = [
  {id:"BEN-021-8842",tier:"3",region:"Asir",income:"4,200",supportType:"Monthly cash",supportAmt:"1,250",startDate:"2025-08-01",formulaVer:"v1.0",
    curHBR:36,hisHBR:[45,43,40,38,36],events:[{date:"2026-05-15",type:"review",detail:"Referred to analyst"},{date:"2026-06-01",type:"approved",detail:"Approved by owner"}],
    outlook:{upgradeProb:0.38,expectRating:"Stable Continuity"},outcome:"—"},
  {id:"BEN-018-2351",tier:"2",region:"Riyadh",income:"8,700",supportType:"Cash mix",supportAmt:"2,100",startDate:"2025-04-01",formulaVer:"v1.1",
    curHBR:31,hisHBR:[42,39,36,33,31],events:[{date:"2026-04-10",type:"review",detail:"Monitoring"},{date:"2026-05-20",type:"tier_change",detail:"Moved from tier 3"}],
    outlook:{upgradeProb:0.62,expectRating:"Actual Ownership"},outcome:"—"},
  {id:"BEN-033-6721",tier:"4",region:"Makkah",income:"3,100",supportType:"In-kind land",supportAmt:"—",startDate:"2025-11-01",formulaVer:"v1.0",
    curHBR:44,hisHBR:[51,48,47,45,44],events:[],outlook:{upgradeProb:0.12,expectRating:"Default"},outcome:"—"},
];
function Beneficiary360Page(){
  const {t,setRoute}=useStore(); const {money}=useMoney(); const [sel,setSel]=useState(null); const [q,setQ]=useState("");
  const fl=q?BEN_360.filter(b=>b.id.toLowerCase().includes(q.toLowerCase())):BEN_360;
  return (<div className="fade">
    <PageHeader title={t("dash360")} sub={t("dash360_sub")} right={<span className="sect-right">
      <AgentBadge name="Decision Routing Agent" lvl="L3"/>
      <button className="btn ghost sm" onClick={()=>setRoute("referrals")}>← {t("back")}</button>
    </span>}/>
    <Section title={t("ia_search")}>
      <input className="input" placeholder={t("dash360_ph")} value={q} onChange={e=>setQ(e.target.value)} style={{maxWidth:360}}/>
    </Section>
    <Section title={t("results")}>
      {fl.map(b=><div key={b.id} className="card pad" style={{marginBottom:8,cursor:"pointer",transition:"border .15s"}} onClick={()=>setSel(sel?.id===b.id?null:b)}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span><strong className="wo">{b.id}</strong> · {b.region} · <span className={"chip "+(b.curHBR<=35?"good":b.curHBR<=38?"amber":"danger")}>{t("bt_risk")} {b.curHBR}%</span></span>
          <span className="muted">{t("dash360_tier")} {b.tier}</span></div>
        {sel?.id===b.id &&<div style={{marginTop:12,borderTop:"1px solid var(--line)",paddingTop:12}}>
          <div className="m-sect lbl">{t("dash360_profile")}</div>
          <div className="cols-4" style={{marginBottom:10}}>
            <div className="mini-kpi"><div className="muted">{t("bt_region")}</div><div>{b.region}</div></div>
            <div className="mini-kpi"><div className="muted">{t("mt_income")}</div><div>{b.income} SAR</div></div>
            <div className="mini-kpi"><div className="muted">{t("dash360_tier")}</div><div>{b.tier}</div></div>
            <div className="mini-kpi"><div className="muted">{t("dash360_formulaVer")}</div><div>{b.formulaVer}</div></div></div>
          <div className="m-sect lbl">{t("dash360_hbrTrend")}</div>
          <MiniTrend start={b.hisHBR[0]} cur={b.curHBR}/>
          <div className="m-sect lbl">{t("dash360_support")}</div>
          <div className="cols-3" style={{marginBottom:10}}>
            <div className="mini-kpi"><div className="muted">{t("dash360_type")}</div><div>{b.supportType}</div></div>
            <div className="mini-kpi"><div className="muted">{t("mt_cost")}</div><div>{b.supportAmt==="—"?"—":money(+b.supportAmt.replace(",","")*1000)}</div></div>
            <div className="mini-kpi"><div className="muted">{t("mt_startDate")}</div><div>{b.startDate}</div></div></div>
          <div className="m-sect lbl">{t("dash360_events")}</div>
          {b.events.length?<table className="tbl"><thead><tr><th>{t("ia_date")}</th><th>{t("cmp_type")}</th><th>{t("detail")}</th></tr></thead>
            <tbody>{b.events.map((e,i)=><tr key={i}><td className="mono">{e.date}</td><td>{t("act_"+e.type)}</td><td className="muted">{e.detail}</td></tr>)}</tbody></table>
            :<div className="muted">{t("noItems")}</div>}
          <div className="m-sect lbl">{t("dash360_outlook")}</div>
          <div className="cols-2" style={{marginBottom:6}}>
            <div className="mini-kpi"><div className="muted">{t("dash360_upgradeProb")}</div><div>{(b.outlook.upgradeProb*100).toFixed(0)}%</div></div>
            <div className="mini-kpi"><div className="muted">{t("dash360_expectRating")}</div><div className={"chip "+(b.outlook.expectRating==="Default"?"danger":"good")}>{b.outlook.expectRating}</div></div></div>
          <div className="m-sect lbl">{t("dash360_outcome")}</div>
          <div className="muted">{b.outcome==="—"?t("dash360_inProgress"):b.outcome}</div>
        </div>}
      </div>)}
    </Section>
  </div>);
}

/* ===== UC-SYS-01 Composite Orchestration (BRD §UC-SYS-01) ===== */
const ORCH_PATHS = [
  {id:"P1",name:"Comprehensive Report",ucs:["Allocation","Fairness"],mode:"parallel",target:"Decisions",desc:"or_p1"},
  {id:"P2",name:"What-if Simulation",ucs:["Formula","Allocation","Fairness"],mode:"serial",target:"What-if",desc:"or_p2"},
  {id:"P3",name:"Monthly Review",ucs:["Data","Allocation","Forecast","Fairness"],mode:"serial",target:"Decisions",desc:"or_p3"},
  {id:"P4",name:"Decision Package",ucs:["Allocation","Reallocation"],mode:"parallel",target:"Decisions",desc:"or_p4"},
];
const ORCH_EXEC = { P1:"running", P2:"success", P3:"partial", P4:"idle" };
function OrchestrationPage(){
  const {t}=useStore(); const [run,setRun]=useState("P3"); const [exp,setExp]=useState(null);
  return (<div className="fade">
    <PageHeader title={t("nav_orchestration")} sub={t("or_sub")} right={<AgentBadge name={t("agent_orch")} lvl="L3"/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("or_rules")}</div>
    {ORCH_PATHS.map(p=>{
      const ex=ORCH_EXEC[p.id]; const isExp=exp===p.id;
      return (<Section key={p.id} title={<span style={{display:"flex",alignItems:"center",gap:8}}>
        <span className="wo">{p.id}</span><strong>{t("or_"+p.id)}</strong>
        <span className={"chip "+(ex==="success"?"good":ex==="running"?"info":ex==="partial"?"amber":"")}>
          {ex==="running"?"⚡":ex==="success"?"✓":ex==="partial"?"⚠":"○"} {t("or_"+ex)}
        </span>
        <span className="chip">{p.mode==="serial"?t("or_serial"):t("or_parallel")}</span>
        <span className="muted" style={{fontSize:12}}>→ {p.target}</span>
      </span>} right={<button className="btn ghost sm" onClick={()=>setExp(isExp?null:p.id)}>{isExp?t("collapse"):t("expand")}</button>}>
        <div className="muted" style={{marginBottom:8}}>{t(p.desc)}</div>
        <div className="or-flow">
          {p.ucs.map((uc,i)=><div key={i} className="or-step">
            <div className="or-node">{t("area_"+uc.toLowerCase().replace(/[\s-]/g,"_"))}</div>
            {i<p.ucs.length-1 && <div className="or-arrow">{p.mode==="serial"?"→":"↔"}</div>}
          </div>)}
          <div className="or-step"><div className="or-arrow">→</div><div className="or-node or-target">{p.target}</div></div>
        </div>
        {isExp && <div style={{marginTop:10,borderTop:"1px solid var(--line)",paddingTop:10}}>
          <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("or_execDetail")}</div>
          <table className="tbl"><thead><tr><th>{t("cmp_uc")}</th><th>{t("cmp_status")}</th><th>{t("cmp_time")}</th></tr></thead>
            <tbody>{p.ucs.map((uc,j)=>{const s=ex==="success"?"ok":ex==="partial"&&j<2?"ok":ex==="running"&&j<1?"running":"wait";
return <tr key={j}><td className="mono">{t("area_"+uc.toLowerCase().replace(/[\s-]/g,"_"))}</td>
<td><span className={"chip "+(s==="ok"?"good":s==="running"?"info":"")}>{"✓|⚡|○".split("|")[s==="ok"?0:s==="running"?1:2]}</span></td>
<td className="muted">{ex==="success"?j+2:ex==="partial"?j+1:"—"}s</td></tr>;})}</tbody></table>
          {ex==="partial" && <div className="banner" style={{marginTop:8,background:"var(--amber-50)"}}>⚠ {t("or_partialWarn")}</div>}
        </div>}
      </Section>);
    })}
  </div>);
}

/* ---- action labels (merged into i18n) ---- */
// Chinese dictionary — reachable only via URL ?ln=zh (no language button is exposed for it).
I18N.zh = {
  appName:"住房补贴动态分配与优化",
  sso_title:"统一身份登录", sso_sub:"统一访问市政与住房部数字服务。", identity:"身份",
  signInTitle:"登录", forgotPwd:"忘记密码？", securityCode:"验证码", or_:"或",
  nafath:"Nafath 国民统一登录", noAccount:"还没有账号？", createAccount:"创建新账号",
  nic1:"NIC", nic2:"国民身份证", identityPh:"选择身份",
  copyright:"© 2026 — 市政与住房部 · 住房支援署", brandLine:"住房补贴动态分配", login_btn:"登录",
  ministry:"市政与住房部", agency:"住房支援署", syntheticData:"合成演示数据 — 非真实受益方",
  login:"登录", username:"用户名", password:"密码", chooseRole:"选择演示身份",
  loginHint:"演示已预填密码（无真实认证）。", enter:"进入", logout:"退出登录", language:"语言", currency:"货币", resetDemo:"重置演示",
  analyst:"分析师", owner:"业务负责人", minister:"部长",
  analyst_full:"分析师", owner_full:"业务负责人", minister_full:"部长",
  analyst_desc:"运行分析与 What-if，组装并上报决策包。", owner_desc:"审阅并采纳战术级推荐。", minister_desc:"裁决战略事项（补贴上限 / 内部法规）。",
  nav_home:"仪表盘", nav_data:"数据就绪", nav_alloc:"分配方案", nav_forecast:"支出预测", back:"返回",
  nav_whatif:"What-if 模拟", nav_packages:"决策包", nav_approvals:"审批中心",
  nav_audit:"审计轨迹", act_version:"版本变更", act_threshold:"阈值修改", act_refer:"转介", act_report:"漏损上报", audit_worm:"仅追加 · 不可删除或修改 · 所有决策与操作永久记录",
  audit_catAll:"全部", audit_catPkg:"决策", audit_catFormula:"公式", audit_catThreshold:"阈值", audit_catRef:"受益方", audit_catFair:"公平性/漏损", audit_catWhatif:"模拟",
  nav_copilot:"住房 Copilot", nav_cockpit:"战略驾驶舱", nav_decisions:"战略决策", nav_fairness:"公平与漏损监测", nav_orchestration:"编排", nav_dash360:"受益方 360°",
  kpi_savings:"预计节省（5年）", kpi_fairness:"公平性差距", kpi_hbr:"住房负担（HBR）",
  kpi_budget:"预算占用率", kpi_contracts:"契约达成进度", kpi_pending:"待决策项",
  kpi_forecastErr:"预测误差", kpi_dataReady:"数据就绪度", kpi_adoption:"采纳率",
  of_budget:"占 79 亿预算", target:"目标", baseline:"基线", current:"当前",
  fair_if:"≥ 1.0 视为公平", toTarget:"向 2030 目标 30–35%",
  explain:"查看理由", impact:"预测影响", submit:"组装并上报决策包", approve:"采纳",
  reject:"驳回并反馈", escalate:"上报部长", adjudicate:"裁决", view:"查看",
  run:"运行", running:"运行中…", done:"完成", apply:"应用", todo:"待办", status:"状态",
  region:"地区", incomeBand:"收入档", contracts:"契约数", subsidy:"平均支援", share:"占比",
  before:"前", after:"后", delta:"变化", scenario:"情景", recommended:"推荐",
  notifTitle:"决策包已上报", noItems:"暂无内容。",
  src_sakani:"Sakani 平台", src_redf:"房地产发展基金（REDF）", src_nhc:"国家住房公司（NHC）",
  src_rega:"房地产总局（Rega）", src_ncsi:"统计总局（NCSI）", src_sama:"中央银行（SAMA）",
  st_ok:"已更新", st_pending:"待批准", st_delayed:"延迟 3–6 个月", quality:"质量", freq:"更新频率",
  bl_lt5:"< 5,000", bl_5to8:"5,000–8,000", bl_8to10:"8,000–10,000",
  bl_10to13:"10,000–13,000", bl_13to16:"13,000–16,000", bl_gt16:"> 16,000",
  below10k:"1 万以下", above10k:"1 万以上",
  rg_riyadh:"利雅得", rg_makkah:"麦加", rg_eastern:"东部省", rg_madinah:"麦地那", rg_asir:"阿西尔",
  rg_qassim:"卡西姆", rg_tabuk:"塔布克", rg_hail:"哈伊勒", rg_jazan:"吉赞", rg_najran:"纳季兰",
  rg_bahah:"巴哈", rg_jawf:"焦夫", rg_northern:"北部边境",
  rg_national:"全国（所有区域）",
  home_hello:"欢迎", monthlyCycle:"月度配分复核",
  data_sub:"每日自动循环清洗数据，并将价格与预算写入 BIDSC。",
  runCycle:"运行每日数据循环", writingBidsc:"写入 BIDSC", bidscDone:"BIDSC 已更新",
  alloc_sub:"在已批准政策矩阵内的可解释建议分配。",
  forecast_sub:"12 个月支出预测与预算上限，加多维公平性差距与漏损。",
  fc_stressTitle:"压力情景分析", fc_stressSub:"3 种自动压力情景", fc_stressTip:"预测引擎自动产生的 3 种压力情景",
  fc_stressScenario:"情景", fc_stressImpact:"影响", fc_stressNote:"说明", fc_stressBr:"系统自动产生以上 3 种压力情景",
  supportType:"支持类型", st_monthly:"月付", st_package:"一次性", st_mix:"混合",
  fc_stressRate:"利率 +2%", fc_stressRateNote:"利率提高 2% 增加长期负债",
  fc_stressExit:"退出减少 50%", fc_stressExitNote:"早期退出减少可释放部分预算",
  fc_stressNew:"新增合同 +20%", fc_stressNewNote:"新增合同增加未来承诺",
  fc_base:"基线", fc_stress:"压力情景",
  fc_alertRules:"预警规则", fc_alertTip:"70% / 90% 预警阈值",
  fc_alertType:"预警类型", fc_alertThreshold:"阈值", fc_alertAction:"响应操作",
  fc_earlyWarn:"早期预警", fc_earlyWarnAction:"通知 P-01/P-02 · 触发再平衡评估",
  fc_depletion:"耗竭危险", fc_depletionAction:"直接通知 P-02 和部长",
  fc_liability2050:"2050 负债高企", fc_liabilityAction:"利率变动触发 · 刺激 What-if 评估",
  fc_demandShort:"需求不足", fc_demandAction:"签约率<80% · 触发再平衡",
  fc_annualBudget:"年预算", fc_ratePlus:"利率上升", fc_contractRate:"签约率",
  fc_alertBr:"预警不自动停止支出 —— 始终转给人做决策",
  fc_portfolioTitle:"投资组合义务表", fc_portfolioTip:"承诺、负债、提前还贷率、压力情景",
  fc_portField:"字段", fc_portRateCommit:"利息支援承诺", fc_portRateCommitNote:"差值 × 剩余贷款本金（摊销）— 来自公式引擎 + BIDSC",
  fc_portInterestCommit:"利息支援承诺 (SAR)", fc_portInterestCommitNote:"来自公式引擎 + BIDSC",
  fc_portInkindCommit:"实物支援承诺", fc_portInkindCommitNote:"已批准期房项目 — 交房时一次性承诺",
  fc_portAnnualCommit:"年度总承诺", fc_portAnnualCommitNote:"字段 14+15+16 — 超过预算上限时标红",
  fc_portCumulative:"累计负债 (SAR)", fc_portCumulativeNote:"从当前年到 2050 年的累计总额",
  fc_portEarlyExit:"预期提前还贷率 (%)", fc_portEarlyExitNote:"来自成效追踪 — 作为负债折减因子",
  fc_portStress20:"压力情景 — 利率+2% 影响", fc_portStress20Note:"利率上升使利息支援承诺增加约 9.4%",
  fc_portStress21:"压力情景 — 提前退出-30% 影响", fc_portStress21Note:"提前退出减少使活跃合同义务增加约 6.8%",
  fc_portStress22:"压力情景 — 新合同+20% 影响", fc_portStress22Note:"新合同使总承诺增加约 17.4%",
  fc_portWarn:"年度承诺超出已批准预算上限 — 已标红（字段 17）。已发出告警。",
   rejectWithNote:"以修改备注驳回（如：以更低预算上限重新计算）", feedbackLoopHint:"驳回后决策路由将推荐返回来源引擎重新计算。如再次被驳回，升级至部长。",
  savingsIndex:"累计节余指数", savingsIndexSub:"目标范围:", contractsTargetSub:"目标：510,000 合同 (2026-2030) · 310K REDF · 150K ZATCA · 50K 开发性住房",
  spendForecast:"支出预测（12 个月）", budgetCeiling:"预算上限", alert:"预警",
  alertMsg:"累计支出超过月度上限的 70% — 已发出预警。",
  fairnessByRegion:"各地区公平性差距", leakage:"漏损与不当受益信号", fairness_sub:"多维公平性差距分析与漏损检测，含升级处置流程。",
  whatif_sub:"用自然语言提问或拖动杠杆——编排层调度智能体，KPI 实时更新。",
  nlPlaceholder:"例如：把 1 万以下家庭的支援上调 10%，评估影响",
  nlTestTip:"测试公式影响 → 调整下方杠杆运行",
  orchestration:"智能体编排", levers:"政策杠杆",
  lv_realloc:"再分配 >1万 → <1万", lv_cap:"封顶 >1万 支援", lv_boost:"提升 <1万 支援", lv_offplan:"限制期房（off-plan）",
  runWhatif:"运行模拟", compare:"基线 vs 情景", assembleFromHere:"由此情景组装决策包",
  pkg_sub:"组装已解释的决策包并沿决策链上报。",
  approvals_sub:"审阅分析师上报的战术级推荐。",
  cockpit_sub:"战略 KPI 与需部长裁决的事项。",
  decisions_sub:"上报待战略裁决的事项（补贴上限 / 内部法规）。",
  audit_sub:"每次提交、采纳、驳回、裁决都被记录。", audit_type:"类型", auditDetail:"审计轨迹详情", openHint:"点击工单编号查看详情",
  copilot_btn:"交付至 Housing Copilot", copilot_sub:"经批准的输出通过 API 契约交付 Housing Copilot。",
  deliver:"交付至 Housing Copilot", opening:"正在打开 Housing Copilot…",
  redline:"系统只做推荐：永不自动审批、永不自动停补、永不修改法规。",
  scenarios:"业务场景导航",
  scenario_cycle_title:"场景一：月度配分周期",
  scenario_cycle_desc:"端到端运行月度配分流程：数据检查 → 公式确认 → 配分计算 → 预测与预警。",
  scenario_cycle_start:"开始月度配分",
  scenario_policy_title:"场景二：政策推演与决策",
  scenario_policy_desc:"在沙箱中测试政策杠杆，组装决策包并提交审批流转。",
  scenario_policy_start:"开始政策模拟",
  scenario_monitor_title:"场景三：分配监测",
  scenario_monitor_desc:"追踪受益方改善、监控公平性与漏损、分析政策市场影响。",
  scenario_monitor_start:"开始监控",
    navGroup_sim:"模拟推演", navGroup_alloc:"月度分配",
    navGroup_monitor:"监测处置", navGroup_tools:"专题工具",
    navGroup_approve:"审批决策", navGroup_observe:"全局监控", navGroup_sys:"系统",
    navTab_overview:"总览", navTab_data:"数据", navTab_allocation:"分配",
    navTab_simulation:"推演", navTab_governance:"决策", navTab_settings:"设置",
  pkgStatus_draft:"草稿", pkgStatus_submitted:"待业务负责人", pkgStatus_approved:"已采纳（战术）",
  pkgStatus_escalated:"待部长", pkgStatus_adjudicated:"已裁决", pkgStatus_rejected:"已驳回",
  pkgStatus_activated:"已激活", pkgStatus_rolled_back:"已回滚", pkgStatus_modified:"已修改", pkgStatus_referred:"已转介", pkgStatus_recorded:"已记录",
  needsMinister:"超出战术权限 — 涉及补贴上限。上报部长。",
  by:"由", at:"于", level:"级别", agentChain:"编排链路",
  ag_uc01:"补贴公式", ag_uc03:"优化", ag_uc04:"预测", ag_uc08:"公平",
  deliveredItems:"补贴推荐 · HBR · 公平性差距 · What-if 结果",
  annualSavings:"年度节省", phaseSavings:"5年节省", reviewRun:"审阅并运行 What-if",
  contractsTarget:"契约目标 2026–2030", ownership:"自有率",
  more:"更多", workOrder:"工单编号", colStatus:"状态", records:"记录数", vsPrev:"较上一循环",
  completeness:"完整度", lastUpdate:"最近更新", leversUsed:"所用杠杆", expectedImpact:"预期影响",
  alertTitle:"预算预警", quickActions:"快捷入口", action:"动作", time:"时间", note:"备注", noLevers:"无变化（基线）",
  td_alloc:"审阅本月配分方案", td_forecast:"处理支出预警", td_whatif:"运行利率情景的 What-if",
  td_packages:"上报已组装的决策包", td_copilot:"向 Housing Copilot 交付已批准输出",
  due_today:"今日到期", due_3:"3 项待处理", due_2:"2 项就绪", due_soon:"本周", due_1:"1 项待办",
  svc_section:"核心服务", btn_details:"详情", btn_open:"打开", aiWorking:"智能体编排中…", cycleDone:"循环完成 — 数据源已刷新",
  tag_auto:"每日自动", tag_monthly:"月度循环", tag_ai:"AI · 实时", tag_explain:"可解释", tag_audit:"已留痕", tag_api:"API 契约",
  pkg_type:"类型", pkg_rationale:"目的", pkg_impact:"预期影响",
  pkg_affected:"受影响户数", pkg_reclassified:"重分类合同",
  pkg_chain:"审批链路", pkg_chainSubmitted:"已提交", pkg_chainApproving:"待审批", pkg_chainAdjudicating:"待裁决",
  pkg_formulaChange:"公式变更", pkg_noFormulaChange:"无公式变更",
};
Object.assign(I18N.zh,{ act_submit:"已提交", act_approve:"已采纳（战术）", act_escalate:"已上报部长", act_adjudicate:"已裁决", act_reject:"已驳回", act_whatif:"模拟推演" });
Object.assign(I18N.en,{ act_submit:"Submitted", act_approve:"Approved (tactical)", act_escalate:"Escalated to Minister", act_adjudicate:"Adjudicated", act_reject:"Rejected", act_whatif:"What-if simulation" });
Object.assign(I18N.ar,{ act_submit:"تم الرفع", act_approve:"اعتُمد (تكتيكي)", act_escalate:"رُفع للوزير", act_adjudicate:"تم البتّ", act_reject:"رُفض", act_whatif:"محاكاة ماذا-لو" });
Object.assign(I18N.en,{ alloc_autosync:"Monthly auto-sync · 1st at 06:00", lastSyncAt:"Last sync", recalc:"Recalculate", recalculating:"Recalculating…", lastRecalc:"Last recalculated", approveSubmit:"Approve & submit", allocStatus_draft:"Draft", allocStatus_submitted:"Awaiting Business Owner", allocStatus_approved:"Approved", allocStatus_rejected:"Rejected", rejectReason:"Rejection reason", rejectReasonPh:"Enter a reason for rejection…", needReason:"A rejection reason is required.", notSubmittedYet:"The analyst has not submitted the plan yet." });
Object.assign(I18N.zh,{ alloc_autosync:"月度自动同步 · 每月 1 日 06:00", lastSyncAt:"上次同步", recalc:"重算", recalculating:"重算中…", lastRecalc:"上次重算", approveSubmit:"审阅通过并上报", allocStatus_draft:"草稿", allocStatus_submitted:"待业务负责人", allocStatus_approved:"已采纳", allocStatus_rejected:"已驳回", rejectReason:"驳回理由", rejectReasonPh:"请填写驳回理由…", needReason:"请填写驳回理由。", notSubmittedYet:"分析师尚未上报该方案。" });
Object.assign(I18N.ar,{ alloc_autosync:"مزامنة شهرية تلقائية · اليوم 1 الساعة 06:00", lastSyncAt:"آخر مزامنة", recalc:"إعادة الحساب", recalculating:"جارٍ إعادة الحساب…", lastRecalc:"آخر إعادة حساب", approveSubmit:"اعتماد ورفع", allocStatus_draft:"مسودة", allocStatus_submitted:"بانتظار مالك الأعمال", allocStatus_approved:"معتمد", allocStatus_rejected:"مرفوض", rejectReason:"سبب الرفض", rejectReasonPh:"اكتب سبب الرفض…", needReason:"سبب الرفض مطلوب.", notSubmittedYet:"لم يرفع المحلل الخطة بعد." });
Object.assign(I18N.en,{ ff_how:"How it works · roles & data", ff_process:"Process", ff_processText:"Pull the actual distribution from BIDSC and compare it with the allocation plan → compute the multi-dimensional Fairness Gap → run leakage-detection models → produce the monthly report → route alerts to the decision chain.", ff_roles:"Roles", ff_inputs:"Data inputs", role_agent:"Agent (automatic)", role_audit:"Audit team", ff_agentDuty:"Computes the Fairness Gap, runs leakage models, produces the monthly report and alerts.", ff_analystDuty:"Reviews the Fairness Gap report and alerts; can trigger a check manually.", ff_ownerDuty:"Adopts action on detected leakage — a confirmed leak is escalated within 24h.", ff_ministerDuty:"Adjudicates large-scale leakage — over 100 cases, within 4h.", ff_auditDuty:"Reviews leakage reports; the monthly report is stored in the Audit Trail.", ff_inputBidsc:"Actual distribution (BIDSC)", ff_inputPlan:"Allocation plan", ff_inputSeg:"Income band & region", ff_inputTrack:"Beneficiary-review alerts", ff_sla:"Confirmed leak → Business Owner within 24h · Leak affecting >100 cases → Minister within 4h · Support is never auto-suspended — the decision is always human." });
Object.assign(I18N.zh,{ ff_how:"运作方式 · 分工与数据", ff_process:"流程", ff_processText:"从 BIDSC 取实际分配并与分配方案对比 → 计算多维公平性差距 → 跑漏损检测模型 → 出月度报告 → 将告警分级路由。", ff_roles:"分工", ff_inputs:"数据来源", role_agent:"智能体（自动）", role_audit:"审计团队", ff_agentDuty:"计算公平性差距、运行漏损模型、产出月度报告与告警。", ff_analystDuty:"审阅公平性差距报告与告警；可手工触发监测。", ff_ownerDuty:"对检测到的漏损采纳处置——确认漏损 24 小时内上报。", ff_ministerDuty:"裁决大规模漏损——超过 100 个案例，4 小时内升级。", ff_auditDuty:"复核漏损报告；月度报告存入审计轨迹。", ff_inputBidsc:"实际分配（BIDSC）", ff_inputPlan:"分配方案", ff_inputSeg:"收入档与地区", ff_inputTrack:"受益方复核告警", ff_sla:"确认漏损 → 业务负责人 24 小时内 · 影响 >100 案例 → 部长 4 小时内 · 绝不自动停补——决定永远在人。" });
Object.assign(I18N.ar,{ ff_how:"آلية العمل · الأدوار والبيانات", ff_process:"العملية", ff_processText:"سحب التوزيع الفعلي من BIDSC ومقارنته بخطة التخصيص ← حساب فجوة العدالة متعددة الأبعاد ← تشغيل نماذج كشف التسرب ← إنتاج التقرير الشهري ← توجيه التنبيهات.", ff_roles:"الأدوار", ff_inputs:"مصادر البيانات", role_agent:"الوكيل (آلي)", role_audit:"فريق التدقيق", ff_agentDuty:"يحسب فجوة العدالة، ويشغّل نماذج التسرب، ويُنتج التقرير الشهري والتنبيهات.", ff_analystDuty:"يراجع تقرير فجوة العدالة والتنبيهات؛ يمكنه تشغيل الفحص يدوياً.", ff_ownerDuty:"يعتمد إجراءً عند كشف تسرب — يُرفع التسرب المؤكد خلال ٢٤ ساعة.", ff_ministerDuty:"يبتّ في التسرب واسع النطاق — أكثر من ١٠٠ حالة، خلال ٤ ساعات.", ff_auditDuty:"يراجع تقارير التسرب؛ يُحفظ التقرير الشهري في سجل التدقيق.", ff_inputBidsc:"التوزيع الفعلي (BIDSC)", ff_inputPlan:"خطة التخصيص", ff_inputSeg:"شريحة الدخل والمنطقة", ff_inputTrack:"تنبيهات مراجعة المستفيدين", ff_sla:"تسرب مؤكد ← مالك الأعمال خلال ٢٤ ساعة · تسرب يؤثر على أكثر من ١٠٠ حالة ← الوزير خلال ٤ ساعات · لا يُوقف الدعم آلياً — القرار دائماً بشري." });
Object.assign(I18N.en,{ leak_report:"Report", leak_cases:"cases", leak_big:"Large-scale (>100 cases) — must escalate to the Minister", leak_routeHint:"Confirmed leak → Business Owner within 24h · >100 cases → Minister within 4h · Support is never auto-suspended.", leakSev_danger:"Confirmed", leakSev_amber:"Likely", leakSev_info:"Warning", leakStatus_detected:"Detected", leakStatus_submitted:"Awaiting Business Owner", leakStatus_adopted:"Action adopted", leakStatus_escalated:"Awaiting Minister", leakStatus_adjudicated:"Adjudicated", leakStatus_rejected:"Dismissed" });
Object.assign(I18N.zh,{ leak_report:"上报", leak_cases:"案例", leak_big:"大规模（>100 案例）— 必须上报部长", leak_routeHint:"确认漏损 → 业务负责人 24 小时内 · >100 案例 → 部长 4 小时内 · 绝不自动停补。", leakSev_danger:"确认", leakSev_amber:"疑似", leakSev_info:"警示", leakStatus_detected:"已检测", leakStatus_submitted:"待业务负责人", leakStatus_adopted:"已采纳处置", leakStatus_escalated:"待部长", leakStatus_adjudicated:"已裁决", leakStatus_rejected:"已驳回" });
Object.assign(I18N.ar,{ leak_report:"رفع", leak_cases:"حالات", leak_big:"واسع النطاق (>١٠٠ حالة) — يجب الرفع للوزير", leak_routeHint:"تسرب مؤكد ← مالك الأعمال خلال ٢٤ ساعة · >١٠٠ حالة ← الوزير خلال ٤ ساعات · لا يُوقف الدعم آلياً.", leakSev_danger:"مؤكد", leakSev_amber:"محتمل", leakSev_info:"تحذير", leakStatus_detected:"تم الكشف", leakStatus_submitted:"بانتظار مالك الأعمال", leakStatus_adopted:"تم اعتماد الإجراء", leakStatus_escalated:"بانتظار الوزير", leakStatus_adjudicated:"تم البتّ", leakStatus_rejected:"مرفوض" });
Object.assign(I18N.en,{ agent_auto:"auto", agent_forecast:"Forecasting & Flagging agent", agent_fair:"Fairness & Leakage agent", manualPush:"Manual push", srcGroup:"Source systems", connected:"connected", srcFlowCap:"ingested & validated → BIDSC" });
Object.assign(I18N.zh,{ agent_auto:"自动", agent_forecast:"支出预测与预警 agent", agent_fair:"公平与漏损监测 agent", manualPush:"手动推送", srcGroup:"源系统", connected:"已连接", srcFlowCap:"汇聚并校验 → BIDSC" });
Object.assign(I18N.ar,{ agent_auto:"آلي", agent_forecast:"وكيل التنبؤ والتنبيه", agent_fair:"وكيل العدالة والتسرب", manualPush:"دفع يدوي", srcGroup:"الأنظمة المصدر", connected:"متصل", srcFlowCap:"يُجمع ويُتحقق منه ← BIDSC" });
Object.assign(I18N.en,{ agent_data:"Data & Budget Update agent", agent_alloc:"Subsidy Optimization agent", agent_route:"Decision Routing agent", agent_orch:"Multi-agent orchestration",
  fml_fg:"Fairness Gap = (subsidy share to <10k) ÷ (population share of <10k). Fair when ≥ 1.0.",
  fml_hbr:"HBR = monthly housing cost (installment + upkeep) ÷ net monthly income. Target 30–35% by 2030.",
  fml_forecast:"12-month spend via OLS price-elasticity model (2017–2025 data). Early alert at 70% of the monthly ceiling.",
  fml_savings:"Savings = current-matrix spend − scenario spend, over the 5-year phase.",
  fml_commit:"Commitments to 2050 = projected total support outlay across the remaining phase.",
  fml_alloc:"Per band: max housing cost = disposable income × deduction rate (40% for >5k); monthly support = actual − optimal interest." });
Object.assign(I18N.zh,{ agent_data:"数据与预算更新 agent", agent_alloc:"补贴优化 agent", agent_route:"决策路由 agent", agent_orch:"多智能体编排",
  fml_fg:"公平性差距 =（<1万群体获得的支援占比）÷（<1万群体的人口占比）。≥ 1.0 视为公平。",
  fml_hbr:"HBR = 月度住房成本（月供 + 维护）÷ 净月收入。2030 目标 30–35%。",
  fml_forecast:"用 OLS 价格弹性模型（2017–2025 数据）预测 12 个月支出；累计达月度上限 70% 时预警。",
  fml_savings:"节省 = 当前矩阵支出 − 情景支出，按 5 年阶段计。",
  fml_commit:"至 2050 承诺 = 剩余阶段内预计的支援支出总额。",
  fml_alloc:"按收入档：最高住房成本 = 可支配收入 × 扣除率（>5千为 40%）；月度支援 = 实际利率 − 最优利率。" });
Object.assign(I18N.ar,{ agent_data:"وكيل تحديث البيانات والميزانية", agent_alloc:"وكيل تحسين الدعم", agent_route:"وكيل توجيه القرار", agent_orch:"تنسيق متعدد الوكلاء",
  fml_fg:"فجوة العدالة = (حصة الدعم لأقل من ١٠ك) ÷ (حصة سكان أقل من ١٠ك). عادلة عند ≥ ١٫٠.",
  fml_hbr:"HBR = تكلفة السكن الشهرية (القسط + الصيانة) ÷ صافي الدخل الشهري. المستهدف ٣٠–٣٥٪ بحلول ٢٠٣٠.",
  fml_forecast:"تنبؤ إنفاق ١٢ شهراً عبر نموذج OLS لمرونة السعر (بيانات ٢٠١٧–٢٠٢٥)؛ تنبيه مبكر عند ٧٠٪ من السقف الشهري.",
  fml_savings:"الوفورات = إنفاق المصفوفة الحالية − إنفاق السيناريو، على مدى ٥ سنوات.",
  fml_commit:"الالتزامات حتى ٢٠٥٠ = إجمالي إنفاق الدعم المتوقع للفترة المتبقية.",
  fml_alloc:"لكل شريحة: أقصى تكلفة سكن = الدخل المتاح × نسبة الخصم (٤٠٪ لأكثر من ٥ك)؛ الدعم الشهري = الفائدة الفعلية − المثلى." });
Object.assign(I18N.en,{ cop_sumTitle:"Delivery summary", cop_sumText:"After each approval, the outputs are delivered to Housing Copilot via the API Contract (< 30s) and surfaced in its presentation layer as a strategic brief.", cop_for:"For", cop_aud:"Minister · Business Owner · strategic decision-makers", cop_i1:"Support recommendation (type + amount + rationale)", cop_i2:"Current & projected HBR", cop_i3:"Fairness Gap (multi-dimensional)", cop_i4:"What-if results", cop_note:"Read-only consumption — Copilot never executes; decisions stay human." });
Object.assign(I18N.zh,{ cop_sumTitle:"交付摘要", cop_sumText:"每次批准后，输出通过 API 契约交付 Housing Copilot（< 30 秒），并在其展示层作为战略简报呈现。", cop_for:"供参考", cop_aud:"部长 · 业务负责人 · 战略决策层", cop_i1:"补贴推荐（类型 + 金额 + 理由）", cop_i2:"当前与预测 HBR", cop_i3:"公平性差距（多维）", cop_i4:"What-if 结果", cop_note:"只读消费 — Copilot 永不执行；决定始终在人。" });
Object.assign(I18N.ar,{ cop_sumTitle:"ملخص التسليم", cop_sumText:"بعد كل اعتماد، تُسلَّم المخرجات إلى مساعد الإسكان عبر عقد الـ API (< ٣٠ ثانية) وتُعرض في طبقة العرض كموجز استراتيجي.", cop_for:"للاطلاع", cop_aud:"الوزير · مالك الأعمال · صنّاع القرار الاستراتيجي", cop_i1:"توصية الدعم (النوع + المبلغ + المبرر)", cop_i2:"HBR الحالي والمتوقع", cop_i3:"فجوة العدالة (متعددة الأبعاد)", cop_i4:"نتائج المحاكاة", cop_note:"استهلاك للقراءة فقط — لا ينفّذ المساعد؛ القرار يبقى بشرياً." });
Object.assign(I18N.en,{ applyReco:"Apply AI suggestion", save_over:"⚠ Exceeds 43%", rel_title:"Release notes", rel_current:"Latest", rel_close:"Close", rel_tz:"All times in Saudi Arabia Standard Time (AST, UTC+3)" });
Object.assign(I18N.zh,{ applyReco:"应用 AI 建议", save_over:"⚠ 超出 43%", rel_title:"更新日志", rel_current:"最新", rel_close:"关闭", rel_tz:"时间均为沙特时间 (AST，UTC+3)" });
Object.assign(I18N.ar,{ applyReco:"تطبيق توصية الذكاء", save_over:"⚠ يتجاوز ٤٣٪", rel_title:"سجل الإصدارات", rel_current:"الأحدث", rel_close:"إغلاق", rel_tz:"جميع الأوقات بتوقيت السعودية (AST، UTC+3)" });
Object.assign(I18N.en,{ askAI:"Ask AI", runLevers:"Run with current levers", ai_title:"AI assessment", ai_start:"Drag the levers or use Ask AI to start a simulation — I'll assess the trade-offs.", ai_fairlow:"Fairness Gap is still {fg} (<1.0) — the low-income segment is still under-served. I'd raise ‘Reallocate’ or ‘Boost <10k’.", ai_tradeoff:"HBR improves to {hbr} and fairness rises, but boosting low-income support eats into savings (only {save}). I'd offset with a higher cap or off-plan restriction — or accept it as a people-first trade-off.", ai_win:"Savings {save} ({pct}% of budget) with Fairness Gap {fg} — fairness and savings both improve. I'd assemble the decision package and submit.", ai_neutral:"Current scenario: savings {save}, Fairness Gap {fg}, HBR {hbr}. You can fine-tune further or submit.", ai_minister:"Reallocation exceeds 20% — this needs the Minister's adjudication." });
Object.assign(I18N.zh,{ askAI:"Ask AI", runLevers:"按当前杠杆运行", ai_title:"AI 评估", ai_start:"拖动杠杆或用 Ask AI 开始推演 —— 我会评估其中的权衡。", ai_fairlow:"Fairness Gap 仍为 {fg}（<1.0），低收入群体仍偏少。建议提高‘再分配’或‘提升 <1万支援’。", ai_tradeoff:"HBR 降至 {hbr}、公平改善，但提升低收入支援吃掉了节省（仅 {save}）。建议适度提高封顶或限期房来对冲，或接受这是‘惠民优先’的取舍。", ai_win:"节省 {save}（占预算 {pct}%）同时 Fairness Gap 达 {fg}，公平与节流双赢，建议组装决策包并上报。", ai_neutral:"当前情景：节省 {save}、Fairness Gap {fg}、HBR {hbr}。可继续微调或上报。", ai_minister:"再分配超过 20%，按规则需上报部长裁决。" });
Object.assign(I18N.ar,{ askAI:"Ask AI", runLevers:"التشغيل بالروافع الحالية", ai_title:"تقييم الذكاء الاصطناعي", ai_start:"حرّك الروافع أو استخدم Ask AI لبدء المحاكاة — سأقيّم المفاضلات.", ai_fairlow:"فجوة العدالة لا تزال {fg} (<١٫٠) — الشريحة منخفضة الدخل ما زالت غير مخدومة. أنصح برفع ‘إعادة التوزيع’ أو ‘رفع دعم <١٠ك’.", ai_tradeoff:"يتحسّن HBR إلى {hbr} وترتفع العدالة، لكن رفع دعم منخفضي الدخل يستهلك الوفورات (فقط {save}). أنصح بتعويض ذلك برفع التقييد، أو قبولها كمفاضلة ‘الأولوية للناس’.", ai_win:"وفورات {save} ({pct}٪ من الميزانية) مع فجوة عدالة {fg} — تتحسّن العدالة والوفورات معاً. أنصح بتجميع حزمة القرار ورفعها.", ai_neutral:"السيناريو الحالي: وفورات {save}، فجوة العدالة {fg}، HBR {hbr}. يمكنك الضبط الدقيق أو الرفع.", ai_minister:"تتجاوز إعادة التوزيع ٢٠٪ — يتطلب ذلك بتّ الوزير." });
Object.assign(I18N.en,{ syncOk:"Daily data sync succeeded", syncFail:"Daily data sync failed", importTitle:"Import to BIDSC", dropHint:"Drag a file here, or click to choose", validating:"Validating data accuracy…", checkPass:"Validation passed — ready to import", checkFail:"Validation failed — completeness <90% or exceptions >10%", importBtn:"Import to BIDSC", fileLabel:"File" });
Object.assign(I18N.zh,{ syncOk:"每日数据同步成功", syncFail:"每日数据同步失败", importTitle:"导入到 BIDSC", dropHint:"拖拽文件到此，或点击选择", validating:"正在校验数据准确性…", checkPass:"校验通过 — 可导入", checkFail:"校验未通过 — 完整度 <90% 或异常 >10%", importBtn:"导入到 BIDSC", fileLabel:"文件" });
Object.assign(I18N.ar,{ syncOk:"نجحت المزامنة اليومية للبيانات", syncFail:"فشلت المزامنة اليومية للبيانات", importTitle:"استيراد إلى BIDSC", dropHint:"اسحب ملفاً هنا أو اضغط للاختيار", validating:"جارٍ التحقق من دقة البيانات…", checkPass:"اجتاز التحقق — جاهز للاستيراد", checkFail:"فشل التحقق — الاكتمال <٩٠٪ أو الاستثناءات >١٠٪", importBtn:"استيراد إلى BIDSC", fileLabel:"الملف" });
Object.assign(I18N.en,{ sla_window:"Response SLA", sla_left:"left", sla_overdue:"Overdue — escalated", cmp_commit:"Commitments to 2050", cmp_recls:"Households reclassified", cmp_contractsLow:"Contracts to <10k", compareNote:"Compared against the current approved plan (baseline).", cmp_showReco:"Show recommended", cmp_hideReco:"Hide recommended", cmp_recommended:"Recommended", notifications:"Notifications", noNotifs:"You're all caught up.", ntf_sla:"Decision package WO-2026-0309 awaiting approval · 8h left", ntf_leak:"Leakage LK-2026-021 escalated to the Minister", ntf_budget:"Budget balance not updated for 18 days", ntf_sync:"Daily data sync completed" });
Object.assign(I18N.zh,{ sla_window:"响应时限", sla_left:"剩余", sla_overdue:"已超时 — 已升级", cmp_commit:"至 2050 承诺", cmp_recls:"重新分类家庭数", cmp_contractsLow:"流向 <1万 合同", compareNote:"对照当前已批准方案（基线）。", cmp_showReco:"显示推荐方案", cmp_hideReco:"隐藏推荐方案", cmp_recommended:"推荐方案", notifications:"通知", noNotifs:"暂无新通知。", ntf_sla:"决策包 WO-2026-0309 待审批 · 剩余 8 小时", ntf_leak:"漏损 LK-2026-021 已升级至部长", ntf_budget:"预算余额已 18 天未更新", ntf_sync:"每日数据同步已完成" });
Object.assign(I18N.ar,{ sla_window:"مهلة الاستجابة", sla_left:"متبقٍ", sla_overdue:"تجاوز المهلة — تم التصعيد", cmp_commit:"الالتزامات حتى ٢٠٥٠", cmp_recls:"الأسر المُعاد تصنيفها", cmp_contractsLow:"عقود لأقل من ١٠ك", compareNote:"بالمقارنة مع الخطة المعتمدة الحالية (الأساس).", cmp_showReco:"إظهار الموصى به", cmp_hideReco:"إخفاء الموصى به", cmp_recommended:"موصى به", notifications:"الإشعارات", noNotifs:"لا إشعارات جديدة.", ntf_sla:"حزمة القرار WO-2026-0309 بانتظار الاعتماد · متبقٍ ٨ ساعات", ntf_leak:"التسرب LK-2026-021 صُعّد إلى الوزير", ntf_budget:"لم يُحدّث رصيد الميزانية منذ ١٨ يوماً", ntf_sync:"اكتملت المزامنة اليومية للبيانات" });
Object.assign(I18N.en,{ qreport:"Data quality report", totalRecords:"Total records", avgCompleteness:"Avg. completeness", exceptions:"Exceptions", thresholdNote:"Min. for BIDSC 90% · halts if exceptions >10%", qOk:"Within thresholds", qBelow:"Below 90% — analyst review required", qExc:"Exceptions >10% — update halted, analyst alerted", budgetBalance:"Budget balance", budgetSub:"Entered manually by the Business Owner from the official financial report.", bud_cash:"Cash support (monthly + package)", bud_inkind:"In-kind support (off-plan land discount)", bud_ceiling:"Interest support ceiling (bank agreements)", saveBalance:"Save balance", enteredBy:"Entered by", budStale:"No balance for >30 days — analyst & owner alerted.", ownerOnlyBudget:"Budget balance is entered by the Business Owner.", uploadBidsc:"Upload to BIDSC", uploadHint:"Manual upload until source integrations are ready.", uploadedOk:"uploaded to BIDSC", rulesTitle:"Key rules & exceptions", rule1:"Min. completeness to write BIDSC: 90% (adjustable).", rule2:"If exceptions exceed 10%, the update is halted and the analyst is alerted.", rule3:"If a source is unavailable, the last saved data is used with a warning.", rule4:"If no budget balance for 30+ days, analyst & owner are alerted.", rule5:"Allocation, Forecast & Beneficiary-tracking don't run until this cycle completes.", mSar:"M SAR" });
Object.assign(I18N.zh,{ qreport:"数据质量报告", totalRecords:"总记录数", avgCompleteness:"平均完整度", exceptions:"异常率", thresholdNote:"写入 BIDSC 最低 90% · 异常 >10% 即停止", qOk:"在门槛内", qBelow:"低于 90% — 需分析师复核", qExc:"异常 >10% — 更新已停止，已通知分析师", budgetBalance:"预算余额", budgetSub:"由业务负责人依据官方财务报告手工录入。", bud_cash:"现金支援预算（月度 + 套餐）", bud_inkind:"实物支援预算（期房土地折扣）", bud_ceiling:"利息支援上限（银行协议总额）", saveBalance:"保存余额", enteredBy:"录入人", budStale:"已超 30 天未录入余额 — 已告警分析师与业务负责人。", ownerOnlyBudget:"预算余额由业务负责人录入。", uploadBidsc:"上传到 BIDSC", uploadHint:"在数据源集成就绪前用手工上传。", uploadedOk:"已上传到 BIDSC", rulesTitle:"关键规则与异常", rule1:"写入 BIDSC 的最低完整度：90%（可调）。", rule2:"异常超过 10% 时停止更新并通知分析师。", rule3:"数据源不可用时，沿用最近一次有效数据并记警告。", rule4:"超过 30 天未录入预算余额，同时告警分析师与业务负责人。", rule5:"本循环未完成前，分配、预测、受益方追踪均不运行。", mSar:"百万 SAR" });
Object.assign(I18N.ar,{ qreport:"تقرير جودة البيانات", totalRecords:"إجمالي السجلات", avgCompleteness:"متوسط الاكتمال", exceptions:"الاستثناءات", thresholdNote:"الحد الأدنى لـ BIDSC ٩٠٪ · يتوقف إذا تجاوزت الاستثناءات ١٠٪", qOk:"ضمن الحدود", qBelow:"أقل من ٩٠٪ — يتطلب مراجعة المحلل", qExc:"الاستثناءات >١٠٪ — أُوقف التحديث وأُبلغ المحلل", budgetBalance:"رصيد الميزانية", budgetSub:"يُدخله مالك الأعمال يدوياً من التقرير المالي الرسمي.", bud_cash:"الدعم النقدي (شهري + باقة)", bud_inkind:"الدعم العيني (خصم أرض البيع على الخارطة)", bud_ceiling:"سقف دعم الفائدة (اتفاقيات البنوك)", saveBalance:"حفظ الرصيد", enteredBy:"أدخله", budStale:"لا رصيد منذ أكثر من ٣٠ يوماً — تم تنبيه المحلل ومالك الأعمال.", ownerOnlyBudget:"يُدخل رصيد الميزانية مالك الأعمال.", uploadBidsc:"رفع إلى BIDSC", uploadHint:"رفع يدوي حتى تجهز تكاملات المصادر.", uploadedOk:"تم الرفع إلى BIDSC", rulesTitle:"القواعد والاستثناءات الرئيسية", rule1:"الحد الأدنى للاكتمال للكتابة إلى BIDSC: ٩٠٪ (قابل للتعديل).", rule2:"إذا تجاوزت الاستثناءات ١٠٪ يتوقف التحديث ويُبلَّغ المحلل.", rule3:"إذا كان المصدر غير متاح، تُستخدم آخر بيانات محفوظة مع تحذير.", rule4:"إذا مرّ ٣٠+ يوماً دون رصيد، يُبلَّغ المحلل ومالك الأعمال.", rule5:"لا تعمل خطة التخصيص والتنبؤ وتتبع المستفيدين حتى تكتمل هذه الدورة.", mSar:"مليون ريال" });

function nowStr(lang){ return new Date().toLocaleString(lang==="ar"?"ar-SA":"en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}); }

/* ---- Leakage alerts: detected → analyst Report → Business Owner adopt/escalate → Minister adjudicate ---- */
const RAW_LEAKS = [
  { id:"LK-2026-021", k:"Riyadh · off-plan cluster",  sev:"danger", cases:140, status:"detected",  history:[] },
  { id:"LK-2026-022", k:"Makkah · duplicate benefit", sev:"amber",  cases:36,  status:"submitted", history:[{role:"analyst",kind:"report",ts:"02 Jun 09:10",note:""}] },
  { id:"LK-2026-023", k:"Eastern · price drift",      sev:"info",   cases:12,  status:"detected",  history:[] },
];
function seedLeaks(){ return RAW_LEAKS.map(l=>({ ...l, history:l.history.map(h=>({...h})) })); }
const LEAK_KIND_KEY = { report:"leak_report", adopt:"approve", escalate:"escalate", adjudicate:"adjudicate", reject:"reject" };

/* =========================================================================
   Seed mock data (work orders + audit trail) so every role page is populated.
   ========================================================================= */
const STATUS_OF = { act_submit:"submitted", act_approve:"approved", act_escalate:"escalated", act_adjudicate:"adjudicated", act_reject:"rejected" };
function makeKpis(params){ const s=computeAllocation(params); const sv=scenarioSavings(s);
  return { savingsPhase:sv.phase, pctBudget:sv.pctOfBudget, fg:s.FG, hbr:s.HBR }; }
const RAW_SEED = [
  { id:"WO-2026-0312", title:"Q2 reallocation · Riyadh & Makkah", params:{reallocatePct:0.10,boostLowPct:0.08,offPlanPct:0.05}, affectsCap:false, status:"submitted", sla:41,
    type:"comprehensive", regions:["Riyadh","Makkah"], rationale:"Redistribute 10% of high-income contracts to low-income bands in Riyadh and Makkah, boosting fairness from 0.58 towards 0.70.",
    reclassified:6528, affected:6528,
    history:[{role:"analyst",action:"act_submit",ts:"03 Jun 09:12",note:""}] },
  { id:"WO-2026-0309", title:"Off-plan restriction · national", params:{offPlanPct:0.12,capHighPct:0.10}, affectsCap:true, status:"submitted", sla:8,
    type:"comprehensive", regions:[], rationale:"Reduce off-plan subsidy by 12% across all bands combined with a 10% cap on high-income support — savings target ~900M SAR.",
    reclassified:0, affected:5100,
    history:[{role:"analyst",action:"act_submit",ts:"02 Jun 14:40",note:""}] },
  { id:"WO-2026-0305", title:"Monthly support rebalancing", params:{reallocatePct:0.12,boostLowPct:0.10,offPlanPct:0.06}, affectsCap:false, status:"approved",
    type:"comprehensive", regions:[], rationale:"Shift 12% of >10k contracts to <10k bands and boost low-income support by 10% — improves FG to 0.85 while staying within tactical authority.",
    reclassified:7834, affected:7834,
    history:[{role:"analyst",action:"act_submit",ts:"28 May 10:05",note:""},{role:"owner",action:"act_approve",ts:"29 May 11:20",note:"Within tactical authority"}] },
  { id:"WO-2026-0299", title:"Support cap revision · >16k band", params:{capHighPct:0.22,reallocatePct:0.18}, affectsCap:true, status:"escalated", sla:50,
    type:"comprehensive", regions:[], rationale:"Reallocate 18% of high-income contracts to low-income — reallocation exceeds 20% threshold, requiring Minister escalation and FG target of 0.95.",
    reclassified:11750, affected:11750,
    history:[{role:"analyst",action:"act_submit",ts:"24 May 08:30",note:""},{role:"owner",action:"act_escalate",ts:"25 May 09:00",note:"Affects support cap"}] },
  { id:"WO-2026-0288", title:"Phase-3 fairness uplift", params:{reallocatePct:0.25,capHighPct:0.20,boostLowPct:0.15,offPlanPct:0.10}, affectsCap:true, status:"adjudicated",
    type:"comprehensive", regions:["Riyadh"], rationale:"Large-scale fairness uplift: 25% reallocation shifts ~16K contracts to low-income bands, boosting FG above 1.0 with combined savings of 2.1B SAR.",
    reclassified:16320, affected:16320,
    history:[{role:"analyst",action:"act_submit",ts:"18 May 09:00",note:""},{role:"owner",action:"act_escalate",ts:"19 May 10:00",note:""},{role:"minister",action:"act_adjudicate",ts:"21 May 12:30",note:"Approved with monitoring"}] },
  { id:"WO-2026-0276", title:"Aggressive cap scenario", params:{capHighPct:0.35,offPlanPct:0.20}, affectsCap:true, status:"rejected",
    type:"comprehensive", regions:[], rationale:"Aggressive 35% high-income cap combined with 20% off-plan restriction — rejected as too aggressive on >13k bands per owner review.",
    reclassified:0, affected:17850,
    history:[{role:"analyst",action:"act_submit",ts:"12 May 08:15",note:""},{role:"owner",action:"act_reject",ts:"13 May 09:40",note:"Too aggressive on >13k bands"}] },
];
function seedPackages(){ return RAW_SEED.map(p=>({ ...p, params:{...p.params}, history:p.history.map(h=>({...h})), kpis:makeKpis(p.params) })); }
function seedAudit(){
  const pkgAudit=[]; RAW_SEED.forEach(p=>p.history.forEach(h=>pkgAudit.push({ role:h.role, action:h.action, target:p.id, status:STATUS_OF[h.action], ts:h.ts, note:h.note, cat:"pkg" })));
  const ext=[
    {role:"analyst", action:"act_version", target:"FML-v1.1", status:"activated", ts:"16 Jun 14:30", note:"Activated v1.1 (deduction 40→43%)", cat:"formula"},
    {role:"analyst", action:"act_version", target:"FML-v1.0", status:"rolled back", ts:"15 Jun 09:00", note:"Rolled back to v1.0 (deduction 43→40%)", cat:"formula"},
    {role:"owner", action:"act_threshold", target:"set_hbrCeil", status:"modified", ts:"15 Jun 10:15", note:"HBR ceiling 35% → 38% · affects Allocation, Beneficiary, What-if", cat:"threshold"},
    {role:"owner", action:"act_threshold", target:"set_earlyAlert", status:"modified", ts:"14 Jun 11:30", note:"Early alert 65% → 70% · affects Budget forecast", cat:"threshold"},
    {role:"analyst", action:"act_refer", target:"BEN****21", status:"referred", ts:"03 Jun 11:00", note:"HBR 52%→36% · Asir · referred to BO", cat:"ref"},
    {role:"owner", action:"act_approve", target:"BEN****77", status:"approved", ts:"18 May 10:30", note:"Approved exit · Madinah · HBR 46%→35%", cat:"ref"},
    {role:"analyst", action:"act_report", target:"LK-2026-020", status:"submitted", ts:"01 Jun 08:20", note:"Leakage: Riyadh off-plan cluster (140 cases)", cat:"fair"},
    {role:"owner", action:"act_escalate", target:"LK-2026-020", status:"escalated", ts:"01 Jun 11:45", note:">100 cases → escalated to Minister", cat:"fair"},
    {role:"analyst", action:"act_whatif", target:"WI-2026-001", status:"recorded", ts:"02 Jun 16:00", note:"Boost <10k +15% · reallocate 10% · cap high 8% · FG 0.58→0.72", cat:"whatif"},
    {role:"analyst", action:"act_whatif", target:"WI-2026-002", status:"recorded", ts:"30 May 14:20", note:"Off-plan restrict 12% · cap high 15% · savings +⃁ 18.2M", cat:"whatif"},
  ];
  return [...pkgAudit,...ext].reverse();
}

/* ===== Config Changes seed ===== */
function seedConfigChanges(){
  const now=()=>{ const d=new Date(); return d.getDate()+" "+["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]+" "+d.getHours().toString().padStart(2,"0")+":"+d.getMinutes().toString().padStart(2,"0"); };
  return [
    { id:"CC-001", status:"draft", paramKey:"set_earlyAlert", paramLabel:"Early budget alert",
      oldValue:70, newValue:65, unit:"%",
      effectiveFrom:"", reason:"Current spending trajectory approaching 70% early; lowering threshold to detect risk sooner.",
      createdAt:"09 Jul 14:10", submittedBy:"analyst", approvedBy:null,
      impactPreview:"Earlier warning by ~2 weeks. Budget utilization at 63% vs 68%.",
      history:[{role:"analyst",action:"act_submit",ts:"09 Jul 14:10",note:""}],
      affects:"Budget forecast", p03Required:false },
    { id:"CC-002", status:"draft", paramKey:"set_minThresh", paramLabel:"Ministerial escalation (redistribution)",
      oldValue:20, newValue:15, unit:"%",
      effectiveFrom:"", reason:"Recommend lowering escalation threshold to give Minister earlier visibility on reallocation decisions.",
      createdAt:"09 Jul 13:45", submittedBy:"analyst", approvedBy:null,
      impactPreview:"More decisions will require Minister approval. Fewer reallocations above 15% bypass review.",
      history:[{role:"analyst",action:"act_submit",ts:"09 Jul 13:45",note:""}],
      affects:"Reallocation, Decisions", p03Required:true },
    { id:"CC-003", status:"scheduled", paramKey:"set_hbrCeil", paramLabel:"HBR ceiling",
      oldValue:38, newValue:35, unit:"%",
      effectiveFrom:"01 Aug 2026 00:00", reason:"Align HBR ceiling with 2030 target trajectory.",
      createdAt:"08 Jul 09:20", submittedBy:"analyst", approvedBy:"owner",
      impactPreview:"HBR target tightened from 38% to 35%. ~8% more beneficiaries flagged for review.",
      history:[{role:"analyst",action:"act_submit",ts:"08 Jul 09:20",note:""},{role:"owner",action:"act_approve",ts:"08 Jul 14:30",note:"Approved — aligns with 2030 targets"}],
      affects:"Allocation, Beneficiary, What-if", p03Required:false },
  ];
}

/* ===== UC-05 Beneficiary Status Tracking (referral list) ===== */
const REFERRALS=[
  {id:"BEN****21",region:"Asir",band:"band_urgent",cur:36,start:52,source:"bt_gosi",months:3,status:"new",improvement:31,savings:18400,lastReview:null,history:[]},
  {id:"BEN****08",region:"Riyadh",band:"band_low",cur:38,start:49,source:"bt_both",months:2,status:"monitoring",improvement:22,savings:12600,lastReview:"2026-05-28",history:[{date:"2026-05-28",action:"bt_act_review",by:"analyst"}]},
  {id:"BEN****55",region:"Makkah",band:"band_urgent",cur:33,start:47,source:"bt_housing",months:3,status:"new",improvement:30,savings:16200,lastReview:null,history:[]},
  {id:"BEN****32",region:"Eastern",band:"band_low",cur:37,start:55,source:"bt_gosi",months:2,status:"monitoring",improvement:33,savings:19800,lastReview:"2026-05-25",history:[{date:"2026-05-25",action:"bt_act_review",by:"analyst"}]},
  {id:"BEN****19",region:"Qassim",band:"band_mid",cur:34,start:41,source:"bt_housing",months:3,status:"new",improvement:17,savings:9800,lastReview:null,history:[]},
  {id:"BEN****77",region:"Madinah",band:"band_low",cur:35,start:46,source:"bt_both",months:3,status:"approved",improvement:24,savings:13800,lastReview:"2026-05-15",history:[{date:"2026-05-15",action:"bt_act_review",by:"analyst"},{date:"2026-05-18",action:"bt_act_approve",by:"owner"}]},
];
function MiniTrend({start,cur}){
  const a=start,b=cur,m1=a-(a-b)*0.45,m2=a-(a-b)*0.75; const pts=[a,m1,m2,b];
  const mx=Math.max(...pts)+1,mn=Math.min(...pts)-2,W=280,H=72,step=W/(pts.length-1);
  const xy=pts.map((v,i)=>[i*step, H-((v-mn)/(mx-mn))*H]);
  const d=xy.map((p,i)=>(i?"L":"M")+p[0].toFixed(0)+" "+p[1].toFixed(0)).join(" ");
  return (<svg width={W} height={H} style={{display:"block",margin:"4px 0"}}>
    <path d={d} fill="none" stroke="var(--primary)" strokeWidth="2.5"/>
    {xy.map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="3.5" fill={i===xy.length-1?"var(--primary)":"#9bc7b0"}/>)}
  </svg>);
}
function BeneficiaryTracking(){
  const {t,setRoute}=useStore();
  const [list,setList]=useState(REFERRALS);
  const [busy,setBusy]=useState(false); const [sel,setSel]=useState(null);
  const [searchSource,setSearchSource]=useState(""); const [searchStatus,setSearchStatus]=useState("");
  const filtered = list.filter(b=>{
    if(searchSource && b.source!==searchSource) return false;
    if(searchStatus && b.status!==searchStatus) return false;
    return true;
  });
  function runDetect(){ setBusy(true); setTimeout(()=>{
    setList(prev=>prev.map(b=>b.status==="monitoring"&&b.months<3?{...b,months:b.months+1}:b)
      .map(b=>b.status==="monitoring"&&b.months>=3?{...b,status:"new"}:b)); setBusy(false); },900); }
  function act(id,kind){ setList(prev=>prev.map(b=>b.id===id?{...b,status:kind==="refer"?"referred":"monitoring"}:b)); setSel(null); }
  const cnt=k=>list.filter(b=>b.status===k).length;
  const btChip=(s)=>{ const m={new:["bt_new",""],monitoring:["bt_review","info"],referred:["bt_referred","amber"],approved:["bt_approved",""]}; const [k,c]=m[s]; return <span className={"chip "+c}>{t(k)}</span>; };
  const totalSavings=list.reduce((s,b)=>b.status==="approved"?0:b.savings,0);
  return (<div className="fade">
    <PageHeader title={t("nav_referrals")} sub={t("bt_sub")} right={<span className="sect-right">
      <button className="btn secondary sm" onClick={()=>setRoute("dash360")}>👤 {t("bt_360")}</button>
      <button className="btn secondary sm" onClick={runDetect} disabled={busy}>{busy?t("running"):("⟳ "+t("bt_run"))}</button>
      <AgentBadge name={t("agent_track")} lvl="L1"/></span>}/>
    <div className="alert-strong" style={{marginBottom:14}}>
      <span className="alert-ico">⚠</span>
      <div style={{flex:1}}>
        <div className="alert-title">{t("bt_redline_title")}</div>
        <div className="alert-body">{t("bt_redline")}</div>
      </div>
    </div>
    <div className="dr-strip" style={{marginBottom:14}}>
      {[["bt_new","new"],["bt_review","monitoring"],["bt_referred","referred"],["bt_approved","approved"]].map(([lk,k])=>(
        <div key={k} className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t(lk)}</div><div className="v">{cnt(k)}</div></div>))}
      <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_potentialSaving")}</div><div className="v" style={{color:"var(--primary)"}}>{n0(totalSavings)}/mo</div></div>
    </div>
    <Section title={t("nav_referrals")} sub={t("bt_rule")} right={<span className="chip amber">{t("bt_improveRule")}</span>}>
      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <select className="input sm" value={searchSource} onChange={e=>setSearchSource(e.target.value)}>
          <option value="">{t("bt_filterSource")}</option>
          <option value="bt_gosi">{t("bt_gosi")}</option>
          <option value="bt_housing">{t("bt_housing")}</option>
          <option value="bt_both">{t("bt_both")}</option>
        </select>
        <select className="input sm" value={searchStatus} onChange={e=>setSearchStatus(e.target.value)}>
          <option value="">{t("bt_filterStatus")}</option>
          <option value="new">{t("bt_new")}</option>
          <option value="monitoring">{t("bt_review")}</option>
          <option value="referred">{t("bt_referred")}</option>
          <option value="approved">{t("bt_approved")}</option>
        </select>
        {filtered.length!==list.length && <button className="btn ghost sm" onClick={()=>{setSearchSource("");setSearchStatus("")}}>✕ {t("reset")}</button>}
      </div>
      <div className="scrollx"><table className="tbl clickable-rows"><thead><tr>
        <th>{t("bt_id")}</th><th>{t("bt_region")}</th><th>{t("bt_band")}</th>
        <th className="right-num">{t("bt_curHBR")}</th><th className="right-num">{t("bt_startHBR")}</th>
        <th className="right-num">{t("bt_improve")}</th><th>{t("bt_source")}</th><th className="right-num">{t("bt_months")}</th><th>{t("bt_status")}</th></tr></thead>
        <tbody>{filtered.map(b=>{
          const impPct = Math.round((b.start-b.cur)/b.start*100);
          const meetingTarget = b.cur <= 38;
          return (<tr key={b.id} onClick={()=>setSel(b)} style={{cursor:"pointer"}}>
          <td className="mono">{b.id}</td><td>{b.region}</td><td>{t(b.band)}</td>
          <td className="right-num mono" style={{color:meetingTarget?"var(--primary)":"var(--amber)",fontWeight:700}}>{b.cur}%</td>
          <td className="right-num mono muted">{b.start}%</td>
          <td className="right-num mono" style={{color:"var(--primary)"}}>{impPct}%</td>
          <td>{t(b.source)}</td><td className="right-num mono">{b.months}/3</td>
          <td>{btChip(b.status)}</td>
        </tr>);})}</tbody></table></div>
    </Section>
    {sel&&<Modal title={t("bt_detailTitle")+" · "+sel.id} onClose={()=>setSel(null)}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8,marginBottom:14}}>
        <div>
          <div className="muted" style={{fontSize:13}}>{sel.region} · {t(sel.band)} · {t("bt_source")}: {t(sel.source)}</div>
          <div style={{marginTop:6}}>{btChip(sel.status)}</div>
        </div>
        <div className="chip" style={{background:sel.cur<=35?"var(--green-50)":sel.cur<=38?"var(--amber-50)":"var(--danger-50)",color:sel.cur<=35?"var(--green-dark)":sel.cur<=38?"var(--amber)":"var(--danger)"}}>
          {sel.cur<=35?t("bt_lowRisk"):sel.cur<=38?t("bt_medRisk"):t("bt_highRisk")}
        </div>
      </div>

      {/* Status flow chart */}
      <div className="bt-flow" style={{marginBottom:14}}>
        <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>{t("bt_flowTitle")}</div>
        <div className="bt-flow-steps">
          {["bt_stepNew","bt_stepMonitor","bt_stepRefer","bt_stepApprove"].map((k,i)=>{
            const stepNames=["bt_new","monitoring","bt_referred","bt_approved"];
            const stepKey=i===0?"new":i===1?"monitoring":i===2?"referred":"approved";
            const stepLabels={new:["bt_new",""],monitoring:["bt_review","info"],referred:["bt_referred","amber"],approved:["bt_approved",""]};
            const [lk,c]=stepLabels[stepKey];
            const isActive=sel.status===stepKey || (stepKey==="referred" && (sel.status==="approved")) || (stepKey==="monitoring" && (sel.status==="referred"||sel.status==="approved"));
            const isPast=["new","monitoring","referred","approved"].indexOf(sel.status)>i;
            return (<div key={k} className={"bt-flow-step"+(isPast?" bt-flow-past":"")+(isActive?" bt-flow-active":"")}>
              <div className="bt-flow-dot">{isPast?"✓":i+1}</div>
              <div className="bt-flow-label">{t(k)}</div>
            </div>);
          })}
        </div>
      </div>

      <div className="cols-3" style={{marginBottom:14}}>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_curHBR")}</div><div className="v" style={{color:sel.cur<=38?"var(--primary)":"var(--amber)"}}>{sel.cur}%</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_improve")}</div><div className="v" style={{color:"var(--primary)"}}>{Math.round((sel.start-sel.cur)/sel.start*100)}%</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_estSaving")}</div><div className="v" style={{color:"var(--primary)"}}>{n0(sel.savings)}/mo</div></div>
      </div>

      <div className="banner" style={{marginBottom:12,background:sel.cur<=38?"var(--green-50)":"var(--amber-50)",borderColor:sel.cur<=38?"#b8dcca":"#ecdcae"}}>
        <span style={{fontWeight:600}}>{t("bt_hbrTarget")}: 38%</span> · {t("bt_curHBR")} {sel.cur}% · {t("bt_gapToTarget")}: {(sel.cur-38)>0?(sel.cur-38).toFixed(1)+"% ":"✓"}</div>

      <div style={{fontSize:13,marginBottom:2,fontWeight:600}}>{t("bt_trend")}: <span className="mono muted">{sel.start}% → {sel.cur}%</span></div>
      <MiniTrend start={sel.start} cur={sel.cur}/>

      {sel.history.length>0&&<div className="timeline" style={{marginTop:14}}>
        <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>{t("bt_actionHistory")}</div>
        {sel.history.map((h,i)=>(<div key={i} className="ev"><div style={{fontSize:12.5}}>
          <span className="tag">{t(h.by)}</span> <b>{t(h.action)}</b></div>
          <div className="muted" style={{fontSize:11}}>{h.date}</div></div>))}
      </div>}

      <div className="banner" style={{margin:"12px 0",background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>● {t("bt_redline")}</div>

      {(sel.status==="new"||sel.status==="monitoring")&&<div style={{display:"flex",gap:8}}>
        <button className="btn" onClick={()=>act(sel.id,"refer")}>↗ {t("bt_refer")}</button>
        <button className="btn secondary" onClick={()=>act(sel.id,"keep")}>{t("bt_keep")}</button>
      </div>}
    </Modal>}
    {/* BR-09 Segment Trend Report */}
    <Section title={<span className="sect-right">{t("bt_segTrend")}<InfoTip text={t("bt_segTrendTip")}/></span>} sub={t("bt_segTrendSub")}>
      <div className="cols-3" style={{marginBottom:10}}>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_segExpected")}</div><div className="v">42</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_segMobile")}</div><div className="v">{t("bt_band_low")}</div><div className="muted" style={{fontSize:11}}>Asir · Riyadh</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("bt_segBudgetImpact")}</div><div className="v" style={{color:"var(--amber)"}}>-183K/mo</div></div>
      </div>
      <div className="muted" style={{fontSize:12}}>{t("bt_segMore")}</div>
    </Section>
    {/* BR-10 Outcome Scorecard */}
    <Section title={<span className="sect-right">{t("bt_scorecard")}<InfoTip text={t("bt_scorecardTip")}/></span>} sub={t("bt_scorecardSub")}>
      <div className="cols-4" style={{marginBottom:10}}>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreOwn")}</div><div className="v" style={{color:"var(--primary)"}}>18%</div></div>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreStable")}</div><div className="v" style={{color:"var(--primary)"}}>42%</div></div>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreDefault")}</div><div className="v" style={{color:"var(--danger)"}}>11%</div></div>
        <div className="mini-kpi"><div className="muted">{t("bt_scoreExit")}</div><div className="v" style={{color:"var(--amber)"}}>29%</div></div>
      </div>
      <table className="tbl"><thead><tr><th>{t("bt_band")}</th><th>{t("bt_scoreOwn")}</th><th>{t("bt_scoreStable")}</th><th>{t("bt_scoreDefault")}</th><th>{t("bt_scoreExit")}</th><th>{t("cmp_notes")}</th></tr></thead>
        <tbody>
          {[["band_urgent","8%","31%","18%","43%",t("bt_scoreUrgentNote")],["band_low","21%","47%","8%","24%",t("bt_scoreLowNote")],["band_mid","25%","42%","10%","23%",t("bt_scoreMidNote")]].map(r=>
            <tr key={r[0]}><td>{t(r[0])}</td><td className="mono">{r[1]}</td><td className="mono">{r[2]}</td><td className="mono">{r[3]}</td><td className="mono">{r[4]}</td><td className="muted">{r[5]}</td></tr>)}
      </tbody></table>
      <div className="muted" style={{fontSize:12,marginTop:8}}>{t("bt_scorecardNote")}</div>
    </Section>
  </div>);
}

/* ===== UC-12 International Benchmarking ===== */
const BENCH=[
  {dim:"bm_hbr", ksa:40.5, target:34,  oecd:30,  best:25,  lowBetter:true,  unit:"%", conf:"high"},
  {dim:"bm_fair",ksa:0.58, target:1.0, oecd:0.90, best:1.10, lowBetter:false, unit:"", conf:"medium"},
  {dim:"bm_cov", ksa:65,   target:80,  oecd:72,  best:88,  lowBetter:false, unit:"%", conf:"high"},
  {dim:"bm_cost",ksa:1.0,  target:0.85,oecd:0.80, best:0.70, lowBetter:true,  unit:"x", conf:"medium"},
  {dim:"bm_sat", ksa:3.9,  target:4.3, oecd:4.1, best:4.6, lowBetter:false, unit:"/5", conf:"low"},
];
const BM_PROGRAMS=[{k:"bmp_sg",tone:"good"},{k:"bmp_de",tone:"good"},{k:"bmp_uk",tone:"warn"},{k:"bmp_us",tone:"gray"}];
function Benchmarking(){
  const {t,setRoute}=useStore(); const [gen,setGen]=useState(false);
  const [filterDim,setFilterDim]=useState("all"); // UC-13 filtering
  const meets=(b)=> b.lowBetter ? b.ksa<=b.target : b.ksa>=b.target;
  const cmpMax=(b)=>Math.max(b.ksa,b.oecd,b.best,b.target)*1.05;
  const confLabel=(c)=>({high:t("bm_confHigh"),medium:t("bm_confMed"),low:t("bm_confLow")})[c]||c;
  const confColor=(c)=>({high:"var(--primary)",medium:"var(--amber)",low:"var(--danger)"})[c]||"var(--muted)";
  const filteredBENCH = filterDim==="all" ? BENCH : BENCH.filter(b=>{
    const ok=meets(b);
    return filterDim==="meets" ? ok : !ok;
  });
  return (<div className="fade">
    <PageHeader title={t("nav_benchmark")} sub={t("bm_sub")} right={<span className="sect-right">
      <button className="btn secondary sm" onClick={()=>setGen(true)}>📄 {t("bm_gen")}</button>
      <AgentBadge name={t("agent_bench")} lvl="L2"/></span>}/>
    {gen&&<div className="banner" style={{marginBottom:14}}>✓ {t("bm_done")}</div>}
    <Section title={t("nav_benchmark")} sub={t("bm_dimsNote")} right={
      <div style={{display:"flex",gap:6}}>
        <select className="input sm" value={filterDim} onChange={e=>setFilterDim(e.target.value)} style={{width:"auto"}}>
          <option value="all">{t("bm_filterAll")}</option>
          <option value="meets">{t("bm_meets")}</option>
          <option value="below">{t("bm_below")}</option>
        </select>
      </div>
    }>
      <table className="tbl"><thead><tr>
        <th>{t("bm_dim")}</th><th className="right-num">{t("bm_ksa")}</th><th className="right-num">{t("bm_ksaTarget")}</th>
        <th className="right-num">{t("bm_oecd")}</th><th className="right-num">{t("bm_best")}</th><th>{t("bm_gap")}</th><th>{t("bm_confidence")}</th></tr></thead>
        <tbody>{filteredBENCH.map(b=>{ const ok=meets(b); return (<tr key={b.dim}>
          <td>{t(b.dim)} <span className="muted" style={{fontSize:11}}>({t(b.lowBetter?"bm_low":"bm_high")})</span></td>
          <td className="right-num mono" style={{fontWeight:700,color:ok?"var(--primary)":"var(--amber)"}}>{b.ksa}{b.unit}</td>
          <td className="right-num mono muted">{b.target}{b.unit}</td>
          <td className="right-num mono">{b.oecd}{b.unit}</td>
          <td className="right-num mono">{b.best}{b.unit}</td>
          <td><span className={"chip "+(ok?"":"amber")}>{ok?("✓ "+t("bm_meets")):t("bm_below")}</span></td>
          <td><span className="chip" style={{background:confColor(b.conf)+"20",color:confColor(b.conf),borderColor:"transparent"}}>{confLabel(b.conf)}</span></td>
        </tr>);})}</tbody></table>
    </Section>
    <Section title={t("bm_cmpTitle")} sub={t("bm_cmpNote")}>
      {BENCH.map(b=>{ const mx=cmpMax(b); const bar=(v,c)=>(<div className="bmbar-row"><span className="bmbar-lab muted">{c}</span><span className="bmbar"><span style={{width:(v/mx*100)+"%",background:c===t("bm_ksa")?"var(--primary)":c===t("bm_best")?"var(--primary)":"#c8cfd9"}}/></span><span className="bmbar-val mono">{v}{b.unit}</span></div>);
        return (<div key={b.dim} style={{marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:6}}>{t(b.dim)}</div>
          {bar(b.ksa,t("bm_ksa"))}{bar(b.oecd,t("bm_oecd"))}{bar(b.best,t("bm_best"))}
        </div>);})}
    </Section>
    <Section title={t("bm_timeline")} sub={t("bm_timelineNote")}>
      <div style={{display:"flex",overflowX:"auto",gap:0,padding:"8px 0"}}>
        {[{yr:"1968",c:"Singapore CPF",tone:"good"},{yr:"1998",c:"Brazil Minha Casa",tone:"warn"},{yr:"2001",c:"Germany Wohngeld (reform)",tone:"good"},{yr:"2013",c:"UK Help to Buy",tone:"warn"},{yr:"2018",c:"Sakani (KSA launch)",tone:"good"},{yr:"2026",c:"MOMAH DSS (current)",tone:"info"}].map((it,i)=>(<div key={i} style={{display:"flex",alignItems:"center",flexShrink:0}}>
          <div style={{width:100,textAlign:"center",padding:"10px 6px",borderRadius:6,background:it.tone==="good"?"var(--green-50)":it.tone==="warn"?"var(--amber-50)":"#eaf0fb"}}>
            <div style={{fontWeight:700,fontSize:13}}>{it.yr}</div>
            <div style={{fontSize:10.5,lineHeight:1.3,marginTop:2}}>{it.c}</div>
            <span className={"chip "+(it.tone==="good"?"":it.tone==="warn"?"amber":"info")} style={{fontSize:9,marginTop:3}}>{t("bm_tl_"+it.tone)}</span>
          </div>
          {i<5&&<div className="muted" style={{margin:"0 2px",fontSize:16}}>→</div>}
        </div>))}
      </div>
    </Section>
    <Section title={t("bm_applic")}>
      <div className="cols-2">
        {BM_PROGRAMS.map(p=>(<div key={p.k} className={"insight-card "+p.tone}>
          <div className="ic-h">{t(p.k+"_h")}</div>
          <div className="ic-t">{t(p.k+"_t")}</div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          <span className={"chip "+(p.tone==="good"?"":p.tone==="warn"?"amber":"gray")}>{t(p.k+"_tag")}</span>
          <button className="btn sm" style={{marginInlineStart:"auto"}} onClick={()=>setRoute("whatif")}>🧪 {t("fv_test")}</button>
          </div>
        </div>))}
      </div>
    </Section>
    <Section title={t("bm_satTitle")}>
      <div className="muted" style={{fontSize:13,lineHeight:1.7}}>{t("bm_note")}</div>
    </Section>
  </div>);
}
Object.assign(I18N.en,{ bm_cmpTitle:"KSA vs OECD vs best-in-class", bm_cmpNote:"Normalised per dimension", bm_applic:"Reference programs — applicability",
  bmp_sg_h:"Singapore · CPF Housing Grant", bmp_sg_t:"Mandatory savings co-fund home purchase.", bmp_sg_tag:"Directly applicable",
  bmp_de_h:"Germany · Wohngeld", bmp_de_t:"Means-tested housing allowance indexed to rent and income.", bmp_de_tag:"Directly applicable",
  bmp_uk_h:"UK · Help to Buy", bmp_uk_t:"Equity loan for first-time buyers on new-builds.", bmp_uk_tag:"Needs legislative change",
  bmp_us_h:"USA · LIHTC", bmp_us_t:"Tax credits for affordable rental supply.", bmp_us_tag:"Not applicable to context" });
Object.assign(I18N.zh,{ bm_cmpTitle:"沙特 vs OECD vs 最佳实践", bm_cmpNote:"按维度归一化", bm_applic:"参照项目 —— 可借鉴性",
  bmp_sg_h:"新加坡 · CPF 购房补助", bmp_sg_t:"强制储蓄共同出资购房。", bmp_sg_tag:"可直接借鉴",
  bmp_de_h:"德国 · Wohngeld", bmp_de_t:"按租金与收入挂钩的经济状况审查住房津贴。", bmp_de_tag:"可直接借鉴",
  bmp_uk_h:"英国 · Help to Buy", bmp_uk_t:"为首次购房者提供新房股权贷款。", bmp_uk_tag:"需立法修改",
  bmp_us_h:"美国 · LIHTC", bmp_us_t:"为可负担租赁供给提供税收抵免。", bmp_us_tag:"不适用本国情境" });
Object.assign(I18N.ar,{ bm_cmpTitle:"السعودية مقابل OECD مقابل الأفضل", bm_cmpNote:"مُطبَّع لكل بُعد", bm_applic:"برامج مرجعية — قابلية التطبيق",
  bmp_sg_h:"سنغافورة · منحة CPF", bmp_sg_t:"ادخار إلزامي يشارك في تمويل الشراء.", bmp_sg_tag:"قابل للتطبيق مباشرة",
  bmp_de_h:"ألمانيا · Wohngeld", bmp_de_t:"بدل سكن مرتبط بالدخل والإيجار.", bmp_de_tag:"قابل للتطبيق مباشرة",
  bmp_uk_h:"بريطانيا · Help to Buy", bmp_uk_t:"قرض ملكية للمشترين لأول مرة.", bmp_uk_tag:"يتطلب تعديلاً تشريعياً",
  bmp_us_h:"أمريكا · LIHTC", bmp_us_t:"إعفاءات ضريبية لعرض الإيجار الميسور.", bmp_us_tag:"غير قابل للتطبيق" });
Object.assign(I18N.en,{ nav_referrals:"Beneficiary Tracking", nav_benchmark:"Intl. Benchmarking", agent_track:"Beneficiary Status Tracking agent", agent_bench:"Benchmarking agent",
  bt_sub:"Track beneficiary improvement and route referrals for human review", bt_rule:"Improvement = HBR ≤ 38% without support for 3 consecutive months → referral list",
  bt_flowTitle:"Status Flow", bt_stepNew:"Identified", bt_stepMonitor:"Monitoring", bt_stepRefer:"Referred", bt_stepApprove:"Improved",
  bt_redline:"Subsidy continues uninterrupted during review — the system never auto-terminates",
  bt_redline_title:"Never Auto-Terminates · Decision Always Human",
  bt_360:"360° View", bt_improveRule:"Temporary improvement (<3 months) does not generate a referral", bt_run:"Run detection",
  bt_new:"New", bt_review:"Monitoring", bt_referred:"Referred to BO", bt_approved:"Approved",
  bt_id:"Beneficiary", bt_region:"Region", bt_band:"Income band", bt_curHBR:"Current HBR", bt_startHBR:"Start HBR", bt_source:"Improvement source", bt_months:"Duration", bt_status:"Status",
  bt_gosi:"GOSI", bt_housing:"Housing", bt_both:"Both", band_urgent:"Most urgent", band_low:"Low income", band_mid:"Mid income",
  bt_reviewBtn:"Review", bt_reviewTitle:"Beneficiary review", bt_detailTitle:"Beneficiary detail", bt_trend:"3-month HBR trend", bt_keep:"Keep support", bt_refer:"Refer to Business Owner",
  bt_potentialSaving:"Potential savings", bt_improve:"Improvement", bt_estSaving:"Est. monthly saving", bt_hbrTarget:"HBR target", bt_gapToTarget:"Gap to target",
  bt_lowRisk:"Low risk", bt_medRisk:"Medium risk", bt_highRisk:"High risk", bt_actionHistory:"Action history", bt_act_review:"Reviewed", bt_act_approve:"Approved",
  bm_sub:"Benchmark KSA housing support against reference countries (OECD + peers)", bm_gen:"Generate benchmark report", bm_done:"Benchmark report generated",
  bm_dim:"Benchmark", bm_ksa:"KSA (current)", bm_ksaTarget:"KSA target", bm_oecd:"OECD avg", bm_best:"Best-in-class", bm_gap:"Status",
  bm_hbr:"Housing Burden (HBR)", bm_fair:"Fairness Gap", bm_cov:"Coverage", bm_cost:"Cost ratio", bm_sat:"User satisfaction",
  bm_low:"lower better", bm_high:"higher better", bm_meets:"Meets target", bm_below:"Below target",
  bm_dimsNote:"5 benchmarks vs reference countries", bm_satTitle:"User satisfaction",
  bm_note:"Satisfaction blends Sakani ratings, contract-cancellation rate (inverse) and the OECD Better Life Index — contextual only; it does not alter the other benchmark recommendations.",
  bm_confidence:"Confidence", bm_confHigh:"High", bm_confMed:"Medium", bm_confLow:"Low", bm_filterAll:"All dimensions",
  bm_timeline:"Housing policy timeline", bm_timelineNote:"Landmark programmes and their adoptability",
  bm_tl_good:"Directly applicable", bm_tl_warn:"Needs legislative change", bm_tl_info:"Current system",
  bt_segTrend:"Segment Trend Report", bt_segTrendTip:"Identify which beneficiary segments are improving or worsening",
  bt_segTrendSub:"Monthly trend analysis by income band and region", bt_segExpected:"Expected improvements (new)",
  bt_segMobile:"Highest-movement segment", bt_segBudgetImpact:"Budget impact (mo.)", bt_segMore:"Uses a 3-month rolling window. Data refreshes monthly from BIDSC.",
  bt_scorecard:"Outcome Scorecard", bt_scorecardTip:"Outcome-based performance by beneficiary band",
  bt_scorecardSub:"12-month outcome distribution by income tier", bt_scoreOwn:"Ownership", bt_scoreStable:"Stable",
  bt_scoreDefault:"At risk", bt_scoreExit:"Early exit", bt_scoreUrgentNote:"High early-exit risk — needs intervention",
  bt_scoreLowNote:"Majority stable — moderate exit risk", bt_scoreMidNote:"Balanced distribution — monitor defaults",
  bt_scorecardNote:"Tracks outcome status at 12 months post-enrolment. Red = risk threshold above 15%.",
  bt_filterSource:"Filter by source", bt_filterStatus:"Filter by status",
  cmp_notes:"Notes", reset:"Reset" });
Object.assign(I18N.zh,{ nav_referrals:"受益状况分析", nav_benchmark:"国际对标", agent_track:"受益状况分析 Agent", agent_bench:"国际对标 Agent",
  bt_sub:"追踪受益方改善情况，将转复核名单转交人工审核", bt_rule:"改善判定 = 无支援下 HBR ≤ 38% 连续 3 个月 → 进入转复核名单",
  bt_flowTitle:"状态流程", bt_stepNew:"已识别", bt_stepMonitor:"监测中", bt_stepRefer:"已转交", bt_stepApprove:"已改善",
  bt_redline:"复核期间补贴持续不间断 — 系统永不自动停补",
  bt_redline_title:"永不自动终止 · 决策始终由人做出",
  bt_360:"360° 视图", bt_improveRule:"临时改善（<3个月）不生成转介", bt_run:"运行检测",
  bt_new:"新建", bt_review:"监测中", bt_referred:"已转业务负责人", bt_approved:"已批准",
  bt_id:"受益方", bt_region:"区域", bt_band:"收入档", bt_curHBR:"当前 HBR", bt_startHBR:"起始 HBR", bt_source:"改善来源", bt_months:"持续", bt_status:"状态",
  bt_gosi:"GOSI", bt_housing:"住宅", bt_both:"两者", band_urgent:"最急需", band_low:"低收入", band_mid:"中等收入",
  bt_reviewBtn:"复核", bt_reviewTitle:"受益方复核", bt_detailTitle:"受益方详情", bt_trend:"近 3 个月 HBR 趋势", bt_keep:"维持支援", bt_refer:"转业务负责人",
  bt_potentialSaving:"预计节省", bt_improve:"改善幅度", bt_estSaving:"预估月节省", bt_hbrTarget:"HBR 目标", bt_gapToTarget:"距目标差距",
  bt_lowRisk:"低风险", bt_medRisk:"中风险", bt_highRisk:"高风险", bt_actionHistory:"操作历史", bt_act_review:"已完成复核", bt_act_approve:"已批准",
  bm_sub:"将沙特住房支持与参照国(OECD + 同侪)对标", bm_gen:"生成对标报告", bm_done:"对标报告已生成",
  bm_dim:"对标维度", bm_ksa:"沙特(当前)", bm_ksaTarget:"沙特目标", bm_oecd:"OECD 均值", bm_best:"最佳实践", bm_gap:"状态",
  bm_hbr:"住房负担 (HBR)", bm_fair:"公平性差距", bm_cov:"覆盖率", bm_cost:"成本比", bm_sat:"用户满意度",
  bm_low:"越低越好", bm_high:"越高越好", bm_meets:"达标", bm_below:"未达标",
  bm_dimsNote:"5 个维度 vs 参照国", bm_satTitle:"用户满意度",
  bm_note:"满意度综合 Sakani 评分、合同取消率(反向)与 OECD Better Life 指数 —— 仅作上下文参考，不改变其它对标建议。",
  bm_confidence:"置信度", bm_confHigh:"高", bm_confMed:"中", bm_confLow:"低", bm_filterAll:"全部维度",
  bm_timeline:"住房政策时间轴", bm_timelineNote:"标志性项目及其可借鉴性",
  bm_tl_good:"可直接借鉴", bm_tl_warn:"需立法修改", bm_tl_info:"当前系统",
  bt_segTrend:"分段趋势报告", bt_segTrendTip:"识别哪些受益方群体正在改善或恶化",
  bt_segTrendSub:"按月收入档和地区的趋势分析", bt_segExpected:"预期改善（新增）",
  bt_segMobile:"变动最大群体", bt_segBudgetImpact:"预算影响（月）", bt_segMore:"使用 3 个月滚动窗口。数据每月从 BIDSC 刷新。",
  bt_scorecard:"成效计分卡", bt_scorecardTip:"按受益方分级的成效表现",
  bt_scorecardSub:"按收入层级的 12 个月成效分布", bt_scoreOwn:"购房拥有", bt_scoreStable:"稳定",
  bt_scoreDefault:"风险", bt_scoreExit:"提前退出", bt_scoreUrgentNote:"提前退出风险高 — 需干预",
  bt_scoreLowNote:"多数稳定 — 中等退出风险", bt_scoreMidNote:"分布均衡 — 关注违约",
  bt_scorecardNote:"追踪入册后 12 个月的成效状态。红色 = 风险阈值超过 15%。",
  bt_filterSource:"按来源筛选", bt_filterStatus:"按状态筛选",
  cmp_notes:"说明", reset:"重置" });
Object.assign(I18N.ar,{ nav_referrals:"تتبع المستفيدين", nav_benchmark:"المقارنة الدولية", agent_track:"وكيل تتبع حالة المستفيد", agent_bench:"وكيل المقارنة المعيارية",
  bt_sub:"تتبّع تحسّن المستفيدين وإحالة القائمة للمراجعة البشرية", bt_rule:"التحسّن = HBR ≤ ٣٨٪ بدون دعم لمدة ٣ أشهر متتالية ← قائمة الإحالة",
  bt_flowTitle:"تسلسل الحالة", bt_stepNew:"تم التحديد", bt_stepMonitor:"قيد المراقبة", bt_stepRefer:"تمت الإحالة", bt_stepApprove:"تم التحسّن",
  bt_redline:"يستمر الدعم دون انقطاع أثناء المراجعة — النظام لا يوقف الدعم تلقائياً أبداً",
  bt_redline_title:"لا إيقاف تلقائي أبداً · القرار دائماً بشري",
  bt_360:"360° العرض", bt_improveRule:"التحسن المؤقت (أقل من ٣ أشهر) لا يُنشئ إحالة", bt_run:"تشغيل الكشف",
  bt_new:"جديد", bt_review:"قيد المتابعة", bt_referred:"محال لمالك الأعمال", bt_approved:"معتمد",
  bt_id:"المستفيد", bt_region:"المنطقة", bt_band:"شريحة الدخل", bt_curHBR:"HBR الحالي", bt_startHBR:"HBR البدائي", bt_source:"مصدر التحسّن", bt_months:"المدة", bt_status:"الحالة",
  bt_gosi:"التأمينات", bt_housing:"سكني", bt_both:"كلاهما", band_urgent:"الأشد حاجة", band_low:"منخفض الدخل", band_mid:"متوسط الدخل",
  bt_reviewBtn:"مراجعة", bt_reviewTitle:"مراجعة المستفيد", bt_detailTitle:"تفاصيل المستفيد", bt_trend:"اتجاه HBR خلال ٣ أشهر", bt_keep:"الإبقاء على الدعم", bt_refer:"إحالة لمالك الأعمال",
  bt_potentialSaving:"الوفورات المحتملة", bt_improve:"التحسّن", bt_estSaving:"التوفير الشهري التقديري", bt_hbrTarget:"هدف HBR", bt_gapToTarget:"الفجوة للهدف",
  bt_lowRisk:"مخاطر منخفضة", bt_medRisk:"مخاطر متوسطة", bt_highRisk:"مخاطر عالية", bt_actionHistory:"سجل الإجراءات", bt_act_review:"تمت المراجعة", bt_act_approve:"تم الاعتماد",
  bm_sub:"مقارنة دعم الإسكان السعودي بالدول المرجعية (OECD + النظراء)", bm_gen:"توليد تقرير المقارنة", bm_done:"تم توليد تقرير المقارنة",
  bm_dim:"المعيار", bm_ksa:"السعودية (حالي)", bm_ksaTarget:"هدف السعودية", bm_oecd:"متوسط OECD", bm_best:"الأفضل", bm_gap:"الحالة",
  bm_hbr:"عبء السكن (HBR)", bm_fair:"فجوة العدالة", bm_cov:"التغطية", bm_cost:"نسبة التكلفة", bm_sat:"رضا المستخدم",
  bm_low:"الأقل أفضل", bm_high:"الأعلى أفضل", bm_meets:"محقق", bm_below:"دون الهدف",
  bm_dimsNote:"٥ معايير مقابل الدول المرجعية", bm_satTitle:"رضا المستخدم",
  bm_note:"يجمع الرضا تقييمات سكني ونسبة إلغاء العقود (عكسياً) ومؤشر OECD لحياة أفضل — سياقي فقط، لا يغيّر التوصيات الأخرى.",
  bm_confidence:"الثقة", bm_confHigh:"عالية", bm_confMed:"متوسطة", bm_confLow:"منخفضة", bm_filterAll:"جميع الأبعاد",
  bm_timeline:"الخط الزمني للسياسات السكنية", bm_timelineNote:"البرامج البارزة وقابليتها للتطبيق",
  bm_tl_good:"قابل للتطبيق مباشرة", bm_tl_warn:"يتطلب تعديلاً تشريعياً", bm_tl_info:"النظام الحالي",
  bt_segTrend:"تقرير اتجاهات القطاعات", bt_segTrendTip:"تحديد قطاعات المستفيدين التي تتحسن أو تتدهور",
  bt_segTrendSub:"تحليل الاتجاهات الشهرية حسب شريحة الدخل والمنطقة", bt_segExpected:"التحسينات المتوقعة (جديد)",
  bt_segMobile:"القطاع الأكثر تغيراً", bt_segBudgetImpact:"أثر الميزانية (شهري)", bt_segMore:"يستخدم نافذة متجددة لـ 3 أشهر. تُحدّث البيانات شهرياً من BIDSC.",
  bt_scorecard:"بطاقة الأداء", bt_scorecardTip:"الأداء حسب فئة المستفيد",
  bt_scorecardSub:"توزيع النتائج على 12 شهراً حسب شريحة الدخل", bt_scoreOwn:"تملك", bt_scoreStable:"مستقر",
  bt_scoreDefault:"خطر", bt_scoreExit:"خروج مبكر", bt_scoreUrgentNote:"خطر خروج مبكر مرتفع — يحتاج تدخلاً",
  bt_scoreLowNote:"غالبيتهم مستقرون — خطر خروج متوسط", bt_scoreMidNote:"توزيع متوازن — مراقبة التعثرات",
  bt_scorecardNote:"يتتبع حالة النتيجة بعد 12 شهراً من التسجيل. الأحمر = عتبة الخطر فوق 15%.",
  bt_filterSource:"تصفية حسب المصدر", bt_filterStatus:"تصفية حسب الحالة",
  cmp_notes:"ملاحظات", reset:"إعادة تعيين" });

/* ===== UC-11 Mortgage-Aware Support Type (substep of UC-03) ===== */
const MORTGAGE_PROFILES=[
  {id:"mp_a", city:"Riyadh", income:9800, product:"prod_offplan", qual:"mt_actual",
    scen:[{k:"mt_cashpkg",hbr:39.2,bud:"−95k",elig:"ok"},{k:"mt_monthly",hbr:40.1,bud:"−1.6k/mo",elig:"ok"},
          {k:"mt_mix",hbr:37.8,bud:"−55k +0.9k/mo",elig:"ok"},{k:"mt_land",hbr:34.5,bud:"−230k land",elig:"ok",cond:"mt_condLand"},
          {k:"mt_interest",hbr:33.1,bud:"−interest",elig:"ok",cond:"mt_condRedf"}]},
  {id:"mp_b", city:"Makkah", income:7400, product:"prod_ready", qual:"mt_actual",
    scen:[{k:"mt_cashpkg",hbr:40.6,bud:"−95k",elig:"ok"},{k:"mt_monthly",hbr:41.2,bud:"−1.6k/mo",elig:"ok"},
          {k:"mt_mix",hbr:38.4,bud:"−55k +0.9k/mo",elig:"ok"},{k:"mt_land",hbr:35.0,bud:"−230k land",elig:"no",cond:"mt_noOffplan"},
          {k:"mt_interest",hbr:34.0,bud:"−interest",elig:"no",cond:"mt_noRedf"}]},
  {id:"mp_c", city:"Asir", income:6200, product:"prod_self", qual:"mt_virtual", fallback:true,
    scen:[{k:"mt_monthly",hbr:39.8,bud:"−1.6k/mo",elig:"ok"}]},
];
function MortgagePlanning(){
  const {t}=useStore(); const [pid,setPid]=useState("mp_a");
  const p=MORTGAGE_PROFILES.find(x=>x.id===pid);
  const eligible=p.scen.filter(s=>s.elig==="ok");
  const best=eligible.reduce((a,b)=>b.hbr<a.hbr?b:a, eligible[0]);
  const allOver=eligible.every(s=>s.hbr>38);
  return (<div className="fade">
    <PageHeader title={t("nav_mortgage")} sub={t("mt_sub")} right={<AgentBadge name={t("agent_alloc")} lvl="L2"/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("mt_note03")}</div>
    <div className="cols-3" style={{marginBottom:14}}>
      <div className="card pad" style={{padding:"10px 14px"}}><div className="muted" style={{fontSize:11.5}}>{t("mt_poolCash")}</div><div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}><span className="mono" style={{fontWeight:700,fontSize:15}}>⃁ 1.58B</span><div className="Progress" style={{flex:1}}><div style={{width:"54%"}}/></div></div><div className="muted" style={{fontSize:10.5,marginTop:2}}>54% · ⃁ 860M {t("mt_remaining")}</div></div>
      <div className="card pad" style={{padding:"10px 14px"}}><div className="muted" style={{fontSize:11.5}}>{t("mt_poolLand")}</div><div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}><span className="mono" style={{fontWeight:700,fontSize:15}}>⃁ 220M</span><div className="Progress" style={{flex:1}}><div style={{width:"38%",background:"var(--amber)"}}/></div></div><div className="muted" style={{fontSize:10.5,marginTop:2}}>38% · ⃁ 136M {t("mt_remaining")}</div></div>
      <div className="card pad" style={{padding:"10px 14px"}}><div className="muted" style={{fontSize:11.5}}>{t("mt_poolInt")}</div><div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}><span className="mono" style={{fontWeight:700,fontSize:15}}>⃁ 4.2B</span><div className="Progress" style={{flex:1}}><div style={{width:"29%",background:"var(--primary)"}}/></div></div><div className="muted" style={{fontSize:10.5,marginTop:2}}>29% · ⃁ 3.0B {t("mt_remaining")}</div></div>
    </div>
    <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
      {MORTGAGE_PROFILES.map(x=>(<button key={x.id} className={"btn sm "+(x.id===pid?"":"secondary")} onClick={()=>setPid(x.id)}>{x.city}</button>))}
    </div>
    <div className="cols-2" style={{marginBottom:4}}>
      <Section title={t("mt_profile")}>
        <div className="kv">
          <div className="kv-row"><span className="muted">{t("mt_city")}</span><span>{p.city}</span></div>
          <div className="kv-row"><span className="muted">{t("mt_income")}</span><span className="mono">⃁ {n0(p.income)}/mo</span></div>
          <div className="kv-row"><span className="muted">{t("mt_product")}</span><span>{t(p.product)}</span></div>
          <div className="kv-row"><span className="muted">{t("mt_qual")}</span><span><span className={"chip "+(p.qual==="mt_actual"?"":"amber")}>{t(p.qual)}</span></span></div>
        </div>
        {p.fallback&&<div className="banner" style={{marginTop:12,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("mt_fallback")}</div>}
      </Section>
      <Section title={t("mt_reco")}>
        <div className="brief-card" style={{margin:0}}><div className="bh">✦ {t(best.k)}</div>
          <div className="bv">HBR → {best.hbr}%</div>
          <div className="bs muted">{t("mt_budimpact")}: {best.bud}</div></div>
        {allOver&&<div className="banner" style={{marginTop:10,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("mt_allover")}</div>}
        <div className="muted" style={{fontSize:12,marginTop:10}}>{t("mt_field17")}</div>
      </Section>
    </div>
    <Section title={t("mt_scenarios")}>
      <table className="tbl"><thead><tr><th>{t("mt_type")}</th><th className="right-num">{t("mt_exphbr")}</th><th>{t("mt_budimpact")}</th><th>{t("mt_elig")}</th></tr></thead>
        <tbody>{p.scen.map(s=>{ const isBest=s===best; return (<tr key={s.k} style={isBest?{background:"var(--green-50)"}:null}>
          <td>{isBest?"✦ ":""}{t(s.k)}{s.cond?<span className="muted" style={{fontSize:11}}> · {t(s.cond)}</span>:null}</td>
          <td className="right-num mono" style={{fontWeight:isBest?700:400,color:s.hbr<=38?"var(--primary)":"var(--amber)"}}>{s.hbr}%</td>
          <td className="mono muted">{s.bud}</td>
          <td>{s.elig==="ok"?<span className="chip">{t("mt_eligible")}</span>:<span className="chip amber">{t("mt_inelig")}</span>}</td>
        </tr>);})}</tbody></table>
    </Section>
  </div>);
}

/* ===== UC-13 Product Portfolio / Inventory Absorption (UC-06 ext) ===== */
const INVENTORY=[
  {region:"Riyadh", units:4200, demand:3100, stale:false},
  {region:"Makkah", units:2600, demand:2450, stale:false},
  {region:"Asir",   units:1800, demand:520,  stale:false},
  {region:"Eastern",units:3100, demand:980,  stale:true},
];
function InventoryAbsorption(){
  const {t}=useStore(); const [reg,setReg]=useState("Riyadh"); const [approved,setApproved]=useState(false);
  const row=INVENTORY.find(r=>r.region===reg);
  const absorb=Math.min(100,Math.round(row.demand/row.units*100));
  const gap=100-absorb;
  const budgetPct=gap>50?24:gap>25?13:7;
  const escalate=budgetPct>20;
  const insufficient=row.demand < row.units*0.4;
  const afterUptake=Math.min(96, absorb+Math.round(gap*0.55));
  return (<div className="fade">
    <PageHeader title={t("nav_inventory")} sub={t("iv_sub")} right={<AgentBadge name={t("agent_realloc")} lvl="L2"/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("iv_rules")}</div>
    <Section title={t("iv_invTitle")} sub={t("iv_invNote")}>
      <table className="tbl"><thead><tr><th>{t("bt_region")}</th><th className="right-num">{t("iv_units")}</th><th className="right-num">{t("iv_demand")}</th><th>{t("iv_absorb")}</th><th></th></tr></thead>
        <tbody>{INVENTORY.map(r=>{ const ab=Math.min(100,Math.round(r.demand/r.units*100)); return (<tr key={r.region} style={r.region===reg?{background:"var(--green-50)"}:null}>
          <td>{r.region}{r.stale&&<span className="chip amber" style={{marginInlineStart:6,fontSize:10}}>⚠ {t("iv_stale")}</span>}</td>
          <td className="right-num mono">{n0(r.units)}</td><td className="right-num mono">{n0(r.demand)}</td>
          <td style={{minWidth:130}}><Progress v={ab/100} color={ab>=80?"var(--primary)":"var(--amber)"}/><span className="muted" style={{fontSize:11}}>{ab}% {t("iv_absorbable")}</span></td>
          <td><button className="btn ghost sm" onClick={()=>{setReg(r.region);setApproved(false);}}>{t("iv_plan")}</button></td>
        </tr>);})}</tbody></table>
    </Section>
    <Section title={t("iv_planTitle")+" · "+reg} right={escalate&&!insufficient?<span className="chip amber">⚠ {t("iv_minister")}</span>:null}>
      {insufficient
        ? <div className="banner" style={{background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("iv_insufficient")}</div>
        : <div>
          <div className="muted" style={{fontSize:12.5,marginBottom:10}}>{t("iv_levers")}</div>
          <div className="cols-3" style={{marginBottom:12}}>
            <KPI label={t("iv_uptake")} value={absorb+"% → "+afterUptake+"%"} sub={t("iv_uptakeSub")} tone="good"/>
            <KPI label={t("kpi_budget")} value={"+"+budgetPct+"%"} sub={t("iv_budgetSub")} tone={escalate?"warn":"good"}/>
            <KPI label={t("kpi_fairness")} value="1.04" sub={t("fair_if")} tone="good"/>
          </div>
          <div className="muted" style={{fontSize:12}}>{t("iv_priority")}</div>
          <button className="btn" style={{marginTop:12}} disabled={approved} onClick={()=>setApproved(true)}>{approved?("✓ "+t("done")):t("iv_approve")}</button>
        </div>}
    </Section>
  </div>);
}

/* ===== UC-14 Policy & Market Impact Attribution ===== */
const ATTRIB={ total:18, events:[{d:"2026-06-01",k:"ev_landfee",type:"policy"},{d:"2026-05-12",k:"ev_ratecut",type:"market"},{d:"2026-04",k:"ev_migration",type:"demo"}] };
function ImpactAttribution(){
  const {t,setRoute}=useStore(); const [act,setAct]=useState(null);
  const segs=[{k:"ia_policy",v:11,c:"#6d5ae6"},{k:"ia_market",v:4,c:"var(--primary)"},{k:"ia_demo",v:3,c:"var(--amber)"}];
  return (<div className="fade">
    <PageHeader title={t("nav_impact")} sub={t("ia_sub")} right={<AgentBadge name={t("agent_realloc")} lvl="L2"/>}/>
    <div className="banner" style={{marginBottom:14,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("ia_trigger")}</div>
    <Section title={t("ia_didTitle")} sub={t("ia_didNote")}>
      <div style={{display:"flex",height:34,borderRadius:8,overflow:"hidden",marginBottom:10}}>
        {segs.map(s=>(<div key={s.k} style={{width:(s.v/ATTRIB.total*100)+"%",background:s.c,color:"#fff",display:"grid",placeItems:"center",fontSize:12,fontWeight:700}}>{s.v}%</div>))}
      </div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>{segs.map(s=>(<span key={s.k} style={{fontSize:12.5}}><span style={{display:"inline-block",width:10,height:10,background:s.c,borderRadius:2,marginInlineEnd:6}}/>{t(s.k)} <b>{s.v}%</b></span>))}</div>
      <div className="muted" style={{fontSize:12.5,marginTop:12,lineHeight:1.7}}>{t("ia_interpret")}</div>
    </Section>
    <Section title={t("ia_events")}>
      <table className="tbl"><thead><tr><th>{t("ia_date")}</th><th>{t("ia_event")}</th><th>{t("ia_factor")}</th></tr></thead>
        <tbody>{ATTRIB.events.map(e=>(<tr key={e.k}><td className="mono">{e.d}</td><td>{t(e.k)}</td>
          <td><span className={"chip "+(e.type==="market"?"info":e.type==="demo"?"amber":"")}>{t("ia_"+e.type)}</span></td></tr>))}</tbody></table>
    </Section>
    <Section title={t("ia_outputs")}>
      {act&&<div className="banner" style={{marginBottom:10}}>✓ {t(act)}</div>}
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button className="btn" onClick={()=>setRoute("whatif")}>✦ {t("ia_feedWhatif")}</button>
        <button className="btn secondary" onClick={()=>setAct("ia_doneUc06")}>{t("ia_uc06")}</button>
        <button className="btn secondary" onClick={()=>setAct("ia_doneUc07")}>↗ {t("ia_uc07")}</button>
      </div>
    </Section>
  </div>);
}
Object.assign(I18N.en,{ nav_mortgage:"Support-Type Optimizer", nav_inventory:"Inventory Absorption", nav_impact:"Policy & Market Impact", agent_realloc:"Reallocation Assessment agent",
  mt_sub:"Pick the optimal support type per beneficiary (substep of the allocation cycle)", mt_note03:"Substep of the allocation cycle — the recommendation feeds the Support Type field of the distribution plan", mt_poolCash:"Cash pool", mt_poolLand:"In-kind (land) pool", mt_poolInt:"Interest subsidy pool", mt_remaining:"remaining",
  mt_profile:"Beneficiary profile", mt_city:"City", mt_income:"Disposable income", mt_product:"Product", mt_qual:"Analysis quality", mt_actual:"Actual mortgage", mt_virtual:"Virtual (no mortgage data)",
  mt_fallback:"No mortgage data — default monthly support applied, marked 'without mortgage analysis'",
  mt_reco:"Recommended support type", mt_budimpact:"Budget impact", mt_field17:"Delivered to the allocation plan as a Support-Type recommendation", mt_allover:"All scenarios exceed the 38% HBR threshold — shown with alert, not disabled",
  mt_scenarios:"Support-type scenarios (expected HBR)", mt_type:"Support type", mt_exphbr:"Expected HBR", mt_elig:"Eligibility",
  mt_cashpkg:"Cash package", mt_monthly:"Monthly cash", mt_mix:"Cash mix", mt_land:"In-kind land discount", mt_interest:"Bank interest support",
  mt_condLand:"off-plan · NHC list", mt_condRedf:"REDF agreement", mt_noOffplan:"not off-plan", mt_noRedf:"no REDF agreement", mt_eligible:"Eligible", mt_inelig:"Not eligible",
  prod_offplan:"Off-plan", prod_ready:"Ready home", prod_self:"Self-build",
  iv_sub:"Match unsold inventory to eligible demand and size a stimulus plan to accelerate absorption", iv_rules:"Priority: longest waiting list (not highest income) · Fairness Gap ≥ 1.0 · >20% budget → Minister",
  iv_invTitle:"Regional inventory vs eligible demand", iv_invNote:"NHC unsold units vs eligible unsigned beneficiaries", iv_units:"Unsold units", iv_demand:"Eligible demand", iv_absorb:"Absorption", iv_absorbable:"absorbable", iv_stale:"Outdated data",
  iv_plan:"Plan", iv_planTitle:"Stimulus plan", iv_minister:"Needs Minister (>20% budget)", iv_insufficient:"Insufficient eligible demand — inventory not absorbable with current support; review allocation policy",
  iv_levers:"Levers: raise unit price ceiling · adjust segment support rate · temporary project support", iv_uptake:"Uptake rate", iv_uptakeSub:"projected after stimulus", iv_budgetSub:"of available budget",
  iv_priority:"Priority given to longest-waiting beneficiaries", iv_approve:"Approve plan (Business Owner)",
  ia_sub:"Isolate what's driving demand change — policy vs market vs demographic (Difference-in-Differences)", ia_trigger:"Signing rate +18% vs monthly average — exceeds the 15% threshold, attribution triggered",
  ia_didTitle:"Impact attribution (Difference-in-Differences)", ia_didNote:"Demand change +18% decomposed by factor", ia_policy:"Policy effect", ia_market:"Market effect", ia_demo:"Demographic effect",
  ia_interpret:"Mostly policy-driven (new land-fee relief), not market overheating — avoids over-allocating budget on a false demand signal.",
  ia_events:"Concurrent events", ia_date:"Date", ia_event:"Event", ia_factor:"Factor", ev_landfee:"New land-fee relief", ev_ratecut:"Interest rate cut", ev_migration:"Regional migration influx",
  ia_outputs:"Route the impact report", ia_feedWhatif:"Feed What-if with actual impact", ia_uc06:"Update reallocation", ia_uc07:"Escalate via decision routing",
  ia_doneUc06:"Reallocation recommendation updated with isolation results", ia_doneUc07:"Impact report routed to decision routing" });
Object.assign(I18N.zh,{ nav_mortgage:"补贴类型优选", nav_inventory:"库存去化", nav_impact:"政策与市场影响", agent_realloc:"再平衡评估 agent",
  mt_sub:"为每位受益方优选最优支援类型(分配周期的子步骤)", mt_note03:"分配周期的子步骤 —— 推荐结果写入分配方案的『支援类型』字段", mt_poolCash:"现金预算池", mt_poolLand:"实物(土地)预算池", mt_poolInt:"利息补贴预算池", mt_remaining:"剩余",
  mt_profile:"受益方画像", mt_city:"城市", mt_income:"可支配收入", mt_product:"产品", mt_qual:"分析质量", mt_actual:"真实抵押数据", mt_virtual:"虚拟(无抵押数据)",
  mt_fallback:"无抵押数据 —— 采用默认月度支援，标注『未做抵押分析』",
  mt_reco:"推荐支援类型", mt_budimpact:"预算影响", mt_field17:"作为支援类型推荐交付配分方案", mt_allover:"所有方案均超过 38% HBR 阈值 —— 带告警显示，不禁用",
  mt_scenarios:"支援类型情景(预计 HBR)", mt_type:"支援类型", mt_exphbr:"预计 HBR", mt_elig:"是否适用",
  mt_cashpkg:"现金一次性", mt_monthly:"按月现金", mt_mix:"现金混合", mt_land:"实物土地折扣", mt_interest:"银行利息支援",
  mt_condLand:"期房 · NHC 名录", mt_condRedf:"REDF 协议", mt_noOffplan:"非期房", mt_noRedf:"无 REDF 协议", mt_eligible:"适用", mt_inelig:"不适用",
  prod_offplan:"期房", prod_ready:"现房", prod_self:"自建",
  iv_sub:"将未售库存与合格需求匹配，测算去化激励方案", iv_rules:"优先级：最长等待名单(非最高收入)· Fairness Gap ≥ 1.0 · 预算 >20% → 部长",
  iv_invTitle:"区域库存 vs 合格需求", iv_invNote:"NHC 未售单元 vs 合格未签约受益方", iv_units:"未售单元", iv_demand:"合格需求", iv_absorb:"去化", iv_absorbable:"可去化", iv_stale:"数据过期",
  iv_plan:"方案", iv_planTitle:"去化激励方案", iv_minister:"需部长(预算 >20%)", iv_insufficient:"合格需求不足 —— 当前支援无法去化该库存；建议复核分配政策",
  iv_levers:"杠杆：提高单价上限 · 调整分档支援率 · 项目临时加码", iv_uptake:"去化率", iv_uptakeSub:"激励后预计", iv_budgetSub:"占可用预算",
  iv_priority:"优先长期等待的受益方", iv_approve:"批准方案(业务负责人)",
  ia_sub:"用 Difference-in-Differences 拆解需求变化：政策 vs 市场 vs 人口", ia_trigger:"签约率较月均 +18% —— 超过 15% 阈值，触发影响归因",
  ia_didTitle:"影响归因(Difference-in-Differences)", ia_didNote:"需求变化 +18% 按因素拆解", ia_policy:"政策效应", ia_market:"市场效应", ia_demo:"人口效应",
  ia_interpret:"主要由政策驱动(新土地费减免)，并非市场过热 —— 避免因误判需求而盲目加预算。",
  ia_events:"并发事件", ia_date:"日期", ia_event:"事件", ia_factor:"因素", ev_landfee:"新土地费减免", ev_ratecut:"利率下调", ev_migration:"区域人口流入",
  ia_outputs:"分发影响报告", ia_feedWhatif:"用真实影响喂给 What-if", ia_uc06:"更新再平衡", ia_uc07:"经决策路由上报",
  ia_doneUc06:"再平衡建议已用归因结果更新", ia_doneUc07:"影响报告已分发至决策路由" });
Object.assign(I18N.ar,{ nav_mortgage:"مُحسِّن نوع الدعم", nav_inventory:"استيعاب المخزون", nav_impact:"أثر السياسات والسوق", agent_realloc:"وكيل تقييم إعادة التوزيع",
  mt_sub:"اختيار نوع الدعم الأمثل لكل مستفيد (خطوة ضمن دورة التخصيص)", mt_note03:"خطوة فرعية من دورة التخصيص — تُغذّي حقل نوع الدعم في خطة التوزيع", mt_poolCash:"حوض النقد", mt_poolLand:"حوض الأراضي (العيني)", mt_poolInt:"حوض دعم الفائدة", mt_remaining:"المتبقي",
  mt_profile:"ملف المستفيد", mt_city:"المدينة", mt_income:"الدخل المتاح", mt_product:"المنتج", mt_qual:"جودة التحليل", mt_actual:"رهن فعلي", mt_virtual:"افتراضي (بدون بيانات رهن)",
  mt_fallback:"لا توجد بيانات رهن — يُطبّق الدعم الشهري الافتراضي مع وسم 'بدون تحليل رهن'",
  mt_reco:"نوع الدعم الموصى به", mt_budimpact:"الأثر على الميزانية", mt_field17:"يُسلَّم إلى خطة التخصيص كتوصية بنوع الدعم", mt_allover:"كل السيناريوهات تتجاوز عتبة HBR ٣٨٪ — تُعرض مع تنبيه دون تعطيل",
  mt_scenarios:"سيناريوهات نوع الدعم (HBR المتوقع)", mt_type:"نوع الدعم", mt_exphbr:"HBR المتوقع", mt_elig:"الأهلية",
  mt_cashpkg:"حزمة نقدية", mt_monthly:"نقد شهري", mt_mix:"مزيج نقدي", mt_land:"خصم أرض عيني", mt_interest:"دعم فائدة بنكية",
  mt_condLand:"على الخارطة · قائمة NHC", mt_condRedf:"اتفاقية REDF", mt_noOffplan:"ليس على الخارطة", mt_noRedf:"لا اتفاقية REDF", mt_eligible:"مؤهل", mt_inelig:"غير مؤهل",
  prod_offplan:"على الخارطة", prod_ready:"جاهز", prod_self:"بناء ذاتي",
  iv_sub:"مطابقة المخزون غير المباع بالطلب المؤهل وتحديد خطة تحفيز لتسريع الاستيعاب", iv_rules:"الأولوية: أطول قائمة انتظار (لا الأعلى دخلاً) · فجوة العدالة ≥ ١٫٠ · >٢٠٪ ميزانية → الوزير",
  iv_invTitle:"المخزون الإقليمي مقابل الطلب المؤهل", iv_invNote:"وحدات NHC غير المباعة مقابل المستفيدين المؤهلين غير المتعاقدين", iv_units:"وحدات غير مباعة", iv_demand:"طلب مؤهل", iv_absorb:"الاستيعاب", iv_absorbable:"قابل للاستيعاب", iv_stale:"بيانات قديمة",
  iv_plan:"خطة", iv_planTitle:"خطة التحفيز", iv_minister:"يتطلب الوزير (>٢٠٪ ميزانية)", iv_insufficient:"طلب مؤهل غير كافٍ — لا يمكن استيعاب المخزون بالدعم الحالي؛ راجع سياسة التخصيص",
  iv_levers:"الروافع: رفع سقف سعر الوحدة · تعديل نسبة دعم الشريحة · دعم مؤقت للمشروع", iv_uptake:"معدل الاستيعاب", iv_uptakeSub:"متوقع بعد التحفيز", iv_budgetSub:"من الميزانية المتاحة",
  iv_priority:"الأولوية للمستفيدين الأطول انتظاراً", iv_approve:"اعتماد الخطة (مالك الأعمال)",
  ia_sub:"عزل محرّك تغيّر الطلب — سياسة مقابل سوق مقابل سكان (الفروق في الفروق)", ia_trigger:"معدل التعاقد +١٨٪ مقابل المتوسط الشهري — يتجاوز عتبة ١٥٪، تم تفعيل العزل",
  ia_didTitle:"عزل الأثر (Difference-in-Differences)", ia_didNote:"تغيّر الطلب +١٨٪ مفصّلاً حسب العامل", ia_policy:"أثر السياسة", ia_market:"أثر السوق", ia_demo:"أثر سكاني",
  ia_interpret:"مدفوع غالباً بالسياسة (إعفاء رسوم الأراضي الجديد) لا بفورة السوق — يتجنّب تضخيم الميزانية على إشارة طلب خاطئة.",
  ia_events:"أحداث متزامنة", ia_date:"التاريخ", ia_event:"الحدث", ia_factor:"العامل", ev_landfee:"إعفاء رسوم أراضٍ جديد", ev_ratecut:"خفض سعر الفائدة", ev_migration:"تدفّق هجرة إقليمي",
  ia_outputs:"توجيه تقرير الأثر", ia_feedWhatif:"تغذية What-if بالأثر الفعلي", ia_uc06:"تحديث إعادة التوزيع", ia_uc07:"التصعيد عبر توجيه القرار",
  ia_doneUc06:"تم تحديث توصية إعادة التوزيع بنتائج العزل", ia_doneUc07:"تم توجيه تقرير الأثر إلى توجيه القرار" });

/* ===== Agent architecture overview (UC-SYS-01) ===== */
const AGENT_ARCH=[
  {k:"agent_data", lvl:"L1", scope:"aa_data"},
  {k:"agent_track", lvl:"L1", scope:"aa_track"},
  {k:"agent_alloc", lvl:"L2", scope:"aa_alloc"},
  {k:"agent_forecast", lvl:"L2", scope:"aa_forecast"},
  {k:"agent_realloc", lvl:"L2", scope:"aa_realloc"},
  {k:"agent_fair", lvl:"L3", scope:"aa_fair"},
  {k:"agent_route", lvl:"L3", scope:"aa_route"},
  {k:"agent_orch", lvl:"L3", scope:"aa_orch"},
];
function AgentArchitecture(){
  const {t}=useStore();
  return (<div className="fade">
    <PageHeader title={t("nav_agents")} sub={t("aa_sub")} right={<AgentBadge name={t("agent_orch")}/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("aa_note")}</div>
    {["L1","L2","L3"].map(lv=>(<Section key={lv} title={t("aa_"+lv)} sub={t("aa_"+lv+"_d")}>
      <div className="cols-2">
        {AGENT_ARCH.filter(a=>a.lvl===lv).map(a=>(<div key={a.k} className="agent-tile">
          <div className="at-head">{GearIcon}<strong>{t(a.k)}</strong><span className="chip gray" style={{marginInlineStart:"auto"}}>{a.lvl}</span></div>
          <div className="muted" style={{fontSize:12.5,lineHeight:1.65,marginTop:8}}>{t(a.scope)}</div>
          <div className="at-foot"><span className="ag-dot"/> {t("agent_auto")}</div>
        </div>))}
      </div>
    </Section>))}
  </div>);
}
Object.assign(I18N.en,{ nav_agents:"Agent Architecture",
  aa_sub:"The multi-agent system behind the platform — levels, scope and coordination", aa_note:"All agents run automatically; every decision stays human-in-the-loop",
  aa_L1:"L1 · Data agents", aa_L1_d:"Ingestion and beneficiary tracking", aa_L2:"L2 · Optimization agents", aa_L2_d:"Computation, forecasting and rebalancing", aa_L3:"L3 · Governance & orchestration", aa_L3_d:"Fairness, routing and coordination",
  aa_data:"Ingests and validates the six source systems into BIDSC; flags exceptions.", aa_track:"Monitors beneficiary improvement and generates referral lists — never auto-terminates support.",
  aa_alloc:"Computes the subsidy formula, the distribution plan and the optimal support type per beneficiary.", aa_forecast:"Projects 12-month spend and raises early/critical budget alerts.",
  aa_realloc:"Rebalancing assessment, inventory absorption and policy/market impact attribution.", aa_fair:"Computes the multi-dimensional Fairness Gap and detects leakage.",
  aa_route:"Routes decisions through the audit trail and delivers approved outputs to Housing Copilot.", aa_orch:"Coordinates all agents and runs What-if simulations on demand.",
  st_tactical:"Tactical sandbox", st_strategic:"Strategic sandbox", st_macro:"Macro-policy sandbox",
  fgdim_region:"Region", fgdim_income:"Income band", fgdim_loan:"Loan term", fgdim_age:"Age group" });
Object.assign(I18N.zh,{ nav_agents:"智能体架构",
  aa_sub:"平台背后的多智能体系统 —— 层级、职责与协同", aa_note:"所有智能体自动运行;每个决策都保留人工把关",
  aa_L1:"L1 · 数据智能体", aa_L1_d:"数据接入与受益方追踪", aa_L2:"L2 · 优化智能体", aa_L2_d:"计算、预测与再平衡", aa_L3:"L3 · 治理与编排", aa_L3_d:"公平、路由与协同",
  aa_data:"将六套源系统接入并校验入 BIDSC;标记异常。", aa_track:"监测受益方改善并生成转复核名单 —— 永不自动停补。",
  aa_alloc:"计算补贴公式、分配方案及每位受益方的最优支援类型。", aa_forecast:"预测 12 个月支出并发出早期/严重预算预警。",
  aa_realloc:"再平衡评估、库存去化与政策/市场影响归因。", aa_fair:"计算多维公平差距并检测漏损。",
  aa_route:"通过审计追踪路由决策,并把已批准结果交付 Housing Copilot。", aa_orch:"协调所有智能体,并按需运行 What-if 推演。",
  st_tactical:"战术沙箱", st_strategic:"战略沙箱", st_macro:"宏观政策沙箱",
  fgdim_region:"地区", fgdim_income:"收入档", fgdim_loan:"贷款期限", fgdim_age:"年龄段" });
Object.assign(I18N.ar,{ nav_agents:"بنية الوكلاء",
  aa_sub:"نظام الوكلاء المتعدد خلف المنصة — المستويات والنطاق والتنسيق", aa_note:"تعمل جميع الوكلاء آلياً؛ يبقى كل قرار بإشراف بشري",
  aa_L1:"L1 · وكلاء البيانات", aa_L1_d:"الاستيعاب وتتبع المستفيدين", aa_L2:"L2 · وكلاء التحسين", aa_L2_d:"الحساب والتنبؤ وإعادة التوازن", aa_L3:"L3 · الحوكمة والتنسيق", aa_L3_d:"العدالة والتوجيه والتنسيق",
  aa_data:"يستوعب ويتحقق من الأنظمة المصدر الستة في BIDSC؛ يضع علامة على الاستثناءات.", aa_track:"يراقب تحسّن المستفيدين ويولّد قوائم الإحالة — لا يوقف الدعم تلقائياً أبداً.",
  aa_alloc:"يحسب صيغة الدعم وخطة التوزيع ونوع الدعم الأمثل لكل مستفيد.", aa_forecast:"يتوقّع إنفاق ١٢ شهراً ويصدر تنبيهات ميزانية مبكرة/حرجة.",
  aa_realloc:"تقييم إعادة التوازن واستيعاب المخزون وعزل أثر السياسات/السوق.", aa_fair:"يحسب فجوة العدالة متعددة الأبعاد ويكشف التسرب.",
  aa_route:"يوجّه القرارات عبر سجل التدقيق ويسلّم المخرجات المعتمدة إلى مساعد الإسكان.", aa_orch:"ينسّق جميع الوكلاء ويشغّل محاكاة What-if عند الطلب.",
  st_tactical:"بيئة تكتيكية", st_strategic:"بيئة استراتيجية", st_macro:"بيئة سياسات كلية",
  fgdim_region:"المنطقة", fgdim_income:"شريحة الدخل", fgdim_loan:"مدة القرض", fgdim_age:"الفئة العمرية" });

/* ===== UC-00 Central Settings ===== */
const SETTINGS_GROUPS=[
  {g:"set_g_dq", at:"2026-06-16 10:44", items:[{k:"set_minComplete",v:90,unit:"%",hint:"0–100",affects:"Data readiness"}]},
  {g:"set_g_budget", at:"2026-06-15 10:09", items:[{k:"set_earlyAlert",v:70,unit:"%",hint:"0–100",affects:"Budget forecast"},{k:"set_critAlert",v:90,unit:"%",hint:"> early",affects:"Budget forecast"}]},
  {g:"set_g_budgetC", at:"2026-06-15 10:09", items:[{k:"set_annual",v:1580,unit:"M",hint:">0",affects:"Budget forecast"},{k:"set_eligible",v:1400000,unit:"",hint:">0",affects:"Allocation"}]},
  {g:"set_g_esc", at:"2026-06-15 10:09", items:[{k:"set_minThresh",v:20,unit:"%",hint:"→ Minister",p03:true,affects:"Reallocation, Decisions"},{k:"set_boTime",v:48,unit:"h",hint:">0",affects:"Decisions"},{k:"set_minTime",v:72,unit:"h",hint:"> BO",p03:true,affects:"Decisions"}]},
  {g:"set_g_fair", at:"2026-06-15 10:09", items:[{k:"set_fgMin",v:1.0,unit:"",hint:"min 0",affects:"Allocation, Fairness"}]},
  {g:"set_g_hbr", at:"2026-06-15 10:09", items:[{k:"set_hbrCeil",v:38,unit:"%",hint:"30–50",affects:"Allocation, Beneficiary, What-if"}]},
  {g:"set_g_mon", at:"2026-06-15 10:09", items:[{k:"set_demandChg",v:15,unit:"%",hint:"0–100",affects:"Impact attribution"},{k:"set_improveDur",v:3,unit:"mo",hint:"1–12",affects:"Beneficiary"}]},
];
function initSettingsVals(){ const o={}; SETTINGS_GROUPS.forEach(g=>g.items.forEach(it=>o[it.k]=it.v)); return o; }
function SettingsPage(){
  const {t,user,configChanges,addConfigChange,submitConfigChange,actOnConfigChange,settingsVals,setSettingVal}=useStore();
  const editable=user!=="minister";
  const [tab,setTab]=useState("current");
  const [saved,setSaved]=useState(false);
  // Schedule change modal state
  const [modal,setModal]=useState(null); // { paramKey, paramLabel, oldValue, unit, affects, p03Required }
  const [newVal,setNewVal]=useState("");
  const [reason,setReason]=useState("");
  const [effectiveFrom,setEffectiveFrom]=useState("");
  const [impactPreview,setImpactPreview]=useState("");
  // Confirm modal state
  const [confirm,setConfirm]=useState(null); // { title, message, onConfirm, confirmLabel, confirmDanger }
  const [detailCc,setDetailCc]=useState(null); // config change detail modal
  function withConfirm(title,message,onConfirm,confirmLabel,confirmDanger){
    setConfirm({ title, message, onConfirm:()=>{ setConfirm(null); onConfirm(); }, confirmLabel, confirmDanger });
  }
  function openSchedule(param){
    setModal({ paramKey:param.k, paramLabel:t(param.k), oldValue:param.v, unit:param.unit, affects:param.affects, p03Required:!!param.p03 });
    setNewVal(String(param.v));
    setReason("");
    setEffectiveFrom("");
    setImpactPreview("");
  }
  function saveDraftSchedule(){
    if(!modal) return;
    withConfirm(t("config_confirm_draft_title"), t("config_confirm_draft_msg"), ()=>{
      const ccData={
        paramKey:modal.paramKey, paramLabel:t(modal.paramKey),
        oldValue:modal.oldValue, newValue:parseFloat(newVal), unit:modal.unit,
        effectiveFrom:effectiveFrom||"",
        reason:reason.trim(), impactPreview:impactPreview.trim()||t("config_impact_preview")+"…",
        affects:modal.affects, p03Required:modal.p03Required||false,
      };
      addConfigChange(ccData);
      setModal(null);
      setSaved(false);
    }, t("config_confirm_save_draft"));
  }
  function submitSchedule(){
    if(!modal || !reason.trim()) return;
    withConfirm(t("config_confirm_submit_title"), t("config_confirm_submit_msg"), ()=>{
      saveDraftScheduleInner();
      const newId="CC-"+(String(configChanges.length+1).padStart(3,"0"));
      submitConfigChange(newId);
    }, t("config_confirm_submit"));
  }
  // Internal: save without confirm (called by submitSchedule after confirm)
  function saveDraftScheduleInner(){
    if(!modal) return;
    const ccData={
      paramKey:modal.paramKey, paramLabel:t(modal.paramKey),
      oldValue:modal.oldValue, newValue:parseFloat(newVal), unit:modal.unit,
      effectiveFrom:effectiveFrom||"",
      reason:reason.trim(), impactPreview:impactPreview.trim()||t("config_impact_preview")+"…",
      affects:modal.affects, p03Required:modal.p03Required||false,
    };
    addConfigChange(ccData);
    setModal(null);
    setSaved(false);
  }
  // Status chip helper
  function statusChip(s){
    const map={draft:"gray", pending:"info", scheduled:"amber", effective:"", superseded:"gray", rejected:"danger"};
    const key="config_status_"+s;
    return <span className={"chip "+(map[s]||"")} style={{fontSize:11}}>{t(key)}</span>;
  }
  // Pending count for owner
  const pendingConfig = configChanges.filter(c=>c.status==="pending"&&user==="owner").length;
  const draftConfig = configChanges.filter(c=>c.status==="draft").length;

  return (<div className="fade">
    {saved&&<div className="banner" style={{marginBottom:10}}>✓ {t("set_saved")}</div>}
    <PageHeader title={t("nav_settings")} sub={t("set_sub")} right={
      <div style={{display:"flex",gap:6}}>
        <button className={"btn sm "+(tab==="current"?"":"secondary")} onClick={()=>setTab("current")}>{t("config_tab_current")}</button>
        <button className={"btn sm "+(tab==="changes"?"":"secondary")} onClick={()=>setTab("changes")}>{t("config_tab_changes")}{pendingConfig?<span className="badge-count" style={{marginInlineStart:4}}>{pendingConfig}</span>:draftConfig?<span className="chip gray" style={{marginInlineStart:4}}>{draftConfig}</span>:null}</button>
      </div>
    }/>

    {tab==="current" && <>
    <div className="card pad" style={{padding:"8px 16px"}}>
      <table className="tbl" style={{fontSize:12.5}}><thead><tr>
        <th style={{width:140}}>{t("set_g")}</th><th>{t("set_param")}</th><th style={{width:70}}>{t("set_affects")}</th><th style={{width:100}}></th><th style={{width:80,textAlign:"end"}}>{t("set_val")}</th><th style={{width:160}}></th>
      </tr></thead><tbody>
        {SETTINGS_GROUPS.flatMap((grp,gi)=>grp.items.map((it,ii)=>(
          <tr key={it.k}>
            {ii===0?<td style={{fontWeight:600,fontSize:12,verticalAlign:"top",paddingTop:12}} rowSpan={grp.items.length}>{t(grp.g)}<div className="muted" style={{fontSize:10,fontWeight:400,marginTop:2}}>{grp.at}</div></td>:null}
            <td><span style={{fontWeight:600}}>{t(it.k)}</span><br/><span className="muted" style={{fontSize:11}}>{it.hint}{it.unit?(" · "+it.unit):""}</span></td>
            <td><span className="chip gray" style={{fontSize:10}}>{it.affects.split(", ").map(a=>t("area_"+a.toLowerCase().replace(/[\s-]/g,"_"))).join(", ")}</span></td>
            <td>{it.p03?<span className="chip info" style={{fontSize:10}}>P-03 {t("set_p03r")}</span>:null}</td>
            <td className="right-num mono" style={{fontWeight:700,fontSize:14}}>{settingsVals[it.k]}{it.unit}</td>
            <td style={{textAlign:"end"}}>
              <button className="btn ghost sm" style={{fontSize:11,whiteSpace:"nowrap"}} onClick={()=>openSchedule(it)} disabled={!editable}>
                ⏱ {t("config_schedule_change")}
              </button>
            </td>
          </tr>
        )))}
      </tbody></table>
    </div>
    <Section title={t("set_brTitle")} sub={t("set_brSub")}>
      <div style={{fontSize:13,lineHeight:1.7}}><ul style={{margin:0,paddingInlineStart:18}}>
        <li><b>1.</b> {t("set_br01")}</li>
        <li><b>2.</b> {t("set_br02")}</li>
        <li><b>3.</b> {t("set_br03")}</li>
        <li><b>4.</b> {t("set_br04")}</li>
        <li><b>5.</b> {t("set_br05")}</li>
      </ul></div>
    </Section>
    </>}

    {tab==="changes" && <>
    {configChanges.length===0
      ? <div className="card pad muted">{t("config_no_changes")}</div>
      : <div className="card pad" style={{padding:"8px 0"}}>
          <table className="tbl" style={{fontSize:12.5}}><thead><tr>
            <th>{t("config_change_id")}</th><th>{t("set_param")}</th><th>{t("config_from_param")}</th><th>{t("config_to_param")}</th>
            <th>{t("config_status_draft_short")}</th><th>{t("config_scheduled_at")}</th><th>{t("config_by")}</th><th></th>
          </tr></thead><tbody>
            {configChanges.map(cc=>{
              const paramLabel = t(cc.paramKey);
              return (<tr key={cc.id} style={{cursor:"pointer"}} onClick={()=>setDetailCc(cc)}>
                <td className="mono"><span className="wo">{cc.id}</span></td>
                <td style={{fontSize:12}}>{cc.paramLabel}</td>
                <td className="right-num mono muted">{cc.oldValue}{cc.unit}</td>
                <td className="right-num mono" style={{fontWeight:700,color:"var(--primary)"}}>{cc.newValue}{cc.unit}</td>
                <td>{statusChip(cc.status)}</td>
                <td className="muted" style={{fontSize:12,whiteSpace:"nowrap"}}>{cc.effectiveFrom||"—"}</td>
                <td className="muted" style={{fontSize:12}}>{cc.submittedBy}</td>
                <td onClick={e=>e.stopPropagation()}>
                  {cc.status==="draft"&&user==="analyst"&&
                    <button className="btn sm" style={{fontSize:11,whiteSpace:"nowrap"}} onClick={()=>withConfirm(t("config_confirm_submit_title"),t("config_confirm_submit_msg"),()=>submitConfigChange(cc.id),t("config_confirm_submit"))}>↑ {t("config_submit")}</button>}
                  {cc.status==="pending"&&(user==="owner"||user==="minister")&&
                    <span className="chip info" style={{fontSize:10}}>{t("config_awaiting")} · {t("nav_approvals")}</span>}
                </td>
              </tr>);
            })}
          </tbody></table>
        </div>}
    </>}

    {/* Schedule Change Modal */}
    {modal && <div className="modal-ov" onClick={()=>setModal(null)}>
      <div className="modal-box" onClick={e=>e.stopPropagation()} style={{width:560}}>
        <div className="modal-head">
          <h3>⏱ {t("config_schedule_change")}</h3>
          <button className="modal-x" onClick={()=>setModal(null)}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{marginBottom:16}}>
            <div className="muted" style={{fontSize:12,marginBottom:4}}>{t("set_param")}</div>
            <div style={{fontWeight:700,fontSize:16}}>{t(modal.paramKey)}</div>
            <div style={{fontSize:13,color:"var(--muted)",marginTop:2}}>{t("config_from_param")} <b>{modal.oldValue}{modal.unit}</b></div>
            {modal.p03Required && <div className="chip info" style={{marginTop:6}}>P-03 {t("set_p03r")}</div>}
          </div>
          <div className="field"><label>{t("config_to_param")} <span className="muted">({modal.unit})</span></label>
            <input className="input mono" type="number" value={newVal} onChange={e=>setNewVal(e.target.value)} step={modal.unit==="%"?"1":"any"}/></div>
          <div className="field"><label>{t("config_reason")}</label>
            <textarea className="input" style={{minHeight:60,resize:"vertical"}} value={reason} onChange={e=>setReason(e.target.value)} placeholder={t("config_reason")+"…"}/></div>
          <div className="field"><label>{t("config_effective_from")}</label>
            <input className="input" type="text" value={effectiveFrom} onChange={e=>setEffectiveFrom(e.target.value)}
              placeholder="e.g. 01 Aug 2026 00:00 (leave empty for immediate on approval)"/></div>
          <div className="field"><label>{t("config_impact_preview")}</label>
            <textarea className="input" style={{minHeight:50,resize:"vertical"}} value={impactPreview} onChange={e=>setImpactPreview(e.target.value)}
              placeholder={t("config_impact_preview")+"… (e.g. Earlier warning by ~2 weeks)"}/></div>
          <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:16}}>
            <button className="btn secondary" onClick={()=>setModal(null)}>{t("back")}</button>
            <button className="btn ghost sm" onClick={saveDraftSchedule} disabled={!newVal.trim()}>💾 {t("set_save")} {t("config_status_draft_short")}</button>
            <button className="btn" onClick={submitSchedule} disabled={!reason.trim()}>↑ {t("config_submit")}</button>
          </div>
        </div>
      </div>
    </div>}
    {detailCc && <Modal title={detailCc.paramLabel+" · "+detailCc.id} onClose={()=>setDetailCc(null)}>
      <div className="pkg-detail" style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span className="wo">{detailCc.id}</span>
            {statusChip(detailCc.status)}
          </div>
          <div className="muted" style={{fontSize:12}}>{t("config_from_param")} <b>{detailCc.oldValue}{detailCc.unit}</b></div>
        </div>
        <div className="muted" style={{fontSize:12}}>{t("config_to_param")} <b style={{color:"var(--primary)",fontWeight:700}}>{detailCc.newValue}{detailCc.unit}</b></div>
        {detailCc.p03Required && <div className="chip info" style={{marginTop:6}}>P-03 {t("set_p03r")}</div>}
      </div>
      {detailCc.reason && <div className="pkg-detail" style={{marginBottom:14}}>
        <div className="muted" style={{fontSize:12,marginBottom:4}}>📝 {t("config_reason")}</div>
        <div style={{fontSize:13,lineHeight:1.6}}>{detailCc.reason}</div>
      </div>}
      {detailCc.impactPreview && <div className="pkg-detail" style={{marginBottom:14}}>
        <div className="muted" style={{fontSize:12,marginBottom:4}}>💡 {t("config_impact_preview")}</div>
        <div style={{fontSize:13,lineHeight:1.6}}>{detailCc.impactPreview}</div>
      </div>}
      {detailCc.effectiveFrom && <div className="pkg-detail" style={{marginBottom:14}}>
        <div className="muted" style={{fontSize:12}}>⏱ {t("config_effective_from")}: <b>{detailCc.effectiveFrom}</b></div>
      </div>}
      {detailCc.history.length>0 && <div className="pkg-detail" style={{marginBottom:0}}>
        <div className="muted" style={{fontSize:12,marginBottom:8}}>{t("nav_audit")}</div>
        <div className="timeline">
          {detailCc.history.map((h,i)=>(
            <div key={i} className="ev">
              <div style={{fontSize:12.5}}>
                <span className="tag">{t(h.role)}</span>
                <b>{t(h.action)}</b>
                {h.note ? <span style={{color:"var(--muted)",fontWeight:400}}> · {h.note}</span> : null}
              </div>
              <div className="muted" style={{fontSize:11}}>{h.ts}</div>
            </div>
          ))}
        </div>
      </div>}
    </Modal>}
    {confirm && <ConfirmModal title={confirm.title} message={confirm.message}
      confirmLabel={confirm.confirmLabel} confirmDanger={confirm.confirmDanger}
      onConfirm={confirm.onConfirm} onCancel={()=>setConfirm(null)}/>}
  </div>);
}

/* ===== UC-01 Subsidy Formula ===== */
function FormulaPage(){
  const {t,setRoute,addPackage,formulaParams,setFormulaParams,formulaVersion,setFormulaVersion,pushAudit,user,lang,packages,
    formulaMatrix,setFormulaMatrix,formulaVersions,setFormulaVersions,createFormulaVersion,activateFormulaVersion,rollbackToVersion,setWhatifContext}=useStore();
  const {ded,dur,ceil,rate}=formulaParams;
  function setParam(k,v){ setFormulaParams(f=>({...f,[k]:v})); }
  const [act,setAct]=useState(null);
  const dirty = ded!==40||dur!==20||ceil!==500000||rate!==4;
  // 3D dimension selectors
  const {region,housingType,incomeBand,regions,housingTypes,incomeBands}=formulaMatrix;
  // Resolve effective params by dimension priority: region > housingType > incomeBand > defaults
  const effParams = (()=>{
    const fromRegion = region!=="all" && regions[region] ? regions[region] : null;
    const fromHt = housingType!=="all" && housingTypes[housingType] ? housingTypes[housingType] : null;
    const fromIb = incomeBand!=="all" && incomeBands[incomeBand] ? incomeBands[incomeBand] : null;
    // Merge: IB overrides HT overrides Region
    return { ...(fromRegion||{}), ...(fromHt||{}), ...(fromIb||{}) };
  })();
  const effDed = effParams.ded ?? ded;
  const effDur = effParams.dur ?? dur;
  const effCeil = effParams.ceil ?? ceil;
  const effRate = effParams.rate ?? rate;
  // Preview bands
  const bands=[3000,6000,9000,14000,22000];
  const preview=bands.map(inc=>{ const maxH=Math.round(inc*effDed/100); const sup=Math.max(0,Math.round(maxH*0.16*(1-effRate/100*0.5))); return {inc,maxH,sup}; });
  // Version management
  const activeVer = formulaVersions.find(v=>v.status==="active");
  const activeId = activeVer?.id||"FML-v1.0";
  const [selVerId,setSelVerId]=useState(null);
  const [actVerId,setActVerId]=useState(null);
  const [cmpVerIds,setCmpVerIds]=useState([]);
  const [saveModal,setSaveModal]=useState(false);
  const [saveLabel,setSaveLabel]=useState("");
  const [saveDesc,setSaveDesc]=useState("");
  const [rollbackModal,setRollbackModal]=useState(null); // { id, label, params }
  // Check activation state from formulaVersion
  const canActivateNow = formulaVersion.canActivate && actVerId && actVerId!==activeId && (
    formulaVersion.approvedVersionId ? actVerId===formulaVersion.approvedVersionId : true
  );
  function handleActivate(){
    if(!actVerId || !formulaVersion.canActivate) return;
    activateFormulaVersion(actVerId);
    setActVerId(null);
    setFormulaVersion(prev=>({...prev,canActivate:false,approvedPkgId:null,approvedVersionId:null}));
    setAct("on");
  }
  function handleRollbackPackage(verId){
    const targetId = verId || actVerId;
    if(!targetId || targetId===activeId) return;
    const ver = formulaVersions.find(v=>v.id===targetId);
    if(!ver) return;
    setRollbackModal({ id:ver.id, label:ver.label||ver.id, params:ver.params });
  }
  function handleRollbackConfirm(){
    if(!rollbackModal) return;
    const ver = formulaVersions.find(v=>v.id===rollbackModal.id);
    if(!ver) return;
    const ts=nowStr(lang);
    const id="WO-2026-0"+(400+Math.max(0,...packages.map(p=>parseInt(p.id.replace("WO-2026-0",""))||0)+1));
    const pkg={ id, title:t("fp_ver_rollback")+": "+ver.id, status:"submitted", sla:48,
      params:{}, kpis:ver.snapshot||{savingsPhase:0,fg:0,hbr:0}, type:"rollback",
      containsFormulaChange:true, formulaSnapshot:{...ver.params, versionId:ver.id, rollback:true},
      rationale:t("fp_ver_rollback")+" "+ver.id+": "+(ver.description||ver.label||""),
      history:[{role:"analyst",action:"act_submit",ts,note:""}] };
    addPackage(pkg);
    setFormulaVersion(prev=>({...prev, canActivate:false, approvedPkgId:id, pendingActivationFor:ver.id }));
    setRollbackModal(null);
    setAct("rbp");
    setRoute("packages");
  }
  function handleSaveVersion(){
    if(!saveLabel.trim()) return;
    createFormulaVersion(saveLabel.trim(), saveDesc.trim());
    setSaveModal(false);
    setSaveLabel("");
    setSaveDesc("");
    setAct("sv");
  }
  function toggleCmp(id){
    setCmpVerIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id].slice(-2));
  }
  const showCmp = cmpVerIds.length===2;
  const v1=showCmp?formulaVersions.find(v=>v.id===cmpVerIds[0]):null;
  const v2=showCmp?formulaVersions.find(v=>v.id===cmpVerIds[1]):null;
  // compute snapshot for comparison
  const cmpRows = showCmp ? [
    {k:"ded", l:"Deduction rate", v1:v1?.params.ded, v2:v2?.params.ded, u:"%"},
    {k:"dur", l:"Duration", v1:v1?.params.dur, v2:v2?.params.dur, u:"y"},
    {k:"ceil",l:"Ceiling", v1:v1?.params.ceil, v2:v2?.params.ceil, u:" SAR"},
    {k:"rate",l:"Rate", v1:v1?.params.rate, v2:v2?.params.rate, u:"%"},
  ] : [];
  function statusChip(s){
    const map={draft:"gray",active:"",superseded:"gray",pending:"amber",validated:"info"};
    return <span className={"chip "+(map[s]||"")} style={{fontSize:11}}>{t("fv_"+s)}</span>;
  }
  return (<div className="fade">
    <PageHeader title={t("nav_formula")} right={<AgentBadge name={t("agent_alloc")} lvl="L2"/>}/>
    {dirty&&!formulaVersion.validated&&<div className="alert-strong" style={{marginBottom:14}}>⚠ {t("fv_br07")}</div>}
    {dirty&&formulaVersion.validated&&!formulaVersion.canActivate&&<div className="banner" style={{marginBottom:14,background:"var(--info-50)",borderColor:"var(--info)"}}>✓ {t("fv_validated")} · {t("fv_approveFirst")}</div>}
    {dirty&&formulaVersion.canActivate&&<div className="banner" style={{marginBottom:14,background:"var(--success-50)",borderColor:"var(--success)"}}>✓ {t("fv_approved")}</div>}
    {act==="on"&&<div className="banner" style={{marginBottom:14}}>✓ {t("fp_activated")}</div>}
    {act==="ap"&&<div className="banner" style={{marginBottom:14,background:"var(--info-50)",borderColor:"var(--info)"}}>→ {t("config_submit")} · {t("config_awaiting")}</div>}
    {act==="rbp"&&<div className="banner" style={{marginBottom:14,background:"var(--info-50)",borderColor:"var(--info)"}}>↩ {t("fp_ver_rollback")} · {t("config_awaiting")}</div>}
    {act==="sv"&&<div className="banner" style={{marginBottom:14}}>✓ {t("fp_version_saved")}</div>}
    <div className="cols-2">
      {/* Left: parameter panel with 3D selectors */}
      <div>
        <Section title={t("fp_params")}>
          {/* Dimension selectors */}
          <div className="cols-3" style={{marginBottom:12,gap:8}}>
            <div className="field"><label style={{fontSize:12}}>{t("fp_region")}</label>
              <select className="input" value={region} onChange={e=>setFormulaMatrix(f=>({...f,region:e.target.value}))} style={{height:34,padding:"4px 8px",fontSize:12}}>
                <option value="all">{t("fp_region_all")}</option>
                {Object.keys(regions).map(k=><option key={k} value={k}>{t("rg_"+k)}</option>)}</select></div>
            <div className="field"><label style={{fontSize:12}}>{t("fp_housing_type")}</label>
              <select className="input" value={housingType} onChange={e=>setFormulaMatrix(f=>({...f,housingType:e.target.value}))} style={{height:34,padding:"4px 8px",fontSize:12}}>
                <option value="all">{t("fp_ht_all")}</option>
                <option value="offplan">{t("fp_ht_offplan")}</option>
                <option value="ready">{t("fp_ht_ready")}</option>
                <option value="selfbuild">{t("fp_ht_selfbuild")}</option></select></div>
            <div className="field"><label style={{fontSize:12}}>{t("fp_income_band")}</label>
              <select className="input" value={incomeBand} onChange={e=>setFormulaMatrix(f=>({...f,incomeBand:e.target.value}))} style={{height:34,padding:"4px 8px",fontSize:12}}>
                <option value="all">{t("fp_ib_all")}</option>
                {BANDS.filter(b=>b.below).map(b=><option key={b.key} value={b.key}>{bandLabel(t,b.key)}</option>)}
                {BANDS.filter(b=>!b.below).map(b=><option key={b.key} value={b.key}>{bandLabel(t,b.key)}</option>)}</select></div>
          </div>
          <div className="muted" style={{fontSize:11.5,marginBottom:8}}>
            {effDed!==ded?<span className="chip amber" style={{fontSize:10,marginInlineEnd:4}}>Override</span>:null}
            {t("fp_ded")}: <b className="mono">{effDed}%</b> · {t("fp_dur")}: <b className="mono">{effDur}{t("fp_yrs")}</b> · {t("fp_ceil")}: <b className="mono">{n0(effCeil)}</b> · {t("fp_rate")}: <b className="mono">{effRate}%</b>
          </div>
          <div className="field"><label style={{display:"flex",justifyContent:"space-between"}}><span>{t("fp_ded")}</span><span className="mono">{ded}%</span></label>
            <input className="range" type="range" min="10" max="60" value={ded} onChange={e=>setParam("ded",+e.target.value)}/></div>
          <div className="field"><label>{t("fp_dur")}</label>
            <select className="input" value={dur} onChange={e=>setParam("dur",+e.target.value)} style={{width:"auto"}}><option value={5}>5 {t("fp_yrs")}</option><option value={10}>10 {t("fp_yrs")}</option><option value={20}>20 {t("fp_yrs")}</option></select></div>
          <div className="field"><label>{t("fp_ceil")} <span className="muted">(SAR)</span></label>
            <input className="input mono" type="number" value={ceil} onChange={e=>setParam("ceil",+e.target.value)}/></div>
          <div className="field"><label style={{display:"flex",justifyContent:"space-between"}}><span>{t("fp_rate")}</span><span className="mono">{rate}%</span></label>
            <input className="range" type="range" min="0" max="15" step="0.5" value={rate} onChange={e=>setParam("rate",+e.target.value)}/></div>
          <div className="set-row"><div><div style={{fontWeight:600,fontSize:13.5}}>{t("fp_income")}</div><div className="muted" style={{fontSize:11.5}}>{t("fp_lockedNote")}</div></div><span className="chip gray">🔒 ⃁ 2,726/mo</span></div>
          <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
            <button className="btn ghost sm" onClick={()=>setSaveModal(true)}>📦 {t("fp_save_version")}</button>
          </div>
        </Section>
      </div>
      {/* Right: cross-dimension preview */}
      <div>
        <Section title={t("fp_cross_preview")} sub={t("fp_previewNote")}>
          <div className="scrollx"><table className="tbl" style={{fontSize:12}}><thead><tr>
            <th>{t("fp_inc")}</th><th className="right-num">{t("fp_maxH")}</th><th className="right-num">{t("fp_sup")}</th>
            <th style={{fontSize:10.5}}>{t("fp_housing_type")}</th><th style={{fontSize:10.5}}>{t("fp_region")}</th>
          </tr></thead>
            <tbody>{preview.map((p,i)=>{
              const htKey = ["offplan","ready","selfbuild"][i%3];
              const regKey = Object.keys(regions)[i%Object.keys(regions).length];
              const ht = housingTypes[htKey]||{};
              const rg = regions[regKey]||{};
              const finalDed = ht.ded||rg.ded||effDed;
              const finalRate = ht.rate||rg.rate||effRate;
              const maxH = Math.round(p.inc*finalDed/100);
              const sup = Math.max(0,Math.round(maxH*0.16*(1-finalRate/100*0.5)));
              return (<tr key={i}>
                <td className="right-num mono">⃁ {n0(p.inc)}</td>
                <td className="right-num mono">⃁ {n0(maxH)}</td>
                <td className="right-num mono" style={{fontWeight:700,color:"var(--primary)"}}>⃁ {n0(sup)}/mo</td>
                <td style={{fontSize:10.5}}><span className="chip" style={{fontSize:9}}>{t("fp_ht_"+htKey)}</span></td>
                <td style={{fontSize:10.5}}><span className="chip gray" style={{fontSize:9}}>{t("rg_"+regKey)}</span></td>
              </tr>);
            })}</tbody></table></div>
          <div className="muted" style={{fontSize:11.5,marginTop:8}}>{dirty?("✎ "+t("fp_candidate")):("● "+t("fp_baseline"))}</div>
        </Section>
      </div>
    </div>
    {/* Version management */}
    <Section title={<span className="sect-right">{t("fv_title")}<InfoTip text={t("fml_fg")}/></span>}
      sub={<span className="muted" style={{fontSize:12}}>{t("fv_active")}: <b>{activeId}</b> · {t("set_lastMod")}: {activeVer?.activatedAt||"—"}</span>}
      right={<div style={{display:"flex",gap:6}}>
        <button className="btn sm" onClick={handleActivate} disabled={!canActivateNow}>✓ {t("fp_activate")}</button>
      </div>}>
      <table className="tbl"><thead><tr>
        <th style={{width:30}}><input type="checkbox" checked={cmpVerIds.length>=2} onChange={()=>{}}/></th>
        <th>{t("config_change_id")}</th><th>{t("fp_version_name")}</th><th>{t("fp_version_desc")}</th><th>{t("fp_ver_created")}</th><th>{t("fp_ver_activated")}</th>
        <th>{t("fp_ver_status")}</th><th></th>
      </tr></thead>
        <tbody>{formulaVersions.map(v=>{
          const isActive = v.status==="active";
          const isSelected = v.id===actVerId;
          const isApproved = formulaVersion.canActivate && formulaVersion.approvedVersionId===v.id && !isActive;
          const rowBg = isActive ? "var(--green-50)" : isSelected ? "#F0F4F8" : isApproved ? "#E3F2FD" : undefined;
          return (<tr key={v.id} style={{background:rowBg,cursor:"pointer",outline:isSelected?"2px solid var(--primary)":"none",outlineOffset:-2}}
            onClick={()=>setActVerId(v.id===actVerId?null:v.id)}>
            <td onClick={e=>e.stopPropagation()}><input type="checkbox" checked={cmpVerIds.includes(v.id)} onChange={()=>{ toggleCmp(v.id); setActVerId(v.id); }}/></td>
            <td className="mono"><span className="wo">{v.id}</span></td>
            <td style={{fontSize:12,fontWeight:600}}>{v.label||v.id}</td>
            <td style={{fontSize:12}}>{v.description}</td>
            <td className="muted" style={{fontSize:12,whiteSpace:"nowrap"}}>{v.createdAt||"—"}</td>
            <td className="muted" style={{fontSize:12,whiteSpace:"nowrap"}}>{v.activatedAt||"—"}</td>
            <td>{statusChip(v.status)}</td>
            <td>
              <div style={{display:"flex",gap:4,flexWrap:"wrap",justifyContent:"flex-end"}}>
                <button className="btn ghost sm" style={{fontSize:11}} onClick={e=>{e.stopPropagation(); setSelVerId(v.id);}}>👁 {t("fp_ver_detail")}</button>
                <button className="btn secondary sm" style={{fontSize:11}} onClick={e=>{
                  e.stopPropagation();
                  setWhatifContext({
                    fromFormula:true, fromVersion:true, versionId:v.id,
                    ded:v.params.ded, dur:v.params.dur, ceil:v.params.ceil, rate:v.params.rate
                  });
                  setRoute("whatif");
                }}>🧪 {t("fv_test")}</button>
              </div>
            </td>
          </tr>);
        })}</tbody></table>
    </Section>
    {/* Version comparison panel */}
    {showCmp && <Section title={t("fp_compare")}>
      <table className="tbl"><thead><tr>
        <th>{t("fp_compare_params")}</th>
        <th className="right-num">{v1.id}</th>
        <th className="right-num">{v2.id}</th>
        <th className="right-num">{t("fp_compare_diff")}</th>
      </tr></thead>
        <tbody>{cmpRows.map(r=>{
          const diff = r.v1!==r.v2;
          const diffText = r.v1!=null&&r.v2!=null ? (r.v2-r.v1>0?"▲ +":"▼ ")+Math.abs(r.v2-r.v1)+r.u : "—";
          return (<tr key={r.k}>
            <td>{r.l}</td>
            <td className="right-num mono">{r.v1}{r.u}</td>
            <td className="right-num mono" style={{fontWeight:700}}>{r.v2}{r.u}</td>
            <td className="right-num mono" style={{color:diff?"var(--primary)":"var(--muted)",fontWeight:diff?700:400}}>{diff?diffText:"—"}</td>
          </tr>);
        })}</tbody></table>
    </Section>}
    {/* Save version modal */}
    {saveModal && <Modal title={t("fp_save_version")} onClose={()=>setSaveModal(false)}>
      <div className="field"><label>{t("fp_version_name")}</label>
        <input className="input" value={saveLabel} onChange={e=>setSaveLabel(e.target.value)} placeholder="e.g. Adjustment v2.0"/></div>
      <div className="field"><label>{t("fp_version_desc")}</label>
        <textarea className="input" style={{minHeight:60}} value={saveDesc} onChange={e=>setSaveDesc(e.target.value)} placeholder="Describe the changes…"/></div>
      <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
        <button className="btn secondary" onClick={()=>setSaveModal(false)}>{t("back")}</button>
        <button className="btn" onClick={handleSaveVersion} disabled={!saveLabel.trim()}>📦 {t("fp_save_version")}</button>
      </div>
    </Modal>}
    {/* Version detail modal */}
    {selVerId && (()=>{
      const v = formulaVersions.find(x=>x.id===selVerId);
      if(!v) return null;
      return (<Modal title={t("fp_ver_detail")+" · "+v.id} onClose={()=>setSelVerId(null)}>
        <div className="pkg-detail" style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <span className="wo">{v.id}</span>
            {statusChip(v.status)}
          </div>
          <div style={{fontSize:13,marginTop:4}}>{v.description}</div>
        </div>
        {v.snapshot && <div className="pkg-detail" style={{marginBottom:14}}>
          <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("fp_ver_snapshot")}</div>
          <div className="cols-3">
            <div className="mini-kpi"><div className="muted">{t("kpi_fairness")}</div><div className="v">{v.snapshot.fg.toFixed(2)}</div></div>
            <div className="mini-kpi"><div className="muted">{t("kpi_hbr")}</div><div className="v">{(v.snapshot.hbr*100).toFixed(1)}%</div></div>
            <div className="mini-kpi"><div className="muted">{t("kpi_savings")}</div><div className="v">{(v.snapshot.spend).toFixed(2)}B</div></div>
          </div>
        </div>}
        <div className="pkg-detail" style={{marginBottom:14}}>
          <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("fp_ver_params")}</div>
          <div style={{fontSize:13}}>
            {t("fp_ded")}: <b className="mono">{v.params.ded}%</b> · {t("fp_dur")}: <b className="mono">{v.params.dur}y</b> · {t("fp_ceil")}: <b className="mono">{n0(v.params.ceil)}</b> · {t("fp_rate")}: <b className="mono">{v.params.rate}%</b>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn ghost sm" onClick={()=>{createFormulaVersion("Fork: "+v.id, "Forked from "+v.id, v.params, v.matrix); setSelVerId(null);}}>📦 {t("fp_ver_create_from")}</button>
          {v.status!=="active"&&<button className="btn sm" onClick={()=>{handleRollbackPackage(v.id); setSelVerId(null);}}>↩ {t("fp_ver_rollback")}</button>}
        </div>
      </Modal>);
    })()}
    {/* Rollback confirmation modal */}
    {rollbackModal && <Modal title={t("fp_ver_rollback")} onClose={()=>setRollbackModal(null)}>
      <div style={{padding:"4px 0 12px",fontSize:13.5,lineHeight:1.6}}>
        {t("fp_rollback_confirm", {ver: rollbackModal.label})}
        <div className="muted" style={{fontSize:12,marginTop:8}}>
          {t("fp_ded")}: <b className="mono">{rollbackModal.params.ded}%</b> · {t("fp_dur")}: <b className="mono">{rollbackModal.params.dur}y</b> · {t("fp_rate")}: <b className="mono">{rollbackModal.params.rate}%</b>
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
        <button className="btn secondary" onClick={()=>setRollbackModal(null)}>{t("cancel")}</button>
        <button className="btn" onClick={handleRollbackConfirm}>✓ {t("confirm")}</button>
      </div>
    </Modal>}
  </div>);
}

/* ===== AI insights (dashboard) ===== */
const INSIGHTS=[{k:"ins_tenure",tone:"info"},{k:"ins_fiscal",tone:"good"},{k:"ins_fair",tone:"warn"}];
function AIInsights(){
  const {t}=useStore();
  return (<Section title={<span className="sect-right">✦ {t("ins_title")}</span>} sub={t("ins_sub")}>
    <div className="cols-3">
      {INSIGHTS.map(i=>(<div key={i.k} className={"insight-card "+i.tone}>
        <div className="ic-h">{t(i.k+"_h")}</div>
        <div className="ic-t">{t(i.k+"_t")}</div>
        <div className="ic-r">✦ {t(i.k+"_r")}</div>
      </div>))}
    </div>
  </Section>);
}
Object.assign(I18N.en,{ nav_settings:"Settings", nav_formula:"Subsidy Formula",
  set_sub:"Central configuration — all thresholds and operating parameters", set_save:"Save changes", set_saved:"Settings saved", set_readonly:"Read-only", set_note:"Changing critical thresholds requires Business Owner approval", set_lastMod:"Last modified", set_p03r:"Approval required", set_affects:"Affects",
  set_g:"Group", set_param:"Parameter", set_val:"Value",
  set_brTitle:"Governance rules for settings", set_brSub:"These rules apply to all threshold changes in this panel",
  set_br01:"All threshold changes are tracked in the Audit Trail — no changes are anonymous.", set_br02:"Modified thresholds take effect immediately upon approval — no batch window.", set_br03:"P-03 (Minister) must approve changes to escalation thresholds (#5) and Minister deadline (#7) - P-02 can enter but cannot activate without P-03 sign-off.", set_br04:"Settings history is append-only — previous values are always retrievable.", set_br05:"Threshold change audit records include: old value → new value, who changed it, when, and which UC(s) are affected.",
  // config changes
  config_tab_current:"Current", config_tab_changes:"Change History",
  config_schedule_change:"Schedule Change", config_change_id:"CC",
  config_effective_from:"Effective from", config_reason:"Reason for change",
  config_impact_preview:"Impact preview", config_submit:"Submit for approval",
  config_status_draft:"Draft", config_status_pending:"Pending approval",
  config_status_scheduled:"Scheduled", config_status_effective:"Effective",
  config_status_superseded:"Superseded", config_status_rejected:"Rejected",
  config_no_changes:"No change history yet", config_from_param:"from", config_to_param:"to",
  config_pending_config:"Pending config changes", config_view_all:"View all",
  config_scheduled_at:"Scheduled at", config_by:"by",
  config_pending_approval:"Pending approval", config_awaiting:"Awaiting approval",
  config_draft_sub:"Changes you have drafted and not yet submitted",
  config_status_draft_short:"Draft", config_status_pending_short:"Pending",
  config_status_scheduled_short:"Scheduled", config_status_effective_short:"Active",
  config_status_rejected_short:"Rejected",
  config_confirm_draft_title:"Save as draft?", config_confirm_draft_msg:"This change will be saved as a draft. You can submit it for approval later.",
  config_confirm_submit_title:"Submit for approval?", config_confirm_submit_msg:"This change will be submitted for P-02 (Business Owner) approval. Continue?",
  config_confirm_approve_title:"Approve this change?", config_confirm_approve_msg:"The change will take effect according to the scheduled time. Continue?",
  config_confirm_reject_title:"Reject this change?", config_confirm_reject_msg:"The change will be rejected and returned to the analyst. Continue?",
  config_confirm_submit:"Submit", config_confirm_save_draft:"Save draft",
  set_g_dq:"Data quality", set_g_budget:"Budget thresholds", set_g_budgetC:"Budget constants", set_g_esc:"Escalation & time limits", set_g_fair:"Fairness gap", set_g_hbr:"Housing burden (HBR)", set_g_mon:"Monitoring thresholds",
  set_minComplete:"Minimum data completeness", set_earlyAlert:"Early budget alert", set_critAlert:"Critical budget alert", set_annual:"Annual budget (SAR M)", set_eligible:"Total eligible population", set_minThresh:"Ministerial escalation (redistribution)", set_boTime:"Business Owner response time", set_minTime:"Minister escalation deadline", set_fgMin:"Fairness Gap minimum acceptable", set_hbrCeil:"HBR ceiling", set_demandChg:"Significant change in demand", set_improveDur:"Improvement duration for HBR",
  f_sub:"The formulas behind the engine — with worked examples",
  // formula page new keys
  fp_params:"Parameters", fp_region:"Region", fp_region_all:"All regions",
  fp_housing_type:"Housing type", fp_ht_all:"All types", fp_ht_offplan:"Off-plan", fp_ht_ready:"Ready", fp_ht_selfbuild:"Self-build",
  fp_income_band:"Income band", fp_ib_all:"All bands",
  fp_cross_preview:"Cross-dimension preview",
  fp_save_version:"Save as version", fp_version_name:"Version name", fp_version_desc:"Description", fp_version_saved:"Version saved",
  fp_compare:"Version comparison", fp_compare_params:"Parameter", fp_compare_diff:"Diff",
  fp_ver_detail:"Details", fp_ver_created:"Created", fp_ver_activated:"Activated", fp_ver_status:"Status",
  fp_ver_snapshot:"Activation snapshot", fp_ver_params:"Parameters",
  fp_ver_rollback:"Rollback", fp_ver_create_from:"Fork from this",
  fp_activate:"Activate", fp_rollback:"Rollback", fp_activated:"Activated", fp_rolledback:"Rolled back",
  fp_rollback_confirm:"This operation will submit a rollback request to the Business Owner for approval. Confirm?",
  cancel:"Cancel", confirm:"Confirm",
  fv_title:"Formula versions", fv_test:"Test in What-if", fv_br07:"A modified formula must be validated in What-if before it can be activated.", fv_draft:"Draft", fv_candidate:"Candidate", fv_pending:"Pending validation", fv_validated:"Validated ✓", fv_testDone:"Ready to activate", fv_approveFirst:"Package approval required before activation", fv_approved:"Approved ✓ Ready to activate", fv_active:"Active", fv_superseded:"Superseded", fv_v11:"Deduction rate 40% → 43% — needs What-if validation.", fv_v10:"Baseline formula in production.",
  agent_status:"Agent fleet status", agent_status_sub:"All 8 agents operational · L1/L2: business, L3: AI orchestration",
  permissionMatrix:"Permission Matrix",
  perm_mat_desc:"View full role-permission mapping (RACI)",
  perm_view:"View",
  perm_edit:"Edit",
  perm_approve:"Approve",
  uc:"Module",
  note:"Note",
  perm_legend:"Legend",
  perm_analyst_desc:"Full edit on 6/14 modules, view-only on others",
  perm_owner_desc:"Approve on Allocation & Decisions, escalation authority",
  perm_minister_desc:"Read-only access to 6 modules, final adjudication",
  al_gateAll:"Checked existing data (completeness, vs last month, What-if verified)",
  fp_ded:"Optimal deduction rate", fp_dur:"Support duration", fp_yrs:"yrs", fp_ceil:"Financing ceiling", fp_rate:"Reference interest rate", fp_income:"Income threshold (statutory)", fp_lockedNote:"Fixed — Ministry of Human Resources poverty line", fp_preview:"Preview by income band", fp_previewNote:"Recomputed live as parameters change", fp_inc:"Income", fp_maxH:"Max housing cost", fp_sup:"Est. monthly support", fp_candidate:"Candidate (unsaved) — validate before activating", fp_baseline:"Matches active v1.0",
  fc_monthly:"Monthly", fc_cumulative:"Cumulative", fc_actual:"Actual", fc_forecast:"Forecast (OLS)", fc_ci:"Confidence ±12%",
  ins_title:"AI insights", ins_sub:"Natural-language reading of the current state",
  ins_tenure_h:"Structural tenure shift", ins_tenure_t:"Rent inflation 8–10% far outpaces wage growth 4–5%, while purchase prices stay in low single digits.", ins_tenure_r:"Shift budget toward purchase subsidies to move citizens out of the volatile rental market.",
  ins_fiscal_h:"Fiscal runway", ins_fiscal_t:"Projected annual spend tracks to ~76%, leaving ~24% (SAR 384M) of budget headroom.", ins_fiscal_r:"Use this headroom for strategic reallocation toward high-need applicants.",
  ins_fair_h:"Fairness gap", ins_fair_t:"FG 0.58 with HBR 40.5% signals misallocation — support isn't reaching the most vulnerable.", ins_fair_r:"Recalibrate the subsidy matrix to raise precision for high-vulnerability segments.",
  whatif_sandbox:"Sandbox-isolated — simulations never touch live allocations or budgets.",
  whatif_hardboundary:"Cabinet regulations unchanged · Hard Boundary enforced",
  hardboundary:"Red Line: Cabinet regulations (Hard Boundary) — never modifiable by the system", });
Object.assign(I18N.zh,{ nav_settings:"设置", nav_formula:"补贴公式",
  set_sub:"中央配置 —— 所有阈值与运行参数", set_save:"保存修改", set_saved:"设置已保存", set_readonly:"只读", set_note:"修改关键阈值需业务负责人审批", set_lastMod:"最近修改", set_p03r:"需部长审批", set_affects:"影响",
  set_g:"分组", set_param:"参数", set_val:"当前值",
  set_brTitle:"设置治理规则", set_brSub:"以下规则适用于本页面的所有阈值修改",
  set_br01:"所有阈值修改均记录在审计轨迹中 — 无匿名修改。", set_br02:"修改的阈值在批准后立即生效 — 无批处理窗口。", set_br03:"P-03（部长）必须审批升级阈值（#5）和部长截止时间（#7）的修改 — P-02 可录入但不能在部长批准前激活。", set_br04:"设置历史仅追加 — 先前值始终可追溯。", set_br05:"阈值变更审计记录包含：旧值→新值、修改人、时间、影响的 UC。",
  config_tab_current:"当前配置", config_tab_changes:"变更历史",
  config_schedule_change:"排期变更", config_change_id:"CC",
  config_effective_from:"生效时间", config_reason:"变更理由",
  config_impact_preview:"影响预览", config_submit:"提交审批",
  config_status_draft:"草稿", config_status_pending:"待审批",
  config_status_scheduled:"已排期", config_status_effective:"已生效",
  config_status_superseded:"已取代", config_status_rejected:"已驳回",
  config_no_changes:"暂无变更记录", config_from_param:"从", config_to_param:"到",
  config_pending_config:"待审批的配置变更", config_view_all:"查看全部",
  config_scheduled_at:"计划生效", config_by:"操作人",
  config_pending_approval:"待审批", config_awaiting:"等待审批",
  config_draft_sub:"你已起草但未提交的变更",
  config_status_draft_short:"草稿", config_status_pending_short:"待审批",
  config_status_scheduled_short:"已排期", config_status_effective_short:"已生效",
  config_status_rejected_short:"已驳回",
  config_confirm_draft_title:"保存草稿？", config_confirm_draft_msg:"变更将以草稿形式保存，之后可提交审批。",
  config_confirm_submit_title:"提交审批？", config_confirm_submit_msg:"变更将提交给 P-02（业务负责人）审批，确认提交？",
  config_confirm_approve_title:"通过此变更？", config_confirm_approve_msg:"变更将按排期时间生效，确认通过？",
  config_confirm_reject_title:"驳回此变更？", config_confirm_reject_msg:"变更将被驳回并退回给分析师，确认驳回？",
  config_confirm_submit:"提交审批", config_confirm_save_draft:"保存草稿",
  set_g_dq:"数据质量", set_g_budget:"预算阈值", set_g_budgetC:"预算常量", set_g_esc:"升级与时限", set_g_fair:"公平性差距", set_g_hbr:"住房负担 (HBR)", set_g_mon:"监测阈值",
  set_minComplete:"最低数据完整度", set_earlyAlert:"预算预警(早期)", set_critAlert:"预算预警(严重)", set_annual:"年度预算 (SAR M)", set_eligible:"合格总人口", set_minThresh:"部长升级阈值(再分配)", set_boTime:"业务负责人响应时限", set_minTime:"部长升级截止", set_fgMin:"公平差距最低可接受", set_hbrCeil:"HBR 上限", set_demandChg:"需求显著变化", set_improveDur:"HBR 改善持续",
  f_sub:"引擎背后的公式 —— 附算例",
  // formula page new keys
  fp_params:"参数面板", fp_region:"地区", fp_region_all:"全部地区",
  fp_housing_type:"住房类型", fp_ht_all:"全部类型", fp_ht_offplan:"期房", fp_ht_ready:"现房", fp_ht_selfbuild:"自建",
  fp_income_band:"收入档", fp_ib_all:"全部档位",
  fp_cross_preview:"交叉维度预览",
  fp_save_version:"另存为版本", fp_version_name:"版本名称", fp_version_desc:"描述", fp_version_saved:"版本已保存",
  fp_compare:"版本对比", fp_compare_params:"参数", fp_compare_diff:"差异",
  fp_ver_detail:"详情", fp_ver_created:"创建时间", fp_ver_activated:"激活时间", fp_ver_status:"状态",
  fp_ver_snapshot:"激活快照", fp_ver_params:"参数",
  fp_ver_rollback:"回滚", fp_ver_create_from:"从此创建",
  fp_activate:"激活", fp_rollback:"回滚", fp_activated:"已激活", fp_rolledback:"已回滚",
  fp_rollback_confirm:"此操作将向业务负责人提交回滚审批请求，是否确认？",
  cancel:"取消", confirm:"确认",
  fv_title:"公式版本", fv_test:"在 What-if 中测试", fv_br07:"修改后的公式必须先在 What-if 验证，才能激活。", fv_draft:"草稿", fv_candidate:"候选", fv_pending:"待验证", fv_validated:"已验证 ✓", fv_testDone:"准备好激活", fv_approveFirst:"须经决策包审批通过方可激活", fv_approved:"已审批 ✓ 可激活", fv_active:"生效中", fv_superseded:"已迭代", fv_v11:"扣除率 40% → 43% —— 需 What-if 验证。", fv_v10:"生产环境基线公式。",
  agent_status:"智能体集群状态", agent_status_sub:"8 个智能体全部运行中 · L1/L2: 业务层, L3: AI 编排",
  permissionMatrix:"权限矩阵", perm_mat_desc:"查看完整角色-权限映射",
  perm_view:"查看", perm_edit:"编辑", perm_approve:"审批", uc:"模块", note:"备注",
  perm_legend:"图例说明",
  perm_analyst_desc:"对 6/14 个模块拥有编辑权,其余仅查看",
  perm_owner_desc:"对配分与决策拥有审批权与逐级上报权",
  perm_minister_desc:"对 6 个模块拥有只读权限,最终裁定权",
  al_gateAll:"已检查现有数据（完整性、环比变化、What-if 已验证）",
  fp_ded:"最优扣除率", fp_dur:"支援期限", fp_yrs:"年", fp_ceil:"融资上限", fp_rate:"参考利率", fp_income:"收入门槛(法定)", fp_lockedNote:"固定 —— 人力资源部贫困线", fp_preview:"按收入档预览", fp_previewNote:"参数变化时实时重算", fp_inc:"收入", fp_maxH:"最高住房成本", fp_sup:"预估月补", fp_candidate:"候选(未保存)—— 激活前需验证", fp_baseline:"与生效 v1.0 一致",
  fc_monthly:"月度", fc_cumulative:"累计", fc_actual:"实际", fc_forecast:"预测(OLS)", fc_ci:"置信区间 ±12%",
  ins_title:"AI 洞察", ins_sub:"对当前态势的自然语言解读",
  ins_tenure_h:"结构性租购转变", ins_tenure_t:"租金通胀 8–10% 远超工资增长 4–5%,而购房价格仍处低个位数。", ins_tenure_r:"建议将预算转向购房补贴,把公民从动荡的租赁市场转移出来。",
  ins_fiscal_h:"财政空间", ins_fiscal_t:"预计年度支出约 76%,剩余约 24%(SAR 3.84 亿)预算空间。", ins_fiscal_r:"利用该空间向高需求申请者做战略再分配。",
  ins_fair_h:"公平差距", ins_fair_t:"FG 0.58 叠加 HBR 40.5%,显示资金配置不佳 —— 支援未触达最脆弱群体。", ins_fair_r:"校准补贴矩阵,提高对高脆弱性群体的精准度。",
  whatif_sandbox:"沙箱隔离 —— 推演绝不影响线上配分或预算。",
  whatif_hardboundary:"内阁法规不变 · 红线边界强制",
  hardboundary:"红线边界：内阁法规（Hard Boundary）—— 系统永不可修改" });
Object.assign(I18N.ar,{ nav_settings:"الإعدادات", nav_formula:"صيغة الدعم",
  set_sub:"التهيئة المركزية — جميع العتبات ومعاملات التشغيل", set_save:"حفظ التغييرات", set_saved:"تم حفظ الإعدادات", set_readonly:"للقراءة فقط", set_note:"تغيير العتبات الحرجة يتطلب موافقة مالك الأعمال", set_lastMod:"آخر تعديل", set_p03r:"موافقة الوزير مطلوبة", set_affects:"يؤثر على",
  set_g:"المجموعة", set_param:"المعامل", set_val:"القيمة",
  set_brTitle:"قواعد حوكمة الإعدادات", set_brSub:"تنطبق هذه القواعد على جميع تغييرات العتبات في هذه اللوحة",
  set_br01:"جميع تغييرات العتبات مسجلة في سجل التدقيق — لا توجد تغييرات مجهولة.", set_br02:"تسري العتبات المعدلة فوراً بعد الموافقة — لا نافذة دفعة.", set_br03:"يجب على الوزير (P-03) الموافقة على تغييرات عتبات التصعيد (#5) ومهلة الوزير (#7) — يمكن لـ P-02 الإدخال لكن لا يمكن التفعيل دون موافقة P-03.", set_br04:"سجل الإعدادات للإلحاق فقط — القيم السابقة قابلة للاسترجاع دائماً.", set_br05:"تتضمن سجلات تدقيق تغيير العتبات: القيمة القديمة ← القيمة الجديدة، من غيّرها، متى، وأي حالات استخدام متأثرة.",
  config_tab_current:"الحالي", config_tab_changes:"سجل التغييرات",
  config_schedule_change:"جدولة تغيير", config_change_id:"CC",
  config_effective_from:"يسري من", config_reason:"سبب التغيير",
  config_impact_preview:"معاينة التأثير", config_submit:"تقديم للموافقة",
  config_status_draft:"مسودة", config_status_pending:"بانتظار الموافقة",
  config_status_scheduled:"مجدول", config_status_effective:"ساري المفعول",
  config_status_superseded:"مستبدل", config_status_rejected:"مرفوض",
  config_no_changes:"لا يوجد سجل تغييرات بعد", config_from_param:"من", config_to_param:"إلى",
  config_pending_config:"تغييرات إعدادات معلقة", config_view_all:"عرض الكل",
  config_scheduled_at:"مجدول في", config_by:"بواسطة",
  config_pending_approval:"بانتظار الموافقة", config_awaiting:"في انتظار الاعتماد",
  config_draft_sub:"التغييرات التي أعددتها ولم ترسلها بعد",
  config_status_draft_short:"مسودة", config_status_pending_short:"معلق",
  config_status_scheduled_short:"مجدول", config_status_effective_short:"نشط",
  config_status_rejected_short:"مرفوض",
  config_confirm_draft_title:"حفظ كمسودة؟", config_confirm_draft_msg:"سيتم حفظ التغيير كمسودة. يمكنك تقديمه للموافقة لاحقاً.",
  config_confirm_submit_title:"تقديم للموافقة؟", config_confirm_submit_msg:"سيتم تقديم التغيير لموافقة P-02 (مالك الأعمال). هل تريد المتابعة؟",
  config_confirm_approve_title:"اعتماد هذا التغيير؟", config_confirm_approve_msg:"سيصبح التغيير سارياً وفقاً للوقت المجدول. هل تريد المتابعة؟",
  config_confirm_reject_title:"رفض هذا التغيير؟", config_confirm_reject_msg:"سيتم رفض التغيير وإعادته للمحلل. هل تريد المتابعة؟",
  config_confirm_submit:"تقديم", config_confirm_save_draft:"حفظ مسودة",
  set_g_dq:"جودة البيانات", set_g_budget:"عتبات الميزانية", set_g_budgetC:"ثوابت الميزانية", set_g_esc:"التصعيد والمهل", set_g_fair:"فجوة العدالة", set_g_hbr:"عبء السكن (HBR)", set_g_mon:"عتبات المراقبة",
  set_minComplete:"الحد الأدنى لاكتمال البيانات", set_earlyAlert:"تنبيه ميزانية مبكر", set_critAlert:"تنبيه ميزانية حرج", set_annual:"الميزانية السنوية (SAR M)", set_eligible:"إجمالي السكان المؤهلين", set_minThresh:"عتبة تصعيد الوزير (إعادة التوزيع)", set_boTime:"مهلة رد مالك الأعمال", set_minTime:"مهلة تصعيد الوزير", set_fgMin:"الحد الأدنى المقبول لفجوة العدالة", set_hbrCeil:"سقف HBR", set_demandChg:"تغيّر كبير في الطلب", set_improveDur:"مدة تحسّن HBR",
  f_sub:"الصيغ خلف المحرك — مع أمثلة محلولة",
  // formula page new keys
  fp_params:"المعاملات", fp_region:"المنطقة", fp_region_all:"جميع المناطق",
  fp_housing_type:"نوع السكن", fp_ht_all:"جميع الأنواع", fp_ht_offplan:"على الخارطة", fp_ht_ready:"جاهز", fp_ht_selfbuild:"بناء ذاتي",
  fp_income_band:"شريحة الدخل", fp_ib_all:"جميع الشرائح",
  fp_cross_preview:"معاينة متعددة الأبعاد",
  fp_save_version:"حفظ كإصدار", fp_version_name:"اسم الإصدار", fp_version_desc:"الوصف", fp_version_saved:"تم حفظ الإصدار",
  fp_compare:"مقارنة الإصدارات", fp_compare_params:"المعامل", fp_compare_diff:"الفرق",
  fp_ver_detail:"التفاصيل", fp_ver_created:"تاريخ الإنشاء", fp_ver_activated:"تاريخ التفعيل", fp_ver_status:"الحالة",
  fp_ver_snapshot:"لقطة التفعيل", fp_ver_params:"المعاملات",
  fp_ver_rollback:"استرجاع", fp_ver_create_from:"إنشاء نسخة من",
  fp_activate:"تفعيل", fp_rollback:"استرجاع", fp_activated:"مُفعَّل", fp_rolledback:"تم الاسترجاع",
  fp_rollback_confirm:"سيؤدي هذا الإجراء إلى إرسال طلب الاسترجاع إلى مسؤول الأعمال للموافقة. هل أنت متأكد؟",
  cancel:"إلغاء", confirm:"تأكيد",
  fv_title:"إصدارات الصيغة", fv_test:"اختبار في What-if", fv_br07:"يجب التحقق من الصيغة المعدّلة في What-if قبل تفعيلها.", fv_draft:"مسودة", fv_candidate:"مرشّح", fv_pending:"بانتظار التحقق", fv_validated:"تم التحقق ✓", fv_testDone:"جاهز للتفعيل", fv_approveFirst:"يلزم موافقة الحزمة قبل التفعيل", fv_approved:"تمت الموافقة ✓ جاهز للتفعيل", fv_active:"فعّال", fv_superseded:"مستبدل", fv_v11:"معدل الخصم ٤٠٪ → ٤٣٪ — يحتاج تحقق What-if.", fv_v10:"الصيغة الأساسية في الإنتاج.",
  agent_status:"حالة أسطول الوكلاء", agent_status_sub:"جميع الوكلاء الثمانية يعملون · L1/L2: طبقة الأعمال, L3: تنسيق الذكاء الاصطناعي",
  permissionMatrix:"مصفوفة الصلاحيات", perm_mat_desc:"عرض تخطيط الصلاحيات الكامل",
  perm_view:"عرض", perm_edit:"تعديل", perm_approve:"اعتماد", uc:"الوحدة", note:"ملاحظة",
  perm_legend:"دليل الرموز",
  perm_analyst_desc:"حق التعديل على ٦/١٤ وحدة، عرض فقط للبقية",
  perm_owner_desc:"اعتماد التخصيص والقرارات، صلاحية التصعيد",
  perm_minister_desc:"وصول للقراءة فقط لـ ٦ وحدات، الفصل النهائي",
  al_gateAll:"تم فحص البيانات الحالية (الاكتمال، المقارنة بالشهر الماضي، التحقق في What-if)",
  fp_ded:"معدل الخصم الأمثل", fp_dur:"مدة الدعم", fp_yrs:"سنة", fp_ceil:"سقف التمويل", fp_rate:"سعر الفائدة المرجعي", fp_income:"حدّ الدخل (نظامي)", fp_lockedNote:"ثابت — خط الفقر لوزارة الموارد البشرية", fp_preview:"معاينة حسب شريحة الدخل", fp_previewNote:"يُعاد حسابه فور تغيير المعاملات", fp_inc:"الدخل", fp_maxH:"أقصى تكلفة سكن", fp_sup:"الدعم الشهري التقديري", fp_candidate:"مرشّح (غير محفوظ) — تحقّق قبل التفعيل", fp_baseline:"مطابق للنسخة الفعّالة v1.0",
  fc_monthly:"شهري", fc_cumulative:"تراكمي", fc_actual:"فعلي", fc_forecast:"تنبؤ (OLS)", fc_ci:"ثقة ±١٢٪",
  ins_title:"رؤى الذكاء الاصطناعي", ins_sub:"قراءة لغوية للوضع الحالي",
  ins_tenure_h:"تحوّل هيكلي في الحيازة", ins_tenure_t:"تضخم الإيجار ٨–١٠٪ يفوق نمو الأجور ٤–٥٪، بينما تبقى أسعار الشراء منخفضة.", ins_tenure_r:"تحويل الميزانية نحو دعم الشراء لإخراج المواطنين من سوق الإيجار المتقلب.",
  ins_fiscal_h:"المتسع المالي", ins_fiscal_t:"الإنفاق السنوي المتوقع نحو ٧٦٪، يتبقى نحو ٢٤٪ (٣٨٤ مليون ريال).", ins_fiscal_r:"استخدام هذا المتسع لإعادة توزيع استراتيجية نحو الأشد حاجة.",
  ins_fair_h:"فجوة العدالة", ins_fair_t:"فجوة ٠٫٥٨ مع HBR ٤٠٫٥٪ تشير إلى سوء تخصيص — الدعم لا يصل للأكثر هشاشة.", ins_fair_r:"إعادة معايرة مصفوفة الدعم لرفع الدقة للشرائح الأشد هشاشة.",
  whatif_sandbox:"معزول في بيئة اختبار — المحاكاة لا تمسّ التخصيصات أو الميزانيات الحية.",
  whatif_hardboundary:"اللوائح الوزارية دون تغيير · حدود حمراء مُطبَّقة",
  hardboundary:"الخط الأحمر: لوائح مجلس الوزراء (حدود صلبة) — لا يمكن للنظام تعديلها" });

/* ===== Dashboard KPI detail modal (12-mo trend + drill) ===== */
const KMON=["Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr","May","Jun"];
const KPI_DETAIL={
  ownership:{titleKey:"kpi_ownership",unit:"%",thr:70,series:[63.0,63.5,64.0,64.2,64.6,65.0,65.2,65.5,65.8,66.0,66.1,66.24],drill:[["Riyadh",68],["Makkah",64],["Eastern",71],["Asir",60],["Madinah",66]],events:[]},
  savings:{titleKey:"kpi_savings",unit:"B",series:[0.2,0.5,0.8,1.0,1.3,1.6,1.8,2.0,2.3,2.6,2.9,3.1],drill:[["Riyadh",0.9],["Makkah",0.7],["Eastern",0.6],["Asir",0.5],["Others",0.4]],events:[]},
  fairness:{titleKey:"kpi_fairness",unit:"",thr:1.0,series:[0.58,0.62,0.66,0.71,0.76,0.81,0.86,0.90,0.94,0.97,1.00,1.02],drill:[["<5K",0.51],["5–10K",0.72],["10–15K",1.02],["15–20K",1.18],[">20K",1.25]],events:[["May","ev_rebalance"]]},
  hbr:{titleKey:"kpi_hbr",unit:"%",thr:38,series:[41.0,40.8,40.5,40.1,39.6,39.0,38.4,37.9,37.4,37.0,36.6,36.2],drill:[["<3K",38.5],["3–5K",35.1],["5–10K",31.4],["10–20K",28.2],[">20K",22.5]],events:[["Jun","ev_fmlAct"]]},
  budget:{titleKey:"kpi_budget",unit:"%",thr:90,series:[12,22,32,41,50,58,64,70,76,80,85,89],drill:[["Cash",54],["In-kind",22],["Interest",13]],events:[["Jun","ev_alert"]]},
};
function KpiDetailModal({kpi,onClose}){
  const {t}=useStore(); const d=KPI_DETAIL[kpi]; if(!d) return null;
  const C=RC; const ok=!!RC.ResponsiveContainer;
  const data=KMON.map((m,i)=>({m,v:d.series[i]}));
  const maxDrill=Math.max(...d.drill.map(x=>x[1]));
  return (<Modal title={<span className="rel-mtitle">📈 {t(d.titleKey)} · {t("kd_trend")}</span>} onClose={onClose}>
    <div style={{width:"100%",height:240,marginBottom:10}}>
      {!ok? <div className="muted" style={{padding:20}}>{t("kd_noChart")}</div> :
      <C.ResponsiveContainer>
        <C.LineChart data={data} margin={{top:8,right:14,left:0,bottom:4}}>
          <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
          <C.XAxis dataKey="m" tick={{fontSize:10}}/>
          <C.YAxis tick={{fontSize:10}} width={36}/>
          <C.Tooltip formatter={(v)=>v+d.unit}/>
          {d.thr!=null?<C.ReferenceLine y={d.thr} stroke="#b3261e" strokeDasharray="4 4"/>:null}
          <C.Line type="monotone" dataKey="v" stroke="#006C35" strokeWidth={2.5} dot={false}/>
        </C.LineChart>
      </C.ResponsiveContainer>}
    </div>
    <div style={{fontWeight:700,fontSize:13,margin:"6px 0 10px"}}>{t("kd_drill")}</div>
    <div className="kd-bars">
      {d.drill.map(([n,v])=>{ const over=kpi==="hbr"&&v>d.thr;
        return (<div key={n} className="kd-row">
          <span className="kd-name">{n}</span>
          <span className="kd-bar"><span style={{width:(v/maxDrill*100)+"%",background:over?"var(--amber)":"var(--primary)"}}/></span>
          <span className="kd-val mono">{v}{d.unit}</span>
        </div>);})}
    </div>
    {d.events.length>0?<div style={{marginTop:14}}>
      <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>{t("kd_events")}</div>
      {d.events.map(([m,k])=>(<div key={k} className="muted" style={{fontSize:12.5}}>— {m}: {t(k)}</div>))}
    </div>:null}
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}>
      <button className="btn secondary" onClick={onClose}>{t("rel_close")}</button>
    </div>
  </Modal>);
}
Object.assign(I18N.en,{ viewTrend:"View trend", kd_trend:"12-month trend", kd_drill:"By income bracket", kd_events:"Key events", kd_noChart:"Chart unavailable (offline)", ev_fmlAct:"Formula update activated", ev_rebalance:"Rebalancing applied", ev_alert:"Budget alert at 73%", wf_runHint:"Run What-if", al_showTrace:"Show trace", al_vsPrev:"vs last month",
  tr_data:"GOSI income ingested · completeness 96.2%", tr_opt:"Applied HBR ≤ 38% · Fairness Gap ≥ 1.0 · optimal rate 2.4%", tr_type:"Compared 5 support types · selected best by HBR",
  alx_how:"How calculated", alx_howT:"GOSI income → deduction rate → max housing cost → optimal rate → monthly support", alx_why:"Why this amount", alx_impact:"Impact if adopted", alx_reason:"FML-v1.1 deduction rate +3pp", alx_annotate:"Annotate", alx_annoPh:"Note for the Business Owner — sent with the decision package" });
Object.assign(I18N.zh,{ viewTrend:"查看趋势", kd_trend:"12 个月趋势", kd_drill:"按收入档", kd_events:"关键事件", kd_noChart:"图表不可用(离线)", ev_fmlAct:"公式更新已激活", ev_rebalance:"已执行再平衡", ev_alert:"预算预警 73%", wf_runHint:"跑 What-if", al_showTrace:"展示链路", al_vsPrev:"环比上月",
  tr_data:"已接入 GOSI 收入 · 完整度 96.2%", tr_opt:"应用 HBR ≤ 38% · Fairness Gap ≥ 1.0 · 最优利率 2.4%", tr_type:"比较 5 种支援类型 · 按 HBR 选最优",
  alx_how:"如何算出", alx_howT:"GOSI 收入 → 扣除率 → 最高住房成本 → 最优利率 → 月度支援", alx_why:"为何是此金额", alx_impact:"采纳后影响", alx_reason:"FML-v1.1 扣除率 +3pp", alx_annotate:"加注释", alx_annoPh:"给业务负责人的备注 —— 随决策包一并提交" });
Object.assign(I18N.ar,{ viewTrend:"عرض الاتجاه", kd_trend:"اتجاه ١٢ شهراً", kd_drill:"حسب شريحة الدخل", kd_events:"أحداث رئيسية", kd_noChart:"الرسم غير متاح (دون اتصال)", ev_fmlAct:"تم تفعيل تحديث الصيغة", ev_rebalance:"تم تطبيق إعادة التوازن", ev_alert:"تنبيه ميزانية عند ٧٣٪", wf_runHint:"تشغيل What-if", al_showTrace:"عرض المسار", al_vsPrev:"مقارنة بالشهر الماضي",
  tr_data:"تم استيعاب دخل التأمينات · الاكتمال ٩٦٫٢٪", tr_opt:"تطبيق HBR ≤ ٣٨٪ · فجوة العدالة ≥ ١٫٠ · معدل أمثل ٢٫٤٪", tr_type:"مقارنة ٥ أنواع دعم · اختيار الأفضل حسب HBR",
  alx_how:"كيف حُسب", alx_howT:"دخل التأمينات → معدل الخصم → أقصى تكلفة سكن → المعدل الأمثل → الدعم الشهري", alx_why:"لماذا هذا المبلغ", alx_impact:"الأثر عند الاعتماد", alx_reason:"FML-v1.1 معدل الخصم +٣ نقاط", alx_annotate:"إضافة ملاحظة", alx_annoPh:"ملاحظة لمالك الأعمال — تُرسل مع حزمة القرار" });

/* ===== Mega KPI visualisations (inline SVG, no chart dep) ===== */
function arcPts(cx,cy,r,a0,a1,n){ const p=[]; for(let i=0;i<=n;i++){ const a=(a0+(a1-a0)*i/n)*Math.PI/180; p.push((cx+r*Math.cos(a)).toFixed(1)+","+(cy-r*Math.sin(a)).toFixed(1)); } return p.join(" "); }
function RadialGauge({value,target,max,unit,color}){
  const frac=Math.max(0,Math.min(1,value/max)); const r=44,cx=56,cy=52;
  const ta=(180-180*(target/max))*Math.PI/180;
  return (<svg viewBox="0 0 112 60" width="100%" height="72">
    <polyline points={arcPts(cx,cy,r,180,0,30)} fill="none" stroke="#e6ece9" strokeWidth="9" strokeLinecap="round"/>
    <polyline points={arcPts(cx,cy,r,180,180-180*frac,30)} fill="none" stroke={color||"var(--primary)"} strokeWidth="9" strokeLinecap="round"/>
    <line x1={cx+(r-8)*Math.cos(ta)} y1={cy-(r-8)*Math.sin(ta)} x2={cx+(r+6)*Math.cos(ta)} y2={cy-(r+6)*Math.sin(ta)} stroke="#085D3A" strokeWidth="2"/>
    <text x={cx} y={cy-4} textAnchor="middle" fontSize="17" fontWeight="800" fill="#16211c">{value}{unit}</text>
  </svg>);
}
function MiniArea({series,thr,min,max,color}){
  const W=120,H=54,mn=min??Math.min(...series)-1,mx=max??Math.max(...series)+1;
  const xy=series.map((v,i)=>[(i/(series.length-1))*W,H-((v-mn)/(mx-mn))*H]);
  const line="M"+xy.map(p=>p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" L");
  const ty=thr!=null?H-((thr-mn)/(mx-mn))*H:null;
  return (<svg viewBox={"0 0 "+W+" "+H} width="100%" height="60" preserveAspectRatio="none">
    <path d={line+" L"+W+" "+H+" L0 "+H+" Z"} fill="rgba(27,131,84,.12)"/>
    <path d={line} fill="none" stroke={color||"var(--primary)"} strokeWidth="2"/>
    {ty!=null?<line x1="0" y1={ty} x2={W} y2={ty} stroke="#b3261e" strokeDasharray="4 3" strokeWidth="1.2"/>:null}
  </svg>);
}
function MiniBars({data,thr}){
  const mx=Math.max(...data.map(d=>d[1]),thr||0)*1.1;
  return (<div style={{display:"flex",alignItems:"flex-end",gap:6,height:60}}>
    {data.map(([n,v],i)=>{ const c=v>=(thr||1)?"var(--primary)":v>=0.9?"var(--amber)":"var(--danger)";
      return <div key={i} title={n+": "+v} style={{flex:1,height:Math.max(4,v/mx*100)+"%",background:c,borderRadius:"3px 3px 0 0"}}/>;})}
  </div>);
}
function StackedBar({segments,marks,total}){
  return (<div style={{paddingTop:6}}>
    <div style={{position:"relative",height:18,borderRadius:9,overflow:"hidden",background:"#eef2ef",display:"flex"}}>
      {segments.map((s,i)=><span key={i} style={{width:(s.v/total*100)+"%",background:s.c}}/>)}
      {marks.map((m,i)=><span key={"m"+i} style={{position:"absolute",insetInlineStart:m+"%",top:-3,width:2,height:24,background:m>=90?"#b3261e":"#9a6b00"}}/>)}
    </div>
  </div>);
}
function MegaKpi({title,value,delta,children,onClick}){
  const {t}=useStore();
  const dcol=delta&&delta[0]==="▲"?"var(--primary)":delta&&delta[0]==="▼"?"var(--amber)":"var(--muted)";
  return (<div className={"mega-kpi"+(onClick?" kpi-click":"")} onClick={onClick}>
    <div className="mk-title">{title}</div>
    <div className="mk-viz">{children}</div>
    <div className="mk-foot">{value?<span className="mk-val">{value}</span>:<span/>}{delta?<span className="mk-delta" style={{color:dcol}}>{delta}</span>:null}</div>
    {onClick?<div className="kpi-more">{t("viewTrend")} ↗</div>:null}
  </div>);
}
Object.assign(I18N.en,{ kpi_ownership:"Home Ownership", dl_title:"Data lineage & gate", dl_go:"GO — ready for downstream", dl_hold:"HOLD — completeness below 90%", dl_opt:"Optimization", dl_fc:"Forecast", dl_track:"Tracking", dl_session:"Session", dl_balance:"Balance entry", qPass:"Pass", qPartial:"Partial", qFail:"Fail",
  kpi_coverage:"Contract Coverage", kpi_mbudget:"Monthly Budget Used", kpi_projAnnual:"Projected Annual Spend", kpi_target:"Contract Target", of_monthly:"of monthly avg", of_ceiling:"of ceiling",
  area_data_readiness:"Data readiness", area_budget_forecast:"Budget forecast", area_allocation:"Allocation", area_reallocation:"Reallocation", area_fairness:"Fairness", area_beneficiary:"Beneficiary", area_what_if:"What-if", area_impact_attribution:"Impact attribution", area_decisions:"Decisions", area_formula:"Formula", area_data:"Data", area_forecast:"Forecast",
  raci_data_import:"Data import & readiness", raci_subsidy_formula:"Subsidy formula", raci_data_quality:"Data quality & pipeline", raci_allocation_algo:"Allocation algorithm", raci_whatif_engine:"What-if engine", raci_beneficiary_tracking:"Beneficiary tracking", raci_forecasting:"Forecasting & fairness", raci_decision_routing:"Decision routing & approval", raci_qc:"QC & escalation", raci_audit_trail:"Audit trail", raci_post_decision:"Post-decision operations", raci_mortgage:"Mortgage planning", raci_benchmarking:"Benchmarking", raci_agent_handoff:"Agent handoff", raci_impact:"Impact attribution" });
Object.assign(I18N.zh,{ kpi_ownership:"住房拥有率", dl_title:"数据血缘与门控", dl_go:"GO —— 可供下游使用", dl_hold:"HOLD —— 完整度低于 90%", dl_opt:"优化", dl_fc:"预测", dl_track:"追踪", dl_session:"会话", dl_balance:"余额录入", qPass:"通过", qPartial:"部分通过", qFail:"失败",
  kpi_coverage:"签约覆盖率", kpi_mbudget:"当月预算使用", kpi_projAnnual:"预测全年支出", kpi_target:"年度签约达成", of_monthly:"占月均", of_ceiling:"占上限",
  area_data_readiness:"数据就绪", area_budget_forecast:"预算预测", area_allocation:"分配", area_reallocation:"再平衡", area_fairness:"公平性", area_beneficiary:"受益方", area_what_if:"推演", area_impact_attribution:"影响归因", area_decisions:"决策", area_formula:"公式", area_data:"数据", area_forecast:"预测",
  raci_data_import:"数据导入与就绪", raci_subsidy_formula:"补贴公式", raci_data_quality:"数据质量与管道", raci_allocation_algo:"分配算法", raci_whatif_engine:"What-if 引擎", raci_beneficiary_tracking:"受益方追踪", raci_forecasting:"预测与公平", raci_decision_routing:"决策路由与审批", raci_qc:"质量管控与升级", raci_audit_trail:"审计轨迹", raci_post_decision:"决策后操作", raci_mortgage:"抵押贷款规划", raci_benchmarking:"国际对标", raci_agent_handoff:"智能体交接", raci_impact:"影响归因" });
Object.assign(I18N.ar,{ kpi_ownership:"نسبة التملّك", dl_title:"سلالة البيانات والبوابة", dl_go:"GO — جاهز للمراحل التالية", dl_hold:"HOLD — الاكتمال دون ٩٠٪", dl_opt:"التحسين", dl_fc:"التنبؤ", dl_track:"التتبّع", dl_session:"الجلسة", dl_balance:"إدخال الرصيد", qPass:"ناجح", qPartial:"جزئي", qFail:"فاشل",
  kpi_coverage:"تغطية العقود", kpi_mbudget:"استخدام ميزانية الشهر", kpi_projAnnual:"الإنفاق السنوي المتوقع", kpi_target:"تحقيق هدف العقود", of_monthly:"من المتوسط الشهري", of_ceiling:"من السقف",
  area_data_readiness:"جاهزية البيانات", area_budget_forecast:"توقعات الميزانية", area_allocation:"التخصيص", area_reallocation:"إعادة التوازن", area_fairness:"العدالة", area_beneficiary:"المستفيد", area_what_if:"ماذا-لو", area_impact_attribution:"إسناد الأثر", area_decisions:"القرارات", area_formula:"الصيغة", area_data:"البيانات", area_forecast:"التنبؤ",
  raci_data_import:"استيراد البيانات وجاهزيتها", raci_subsidy_formula:"معادلة الدعم", raci_data_quality:"جودة البيانات وخط الأنابيب", raci_allocation_algo:"خوارزمية التخصيص", raci_whatif_engine:"محرك ماذا-لو", raci_beneficiary_tracking:"تتبع المستفيدين", raci_forecasting:"التنبؤ والعدالة", raci_decision_routing:"توجيه القرارات والاعتماد", raci_qc:"مراقبة الجودة والتصعيد", raci_audit_trail:"سجل التدقيق", raci_post_decision:"عمليات ما بعد القرار", raci_mortgage:"تخطيط الرهن العقاري", raci_benchmarking:"المقارنة المعيارية", raci_agent_handoff:"تسليم الوكيل", raci_impact:"إسناد الأثر" });
Object.assign(I18N.en,{ dash360:"Beneficiary 360° Dashboard", dash360_sub:"Individual review — Profile, Support History, Events, Outlook, Outcome Status (SLA <3s)", dash360_ph:"Search by beneficiary ID…", dash360_tier:"Tier", dash360_profile:"Profile", dash360_hbrTrend:"HBR trend (24-month)", dash360_support:"Support History", dash360_type:"Type", dash360_formulaVer:"Formula version", dash360_events:"Events", dash360_outlook:"Outlook & Scorecard", dash360_upgradeProb:"Upgrade probability (6m)", dash360_expectRating:"Expected outcome rating", dash360_outcome:"Outcome (12-month)", dash360_inProgress:"In progress (<12 months)",
  or_sub:"View active orchestration paths with execution status and intermediate-failure handling", or_rules:"Conflicts explicitly raised · Every execution logged · Partial results on failure", or_P1:"Comprehensive Report", or_P2:"What-if Simulation", or_P3:"Monthly Review", or_P4:"Decision Package", or_serial:"Serial", or_parallel:"Parallel", or_idle:"Idle", or_running:"Running", or_success:"Success", or_partial:"Partial", or_execDetail:"Execution detail (module-level)", or_partialWarn:"Forecast module failed — last successful module output saved to Audit Trail; restart scheduled in 15min. Partial result delivered.", or_p1:"Parallel: Allocation + Fairness → Decisions assembly. SLA <60s.", or_p2:"Serial: Formula → Allocation → Fairness. If Allocation fails, halt and log. SLA <60s.", or_p3:"Serial: Data → Allocation → Forecast → Fairness. If Forecast fails, partial result + restart.", or_p4:"Parallel: Allocation + Reallocation → Decisions bundling. SLA <60s.", agent_orch:"Multi-agent orchestration coordinator",
  cmp_uc:"Module", cmp_status:"Status", cmp_time:"Execution time", cmp_type:"Type", results:"Results" });
Object.assign(I18N.zh,{ dash360:"受益方 360° 全景视图", dash360_sub:"受益方维度洞察——画像、支援历史、事件、前景、成效状态 (SLA<3s)", dash360_ph:"按受益方 ID 搜索…", dash360_tier:"收入档", dash360_profile:"画像", dash360_hbrTrend:"HBR 趋势 (24 个月)", dash360_support:"支援历史", dash360_type:"类型", dash360_formulaVer:"公式版本", dash360_events:"事件", dash360_outlook:"前景与计分卡", dash360_upgradeProb:"6 个月内升档概率", dash360_expectRating:"预期成效评级", dash360_outcome:"12 个月成效结果", dash360_inProgress:"未满 12 个月（进行中）",
  or_sub:"查看活跃编排路径的执行状态和中间失败处理", or_rules:"冲突主动上报 · 每次执行记入审计 · 部分失败返回中间结果", or_P1:"综合报告", or_P2:"What-if 推演", or_P3:"月度审查", or_P4:"决策包", or_serial:"串行", or_parallel:"并行", or_idle:"空闲", or_running:"运行中", or_success:"成功", or_partial:"部分成功", or_execDetail:"执行详细（模块级别）", or_partialWarn:"预测模块失败 —— 最近一次成功模块输出已保存至审计轨迹并安排 15 分钟后重启。已交付部分结果。", or_p1:"并行: 配分 + 公平 → 决策组装。SLA<60s。", or_p2:"串行: 公式 → 配分 → 公平。配分失败则停止并记录。SLA<60s。", or_p3:"串行: 数据 → 配分 → 预测 → 公平。预测失败则交付部分结果并重启。", or_p4:"并行: 配分 + 再平衡 → 决策组合。SLA<60s。", agent_orch:"多 Agent 编排协调器",
  cmp_uc:"模块", cmp_status:"状态", cmp_time:"执行时间", cmp_type:"类型", results:"结果" });
Object.assign(I18N.ar,{ dash360:"لوحة المستفيد 360°", dash360_sub:"مراجعة فردية — الملف الشخصي، تاريخ الدعم، الأحداث، التوقعات، حالة النتيجة (SLA <3s)", dash360_ph:"بحث برقم المستفيد…", dash360_tier:"الشريحة", dash360_profile:"الملف الشخصي", dash360_hbrTrend:"اتجاه HBR (24 شهراً)", dash360_support:"تاريخ الدعم", dash360_type:"النوع", dash360_formulaVer:"إصدار المعادلة", dash360_events:"الأحداث", dash360_outlook:"التوقعات وبطاقة الأداء", dash360_upgradeProb:"احتمال الانتقال لشريحة أعلى (6 أشهر)", dash360_expectRating:"تصنيف النتيجة المتوقعة", dash360_outcome:"النتيجة (12 شهراً)", dash360_inProgress:"قيد التنفيذ (<12 شهراً)",
  or_sub:"عرض مسارات التنسيق النشطة مع حالة التنفيذ ومعالجة الفشل الوسيط", or_rules:"التعارضات تُرفع صراحةً · كل تنفيذ يُسجل · نتائج جزئية عند الفشل", or_P1:"تقرير شامل", or_P2:"محاكاة ما-لو", or_P3:"مراجعة شهرية", or_P4:"حزمة قرار", or_serial:"تسلسلي", or_parallel:"متوازي", or_idle:"خامل", or_running:"قيد التشغيل", or_success:"نجاح", or_partial:"جزئي", or_execDetail:"تفاصيل التنفيذ (مستوى الوحدة)", or_partialWarn:"فشلت وحدة التنبؤ — تم حفظ آخر مخرجات وحدة ناجحة في سجل التدقيق؛ وجدولة إعادة التشغيل بعد 15 دقيقة. تم تسليم نتيجة جزئية.", or_p1:"متوازي: التخصيص + العدالة → تجميع القرارات. SLA<60s.", or_p2:"تسلسلي: الصيغة → التخصيص → العدالة. إذا فشل التخصيص يتوقف ويُسجل. SLA<60s.", or_p3:"تسلسلي: البيانات → التخصيص → التنبؤ → العدالة. إذا فشل التنبؤ، نتيجة جزئية + إعادة تشغيل.", or_p4:"متوازي: التخصيص + إعادة التوازن → دمج القرارات. SLA<60s.", agent_orch:"منسّق التنسيق متعدد الوكلاء",
  cmp_uc:"الوحدة", cmp_status:"الحالة", cmp_time:"وقت التنفيذ", cmp_type:"النوع", results:"النتائج" });

function App(){
  const [user,setUserState]=useState(null);
  const [lang,setLang]=useState(()=>{ try{ const q=new URLSearchParams(window.location.search).get("ln"); if(q==="zh"||q==="ar"||q==="en") return q; }catch(e){} return "en"; });
  const [currency,setCurrency]=useState("symbol");
  const [route,setRoute]=useState("home");
  const [packages,setPackages]=useState(seedPackages);
  const [audit,setAudit]=useState(seedAudit);
  const [allocation,setAllocation]=useState({lastSync:"2026-06-01 06:00", recalcAt:null, status:"draft", rejectNote:"", at:null});
  const [leaks,setLeaks]=useState(seedLeaks);
  const [budget,setBudget]=useState({cash:1580, inkind:220, ceiling:4200, enteredBy:"owner", enteredAt:"2026-05-28 10:00", daysSince:18});
  const [formulaParams,setFormulaParams]=useState({ded:40,dur:20,ceil:500000,rate:4});
  const [formulaVersion,setFormulaVersion]=useState({validated:false,canActivate:false,approvedPkgId:null,approvedVersionId:null,active:"v1.0",lastValidated:null});
  // Multi-dimensional formula matrix (region + housingType + incomeBand)
  const [formulaMatrix,setFormulaMatrix]=useState({
    region:"all", housingType:"all", incomeBand:"all",
    regions:{ riyadh:{ded:40,dur:20,ceil:500000,rate:4}, makkah:{ded:38,dur:20,ceil:450000,rate:4}, eastern:{ded:40,dur:20,ceil:480000,rate:4}, asir:{ded:36,dur:20,ceil:380000,rate:3.5}, madinah:{ded:38,dur:20,ceil:420000,rate:4}, qassim:{ded:36,dur:20,ceil:400000,rate:3.5}, tabuk:{ded:35,dur:20,ceil:380000,rate:3.5}, hail:{ded:34,dur:20,ceil:360000,rate:3.5}, jazan:{ded:34,dur:20,ceil:360000,rate:3}, najran:{ded:33,dur:20,ceil:350000,rate:3}, bahah:{ded:33,dur:20,ceil:350000,rate:3}, jawf:{ded:33,dur:20,ceil:350000,rate:3}, northern:{ded:34,dur:20,ceil:360000,rate:3.5} },
    housingTypes:{ offplan:{ded:42,dur:20,ceil:550000,rate:3.5}, ready:{ded:40,dur:20,ceil:500000,rate:4}, selfbuild:{ded:35,dur:25,ceil:400000,rate:3} },
    incomeBands:{ lt5:{ded:45,dur:25,ceil:350000,rate:3}, "5to8":{ded:42,dur:20,ceil:450000,rate:3.5}, "8to10":{ded:40,dur:20,ceil:500000,rate:4}, "10to13":{ded:38,dur:20,ceil:550000,rate:4.5}, "13to16":{ded:36,dur:20,ceil:600000,rate:5}, gt16:{ded:34,dur:20,ceil:650000,rate:5.5} },
  });
  // Formula versions history (multi-version array)
function seedFormulaVersions(fm){
  return [
    { id:"FML-v1.0", label:"Baseline v1.0", status:"active",
      params:{ded:40,dur:20,ceil:500000,rate:4}, matrix:fm,
      activatedAt:"2026-05-01 09:00", createdBy:"system", approvedBy:null, approvedPkgId:null,
      description:"Initial formula from approved matrix", changelog:"Baseline release",
      snapshot:{fg:0.72,hbr:0.405,spend:1.89e9} },
    { id:"FML-v1.1", label:"Adjustment v1.1", status:"superseded",
      params:{ded:43,dur:20,ceil:500000,rate:4}, matrix:fm,
      activatedAt:"2026-06-01 10:00", createdBy:"analyst", approvedBy:"owner", approvedPkgId:"WO-2026-0401",
      description:"Deduction rate 40%→43% to improve FG", changelog:"Increased deduction rate",
      snapshot:{fg:0.95,hbr:0.390,spend:1.82e9} },
  ];
}
  const [formulaVersions,setFormulaVersions]=useState(seedFormulaVersions(formulaMatrix));
  const [whatifContext,setWhatifContext]=useState(null);
  const [settingsVals,setSettingsVals]=useState(initSettingsVals());
  const [configChanges,setConfigChanges]=useState(seedConfigChanges);
  // Dynamic baseline: reacts to formula activation. Check formulaVersions for active version.
  const baseline = useMemo(() => {
    const activeVer = formulaVersions.find(v=>v.status==="active");
    if (activeVer && activeVer.id !== "FML-v1.0") {
      return computeAllocation({}, activeVer.params);
    }
    return computeAllocation({});
  }, [formulaVersions]);
  const t=(k)=>{ const d=I18N[lang]; if(d && d[k]!==undefined) return d[k]; const e=I18N.en; return (e && e[k]!==undefined) ? e[k] : k; };

  useEffect(()=>{ const html=document.documentElement; html.lang=lang; html.dir=lang==="ar"?"rtl":"ltr"; },[lang]);

  function setUser(r){ setUserState(r); setRoute(r==="minister"?"cockpit":"home"); }
  function pushAudit(ev){ setAudit(prev=>[{...ev,ts:nowStr(lang)},...prev]); }
  function addPackage(data){
    const ts=nowStr(lang);
    const id="WO-2026-0"+(400+packages.length);
    const pkg={ id, status:"submitted", sla:48,
      history:[{role:"analyst",action:"act_submit",ts,note:""}], ...data };
    setPackages(prev=>[pkg,...prev]);
    pushAudit({role:"analyst",action:"act_submit",target:id,status:"submitted",cat:data.containsFormulaChange?"formula":"pkg"});
  }
  function actOnPackage(id,kind,note){
    const map={ approve:["approved","act_approve","owner"], escalate:["escalated","act_escalate","owner"],
      reject:["rejected","act_reject",user], adjudicate:["adjudicated","act_adjudicate","minister"] };
    const [status,action,role]=map[kind]; const ts=nowStr(lang);
    const actedPkg = packages.find(p=>p.id===id);
    const auditCat = actedPkg?.containsFormulaChange ? "formula" : "pkg";
    setPackages(prev=>{
      const pkg=prev.find(p=>p.id===id);
      if(pkg&&pkg.containsFormulaChange&&(kind==="approve"||kind==="adjudicate")){
        const approvedVersionId = pkg.formulaSnapshot?.versionId || null;
        setFormulaVersion(fv=>({...fv, canActivate:true, approvedPkgId:id, approvedVersionId }));
        // Update version status from "draft" to "validated"
        if(approvedVersionId){
          setFormulaVersions(prev=>prev.map(v=>v.id===approvedVersionId?{...v,status:"validated"}:v));
        }
        // Rollback: auto-activate the version directly
        if(pkg.type==="rollback" && approvedVersionId){
          const ver=formulaVersions.find(v=>v.id===approvedVersionId);
          if(ver){
            const ats=nowStr(lang);
            setFormulaVersions(prev=>prev.map(v=>{
              if(v.id===approvedVersionId) return {...v,status:"active",activatedAt:ats,params:{...v.params}};
              if(v.status==="active") return {...v,status:"superseded",snapshot:{...v.snapshot}};
              return v;
            }));
            setFormulaParams(ver.params);
            setFormulaVersion(fv=>({...fv, active:approvedVersionId, canActivate:false, approvedVersionId:null, lastValidated:ats }));
            pushAudit({role:"owner",action:"act_version",target:approvedVersionId,status:"activated",note:"Rollback activated: "+ver.description,cat:"formula"});
          }
        }
      }
      return prev.map(p=>p.id===id?{...p,status,history:[...p.history,{role,action,ts,note:note||""}]}:p);
    });
    pushAudit({role,action,target:id,status,note:note||"",cat:auditCat});
  }
  function recalcAlloc(){ setAllocation(a=>({...a, recalcAt:nowStr(lang), status:"draft", rejectNote:"", at:null})); }
  function submitAlloc(){ setAllocation(a=>({...a, status:"submitted", at:nowStr(lang), rejectNote:""})); }
  function actAlloc(kind,note){ setAllocation(a=>({...a, status:kind==="approve"?"approved":"rejected", rejectNote:kind==="reject"?(note||""):"", at:nowStr(lang)})); }
  function leakAct(id,kind,note){
    const map={ report:["submitted","analyst"], adopt:["adopted","owner"], escalate:["escalated","owner"], adjudicate:["adjudicated","minister"], reject:["rejected",user] };
    const [status,role]=map[kind]; const ts=nowStr(lang);
    setLeaks(prev=>prev.map(l=>l.id===id?{...l,status,history:[...l.history,{role,kind,ts,note:note||""}]}:l));
  }
  function saveBudget(vals){ setBudget(b=>({...b,...vals, enteredBy:user, enteredAt:nowStr(lang), daysSince:0})); }
  function reset(){ setPackages(seedPackages()); setAudit(seedAudit()); setAllocation({lastSync:"2026-06-01 06:00", recalcAt:null, status:"draft", rejectNote:"", at:null}); setLeaks(seedLeaks()); setConfigChanges(seedConfigChanges()); setSettingsVals(initSettingsVals()); setFormulaParams({ded:40,dur:20,ceil:500000,rate:4}); setFormulaVersion({validated:false,canActivate:false,approvedPkgId:null,approvedVersionId:null,active:"v1.0",lastValidated:null}); setFormulaVersions([...seedFormulaVersions()]); setBudget({cash:1580, inkind:220, ceiling:4200, enteredBy:"owner", enteredAt:"2026-05-28 10:00", daysSince:18}); setRoute(user==="minister"?"cockpit":"home"); }

  function addConfigChange(data){
    const ts=nowStr(lang);
    const id="CC-"+(String(configChanges.length+1).padStart(3,"0"));
    const cc={ id, status:"draft", history:[], createdAt:ts, submittedBy:"analyst", approvedBy:null, ...data };
    setConfigChanges(prev=>[cc,...prev]);
  }
  function submitConfigChange(id){
    setConfigChanges(prev=>prev.map(cc=>cc.id===id?{...cc,status:"pending",history:[...cc.history,{role:"analyst",action:"act_submit",ts:nowStr(lang),note:""}]}:cc));
    pushAudit({role:"analyst",action:"act_submit",target:id,status:"submitted",cat:"config"});
  }
  function actOnConfigChange(id,kind,note){
    const map={ approve:["scheduled","act_approve","owner"], reject:["rejected","act_reject",user], escalate:["pending","act_escalate","owner"] };
    if(kind==="approve"){
      const cc=configChanges.find(c=>c.id===id);
      if(cc && !cc.effectiveFrom){
        // Immediate effective if no scheduled date — also update settingsVals
        setConfigChanges(prev=>prev.map(c=>c.id===id?{...c,status:"effective",approvedBy:user,history:[...c.history,{role:"owner",action:"act_approve",ts:nowStr(lang),note:note||""}]}:c));
        if(cc.paramKey) setSettingsVals(prev=>({...prev,[cc.paramKey]:cc.newValue}));
        pushAudit({role:"owner",action:"act_approve",target:id,status:"effective",note:note||"",cat:"config"});
        return;
      }
    }
    const [status,action,role]=map[kind];
    setConfigChanges(prev=>prev.map(c=>c.id===id?{...c,status,approvedBy:kind==="approve"?user:c.approvedBy,history:[...c.history,{role,action,ts:nowStr(lang),note:note||""}]}:c));
    // If approved with a scheduled date, don't update yet; if rejected, keep old value
    if(kind==="approve"){
      const cc=configChanges.find(c=>c.id===id);
      if(cc && cc.paramKey) setSettingsVals(prev=>({...prev,[cc.paramKey]:cc.newValue}));
    }
    pushAudit({role,action,target:id,status,note:note||"",cat:"config"});
  }
  function setSettingVal(key,val){
    setSettingsVals(prev=>({...prev,[key]:val}));
  }
  // Formula version management
  function createFormulaVersion(label, description, params, matrixSnapshot){
    const ts=nowStr(lang);
    const id="FML-v"+(formulaVersions.length+1).toFixed(1);
    const sv=scenarioSavings(computeAllocation({}, params||formulaParams));
    const scn=computeAllocation({}, params||formulaParams);
    const ver={ id, label, status:"draft", params:params||{...formulaParams},
      matrix:matrixSnapshot||{...formulaMatrix},
      activatedAt:null, createdBy:user, approvedBy:null, approvedPkgId:null,
      description, changelog:description, createdAt:ts,
      snapshot:{fg:scn.FG, hbr:scn.HBR, spend:scn.spend/1e9} };
    setFormulaVersions(prev=>[ver,...prev]);
    pushAudit({role:user,action:"act_version",target:id,status:"created",note:"Created: "+description,cat:"formula"});
    return id;
  }
  function activateFormulaVersion(id){
    const ver=formulaVersions.find(v=>v.id===id);
    if(!ver) return;
    const ts=nowStr(lang);
    // Deactivate current active + activate target in a single pass
    setFormulaVersions(prev=>prev.map(v=>{
      if(v.id===id) return {...v,status:"active",activatedAt:ts,params:{...v.params}};
      if(v.status==="active") return {...v,status:"superseded",snapshot:{...v.snapshot}};
      return v;
    }));
    // Sync to engine
    setFormulaParams(ver.params);
    setFormulaVersion(fv=>({...fv, active:id, validated:true, canActivate:false, approvedVersionId:null, lastValidated:ts }));
    pushAudit({role:user,action:"act_version",target:id,status:"activated",note:"Activated: "+ver.description,cat:"formula"});
  }
  function rollbackToVersion(id){
    const ver=formulaVersions.find(v=>v.id===id);
    if(!ver) return;
    activateFormulaVersion(id);
  }

  const store={ t,lang,setLang,currency,setCurrency,user,setUser,route,setRoute,packages,audit,addPackage,actOnPackage,reset,allocation,recalcAlloc,submitAlloc,actAlloc,leaks,leakAct,budget,saveBudget,formulaParams,setFormulaParams,formulaVersion,setFormulaVersion,baseline,pushAudit,configChanges,addConfigChange,submitConfigChange,actOnConfigChange,settingsVals,setSettingVal,whatifContext,setWhatifContext,formulaMatrix,setFormulaMatrix,formulaVersions,setFormulaVersions,createFormulaVersion,activateFormulaVersion,rollbackToVersion };

  if(!user) return (<Ctx.Provider value={store}><Login/></Ctx.Provider>);

  let page=null;
  if(user==="analyst"){
    page = route==="data"?<DataReadiness/> : route==="formula"?<FormulaPage/> : route==="alloc"?<Allocation/> : route==="mortgage"?<MortgagePlanning/> : route==="forecast"?<ForecastFairness/>
      : route==="fairness"?<FairnessLeakage/> : route==="referrals"?<BeneficiaryTracking/> : route==="impact"?<ImpactAttribution/> : route==="whatif"?<WhatIf/> : route==="packages"?<DecisionPackages/>
      : route==="inventory"?<InventoryAbsorption/> : route==="benchmark"?<Benchmarking/> : route==="audit"?<AuditTrailPage/>
      : route==="copilot"?<CopilotHandoff/> : route==="dash360"?<Beneficiary360Page/> : route==="orchestration"?<OrchestrationPage/> : route==="permissions"?<PermissionsPage/> : route==="settings"?<SettingsPage/> : <AnalystHome/>;
  } else if(user==="owner"){
    page = route==="data"?<DataReadiness/> : route==="alloc"?<Allocation/> : route==="approvals"?<DecisionPackages filter={p=>p.status!=="draft"} showConfig="owner"/> : route==="referrals"?<BeneficiaryTracking/> : route==="fairness"?<FairnessLeakage/> : route==="forecast"?<ForecastFairness/>
      : route==="inventory"?<InventoryAbsorption/> : route==="impact"?<ImpactAttribution/> : route==="benchmark"?<Benchmarking/> : route==="audit"?<AuditTrailPage/>
      : route==="dash360"?<Beneficiary360Page/> : route==="orchestration"?<OrchestrationPage/> : route==="permissions"?<PermissionsPage/> : route==="settings"?<SettingsPage/> : <OwnerHome/>;
  } else {
    page = route==="decisions"?<DecisionPackages filter={p=>["escalated","adjudicated","rejected"].includes(p.status)} showConfig="minister"/>
      : route==="forecast"?<ForecastFairness/> : route==="fairness"?<FairnessLeakage/> : route==="impact"?<ImpactAttribution/> : route==="benchmark"?<Benchmarking/> : route==="audit"?<AuditTrailPage/>
      : route==="dash360"?<Beneficiary360Page/> : route==="orchestration"?<OrchestrationPage/> : route==="permissions"?<PermissionsPage/> : route==="settings"?<SettingsPage/> : <MinisterHome/>;
  }
  return (<Ctx.Provider value={store}>
    <TopBar/>
    <div className="shell"><Sidebar/><div className="content">{page}</div></div>
  </Ctx.Provider>);
}

export default App;




