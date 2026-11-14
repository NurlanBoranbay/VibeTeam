import Landing from "./pages/Landing";
import { CreditUse, Forecast, NinetyDays, Plan } from "./pages/PlanPages";
import Setup from "./pages/Setup";
import { BankCall, UpdateBalances, WhatIf, YourData } from "./pages/ToolPages";
import { useStore } from "./store";
import { Empty, TopNav, useRoute } from "./ui";

const NEEDS_PLAN: Record<string, () => JSX.Element> = {
  plan: Plan,
  days: NinetyDays,
  forecast: Forecast,
  "what-if": WhatIf,
  bank: BankCall,
  update: UpdateBalances,
  credit: CreditUse,
};

export default function App() {
  const route = useRoute();
  const { inputs, error } = useStore();
  const [section, param] = route.split("/");

  let page: JSX.Element;
  if (section === "setup") {
    const step = Math.min(4, Math.max(1, Number(param) || 1));
    page = <Setup step={step} />;
  } else if (section === "data") {
    page = <YourData />;
  } else if (section in NEEDS_PLAN) {
    const Page = NEEDS_PLAN[section];
    // key: tool pages keep local drafts, so remount them when the plan's inputs change
    page = inputs ? <Page key={JSON.stringify(inputs)} /> : <Empty />;
  } else {
    page = <Landing />;
  }

  return (
    <>
      <TopNav route={section} />
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {page}
    </>
  );
}
