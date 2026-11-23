import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./shell/Logo";
import { ChatView } from "./chat/ChatView";
import type { Chat } from "./chat/types";
import { uid } from "./chat/types";
import { openStore, type ChatStore } from "./platform/store";
import { QuestPage, type QuestCommand } from "./quests/QuestPage";
import { OnboardingPage } from "./onboarding/OnboardingPage";
import { openQuestStore } from "./platform/questStore";
import { aheadIsStale, readCalendarAhead } from "./platform/calendar";
import { OrchestratorPanel, type OrchStatus } from "./orchestrator/OrchestratorPanel";
import { subscribe } from "./platform/deskBus";
import type { Semester } from "./quests/types";
import { DeskPanel } from "./shell/DeskPanel";
import { WeekPage } from "./now/WeekPage";
import { VersionLabel } from "./updates/VersionPanel";
import { addDays, daysBetween, toDay } from "./mastery/days";

const newChat = (): Chat => ({ id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [], notes: [] });

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

type View = "now" | "week" | "courses" | "chat" | "setup";

const Icon = {
  now: <path d="M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 5v3l2 1.3" />,
  week: <path d="M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3" />,
  courses: <path d="M3 3.5h4v4H3zM9 3.5h4v4H9zM3 9.5h4v4H3zM9 9.5h4v4H9z" />,
  ask: <path d="M4.5 6.2a3.5 3.5 0 1 1 4.6 3.3c-.7.3-1.1.8-1.1 1.5M8 13h0" />,
  tell: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
};
const Svg = ({ children }: { children: JSX.Element }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

/** "Winter semester · week 6 of 14", or just the name. */
function semesterLine(s: Semester | null): string | null {
  if (!s) return null;
  if (s.source === "sample") return "Sample semester";
  if (!s.startDate || !s.endDate) return s.name;
  const today = toDay();
  const total = Math.max(1, Math.ceil((daysBetween(s.startDate, s.endDate) + 1) / 7));
  const week = Math.floor(daysBetween(s.startDate, today) / 7) + 1;
  if (week < 1) return `${s.name} · starts soon`;
  if (week > total) return `${s.name} · ended`;
  return `${s.name} · week ${week} of ${total}`;
}

export function App() {
  const [store, setStore] = useState<ChatStore | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState<Chat>(newChat);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [view, setView] = useState<View>("now");
  const [nowLoaded, setNowLoaded] = useState(false);
  useEffect(() => {
    if (view === "now") setNowLoaded(true);
  }, [view]);
  // Focus mode: the sidebar shrinks to an icon strip. Remembered in this browser only.
  const [focus, setFocus] = useState<boolean>(() => {
    try {
      return localStorage.getItem("studydesk.focus") === "1";
    } catch {
      return false;
    }
  });
  const toggleFocus = () =>
    setFocus((f) => {
      try {
        localStorage.setItem("studydesk.focus", f ? "0" : "1");
      } catch {
        /* not remembered */
      }
      setToolsOpen(false);
      return !f;
    });
  // The semester, for the sidebar line; null until loaded, "none" when there isn't one yet.
  const [semester, setSemester] = useState<Semester | null | "none">(null);
  // "Tell StudyDesk" (the Orchestrator): a panel over every screen, expandable to a full window.
  const [orchOpen, setOrchOpen] = useState(false);
  const [orchExpanded, setOrchExpanded] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const [status, setStatus] = useState<OrchStatus>({ needs: 0, notes: 0, nightly: "off", nightlyTime: null });
  const [askSeed, setAskSeed] = useState<{ chatId: string; question: string } | null>(null);
  // The ⋯ menu: testing tools and a new semester.
  const [toolsOpen, setToolsOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [command, setCommand] = useState<QuestCommand | null>(null);
  // A reading started from Organize runs in the setup screen's runner, kept mounted (hidden) while it works.
  const [runPending, setRunPending] = useState(false);
  // When "Start a new semester" was pressed (0: it wasn't): opens the setup page on its "Are you sure?" step.
  const [newSemesterAsk, setNewSemesterAsk] = useState(0);
  useEffect(() => subscribe("draft", "app", (d) => setRunPending(d.status === "active" && d.setupStep === "running")), []);

  const go = useCallback((v: View) => {
    setView(v);
    setNewSemesterAsk(0);
    setMenuOpen(false);
    setToolsOpen(false);
  }, []);

  const openOrch = useCallback(() => {
    const sel = window.getSelection()?.toString().trim();
    if (sel && !document.querySelector(".orch")?.contains(window.getSelection()?.anchorNode ?? null)) setQuote(sel.slice(0, 600));
    setOrchOpen(true);
    setMenuOpen(false);
  }, []);
  // Ctrl/⌘ J opens and closes the StudyDesk chat from every screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOrchOpen((o) => {
          if (!o) openOrch();
          return !o;
        });
      }
      if (e.key === "Escape") setToolsOpen(false);
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

  // A new student (no semester yet) starts with the setup chat.
  const first = useRef(true);
  useEffect(() => {
    openQuestStore()
      .then((qs) => qs.loadSemester())
      .then((sem) => {
        setSemester(sem ?? "none");
        if (!sem && first.current) setView((v) => (v === "now" ? "setup" : v));
        first.current = false;
      })
      .catch(() => setSemester("none"));
    // Read again on each screen change: the quest page can switch to sample data without telling anyone.
  }, [view]);
  useEffect(() => subscribe("semester", "app", (s) => setSemester(s)), []);

  // The calendar is live data: while the page is open, the coming two weeks are
  // read again every few hours, so the nightly run (which can't reach the
  // calendar) sizes tomorrow's quest from the latest read, not from setup.
  const calendarLive = semester && semester !== "none" && semester.calendarSync;
  useEffect(() => {
    if (!calendarLive) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const qs = await openQuestStore();
        if (qs.mode !== "cloud") return;
        const today = toDay();
        if (!aheadIsStale(await qs.loadCalendar(), today, Date.now())) return;
        const ahead = await readCalendarAhead(today);
        if (!stopped) await qs.saveCalendar(ahead);
      } catch {
        /* calendar not reachable right now: the last read stays */
      }
    };
    void refresh();
    const timer = setInterval(refresh, 30 * 60 * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [calendarLive]);

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
    go("chat");
  };

  const sem = semester && semester !== "none" ? semester : null;
  // Setting up counts as something StudyDesk needs from the student.
  const needs = status.needs + (semester === "none" || sem?.source === "sample" ? 1 : 0);
  const shown: View = view;
  const chatTitle = chats.find((c) => c.id === current.id)?.title ?? "New chat";
  const title = { now: "Now", week: "Week", courses: "Courses", chat: chatTitle, setup: "Set up your semester" }[shown];
  const command_ = (kind: QuestCommand["kind"]) => {
    setCommand({ id: Date.now(), kind });
    setConfirmRestart(false);
    go("now");
  };
  // Exams in the next four weeks, for the Week item.
  const examsSoon = sem ? sem.keyDates.filter((k) => k.date >= toDay() && k.date <= addDays(toDay(), 28)).length : 0;

  const badge = needs > 0 ? (
    <span className="nav-badge" aria-label={`${needs} ${needs === 1 ? "thing needs" : "things need"} you`}>
      {needs}
    </span>
  ) : status.notes > 0 ? (
    <span className="nav-dot" aria-label="New note" />
  ) : null;

  return (
    <div className={"app" + (menuOpen ? " menu-open" : "") + (focus ? " is-focus" : "")}>
      <aside className="side" aria-label="StudyDesk">
        <div className="brand">
          <Logo />
          <span className="nav-text">StudyDesk</span>
          <VersionLabel />
          <button type="button" className="icon-btn focus-btn" onClick={toggleFocus} aria-pressed={focus} aria-label={focus ? "Show the full sidebar" : "Focus mode: shrink the sidebar"} title={focus ? "Show the full sidebar" : "Focus mode"}>
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 3h11v10h-11zM6 3v10" />
              {focus ? <path d="M8.5 6.5L10 8l-1.5 1.5" /> : <path d="M10.5 6.5L9 8l1.5 1.5" />}
            </svg>
          </button>
        </div>
        {semesterLine(sem) && <p className="side-semester">{semesterLine(sem)}</p>}

        <nav className="side-nav" aria-label="Screens">
          <button type="button" className={"nav-item" + (shown === "now" ? " is-current" : "")} aria-current={shown === "now" ? "page" : undefined} title="Now: what to do, and when" onClick={() => go("now")}>
            <Svg>{Icon.now}</Svg>
            <span className="nav-text">Now</span>
          </button>
          <button type="button" className={"nav-item" + (shown === "week" ? " is-current" : "")} aria-current={shown === "week" ? "page" : undefined} title="Week: the run-up to your exams" onClick={() => go("week")}>
            <Svg>{Icon.week}</Svg>
            <span className="nav-text">Week</span>
            {examsSoon > 0 && <span className="nav-count">{examsSoon} {examsSoon === 1 ? "exam" : "exams"}</span>}
          </button>
          <button type="button" className={"nav-item" + (shown === "courses" ? " is-current" : "")} aria-current={shown === "courses" ? "page" : undefined} title="Courses: your semester, dates and files" onClick={() => go("courses")}>
            <Svg>{Icon.courses}</Svg>
            <span className="nav-text">Courses</span>
          </button>
          <button
            type="button"
            className={"nav-item" + (shown === "chat" && !chats.some((c) => c.id === current.id) ? " is-current" : "")}
            title="Ask: a tutor chat for anything you're stuck on"
            onClick={() => open(newChat())}
          >
            <Svg>{Icon.ask}</Svg>
            <span className="nav-text">Ask</span>
          </button>
        </nav>

        <p className="side-label">Recent chats</p>
        <nav className="chat-list" aria-label="Chats">
          {!loaded && <p className="side-empty">Loading your chats…</p>}
          {loaded && chats.length === 0 && <p className="side-empty">Your chats will show up here.</p>}
          {chats.map((c) => (
            <div key={c.id} className={"chat-item" + (shown === "chat" && c.id === current.id ? " is-current" : "")}>
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

        <button
          type="button"
          className={"organize-btn" + (orchOpen ? " is-current" : "")}
          aria-expanded={orchOpen}
          onClick={() => (orchOpen ? setOrchOpen(false) : openOrch())}
          title="Tell StudyDesk what changed, or ask about your plan (Ctrl/⌘ J)"
        >
          <Svg>{Icon.tell}</Svg>
          <span className="nav-text">Tell StudyDesk</span>
          {badge}
          <kbd className="organize-kbd">Ctrl J</kbd>
        </button>
        <div className="side-foot">
          <span className={"run-dot is-" + status.nightly} aria-hidden="true" />
          <span className="side-run">
            {status.nightly === "on" && status.nightlyTime
              ? `Nightly run at ${status.nightlyTime}`
              : status.nightly === "failed"
                ? "Nightly run not set up"
                : store?.mode === "local"
                  ? "Preview: saved in this browser"
                  : "Saved to your claude.ai account"}
          </span>
          <button type="button" className="icon-btn tools-btn" aria-label="More" aria-expanded={toolsOpen} onClick={() => setToolsOpen((o) => !o)}>
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
              <circle cx="3.5" cy="8" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="12.5" cy="8" r="1.3" />
            </svg>
          </button>
          {toolsOpen && (
            <div className="tools-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  // Only this way in asks "Are you sure?"; the setup sheet and its to-do list open without it.
                  go("setup");
                  if (sem && sem.source !== "sample") setNewSemesterAsk(Date.now());
                }}
              >
                {sem && sem.source !== "sample" ? "Start a new semester" : "Set up your semester"}
              </button>
              <p className="tools-label">Testing tools</p>
              <button type="button" role="menuitem" onClick={() => command_("build")}>
                Plan today again
              </button>
              {sem?.source === "sample" &&
                (confirmRestart ? (
                  <div className="tools-confirm">
                    <span>Restart with fresh sample homework? Your attempts are kept.</span>
                    <span>
                      <button type="button" className="mini-btn" onClick={() => command_("restart")}>
                        Restart
                      </button>
                      <button type="button" className="mini-btn" onClick={() => setConfirmRestart(false)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : (
                  <button type="button" role="menuitem" onClick={() => setConfirmRestart(true)}>
                    Restart the sample semester
                  </button>
                ))}
              <p className="tools-foot">{store?.mode === "cloud" ? "Chats are saved privately to your claude.ai account." : "Preview mode: everything is saved in this browser only."}</p>
            </div>
          )}
        </div>
      </aside>
      <button type="button" className="scrim" aria-label="Close the menu" onClick={() => setMenuOpen(false)} />

      <main className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Show menu and chats" onClick={() => setMenuOpen(true)}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 6h13M3.5 10h13M3.5 14h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <span className="topbar-title">{title}</span>
        </header>
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {/* Now stays loaded once opened, so coming back to it is instant. */}
        {(shown === "now" || nowLoaded) && (
          <div className={"today-host" + (shown === "now" ? "" : " is-hidden")} aria-hidden={shown !== "now"}>
            <QuestPage key={sem?.id ?? "none"} onStartSetup={() => go("setup")} onOpenWeek={() => go("week")} onOpenTodo={() => go("setup")} command={command} />
          </div>
        )}
        {shown === "week" && <WeekPage onOpenNow={() => go("now")} />}
        {shown === "chat" && <ChatView key={current.id} initial={current} save={save} onSaveError={onSaveError} autoSend={askSeed?.chatId === current.id ? askSeed.question : undefined} />}
        {shown === "courses" && (
          <div className="courses-page">
            <DeskPanel onOpenSetup={() => go("setup")} />
          </div>
        )}
        {(shown === "setup" || runPending) && (
          <div className={shown === "setup" ? "setup-host" : "setup-host is-hidden"} aria-hidden={shown !== "setup"}>
            {shown === "setup" && sem && (
              <button type="button" className="link-btn setup-back" onClick={() => go("courses")}>
                ← Back to Courses
              </button>
            )}
            <OnboardingPage onDone={() => go("now")} askNewSemester={newSemesterAsk} />
          </div>
        )}

        <nav className="tabbar" aria-label="Screens">
          <button type="button" className={shown === "now" ? "is-current" : ""} onClick={() => go("now")}>
            <Svg>{Icon.now}</Svg>
            Now
          </button>
          <button type="button" className={shown === "week" ? "is-current" : ""} onClick={() => go("week")}>
            <Svg>{Icon.week}</Svg>
            Week
          </button>
          <button type="button" className="tab-tell" aria-label="Tell StudyDesk" onClick={() => (orchOpen ? setOrchOpen(false) : openOrch())}>
            <span className="tab-icon">
              <Svg>{Icon.tell}</Svg>
              {badge}
            </span>
          </button>
          <button type="button" className={shown === "courses" || shown === "setup" ? "is-current" : ""} onClick={() => go("courses")}>
            <Svg>{Icon.courses}</Svg>
            Courses
          </button>
          <button type="button" className={shown === "chat" ? "is-current" : ""} onClick={() => open(newChat())}>
            <Svg>{Icon.ask}</Svg>
            Ask
          </button>
        </nav>
      </main>
      <OrchestratorPanel
        open={orchOpen}
        dock={null}
        expanded={orchExpanded}
        onClose={() => setOrchOpen(false)}
        onToggleExpand={() => setOrchExpanded((x) => !x)}
        screen={
          shown === "now"
            ? "Now (today's plan: blocks on the clock)"
            : shown === "week"
              ? "Week (the run-up to the exams)"
              : shown === "courses"
                ? "Courses (semester, courses, dates, files)"
                : shown === "setup"
                  ? "Semester setup"
                  : `Ask chat "${chatTitle}"`
        }
        quote={quote}
        onClearQuote={() => setQuote(null)}
        onStatus={setStatus}
        onOpenAsk={(question) => {
          const c = newChat();
          setAskSeed({ chatId: c.id, question });
          setCurrent(c);
          go("chat");
          setOrchExpanded(false);
        }}
        onOpenSetup={() => {
          go("setup");
          setOrchOpen(false);
        }}
      />
    </div>
  );
}
