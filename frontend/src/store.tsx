import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authLogin, authLogout, authRegister, calculatePlan, deleteMe, fetchMe, saveMyPlan, type Card, type Inputs, type Plan } from "./api";

const KEY = "finpilot.inputs";
const PROGRESS_KEY = "finpilot.progress";
const COLORS_KEY = "finpilot.colors";
const TOKEN_KEY = "finpilot.token";
const EMAIL_KEY = "finpilot.email";
const FLAGS_KEY = "finpilot.flags"; // which first-visit steps are done

function readFlags(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FLAGS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The card colour each card id was given, as an index into FACES. Cards not listed get a default colour. */
export type CardColors = Record<string, number>;

/** What the person has done so far. `peak` is the largest total debt seen, so paying down shows as progress. */
export interface Progress {
  peak: number;
  paid: number;
  missions: string[];
  /** calls to the bank the person logged: what they asked for and how it went */
  calls: CallNote[];
}
export interface CallNote {
  card: string;
  goal: string;
  result: "yes" | "no";
  date: string;
}
export interface Notice {
  text: string;
  href?: string;
  label?: string;
}
const NO_PROGRESS: Progress = { peak: 0, paid: 0, missions: [], calls: [] };

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

// A second example where one card is nearly paid off, so the extra money reaches a second card in
// the very first cycle. The figures come out of the same engine as everything else.
export const DEMO_2: Inputs = {
  goal: "less_interest",
  budget: 500,
  strategy: "avalanche",
  cards: [
    { id: "card-a", treatment: "revolving", name: "Card A", balance: 320, minimum: 35, apr: 29, due_day: 22, limit: 3000 },
    { id: "card-b", treatment: "revolving", name: "Card B", balance: 2500, minimum: 60, apr: 24, due_day: 28, limit: 5000 },
    { id: "card-c", treatment: "revolving", name: "Card C", balance: 600, minimum: 30, apr: 19, due_day: 5, limit: null },
  ],
};
const DEMOS = [DEMO, DEMO_2];

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
  /** a new plan from setup: ends demo mode */
  setInputs: (next: Inputs) => void;
  /** a change to the current plan (budget, card, payment, strategy): the demo stays a demo */
  update: (next: Inputs, notice?: Notice) => void;
  /** what the last action changed, shown at the top until dismissed */
  notice: Notice | null;
  setNotice: (n: Notice | null) => void;
  retry: () => void;
  /** open a demo; with no number, the current one is reset */
  loadDemo: (which?: number) => void;
  demoIndex: number;
  logCall: (note: CallNote) => void;
  setSaveOnDevice: (on: boolean) => void;
  deleteAll: () => void;
  /** the signed-in account, if any; the app works the same without one */
  account: { email: string } | null;
  /** resolves to true when a plan is on screen afterwards (saved in the account, or the one just built) */
  signIn: (email: string, password: string, isNew: boolean) => Promise<boolean>;
  signOut: () => void;
  deleteAccount: () => Promise<void>;
  /** first-visit steps, remembered in this browser */
  onboarded: boolean;
  setOnboarded: () => void;
  toured: boolean;
  setToured: () => void;
  offerSeen: boolean;
  /** the assistant side panel is open */
  /** a saved plan is being fetched from the account, so "no plan" is not known yet */
  restoring: boolean;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  setOfferSeen: () => void;
  /** card colours the person picked; kept apart from the inputs so a new colour never recalculates the plan */
  colors: CardColors;
  setColors: (next: CardColors) => void;
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

function readColors(): CardColors {
  try {
    const raw = localStorage.getItem(COLORS_KEY);
    return raw ? (JSON.parse(raw) as CardColors) : {};
  } catch {
    return {};
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
  const [demoIndex, setDemoIndex] = useState(0);
  const [saveOnDevice, setSave] = useState(saved !== null);
  const [prefill, setPrefill] = useState<Card[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [restoring, setRestoring] = useState(() => !!readText(TOKEN_KEY));
  const [progress, setProgress] = useState<Progress>(() => (saved ? readProgress() : NO_PROGRESS));
  const [colors, setColors] = useState<CardColors>(() => (saved ? readColors() : {}));
  const [token, setToken] = useState<string | null>(() => readText(TOKEN_KEY));
  const [account, setAccount] = useState<{ email: string } | null>(() => (readText(TOKEN_KEY) && readText(EMAIL_KEY) ? { email: readText(EMAIL_KEY)! } : null));
  const [flags, setFlags] = useState<Record<string, boolean>>(readFlags);
  const flag = (name: string) => {
    setFlags((now) => {
      const next = { ...now, [name]: true };
      try {
        localStorage.setItem(FLAGS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: the step shows again next visit */
      }
      return next;
    });
  };
  const remember = (t: string | null, email: string | null) => {
    try {
      if (t && email) {
        localStorage.setItem(TOKEN_KEY, t);
        localStorage.setItem(EMAIL_KEY, email);
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(EMAIL_KEY);
      }
    } catch {
      /* storage unavailable: signed in for this visit only */
    }
    setToken(t);
    setAccount(t && email ? { email } : null);
  };
  /** Put a saved plan on screen. */
  const open = (state: { inputs: Inputs | null; progress?: unknown; colors?: unknown }) => {
    if (!state.inputs) return;
    setIsDemo(false);
    setInputsState(state.inputs);
    if (state.progress) setProgress({ ...NO_PROGRESS, ...(state.progress as Progress) });
    if (state.colors) setColors(state.colors as CardColors);
  };

  // Signed in from an earlier visit: open the plan saved in the account.
  useEffect(() => {
    if (!token) return;
    fetchMe(token)
      .then((me) => {
        if (me.plan) open(me.plan);
      })
      .catch(() => remember(null, null)) // the sign-in is no longer valid
      .finally(() => setRestoring(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // With an account, every change is saved to it a moment later. The demo is never saved.
  useEffect(() => {
    if (!token || !inputs || isDemo) return;
    const timer = setTimeout(() => {
      saveMyPlan(token, { inputs, progress, colors }).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [token, inputs, progress, colors, isDemo]);

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

  useEffect(() => {
    try {
      if (saveOnDevice && !isDemo && Object.keys(colors).length) localStorage.setItem(COLORS_KEY, JSON.stringify(colors));
      else localStorage.removeItem(COLORS_KEY);
    } catch {
      /* storage unavailable */
    }
  }, [saveOnDevice, colors, isDemo]);

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
    }, 0);
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
    notice,
    setNotice,
    update: (next, n) => {
      setInputsState(next);
      setNotice(n ?? null);
    },
    setInputs: (next) => {
      setIsDemo(false);
      setInputsState(next);
    },
    retry: () => setAttempt((n) => n + 1),
    demoIndex,
    logCall: (note) => setProgress((now) => ({ ...now, calls: [note, ...now.calls] })),
    loadDemo: (which) => {
      const i = typeof which === "number" ? which % DEMOS.length : demoIndex;
      setDemoIndex(i);
      setIsDemo(true);
      setInputsState(DEMOS[i]);
      setColors({});
      setNotice(null);
    },
    setSaveOnDevice: setSave,
    deleteAll: () => {
      setIsDemo(false);
      setSave(false);
      setInputsState(null);
      setProgress(NO_PROGRESS);
      setColors({});
    },
    colors,
    setColors,
    account,
    signIn: async (email, password, isNew) => {
      const out = await (isNew ? authRegister(email, password) : authLogin(email, password));
      remember(out.token, out.email);
      const me = await fetchMe(out.token);
      if (me.plan && me.plan.inputs) {
        open(me.plan);
        return true;
      }
      if (inputs && !isDemo) {
        await saveMyPlan(out.token, { inputs, progress, colors });
        return true;
      }
      return false;
    },
    signOut: () => {
      if (token) authLogout(token).catch(() => undefined);
      remember(null, null);
    },
    deleteAccount: async () => {
      if (token) await deleteMe(token);
      remember(null, null);
    },
    onboarded: !!flags.onboarded,
    setOnboarded: () => flag("onboarded"),
    toured: !!flags.toured,
    setToured: () => flag("toured"),
    offerSeen: !!flags.offer,
    restoring,
    chatOpen,
    setChatOpen,
    setOfferSeen: () => flag("offer"),
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used inside StoreProvider");
  return s;
}
