import { useEffect } from "react";
import { AccountOffer, AccountPage, Assistant, PlansPage, Tutorial } from "./pages/Extras";
import ImportPage from "./pages/Import";
import Landing from "./pages/Landing";
import { Plan, Schedule } from "./pages/PlanPages";
import Setup from "./pages/Setup";
import { BankCall, UpdateBalances, WhatIf, YourData } from "./pages/ToolPages";
import { useStore } from "./store";
import { go, Problem, TopNav, useRoute } from "./ui";

const NEEDS_PLAN: Record<string, () => JSX.Element> = {
  plan: Plan,
  schedule: Schedule,
  // the old Compare page now lives in the plan's "Which order costs less" block
  forecast: Plan,
  "what-if": WhatIf,
  bank: BankCall,
  update: UpdateBalances,
};

const HAS_DRAFTS = new Set(["what-if", "bank", "update"]);

export default function App() {
  const route = useRoute();
  const { inputs, plan, pending, failed, retry, notice, setNotice, restoring } = useStore();
  const [section, param] = route.split("/");
  const lost = section in NEEDS_PLAN && !inputs && !restoring;
  useEffect(() => {
    if (lost) go("");
  }, [lost]);

  let page: JSX.Element;
  let banner: JSX.Element | null = null;
  if (section === "setup") {
    const step = Math.min(4, Math.max(1, Number(param) || 1));
    page = <Setup step={step} />;
  } else if (section === "data") {
    page = <YourData />;
  } else if (section === "import") {
    page = <ImportPage />;
  } else if (section === "account") {
    page = <AccountPage />;
  } else if (section === "plus") {
    page = <PlansPage />;
  } else if (section in NEEDS_PLAN) {
    const Page = NEEDS_PLAN[section];
    // A page that needs a plan, opened without one: the person is sent to the home page instead of an empty screen.
    if (!inputs) page = restoring ? <main className="page muted">Opening your plan…</main> : <Landing />;
    else if (!plan && failed) page = <Problem onRetry={retry} />;
    else if (!plan) page = <main className="page muted">Calculating your plan…</main>;
    else {
      // The numbers on screen belong to the previous inputs until the new calculation lands,
      // so they are dimmed and labelled instead of being shown as current.
      if (pending) banner = <p className="banner info">Recalculating…</p>;
      else if (failed)
        banner = (
          <p className="banner" role="alert">
            We couldn’t calculate your plan. The numbers below are from before your last change.{" "}
            <button type="button" className="link" onClick={retry}>
              Try again
            </button>
          </p>
        );
      // key: tool pages keep local drafts, so they are rebuilt when the plan's inputs change. Plan and
      // Schedule hold no drafts: they update in place, so a change never replays the page animation.
      page = (
        <div className={pending || failed ? "stale" : undefined} aria-busy={pending}>
          <Page key={HAS_DRAFTS.has(section) ? JSON.stringify(inputs) : section} />
        </div>
      );
    }
  } else {
    page = <Landing />;
  }

  return (
    <>
      <TopNav route={section} />
      {notice && (
        <p className="banner done" role="status">
          <span>{notice.text}</span>
          {notice.href && <a href={notice.href}>{notice.label ?? "See it"} →</a>}
          <button type="button" className="link" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </p>
      )}
      {banner}
      {page}
      <Assistant />
      <Tutorial route={section} />
      <AccountOffer route={section} />
    </>
  );
}
