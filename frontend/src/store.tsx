import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { calculatePlan, type Card, type Inputs, type Plan } from "./api";

const KEY = "finpilot.inputs";
const PROGRESS_KEY = "finpilot.progress";

/** What the person has done so far. `peak` is the largest total debt seen, so paying down shows as progress. */
export interface Progress {
  peak: number;
  paid: number;
  missions: string[];
}
const NO_PROGRESS: Progress = { peak: 0, paid: 0, missions: [] };

export const DEMO: Inputs = {
  goal: "less_interest",
  budget: 500,
  strategy: "avalanche",
  cards: [
    { id: "card-a", treatment: "revolving", name: "Card A", balance: 1500, minimum: 40, apr: 29, due_day: 22, limit: 3000 },
    { id: "card-b", treatment: "revolving", name: "Card B", balance: 2500, minimum: 60, apr: 24, due_day: 28, limit: 5000 },
    { id: "card-c", treatment: "revolving", name: "Card C", balance: 600, minimum: 30, apr: 19, due_day: 5, limit: null },
  ],
};

export const newCard = (index: number): Card => ({
  id: `card-${Math.random().toString(36).slice(2, 8)}`,
  name: `Card ${"ABC"[index] ?? index + 1}`,
  balance: 0,
  minimum: 0,
  apr: null,
  due_day: null,
  limit: null,
  treatment: null,
});

interface Store {
  inputs: Inputs | null;
  /** the plan calculated from `inputs`; while `pending`, it is still the previous one */
  plan: Plan | null;
  /** a calculation for the current inputs is in flight */
  pending: boolean;
  /** the last calculation failed */
  failed: boolean;
  isDemo: boolean;
  saveOnDevice: boolean;
  /** cards read by an import, waiting to be checked in setup; not part of the plan yet */
  prefill: Card[] | null;
  setPrefill: (cards: Card[] | null) => void;
  progress: Progress;
  /** a payment was marked as paid on the Balances page */
  markPaid: () => void;
  toggleMission: (id: string) => void;
  setInputs: (next: Inputs) => void;
  retry: () => void;
  loadDemo: () => void;
  setSaveOnDevice: (on: boolean) => void;
  deleteAll: () => void;
}

const Ctx = createContext<Store | null>(null);

function readSaved(): Inputs | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Inputs) : null;
  } catch {
    return null;
  }
}

function readProgress(): Progress {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? { ...NO_PROGRESS, ...(JSON.parse(raw) as Progress) } : NO_PROGRESS;
  } catch {
    return NO_PROGRESS;
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const saved = useMemo(readSaved, []);
  const [inputs, setInputsState] = useState<Inputs | null>(saved);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pending, setPending] = useState(saved !== null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [isDemo, setIsDemo] = useState(false);
  const [saveOnDevice, setSave] = useState(saved !== null);
  const [prefill, setPrefill] = useState<Card[] | null>(null);
  const [progress, setProgress] = useState<Progress>(() => (saved ? readProgress() : NO_PROGRESS));

  // the highest debt seen is the starting line for "paid off so far"
  useEffect(() => {
    if (plan && !isDemo && plan.total_debt > progress.peak) setProgress((now) => ({ ...now, peak: plan.total_debt }));
  }, [plan, isDemo, progress.peak]);
  useEffect(() => {
    try {
      if (saveOnDevice && !isDemo) localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
      else localStorage.removeItem(PROGRESS_KEY);
    } catch {
      /* storage unavailable */
    }
  }, [saveOnDevice, progress, isDemo]);

  // Every screen reads this one plan, so a change to the inputs updates all of them together.
  useEffect(() => {
    if (!inputs) {
      setPlan(null);
      setPending(false);
      setFailed(false);
      return;
    }
    let stale = false;
    setPending(true);
    setFailed(false);
    const timer = setTimeout(() => {
      calculatePlan(inputs)
        .then((p) => {
          if (stale) return;
          setPlan(p);
          setPending(false);
        })
        .catch(() => {
          if (stale) return;
          setFailed(true);
          setPending(false);
        });
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [inputs, attempt]);

  // Saving is opt-in. Nothing is written unless the person turned it on.
  useEffect(() => {
    try {
      if (saveOnDevice && inputs && !isDemo) localStorage.setItem(KEY, JSON.stringify(inputs));
      else localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable: the app still works for this visit */
    }
  }, [saveOnDevice, inputs, isDemo]);

  const store: Store = {
    inputs,
    plan,
    pending,
    failed,
    isDemo,
    saveOnDevice,
    prefill,
    setPrefill,
    progress,
    markPaid: () => setProgress((now) => ({ ...now, paid: now.paid + 1 })),
    toggleMission: (id) => setProgress((now) => ({ ...now, missions: now.missions.includes(id) ? now.missions.filter((x) => x !== id) : [...now.missions, id] })),
    // entering your own numbers ends demo mode
    setInputs: (next) => {
      setIsDemo(false);
      setInputsState(next);
    },
    retry: () => setAttempt((n) => n + 1),
    loadDemo: () => {
      setIsDemo(true);
      setInputsState(DEMO);
    },
    setSaveOnDevice: setSave,
    deleteAll: () => {
      setIsDemo(false);
      setSave(false);
      setInputsState(null);
      setProgress(NO_PROGRESS);
    },
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used inside StoreProvider");
  return s;
}
