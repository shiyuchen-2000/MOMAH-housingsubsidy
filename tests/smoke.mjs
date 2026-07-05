// Mini render smoke test — no real React needed.
// Transpiles src/App.jsx (JSX→createElement), then walks each page component's render tree
// with a mocked store/context to catch runtime errors (undefined access, bad refs).
// Run:  NODE_PATH=/usr/local/lib/node_modules_global/lib/node_modules node tests/smoke.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let src = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
src = src
  .replace('import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";', "")
  .replace('import * as RC from "recharts";', "")
  .replace(/\nexport default App;\s*$/, "\n");
const js = ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.ESNext } }).outputText;

/* ---- mini React ---- */
let count = 0;
const Fragment = Symbol("Fragment");
function createElement(type, props, ...kids) { return { type, props: { ...(props || {}), children: kids } }; }
const noop = () => {};
function render(el) {
  if (el == null || el === false || typeof el === "string" || typeof el === "number") return;
  if (Array.isArray(el)) { el.forEach(render); return; }
  const { type, props } = el;
  if (type == null) { render(props && props.children); return; }
  if (type._isProvider) { const prev = type._ctx._v; type._ctx._v = props.value; render(props.children); type._ctx._v = prev; return; }
  if (type === Fragment) { render(props.children); return; }
  if (typeof type === "function") { count++; const out = type(props || {}); render(out); return; }
  render(props && props.children); // host element
}
function createContext(def) { const ctx = { _v: def }; ctx.Provider = { _isProvider: true, _ctx: ctx }; return ctx; }
const useState = (i) => [typeof i === "function" ? i() : i, noop];
const useMemo = (fn) => fn();
const useEffect = noop;
const useRef = (i) => ({ current: i ?? null });
let CTXVAL = null;             // current store (set per render below)
const useContext = (ctx) => (ctx && "_v" in ctx ? ctx._v : null);
const React = { createElement, Fragment };
const RC = new Proxy({}, { get: () => (() => null) });
const win = { location: { search: "" }, matchMedia: () => ({ matches: false, addEventListener: noop }), devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop, open: noop, innerWidth: 1280 };
const doc = { documentElement: {}, getElementById: () => ({ textContent: "", getContext: () => null, clientWidth: 600 }), addEventListener: noop, createElement: () => ({ getContext: () => null }), body: {} };

/* ---- evaluate the module, then render each page ---- */
const harness = `
  const seedAll = { packages: typeof seedPackages==='function'?seedPackages():[], audit: typeof seedAudit==='function'?seedAudit():[], leaks: typeof seedLeaks==='function'?seedLeaks():[] };
  function makeStore(lang, user){
    const t=(k)=>{ const d=I18N[lang]; if(d&&d[k]!==undefined) return d[k]; const e=I18N.en; return (e&&e[k]!==undefined)?e[k]:k; };
    return { t, lang, setLang:()=>{}, currency:"symbol", setCurrency:()=>{}, user, setUser:()=>{}, route:"home", setRoute:()=>{},
      packages:seedAll.packages, audit:seedAll.audit, addPackage:()=>{}, actOnPackage:()=>{}, reset:()=>{},
      allocation:{lastSync:"2026-06-01 06:00",recalcAt:null,status:"draft",rejectNote:"",at:null},
      recalcAlloc:()=>{}, submitAlloc:()=>{}, actAlloc:()=>{},
      leaks:seedAll.leaks, leakAct:()=>{},
      budget:{cash:1580,inkind:220,ceiling:4200,enteredBy:"owner",enteredAt:"2026-05-28 10:00",daysSince:18}, saveBudget:()=>{} };
  }
  const PAGES=[["Login","analyst",Login],["AnalystHome","analyst",AnalystHome],["OwnerHome","owner",OwnerHome],["MinisterHome","minister",MinisterHome],
    ["DataReadiness","analyst",DataReadiness],["Allocation","analyst",Allocation],["ForecastFairness","analyst",ForecastFairness],
    ["WhatIf","analyst",WhatIf],["DecisionPackages","analyst",DecisionPackages],["AuditTrailPage","analyst",AuditTrailPage],
    ["CopilotHandoff","analyst",CopilotHandoff],["BeneficiaryTracking","analyst",BeneficiaryTracking],["Benchmarking","analyst",Benchmarking],
    ["MortgagePlanning","analyst",MortgagePlanning],["InventoryAbsorption","analyst",InventoryAbsorption],["ImpactAttribution","analyst",ImpactAttribution],
    ["SettingsPage","analyst",SettingsPage],["FormulaPage","analyst",FormulaPage],["AIInsights","analyst",AIInsights],["AgentArchitecture","analyst",AgentArchitecture],
    ["TopBar","analyst",TopBar],["Sidebar","analyst",Sidebar]];
  let ok=0, fail=0;
  for(const lang of ["en","ar"]){
    for(const [name,user,Comp] of PAGES){
      try{ render(createElement(Ctx.Provider,{value:makeStore(lang,user)}, createElement(Comp,null))); ok++; }
      catch(e){ fail++; console.log("✗ "+name+" ["+lang+"]: "+(e&&e.message||e)); }
    }
  }
  REPORT(ok, fail);
`;

const fn = new Function("React", "useState", "useMemo", "useEffect", "useRef", "createContext", "useContext", "RC", "window", "document", "render", "createElement", "REPORT",
  js + "\n" + harness);
fn(React, useState, useMemo, useEffect, useRef, createContext, useContext, RC, win, doc, render, createElement,
  (ok, fail) => { console.log("rendered OK: " + ok + " / " + (ok + fail)); process.exit(fail ? 1 : 0); });
