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
import { QUEST_CHANGED } from "./quests/times";
import { syncStudyEntries } from "./platform/studyEntries";
import { OrchestratorPanel, type OrchStatus } from "./orchestrator/OrchestratorPanel";
import { publish, subscribe } from "./platform/deskBus";
import type { Semester } from "./quests/types";
import { CoursesPage } from "./courses/CoursesPage";
import { InputBox } from "./chat/InputBox";
import type { PendingAttachment } from "./lib/files";
import { VersionLabel } from "./updates/VersionPanel";
import { daysBetween, toDay } from "./mastery/days";

const newChat = (): Chat => ({ id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [], notes: [] });

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

type View = "today" | "chat" | "courses" | "organize" | "setup";

const Icon = {
  today: <path d="M3.5 2.5h9v11h-9zM5.8 7.6l1.6 1.6 3-3.4" />,
  ask: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  courses: <path d="M3 3h4.5v10.5H3zM8.5 3H13v10.5H8.5zM4.5 5.5h1.5M10 5.5h1.5" />,
  organize: <path d="M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  todo: <path d="M2.5 2.5h11v11h-11zM5 8l2 2 4-4" />,
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
  // Narrow screens show Organize's chat or its to-do list, not one under the other, so the chat box stays at hand.
  const [orgView, setOrgView] = useState<"chat" | "todo">("chat");
  // Wide screens can hide Organize's To do behind a slim strip. Remembered in this browser only.
  const [todoHidden, setTodoHidden] = useState(() => {
    try {
      return localStorage.getItem("studydesk.todoHidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleTodo = () => {
    try {
      localStorage.setItem("studydesk.todoHidden", todoHidden ? "0" : "1");
    } catch {
      /* not remembered */
    }
    setTodoHidden(!todoHidden);
  };
  // The course page open on Courses (null: the list).
  const [courseId, setCourseId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [view, setView] = useState<View>("today");
  const [todayLoaded, setTodayLoaded] = useState(false);
  useEffect(() => {
    if (view === "today") setTodayLoaded(true);
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
  // Organize (the Orchestrator): a full page, and a quick panel over every other screen.
  const [orchOpen, setOrchOpen] = useState(false);
  const [orchExpanded, setOrchExpanded] = useState(false);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [todoDock, setTodoDock] = useState<HTMLDivElement | null>(null);
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
    if (v === "organize") setOrchOpen(false);
  }, []);

  const openOrch = useCallback(() => {
    const sel = window.getSelection()?.toString().trim();
    if (sel && !document.querySelector(".orch")?.contains(window.getSelection()?.anchorNode ?? null)) setQuote(sel.slice(0, 600));
    setOrchOpen(true);
    setMenuOpen(false);
  }, []);
  // On the Organize page the chat is already there; elsewhere it opens as a panel.
  const viewRef = useRef(view);
  viewRef.current = view;
  // Setup is finished: the setup page hands over to Today, where the placement check waits.
  const onSetupDone = useCallback(() => viewRef.current === "setup" && go("today"), [go]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (viewRef.current === "organize") return (document.querySelector(".orch.is-docked textarea") as HTMLTextAreaElement | null)?.focus();
        setOrchOpen((o) => {
          if (!o) openOrch();
          return !o;
        });
      }
      if (e.key === "Escape") setToolsOpen(false);
    };
    const onAsk = (e: Event) => {
      setQuote((e as CustomEvent<{ quote: string }>).detail?.quote || null);
      if (viewRef.current !== "organize") setOrchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("studydesk:ask", onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("studydesk:ask", onAsk);
    };
    // viewRef is read at event time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOrch]);

  // A new student (no semester yet) starts in Organize, which begins with the setup chat.
  const first = useRef(true);
  useEffect(() => {
    openQuestStore()
      .then((qs) => qs.loadSemester())
      .then((sem) => {
        setSemester(sem ?? "none");
        if (!sem && first.current) setView((v) => (v === "today" ? "setup" : v));
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
    // Study entries follow today's quest: a quest written or finished here moves them within a minute.
    let syncing = false;
    const sync = async () => {
      if (syncing || stopped) return;
      syncing = true;
      try {
        const qs = await openQuestStore();
        if (qs.mode === "cloud") await syncStudyEntries(qs, toDay());
      } catch {
        /* not allowed or not reachable right now: tried again later */
      } finally {
        syncing = false;
      }
    };
    let soon: ReturnType<typeof setTimeout> | undefined;
    const onQuest = () => {
      clearTimeout(soon);
      soon = setTimeout(sync, 45_000);
    };
    window.addEventListener(QUEST_CHANGED, onQuest);
    void refresh().then(sync);
    const timer = setInterval(() => void refresh().then(sync), 30 * 60 * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(soon);
      window.removeEventListener(QUEST_CHANGED, onQuest);
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

  /** A message for StudyDesk written on another screen: sent in its chat, which opens as a panel. */
  const askOrch = (text: string, files: PendingAttachment[], quote?: string) => {
    publish("ask", { text, files, quote }, "app");
    setOrchOpen(true);
  };

  const open = (c: Chat) => {
    setCurrent(c);
    go("chat");
  };

  const sem = semester && semester !== "none" ? semester : null;
  // Setting up counts as something StudyDesk needs from the student.
  const needs = status.needs + (semester === "none" || sem?.source === "sample" ? 1 : 0);
  const organizeView = view === "organize" || view === "setup";
  // Organize without a semester is the setup chat.
  const shown: View = view === "organize" && semester === "none" ? "setup" : view;
  const chatTitle = chats.find((c) => c.id === current.id)?.title ?? "New chat";
  const shownCourse = shown === "courses" ? sem?.courses.find((c) => c.id === courseId) : undefined;
  const title = shown === "today" ? "Today" : shown === "chat" ? chatTitle : shown === "setup" ? "Set up your semester" : shown === "courses" ? "Courses" : "Organize";
  const goCourses = () => {
    setCourseId(null);
    go("courses");
  };
  const command_ = (kind: QuestCommand["kind"]) => {
    setCommand({ id: Date.now(), kind });
    setConfirmRestart(false);
    go("today");
  };

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
          <button type="button" className={"nav-item" + (shown === "today" ? " is-current" : "")} aria-current={shown === "today" ? "page" : undefined} title="Today" onClick={() => go("today")}>
            <Svg>{Icon.today}</Svg>
            <span className="nav-text">Today</span>
          </button>
          <button
            type="button"
            className={"nav-item" + (shown === "chat" && !chats.some((c) => c.id === current.id) ? " is-current" : "")}
            title="Ask: start a new chat"
            onClick={() => open(newChat())}
          >
            <Svg>{Icon.ask}</Svg>
            <span className="nav-text">Ask</span>
          </button>
          <button type="button" className={"nav-item" + (shown === "courses" ? " is-current" : "")} aria-current={shown === "courses" ? "page" : undefined} title="Courses" onClick={goCourses}>
            <Svg>{Icon.courses}</Svg>
            <span className="nav-text">Courses</span>
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
          className={"organize-btn" + (organizeView ? " is-current" : "")}
          aria-current={organizeView ? "page" : undefined}
          onClick={() => go("organize")}
          title="Tell StudyDesk what changed, and what it needs from you (Ctrl/⌘ J)"
        >
          <Svg>{Icon.organize}</Svg>
          <span className="nav-text">Organize</span>
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
                  // Once a semester is set up, this is the only way onto the setup page, and it asks "Are you sure?" first.
                  go("setup");
                  if (sem && sem.source !== "sample") setNewSemesterAsk(Date.now());
                }}
              >
                {sem && sem.source !== "sample" ? "Start a new semester" : "Set up your semester"}
              </button>
              <p className="tools-label">Testing tools</p>
              <button type="button" role="menuitem" onClick={() => command_("build")}>
                Build a new quest for today
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
        {/* Today stays loaded once opened, so coming back to it is instant. */}
        {(shown === "today" || todayLoaded) && (
          <div className={"today-host" + (shown === "today" ? "" : " is-hidden")} aria-hidden={shown !== "today"}>
            <QuestPage key={sem?.id ?? "none"} onStartSetup={() => go("setup")} command={command} />
          </div>
        )}
        {shown === "chat" && <ChatView key={current.id} initial={current} save={save} onSaveError={onSaveError} autoSend={askSeed?.chatId === current.id ? askSeed.question : undefined} />}
        {shown === "organize" && (
          <div className="organize" data-narrow={orgView} data-todo-hidden={todoHidden || undefined}>
            <div className="setup-switch organize-switch" role="tablist" aria-label="Show">
              <button type="button" role="tab" aria-selected={orgView === "chat"} className={orgView === "chat" ? "is-on" : ""} onClick={() => setOrgView("chat")}>
                Chat
              </button>
              <button type="button" role="tab" aria-selected={orgView === "todo"} className={orgView === "todo" ? "is-on" : ""} onClick={() => setOrgView("todo")}>
                To do
                {badge}
              </button>
            </div>
            <div className="organize-chat" ref={setDock} />
            <div className="organize-data" ref={setTodoDock} />
            {todoHidden && (
              <button type="button" className="todo-rail" onClick={toggleTodo} aria-label="Show To do" title="Show To do">
                <span className="tab-icon">
                  <Svg>{Icon.todo}</Svg>
                  {badge}
                </span>
                <span className="todo-rail-label">To do</span>
              </button>
            )}
          </div>
        )}
        {shown === "courses" && (
          <div className="courses-host">
            <CoursesPage courseId={courseId} onOpen={setCourseId} onOpenSetup={() => go("setup")} onToday={() => go("today")} onAsk={askOrch} />
            <div className="courses-box">
              <InputBox id="courses-box" keepAll compact placeholder={`Tell StudyDesk what's wrong or new${shownCourse ? ` in ${shownCourse.name}` : ""}. Drop or paste files.`} onSend={(t, f) => askOrch(t, f)} />
            </div>
          </div>
        )}
        {(shown === "setup" || runPending) && (
          <div className={shown === "setup" ? "setup-host" : "setup-host is-hidden"} aria-hidden={shown !== "setup"}>
            {shown === "setup" && sem && (
              <button type="button" className="link-btn setup-back" onClick={() => go("organize")}>
                ← Back to Organize
              </button>
            )}
            <OnboardingPage onDone={onSetupDone} askNewSemester={newSemesterAsk} />
          </div>
        )}

        <nav className="tabbar" aria-label="Screens">
          <button type="button" className={shown === "today" ? "is-current" : ""} onClick={() => go("today")}>
            <Svg>{Icon.today}</Svg>
            Today
          </button>
          <button type="button" className={shown === "chat" ? "is-current" : ""} onClick={() => open(newChat())}>
            <Svg>{Icon.ask}</Svg>
            Ask
          </button>
          <button type="button" className={shown === "courses" ? "is-current" : ""} onClick={goCourses}>
            <Svg>{Icon.courses}</Svg>
            Courses
          </button>
          <button type="button" className={organizeView ? "is-current" : ""} onClick={() => go("organize")}>
            <span className="tab-icon">
              <Svg>{Icon.organize}</Svg>
              {badge}
            </span>
            Organize
          </button>
        </nav>
      </main>
      <OrchestratorPanel
        open={orchOpen && shown !== "organize"}
        dock={shown === "organize" ? dock : null}
        todoDock={shown === "organize" ? todoDock : null}
        onStartTodo={() => setOrgView("chat")}
        onHideTodo={toggleTodo}
        expanded={orchExpanded}
        onClose={() => setOrchOpen(false)}
        onToggleExpand={() => setOrchExpanded((x) => !x)}
        screen={shown === "today" ? "Today's quest" : shown === "setup" ? "Semester setup" : shown === "organize" ? "Organize page (chat and to-do list)" : shown === "courses" ? (shownCourse ? `Courses: the page of ${shownCourse.name} (progress, dates, skills, files)` : "Courses: the semester and all courses") : `Ask chat "${chatTitle}"`}
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
        onNewQuest={(o) => {
          setTodayLoaded(true);
          setCommand({ id: Date.now(), kind: "build", ...o });
        }}
      />
    </div>
  );
}
