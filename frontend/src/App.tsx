import ImportPage from "./pages/Import";
import Landing from "./pages/Landing";
import { Forecast, Plan, Schedule } from "./pages/PlanPages";
import Setup from "./pages/Setup";
import { BankCall, UpdateBalances, WhatIf, YourData } from "./pages/ToolPages";
import { useStore } from "./store";
import { Empty, Problem, TopNav, useRoute } from "./ui";

const NEEDS_PLAN: Record<string, () => JSX.Element> = {
  plan: Plan,
  schedule: Schedule,
  forecast: Forecast,
  "what-if": WhatIf,
  bank: BankCall,
  update: UpdateBalances,
};

export default function App() {
  const route = useRoute();
  const { inputs, plan, pending, failed, retry } = useStore();
  const [section, param] = route.split("/");

  let page: JSX.Element;
  let banner: JSX.Element | null = null;
  if (section === "setup") {
    const step = Math.min(4, Math.max(1, Number(param) || 1));
    page = <Setup step={step} />;
  } else if (section === "data") {
    page = <YourData />;
  } else if (section === "import") {
    page = <ImportPage />;
  } else if (section in NEEDS_PLAN) {
    const Page = NEEDS_PLAN[section];
    if (!inputs) page = <Empty />;
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
      // key: tool pages keep local drafts, so remount them when the plan's inputs change
      page = (
        <div className={pending || failed ? "stale" : undefined} aria-busy={pending}>
          <Page key={JSON.stringify(inputs)} />
        </div>
      );
    }
  } else {
    page = <Landing />;
  }

  return (
    <>
      <TopNav route={section} />
      {banner}
      {page}
    </>
  );
}
