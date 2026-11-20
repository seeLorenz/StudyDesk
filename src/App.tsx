import { useCallback, useEffect, useState } from "react";
import { ChatView } from "./chat/ChatView";
import type { Chat } from "./chat/types";
import { uid } from "./chat/types";
import { openStore, type ChatStore } from "./platform/store";
import { QuestPage } from "./quests/QuestPage";
import { OnboardingPage } from "./onboarding/OnboardingPage";
import { openQuestStore } from "./platform/questStore";
import { OrchestratorPanel } from "./orchestrator/OrchestratorPanel";
import { subscribe } from "./platform/deskBus";

const newChat = (): Chat => ({ id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [], notes: [] });

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function App() {
  const [store, setStore] = useState<ChatStore | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState<Chat>(newChat);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "quest" | "setup">("chat");
  // The StudyDesk chat (Orchestrator): a side panel over every screen.
  const [orchOpen, setOrchOpen] = useState(false);
  const [orchExpanded, setOrchExpanded] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [askSeed, setAskSeed] = useState<{ chatId: string; question: string } | null>(null);
  // A reading started from the StudyDesk chat runs in the setup screen's runner, kept mounted (hidden) while it works.
  const [runPending, setRunPending] = useState(false);
  useEffect(() => subscribe("draft", "app", (d) => setRunPending(d.status === "active" && d.setupStep === "running")), []);

  const openOrch = useCallback(() => {
    const sel = window.getSelection()?.toString().trim();
    if (sel && !document.querySelector(".orch")?.contains(window.getSelection()?.anchorNode ?? null)) setQuote(sel.slice(0, 600));
    setOrchOpen(true);
    setMenuOpen(false);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOrchOpen((o) => {
          if (!o) openOrch();
          return !o;
        });
      }
    };
    const onAsk = (e: Event) => {
      setQuote((e as CustomEvent<{ quote: string }>).detail?.quote || null);
      setOrchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("studydesk:ask", onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("studydesk:ask", onAsk);
    };
  }, [openOrch]);

  // A new student (no semester yet) starts in the setup chat.
  useEffect(() => {
    openQuestStore()
      .then((qs) => qs.loadSemester())
      .then((sem) => {
        if (!sem) setView((v) => (v === "chat" ? "setup" : v));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let stop = () => {};
    openStore().then((s) => {
      setStore(s);
      const timer = setTimeout(() => setNotice("Your saved chats are taking a while to load."), 10_000);
      stop = s.watchChats(
        (list) => {
          clearTimeout(timer);
          setNotice((n) => (n === "Your saved chats are taking a while to load." ? null : n));
          setChats(list);
          setLoaded(true);
        },
        (msg) => {
          clearTimeout(timer);
          setNotice(msg);
          setLoaded(true);
        },
      );
    });
    return () => stop();
  }, []);

  const save = useCallback((chat: Chat) => (store ? store.saveChat(chat) : Promise.resolve()), [store]);
  const onSaveError = useCallback((m: string) => setNotice(m), []);

  const open = (c: Chat) => {
    setCurrent(c);
    setView("chat");
    setMenuOpen(false);
  };

  return (
    <div className={"app" + (menuOpen ? " menu-open" : "")}>
      <aside className="side" aria-label="Chats">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          StudyDesk
        </div>
        <button
          type="button"
          className={"quest-link" + (view === "quest" ? " is-current" : "")}
          onClick={() => {
            setView("quest");
            setMenuOpen(false);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 2.5h10v11H3zM5.5 6l1.5 1.5L10.5 4M5.5 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Today's quest
        </button>
        <button
          type="button"
          className={"quest-link" + (view === "setup" ? " is-current" : "")}
          onClick={() => {
            setView("setup");
            setMenuOpen(false);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Start New Semester
        </button>
        <button type="button" className={"quest-link" + (orchOpen ? " is-current" : "")} onClick={() => (orchOpen ? setOrchOpen(false) : openOrch())} title="Ask about your desk or tell it what changed (Ctrl/⌘ J)">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          Talk to StudyDesk
          {unseen > 0 && <span className="orch-badge" aria-label={`${unseen} new`}>{unseen}</span>}
        </button>
        <button type="button" className="new-chat" onClick={() => open(newChat())}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New chat
        </button>
        <nav className="chat-list">
          {!loaded && <p className="side-empty">Loading your chats…</p>}
          {loaded && chats.length === 0 && <p className="side-empty">Your chats will show up here.</p>}
          {chats.map((c) => (
            <div key={c.id} className={"chat-item" + (view === "chat" && c.id === current.id ? " is-current" : "")}>
              <button type="button" className="chat-open" onClick={() => open(c)}>
                <span className="chat-title">{c.title}</span>
                <span className="chat-meta">
                  {when(c.updatedAt)}
                  {c.notes.length > 0 && ` · ${c.notes.length} ${c.notes.length === 1 ? "note" : "notes"}`}
                </span>
              </button>
              {confirmId === c.id ? (
                <span className="chat-confirm">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      store?.deleteChat(c.id);
                      setConfirmId(null);
                      if (current.id === c.id) setCurrent(newChat());
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="chat-del" aria-label={`Delete ${c.title}`} onClick={() => setConfirmId(c.id)}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </nav>
        <p className="side-foot">
          {store?.mode === "cloud" ? "Chats are saved privately to your claude.ai account." : "Preview mode: chats are saved in this browser only."}
        </p>
      </aside>
      <button type="button" className="scrim" aria-label="Close chat list" onClick={() => setMenuOpen(false)} />

      <main className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Show chats" onClick={() => setMenuOpen(true)}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 6h13M3.5 10h13M3.5 14h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button type="button" className="icon-btn orch-top" aria-label="Talk to StudyDesk" onClick={() => (orchOpen ? setOrchOpen(false) : openOrch())}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 4.5h14v9H9.5l-4 3v-3H3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            {unseen > 0 && <span className="orch-badge">{unseen}</span>}
          </button>
          <span className="topbar-title">{view === "quest" ? "Today's quest" : view === "setup" ? "Start New Semester" : chats.find((c) => c.id === current.id)?.title ?? "New chat"}</span>
        </header>
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {view === "quest" ? (
          <QuestPage onStartSetup={() => setView("setup")} />
        ) : view === "setup" ? null : (
          <ChatView key={current.id} initial={current} save={save} onSaveError={onSaveError} autoSend={askSeed?.chatId === current.id ? askSeed.question : undefined} />
        )}
        {(view === "setup" || runPending) && (
          <div className={view === "setup" ? "setup-host" : "setup-host is-hidden"} aria-hidden={view !== "setup"}>
            <OnboardingPage onDone={() => setView("quest")} />
          </div>
        )}
      </main>
      <OrchestratorPanel
        open={orchOpen}
        expanded={orchExpanded}
        onClose={() => setOrchOpen(false)}
        onToggleExpand={() => setOrchExpanded((x) => !x)}
        screen={view === "quest" ? "Today's quest" : view === "setup" ? "Start New Semester" : `Ask chat "${chats.find((c) => c.id === current.id)?.title ?? "New chat"}"`}
        quote={quote}
        onClearQuote={() => setQuote(null)}
        onUnseen={setUnseen}
        onOpenAsk={(question) => {
          const c = newChat();
          setAskSeed({ chatId: c.id, question });
          setCurrent(c);
          setView("chat");
          if (!orchExpanded) return;
          setOrchExpanded(false);
        }}
        onOpenSetup={() => {
          setView("setup");
          setOrchOpen(false);
        }}
      />
    </div>
  );
}
