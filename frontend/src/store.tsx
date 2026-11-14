import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { calculatePlan, type Card, type Inputs, type Plan } from "./api";

const KEY = "finpilot.inputs";

export const DEMO: Inputs = {
  goal: "less_interest",
  budget: 500,
  strategy: "avalanche",
  cards: [
    { id: "card-a", name: "Card A", balance: 1500, minimum: 40, apr: 29, due_day: 22, limit: 3000 },
    { id: "card-b", name: "Card B", balance: 2500, minimum: 60, apr: 24, due_day: 28, limit: 5000 },
    { id: "card-c", name: "Card C", balance: 600, minimum: 30, apr: 19, due_day: 5, limit: null },
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
});

interface Store {
  inputs: Inputs | null;
  plan: Plan | null;
  error: string;
  isDemo: boolean;
  saveOnDevice: boolean;
  setInputs: (next: Inputs) => void;
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

export function StoreProvider({ children }: { children: ReactNode }) {
  const saved = useMemo(readSaved, []);
  const [inputs, setInputsState] = useState<Inputs | null>(saved);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [isDemo, setIsDemo] = useState(false);
  const [saveOnDevice, setSave] = useState(saved !== null);

  // Recalculate on the backend whenever the inputs change.
  useEffect(() => {
    if (!inputs) {
      setPlan(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      calculatePlan(inputs)
        .then((p) => {
          if (!stale) {
            setPlan(p);
            setError("");
          }
        })
        .catch(() => {
          if (!stale) setError("Could not reach the FinPilot API. Start the backend on port 8000, then reload.");
        });
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [inputs]);

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
    error,
    isDemo,
    saveOnDevice,
    setInputs: (next) => setInputsState(next),
    loadDemo: () => {
      setIsDemo(true);
      setInputsState(DEMO);
    },
    setSaveOnDevice: setSave,
    deleteAll: () => {
      setIsDemo(false);
      setSave(false);
      setInputsState(null);
    },
  };
  // Entering your own numbers ends demo mode.
  const setInputs = (next: Inputs) => {
    setIsDemo(false);
    setInputsState(next);
  };
  return <Ctx.Provider value={{ ...store, setInputs }}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used inside StoreProvider");
  return s;
}
