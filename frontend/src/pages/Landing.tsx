import { go } from "../ui";
import { useStore } from "../store";

const POINTS = [
  { img: "/img/fp-icon-calendar-check.jpg", title: "One clear next step", text: "Each card gets one amount and one date. Minimums first, the rest goes where it saves the most interest." },
  { img: "/img/fp-icon-arrows-cycle.jpg", title: "Recalculates when life changes", text: "A new statement, a different budget or a lower rate from the bank. Change one number and see the new schedule." },
  { img: "/img/fp-icon-phone.jpg", title: "A script for the bank call", text: "Wording to ask for a lower APR, then enter what the bank really offers." },
];

const EXAMPLE = [
  { name: "Card A · 29% APR", pay: "$410", split: "$40 min + $370 extra" },
  { name: "Card B · 24% APR", pay: "$60", split: "Minimum only" },
  { name: "Card C · 19% APR", pay: "$30", split: "Minimum only" },
];

export default function Landing() {
  const { loadDemo, inputs, isDemo } = useStore();
  const openDemo = () => {
    loadDemo();
    go("plan");
  };
  return (
    <main className="page">
      <section className="hero">
        <div className="hero-text">
          <h1 className="display">Know what to pay on each card</h1>
          <p className="lede">
            Enter your cards and what you can put toward them each month. Get a payment for every card, a 90-day schedule and an estimated debt-free month.
          </p>
          <div className="actions">
            <a className="btn" href={inputs && !isDemo ? "#/plan" : "#/setup/1"}>
              {inputs && !isDemo ? "Open my plan" : "Build my plan"}
            </a>
            <button type="button" className="btn ghost" onClick={openDemo}>
              Open the demo example
            </button>
          </div>
          <div className="tiles">
            {EXAMPLE.map((c, i) => (
              <div key={c.name} className="tile" style={{ marginTop: i * 28 }}>
                <span className="small muted">{c.name}</span>
                <b>{c.pay}</b>
                <span className="pill">{c.split}</span>
              </div>
            ))}
          </div>
          <p className="small muted">Example: $500 a month across three cards, $4,600 owed. The payments for the first payment cycle.</p>
        </div>
        <img className="hero-img" src="/img/fp-hero-card-stack.jpg" alt="Three blank metal credit cards floating in a stack" />
      </section>

      <section className="grid3">
        {POINTS.map((p) => (
          <div key={p.title} className="panel">
            <img className="icon" src={p.img} alt="" />
            <h2>{p.title}</h2>
            <p className="muted">{p.text}</p>
          </div>
        ))}
      </section>

      <footer className="foot small muted">
        <span>No sign-up, SSN, card number, bank password or credit bureau access.</span>
        <span>Estimates only. FinPilot does not move money or promise a result.</span>
      </footer>
    </main>
  );
}
