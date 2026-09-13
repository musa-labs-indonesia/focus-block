import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Types
type Todo = {
  id: string;
  title: string;
  durationMinutes: number;
  blockedSites: string[];
  createdAt: number;
};

type ActiveSession = {
  todoId: string;
  endAt: number;
  startAt: number;
  durationSeconds: number;
};

type FormError = {
  field: "title" | "duration" | "site";
  message: string;
};

// Helpers
const STORAGE_TODOS = "focusblock_todos";
const STORAGE_GLOBAL = "focusblock_global_blocks";
const STORAGE_SESSION = "focusblock_active_session";

function normalizeInputSite(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("https://")) s = s.slice(8);
  else if (s.startsWith("http://")) s = s.slice(7);
  if (s.includes("/")) s = s.split("/")[0];
  if (s.includes(":")) s = s.split(":")[0];
  s = s.trim().replace(/\.$/, "");
  if (s.startsWith("www.")) s = s.slice(4);
  if (!s || !s.includes(".")) return null;
  if (/[^a-z0-9.-]/.test(s)) return null;
  return s;
}

function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Main Component
export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [globalBlocks, setGlobalBlocks] = useState<string[]>([]);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [blockStatus, setBlockStatus] = useState<{ active: boolean; sites: string[] } | null>(null);
  const [globalInput, setGlobalInput] = useState("");
  const [savedAuth, setSavedAuth] = useState<{ enabled: boolean; platform: string } | null>(null);
  const [page, setPage] = useState<"focus" | "settings">("focus");
  const [hostsPreview, setHostsPreview] = useState<string | null>(null);
  const [dbLoaded, setDbLoaded] = useState(false);
  const [dark, setDark] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem("focusblock_dark");
      if (s !== null) return s === "1";
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  });
  // form state
  const [formTitle, setFormTitle] = useState("");
  const [formDuration, setFormDuration] = useState(25);
  const [formSites, setFormSites] = useState<string[]>([]);
  const [formSiteInput, setFormSiteInput] = useState("");
  const [formError, setFormError] = useState<FormError | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const appContentRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLFormElement>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousPageRef = useRef(page);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const durationInputRef = useRef<HTMLInputElement>(null);

  const activeTodo = useMemo(() => {
    if (!active) return null;
    return todos.find((t) => t.id === active.todoId) || null;
  }, [active, todos]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("focusblock_dark", dark ? "1" : "0");
    } catch {}
  }, [dark]);

  useEffect(() => {
    document.title = page === "focus" ? "Focus tasks · Focus Block" : "Settings · Focus Block";
    if (previousPageRef.current !== page) pageHeadingRef.current?.focus();
    previousPageRef.current = page;
  }, [page]);

  useEffect(() => {
    if (!showAdd) return;
    const dialog = modalRef.current;
    const appContent = appContentRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    appContent?.setAttribute("inert", "");
    titleInputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowAdd(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      appContent?.removeAttribute("inert");
      lastTriggerRef.current?.focus();
      lastTriggerRef.current = null;
    };
  }, [showAdd]);

  const intervalRef = useRef<number | null>(null);

  // load from sqlite (with localStorage migration fallback)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [t, g, s] = await Promise.all([
          invoke<Todo[]>("get_todos"),
          invoke<string[]>("get_global_blocks"),
          invoke<ActiveSession | null>("get_active_session"),
        ]);
        if (cancelled) return;
        let migratedTodos = t;
        let migratedGlobals = g;
        let migratedSession = s;
        if (t.length === 0 && g.length === 0 && s === null) {
          try {
            const lt = localStorage.getItem(STORAGE_TODOS) || localStorage.getItem("focusblock_todos");
            const lg = localStorage.getItem(STORAGE_GLOBAL) || localStorage.getItem("focusblock_global_blocks");
            const ls = localStorage.getItem(STORAGE_SESSION) || localStorage.getItem("focusblock_active_session");
            let needMigrate = false;
            if (lt) {
              const parsed: Todo[] = JSON.parse(lt);
              if (Array.isArray(parsed) && parsed.length > 0) {
                migratedTodos = parsed;
                needMigrate = true;
              }
            }
            if (lg) {
              const parsed: string[] = JSON.parse(lg);
              if (Array.isArray(parsed) && parsed.length > 0) {
                migratedGlobals = parsed;
                needMigrate = true;
              }
            }
            if (ls) {
              const sess: ActiveSession = JSON.parse(ls);
              if (sess && sess.endAt > Date.now()) {
                migratedSession = sess;
                needMigrate = true;
              }
            }
            if (needMigrate) {
              if (migratedTodos.length) invoke("sync_todos", { todos: migratedTodos }).catch(() => {});
              if (migratedGlobals.length) invoke("set_global_blocks", { sites: migratedGlobals }).catch(() => {});
              if (migratedSession) invoke("save_active_session", { session: migratedSession }).catch(() => {});
            }
          } catch {}
        }
        if (migratedSession && migratedSession.endAt <= Date.now()) {
          migratedSession = null;
          invoke("clear_active_session").catch(() => {});
        }
        setTodos(migratedTodos);
        setGlobalBlocks(migratedGlobals);
        setActive(migratedSession);
        if (migratedSession) {
          const rem = Math.ceil((migratedSession.endAt - Date.now()) / 1000);
          setRemaining(rem > 0 ? rem : 0);
        }
      } catch {
        // fallback for browser dev (no tauri) — also check old keys
        try {
          const v = localStorage.getItem(STORAGE_TODOS) || localStorage.getItem("focusblock_todos");
          if (v) setTodos(JSON.parse(v));
        } catch {}
        try {
          const v = localStorage.getItem(STORAGE_GLOBAL) || localStorage.getItem("focusblock_global_blocks");
          if (v) setGlobalBlocks(JSON.parse(v));
        } catch {}
        try {
          const v = localStorage.getItem(STORAGE_SESSION) || localStorage.getItem("focusblock_active_session");
          if (v) {
            const sess: ActiveSession = JSON.parse(v);
            if (sess.endAt > Date.now()) {
              setActive(sess);
              const rem = Math.ceil((sess.endAt - Date.now()) / 1000);
              setRemaining(rem > 0 ? rem : 0);
            } else localStorage.removeItem(STORAGE_SESSION);
          }
        } catch {}
      } finally {
        if (!cancelled) setDbLoaded(true);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // persist to sqlite (fallback to localStorage when not in tauri)
  useEffect(() => {
    if (!dbLoaded) return;
    invoke("sync_todos", { todos }).catch(() => {
      try {
        localStorage.setItem(STORAGE_TODOS, JSON.stringify(todos));
      } catch {}
    });
  }, [todos, dbLoaded]);
  useEffect(() => {
    if (!dbLoaded) return;
    invoke("set_global_blocks", { sites: globalBlocks }).catch(() => {
      try {
        localStorage.setItem(STORAGE_GLOBAL, JSON.stringify(globalBlocks));
      } catch {}
    });
  }, [globalBlocks, dbLoaded]);
  useEffect(() => {
    if (!dbLoaded) return;
    if (active)
      invoke("save_active_session", { session: active }).catch(() => {
        try {
          localStorage.setItem(STORAGE_SESSION, JSON.stringify(active));
        } catch {}
      });
    else
      invoke("clear_active_session").catch(() => {
        try {
          localStorage.removeItem(STORAGE_SESSION);
        } catch {}
      });
  }, [active, dbLoaded]);

  // auto-recover orphaned hosts block (close killed / auth rejected) — runs once after db load
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (!dbLoaded || recoveredRef.current) return;
    recoveredRef.current = true;
    (async () => {
      try {
        const [status, sess] = await Promise.all([
          invoke<{ active: boolean; sites: string[] }>("get_block_status"),
          invoke<ActiveSession | null>("get_active_session"),
        ]);
        const hasActive = !!sess && sess.endAt > Date.now();
        const isExpired = sess ? sess.endAt <= Date.now() : false;
        if (status.active && (!hasActive || isExpired)) {
          showToast("Found leftover block from previous session — clearing…");
          try {
            await invoke("deactivate_blocks");
            await refreshBlockStatus();
            await refreshHostsPreview();
            showToast("Orphaned block cleared");
          } catch (e: any) {
            showToast(`Could not auto-clear orphaned block: ${String(e).slice(0, 120)} — clear manually in Settings`);
          }
          if (isExpired) invoke("clear_active_session").catch(() => {});
        } else if (hasActive && !status.active) {
          // session active but hosts clear (app was closed and hosts cleared) → end unprotected session
          const t = await invoke<Todo[]>("get_todos").catch(() => todos);
          const g = await invoke<string[]>("get_global_blocks").catch(() => globalBlocks);
          const todo = t.find((x) => x.id === sess!.todoId);
          const needsBlock = (todo?.blockedSites.length || 0) + g.length > 0;
          if (needsBlock) {
            showToast("Session was active but blocks were cleared (app was closed) — ending session");
            setActive(null);
          }
        }
      } catch {}
    })();
  }, [dbLoaded]);

  // fetch block status
  async function refreshBlockStatus() {
    try {
      const res = await invoke<{ active: boolean; sites: string[] }>("get_block_status");
      setBlockStatus(res);
    } catch {
      setBlockStatus(null);
    }
  }
  async function refreshSavedAuth() {
    try {
      const res = await invoke<{ enabled: boolean; platform: string }>("check_saved_auth");
      setSavedAuth(res);
    } catch {
      setSavedAuth(null);
    }
  }
  async function enableSavedAuth() {
    try {
      const msg = await invoke<string>("enable_saved_auth");
      await refreshSavedAuth();
      showToast(msg);
    } catch (e: any) {
      showToast(`Unable to enable saved authorization: ${String(e).slice(0, 140)}`);
    }
  }
  async function disableSavedAuth() {
    try {
      const msg = await invoke<string>("disable_saved_auth");
      await refreshSavedAuth();
      showToast(msg);
    } catch (e: any) {
      showToast(`Unable to disable saved authorization: ${String(e).slice(0, 140)}`);
    }
  }
  async function refreshHostsPreview() {
    try {
      const txt = await invoke<string>("preview_hosts");
      setHostsPreview(txt);
    } catch {
      setHostsPreview(null);
    }
  }
  useEffect(() => {
    refreshBlockStatus();
    refreshSavedAuth();
    refreshHostsPreview();
  }, []);
  useEffect(() => {
    if (page === "settings") {
      refreshBlockStatus();
      refreshSavedAuth();
      refreshHostsPreview();
    }
  }, [page]);

  // timer tick
  useEffect(() => {
    if (!active) {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }
    // init remaining
    const calc = () => Math.max(0, Math.ceil((active.endAt - Date.now()) / 1000));
    setRemaining(calc());
    intervalRef.current = window.setInterval(() => {
      const r = calc();
      setRemaining(r);
      if (r <= 0) {
        // finished
        if (intervalRef.current) window.clearInterval(intervalRef.current);
        // deactivate blocks
        invoke("deactivate_blocks").catch(() => {});
        setTimeout(() => refreshBlockStatus(), 300);
        setToast(`✓ "${activeTodo?.title || "Task"}" is complete. Blocks cleared.`);
        setTimeout(() => setToast(null), 4000);
        setActive(null);
      }
    }, 1000);
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [active, activeTodo?.title]);

  // prevent window close while session active (hard block — no escape)
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        // rust also prevents, this is for toast UX
        event.preventDefault();
        showToast("Cannot close — session running. Timer must finish. No pause, no escape.");
      })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [active]);

  // cleanup on unmount: deactivate if we are leaving while active? No, only if timer ended.
  // But if user closes window, Rust will clean via on_window_event.

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // global blocks handlers
  function addGlobalSite() {
    const n = normalizeInputSite(globalInput);
    if (!n) {
      setGlobalError("Enter a valid domain, such as youtube.com.");
      showToast("Enter a valid domain, such as youtube.com.");
      return;
    }
    if (globalBlocks.includes(n)) {
      setGlobalError("That domain is already blocked globally.");
      showToast("That domain is already blocked globally.");
      return;
    }
    if (active) {
      setGlobalError("Global blocks cannot change while a session runs.");
      showToast("You cannot change blocked domains during a session.");
      return;
    }
    setGlobalBlocks((p) => [...p, n]);
    setGlobalInput("");
    setGlobalError(null);
  }
  function removeGlobalSite(s: string) {
    if (active) {
      showToast("You cannot change blocked domains during a session.");
      return;
    }
    setGlobalBlocks((p) => p.filter((x) => x !== s));
  }

  // form handlers
  function openAdd() {
    if (active) {
      showToast("You cannot add a task during a session.");
      return;
    }
    lastTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(null);
    setFormTitle("");
    setFormDuration(25);
    setFormSites([]);
    setFormSiteInput("");
    setFormError(null);
    setShowAdd(true);
  }
  function openEdit(todo: Todo) {
    if (active?.todoId === todo.id) {
      showToast("Can't edit running task");
      return;
    }
    if (active) {
      showToast("Can't edit while another session runs");
      return;
    }
    lastTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(todo);
    setFormTitle(todo.title);
    setFormDuration(todo.durationMinutes);
    setFormSites([...todo.blockedSites]);
    setFormSiteInput("");
    setFormError(null);
    setShowAdd(true);
  }
  function addFormSite() {
    const n = normalizeInputSite(formSiteInput);
    if (!n) {
      setFormError({ field: "site", message: "Enter a valid domain, such as youtube.com." });
      showToast("Enter a valid domain, such as youtube.com.");
      return;
    }
    if (formSites.includes(n)) {
      setFormError({ field: "site", message: "That domain is already added to this task." });
      showToast("That domain is already added to this task.");
      return;
    }
    setFormSites((p) => [...p, n]);
    setFormSiteInput("");
    setFormError(null);
  }
  function removeFormSite(s: string) {
    setFormSites((p) => p.filter((x) => x !== s));
  }
  function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const title = formTitle.trim();
    if (!title) {
      setFormError({ field: "title", message: "Enter a title for this task." });
      showToast("Enter a title for this task.");
      titleInputRef.current?.focus();
      return;
    }
    if (formDuration < 1 || formDuration > 480) {
      setFormError({ field: "duration", message: "Enter a duration from 1 to 480 minutes." });
      showToast("Enter a duration from 1 to 480 minutes.");
      durationInputRef.current?.focus();
      return;
    }
    setFormError(null);
    if (editing) {
      setTodos((prev) =>
        prev.map((t) =>
          t.id === editing.id ? { ...t, title, durationMinutes: formDuration, blockedSites: formSites } : t
        )
      );
      showToast("Task updated");
    } else {
      const todo: Todo = {
        id: uid(),
        title,
        durationMinutes: formDuration,
        blockedSites: formSites,
        createdAt: Date.now(),
      };
      setTodos((prev) => [todo, ...prev]);
      showToast("Task added");
    }
    setShowAdd(false);
  }
  function deleteTodo(id: string) {
    if (active?.todoId === id) {
      showToast("You cannot delete the running task.");
      return;
    }
    if (active) {
      showToast("You cannot delete tasks during a session.");
      return;
    }
    if (!confirm("Delete this task?")) return;
    setTodos((p) => p.filter((t) => t.id !== id));
    showToast("Task deleted");
  }

  async function startTodo(todo: Todo) {
    if (active) {
      showToast("A session is already running. Finish it before starting another.");
      return;
    }
    const merged = Array.from(new Set([...globalBlocks, ...todo.blockedSites]));
    // activate blocks — abort if auth rejected (no block = no session)
    try {
      if (merged.length > 0) {
        await invoke("activate_blocks", { sites: merged });
        await refreshBlockStatus();
      } else {
        await invoke("deactivate_blocks").catch(() => {});
      }
    } catch (err: any) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      showToast(`Blocking failed: ${msg.slice(0, 180)} — session not started`);
      return;
    }

    const durationSec = todo.durationMinutes * 60;
    const now = Date.now();
    const sess: ActiveSession = {
      todoId: todo.id,
      startAt: now,
      endAt: now + durationSec * 1000,
      durationSeconds: durationSec,
    };
    setActive(sess);
    setRemaining(durationSec);
    showToast(`Started "${todo.title}" for ${todo.durationMinutes} minutes. Controls are locked until it ends.`);
  }

  const filteredTodos = todos.filter((t) => {
    if (!query.trim()) return true;
    return t.title.toLowerCase().includes(query.toLowerCase());
  });

  const totalMinutes = todos.reduce((a, b) => a + b.durationMinutes, 0);
  const progress = active ? ((active.durationSeconds - remaining) / active.durationSeconds) * 100 : 0;

  return (
    <div className="min-h-screen bg-[#fafaf9] dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 selection:bg-violet-200">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <div ref={appContentRef}>
        <div role="status" className="sr-only" aria-live="polite">{toast ?? ""}</div>
        {/* Header */}
        <header className="sticky top-0 z-30 bg-white dark:bg-zinc-900 dark:bg-zinc-700 border-b border-zinc-200 dark:border-zinc-700 dark:border-zinc-800">
          <div className="max-w-[1100px] mx-auto px-4 sm:px-6 h-[64px] flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-md bg-zinc-900 dark:bg-zinc-800 flex items-center justify-center text-white">
                <img src="/logo.svg" alt="Focus Block" className="w-6 h-6 brightness-0 invert" />
              </div>
              <div>
                <h1 className="font-extrabold tracking-tight leading-none text-[17px]">Focus Block</h1>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium -mt-0.5">Focused work, fewer distractions</p>
              </div>
            </div>
            <nav className="hidden md:flex items-center gap-1 p-1 rounded-md bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700" aria-label="Primary">
              <button
                onClick={() => setPage("focus")}
                aria-current={page === "focus" ? "page" : undefined}
                className={`min-h-11 px-3.5 rounded-md text-xs font-bold transition ${page === "focus" ? "bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"}`}
              >
                ◷ Focus
              </button>
              <button
                onClick={() => setPage("settings")}
                aria-current={page === "settings" ? "page" : undefined}
                className={`min-h-11 px-3.5 rounded-md text-xs font-bold transition ${page === "settings" ? "bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"}`}
              >
                ⚙ Settings {globalBlocks.length > 0 && <span className="ml-1 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px]">{globalBlocks.length}</span>}
              </button>
            </nav>
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="hidden sm:flex items-center gap-2 text-xs">
                <span className="px-2.5 py-1 rounded bg-zinc-900 dark:bg-zinc-700 text-white font-semibold dark:bg-zinc-800 dark:text-zinc-100 border border-transparent dark:border-zinc-700">{todos.length} tasks</span>
                <span className="px-2.5 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-medium dark:text-zinc-300">{totalMinutes} min total</span>
                {blockStatus?.active && (
                  <span className="px-2.5 py-1 rounded bg-red-500 text-white font-semibold animate-pulse">⛔ {blockStatus.sites.length} sites blocked</span>
                )}
              </div>
              <button onClick={() => setDark((v) => !v)} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"} className="min-h-11 w-11 grid place-items-center rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition">{dark ? "☀" : "🌙"}</button>
              <button
                onClick={openAdd}
                disabled={!!active}
                className="inline-flex items-center gap-1.5 min-h-11 px-3.5 rounded-md bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition"
              >
                <span aria-hidden="true" className="text-base leading-none">＋</span> New task
              </button>
            </div>
          </div>
        </header>
        <div className="md:hidden flex justify-center py-3">
          <nav className="flex items-center gap-1 p-1 rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-700" aria-label="Primary">
            <button onClick={() => setPage("focus")} aria-current={page === "focus" ? "page" : undefined} className={`min-h-11 px-4 rounded-md text-xs font-bold ${page === "focus" ? "bg-zinc-900 dark:bg-zinc-700 text-white" : "text-zinc-500 dark:text-zinc-400"}`}>◷ Focus</button>
            <button onClick={() => setPage("settings")} aria-current={page === "settings" ? "page" : undefined} className={`min-h-11 px-4 rounded-md text-xs font-bold ${page === "settings" ? "bg-zinc-900 dark:bg-zinc-700 text-white" : "text-zinc-500 dark:text-zinc-400"}`}>⚙ Settings</button>
          </nav>
        </div>

      <main id="main-content" className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 space-y-8">
        <div className="flex items-end justify-between border-b border-zinc-300 dark:border-zinc-700 pb-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">{page === "focus" ? "Work queue" : "Configuration"}</p>
            <h2 ref={pageHeadingRef} tabIndex={-1} className="mt-1 text-2xl font-extrabold tracking-tight">{page === "focus" ? "Focus tasks" : "Settings"}</h2>
          </div>
          <p className="hidden sm:block text-sm text-zinc-500 dark:text-zinc-400">{page === "focus" ? "Choose one task and start a focused session." : "Control how Focus Block blocks distracting sites."}</p>
        </div>
        {/* Active Session */}
        {active && activeTodo ? (
          <section className="relative overflow-hidden rounded-md bg-zinc-900 dark:bg-zinc-700 text-white p-6 sm:p-8" aria-labelledby="active-session-heading">
            <div className="absolute inset-0 bg-gradient-to-br from-violet-600/30 via-transparent to-fuchsia-500/20 pointer-events-none" />
            <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div className="space-y-3 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-white dark:bg-zinc-900 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 text-xs font-bold">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> ACTIVE SESSION
                  </span>
                  <span className="text-xs text-zinc-400">Controls are locked until the timer ends.</span>
                </div>
                <h3 id="active-session-heading" className="text-2xl sm:text-3xl font-extrabold tracking-tight leading-tight truncate">{activeTodo.title}</h3>
                <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
                  <span className="px-2.5 py-1 rounded bg-white dark:bg-zinc-900 dark:bg-zinc-700/10 border border-white/10">{activeTodo.durationMinutes} minute session</span>
                  {[...globalBlocks, ...activeTodo.blockedSites].length > 0 && (
                    <span className="px-2.5 py-1 rounded bg-red-500/20 border border-red-500/30 text-red-200">
                      ⛔ Blocking {Array.from(new Set([...globalBlocks, ...activeTodo.blockedSites])).join(", ")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 max-w-[60ch]">
                  Blocking is active across browsers through <code className="px-1 py-0.5 rounded bg-white dark:bg-zinc-900 dark:bg-zinc-700/10">/etc/hosts</code>. It will clear when the session ends.
                </p>
              </div>
              <div className="flex flex-col items-center lg:items-end gap-3">
                <div className="text-[56px] sm:text-[72px] font-black tracking-tighter tabular-nums leading-none" role="timer" aria-label={`${formatTime(remaining)} remaining`} aria-live="off">
                  {formatTime(remaining)}
                </div>
                <div className="text-xs font-semibold tracking-widest text-zinc-400">REMAINING</div>
                <div className="w-full lg:w-[320px] h-2 rounded-full bg-white dark:bg-zinc-900 dark:bg-zinc-700/10 overflow-hidden" role="progressbar" aria-label="Focus session progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
                  <div
                    className="h-full bg-white dark:bg-zinc-900 dark:bg-zinc-700 transition-all duration-1000 ease-linear"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium">Started {new Date(active.startAt).toLocaleTimeString()} · ends {new Date(active.endAt).toLocaleTimeString()}</div>
              </div>
            </div>
            {/* subtle grid */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.04]" style={{ backgroundImage: `linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)`, backgroundSize: `24px 24px` }} />
          </section>
        ) : (
          <section className="border-y border-zinc-200 dark:border-zinc-700 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3" aria-label="Session status">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-md bg-violet-50 border border-violet-200 flex items-center justify-center text-violet-600" aria-hidden="true">◷</span>
              <div>
                <p className="font-semibold text-sm">No active session</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Choose a task to start a session. The timer runs until it ends.</p>
              </div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
              {blockStatus?.active ? (
                <span className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700">⚠ Sites remain blocked and will clear on the next start or finish.</span>
              ) : (
                <span className="px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700">✓ No sites are blocked.</span>
              )}
            </div>
          </section>
        )}

        {page === "focus" ? (
          <>
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-200 dark:border-zinc-700 pb-4">
              <div className="relative flex-1 w-full max-w-xl">
                <label htmlFor="task-search" className="block text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400 mb-2">Find a task</label>
                <input
                  id="task-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by task name"
                  className="w-full pl-3 pr-3 py-2.5 rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-700 text-sm outline-none focus:border-violet-500 focus:bg-white placeholder:text-zinc-400"
                />
              </div>
              <div className="flex items-center gap-2 text-xs shrink-0" aria-label={`${todos.length} tasks, ${totalMinutes} minutes total`}>
                <span className="px-2.5 py-1 rounded bg-zinc-900 dark:bg-zinc-700 text-white font-semibold">{todos.length} tasks</span>
                <span className="px-2.5 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-medium">{totalMinutes} min total</span>
                {globalBlocks.length > 0 && <span className="px-2.5 py-1 rounded bg-red-50 border border-red-200 text-red-700 font-medium">🌐 {globalBlocks.length} global</span>}
                {blockStatus?.active && <span className="px-2.5 py-1 rounded bg-red-500 text-white font-semibold animate-pulse">⛔ {blockStatus.sites.length} blocked</span>}
              </div>
            </div>

            {/* Todo grid */}
            {filteredTodos.length === 0 ? (
              <div className="border-y border-zinc-200 dark:border-zinc-700 py-16 text-center">
                <div className="w-12 h-12 mx-auto rounded-md bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 grid place-items-center text-xl mb-3">📋</div>
                <h3 className="font-bold">{todos.length === 0 ? "No tasks yet" : "No matches"}</h3>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 max-w-[40ch] mx-auto">
                  {todos.length === 0 ? "Create a task with a duration and optional blocked domains." : `No tasks match "${query}". Try a different name.`}
                </p>
                {todos.length === 0 && (
                  <button onClick={openAdd} className="mt-4 min-h-11 px-4 py-2 rounded-md bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700">
                    ＋ Create task
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredTodos.map((todo) => {
                  const isRunning = active?.todoId === todo.id;
                  const isLocked = !!active;
                  const isThisLocked = isRunning || isLocked;
                  const mergedCount = new Set([...globalBlocks, ...todo.blockedSites]).size;
                  return (
                    <div
                      key={todo.id}
                      className={`group relative rounded-md border bg-white dark:bg-zinc-900 dark:bg-zinc-700 p-4 flex flex-col gap-3 transition ${isRunning ? "border-violet-300 ring-2 ring-violet-200 bg-violet-50/50 dark:bg-violet-950/30" : "border-zinc-200 dark:border-zinc-700"}`}
                    >
                      {isRunning && (
                        <div className="absolute -top-2 end-3 px-2.5 py-1 rounded bg-violet-600 text-white text-[11px] font-bold flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-white dark:bg-zinc-900 dark:bg-zinc-700 animate-pulse" /> RUNNING
                        </div>
                      )}
                      <div className="flex items-start justify-between gap-2 pr-6">
                        <h4 className="font-bold leading-tight line-clamp-2 flex-1">{todo.title}</h4>
                        <span className="shrink-0 px-2.5 py-1 rounded bg-zinc-900 dark:bg-zinc-700 text-white text-xs font-bold tabular-nums">
                          {todo.durationMinutes} min
                        </span>
                      </div>
                      {isRunning ? (
                        <div className="rounded-md bg-zinc-900 dark:bg-zinc-700 text-white p-3 flex items-center justify-between">
                          <span className="text-xs font-semibold tracking-widest text-zinc-400">TIME REMAINING</span>
                          <span className="text-xl font-black tabular-nums">{formatTime(remaining)}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                          <span className="px-2 py-1 rounded bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">◷ {todo.durationMinutes} minute session</span>
                          {mergedCount > 0 && <span className="px-2 py-1 rounded bg-red-50 border border-red-200 text-red-700">⛔ {mergedCount} blocked site(s)</span>}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1 min-h-[24px]">
                        {todo.blockedSites.length === 0 ? (
                          <span className="text-xs text-zinc-400 italic">No task-specific domains</span>
                        ) : (
                          todo.blockedSites.map((s) => (
                            <span key={s} className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium">
                              {s}
                            </span>
                          ))
                        )}
                        {globalBlocks.length > 0 && (
                          <span className="px-2 py-1 rounded bg-red-50 border border-red-200 text-red-700 text-xs">+ {globalBlocks.length} global</span>
                        )}
                      </div>
                      {isRunning && (
                        <div className="h-1.5 rounded-full bg-zinc-200 overflow-hidden">
                          <div className="h-full bg-violet-600 transition-all duration-1000" style={{ width: `${progress}%` }} />
                        </div>
                      )}
                      <div className="flex gap-2 mt-auto pt-1">
                        <button
                          onClick={() => startTodo(todo)}
                          disabled={!!active}
                          className={`flex-1 inline-flex items-center justify-center gap-1.5 min-h-11 py-2 rounded-md text-sm font-bold transition ${isRunning ? "bg-zinc-900 dark:bg-zinc-700 text-white opacity-60 cursor-not-allowed" : active ? "bg-zinc-100 text-zinc-400 border border-zinc-200 dark:border-zinc-700 cursor-not-allowed" : "bg-violet-600 hover:bg-violet-700 text-white"}`}
                        >
                          {isRunning ? "● Focusing…" : "▶ Start"}
                        </button>
                        <button onClick={() => openEdit(todo)} disabled={isThisLocked} aria-label={`Edit ${todo.title}`} title={isThisLocked ? "Locked while session runs" : "Edit task"} className="min-w-11 min-h-11 px-3 py-2 rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 text-sm font-semibold hover:bg-zinc-50 dark:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed">✎</button>
                        <button onClick={() => deleteTodo(todo.id)} disabled={isThisLocked} aria-label={`Delete ${todo.title}`} title={isThisLocked ? "Locked while session runs" : "Delete task"} className="min-w-11 min-h-11 px-3 py-2 rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 text-sm hover:bg-red-50 hover:border-red-200 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed">✕</button>
                      </div>
                      {isRunning && <p className="text-[11px] text-center text-violet-700 font-medium">The timer cannot be paused, stopped, or edited.</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="space-y-8">
              <section className="border-y border-zinc-200 dark:border-zinc-700 py-6" aria-labelledby="global-blocks-heading">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="max-w-[62ch]">
                    <div className="flex items-center gap-3">
                      <h3 id="global-blocks-heading" className="font-bold text-base">Global blocks</h3>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-[11px] font-semibold">{globalBlocks.length}</span>
                    </div>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">These domains are blocked in every focus session. Task-specific domains are added when you create a task.</p>
                  </div>
                  {active && <span className="self-start text-xs px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700 font-medium">Locked during a session</span>}
                </div>
                <div className="mt-5 flex flex-col sm:flex-row gap-2 max-w-2xl">
                  <div className="flex-1">
                    <label htmlFor="global-site" className="sr-only">Global blocked domain</label>
                    <input id="global-site" name="global-site" type="text" autoComplete="off" value={globalInput} onChange={(e) => { setGlobalInput(e.target.value); setGlobalError(null); }} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addGlobalSite())} placeholder="youtube.com" disabled={!!active} aria-invalid={globalError ? "true" : undefined} aria-describedby={globalError ? "global-site-error" : undefined} className="w-full px-3.5 py-2.5 rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-700 text-sm outline-none focus:border-violet-500 disabled:opacity-50 placeholder:text-zinc-400" />
                    {globalError && <p id="global-site-error" className="mt-1 text-xs text-red-700">{globalError}</p>}
                  </div>
                  <button onClick={addGlobalSite} disabled={!!active} className="min-h-11 px-4 py-2.5 rounded-md bg-zinc-900 dark:bg-zinc-700 text-white text-sm font-semibold hover:bg-black disabled:opacity-40">Add domain</button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-4 min-h-[28px]">
                  {globalBlocks.length === 0 ? <span className="text-xs text-zinc-400 italic">No global domains yet. Add one to block it across all sessions.</span> : globalBlocks.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded bg-red-50 border border-red-200 text-red-700 text-xs font-medium">{s}<button onClick={() => removeGlobalSite(s)} disabled={!!active} aria-label={`Remove ${s} from global blocks`} className="compact-hit grid place-items-center rounded bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-red-200 hover:bg-red-50 disabled:opacity-40">×</button></span>
                  ))}
                </div>
                <p className="mt-4 border-l-2 border-amber-300 pl-3 text-xs text-amber-800">Global and task-specific domains are combined when a session starts. Blocks are applied through <code className="px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">/etc/hosts</code>.</p>
              </section>

              <div className="grid gap-x-8 gap-y-8 lg:grid-cols-2">
                <section className="border-b border-zinc-200 dark:border-zinc-700 pb-6" aria-labelledby="saved-auth-heading">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 id="saved-auth-heading" className="font-bold text-base">Saved authorization</h3>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">Authorize once and Focus Block stops asking for a password — no daily reset.</p>
                    </div>
                    <span className={`shrink-0 px-2.5 py-1 rounded text-xs font-bold border ${savedAuth?.enabled ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-zinc-100 border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400"}`}>{savedAuth?.enabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                    {blockStatus?.active ? <span className="px-2 py-1 rounded bg-red-50 border border-red-200 text-red-700">⛔ {blockStatus.sites.length} sites blocked now</span> : <span className="px-2 py-1 rounded bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400">No sites blocked now</span>}
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {savedAuth?.platform !== "macos" && savedAuth?.platform !== "windows" && (savedAuth?.enabled ? <button onClick={disableSavedAuth} className="min-h-11 px-4 py-2 rounded-md bg-zinc-900 dark:bg-zinc-700 text-white text-sm font-semibold hover:bg-black">Disable saved authorization</button> : <button onClick={enableSavedAuth} className="min-h-11 px-4 py-2 rounded-md bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700">Enable saved authorization</button>)}
                    <button onClick={() => {refreshBlockStatus(); refreshSavedAuth(); refreshHostsPreview(); showToast("Settings refreshed");}} className="min-h-11 px-4 py-2 rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-700 text-sm font-semibold hover:bg-zinc-50 dark:bg-zinc-800">Refresh status</button>
                  </div>
                  <p className="text-xs text-zinc-400 mt-3">{savedAuth && savedAuth.platform !== "linux" ? "Linux only — macOS and Windows ask for system permission at each session start and finish." : "Disabled means Focus Block asks for permission at each session start and finish. Enabling requires one system authorization, then never again until you disable it."}</p>
                </section>

                <section className="border-b border-zinc-200 dark:border-zinc-700 pb-6" aria-labelledby="hosts-heading">
                  <div className="flex items-center justify-between gap-3">
                    <h3 id="hosts-heading" className="font-bold text-base">Hosts diagnostics</h3>
                    <button onClick={refreshHostsPreview} className="min-h-11 px-3 rounded-md bg-zinc-900 dark:bg-zinc-700 text-white text-xs font-semibold">Reload preview</button>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 mt-4 text-xs">
                    <div className="rounded-md border border-zinc-200 dark:border-zinc-700 p-3">
                      <dt className="font-bold text-zinc-700">Blocking status</dt>
                      <dd className={`mt-1 text-sm font-black ${blockStatus?.active ? "text-red-600" : "text-emerald-600"}`}>{blockStatus?.active ? "Active" : "Inactive"}</dd>
                      <dd className="text-[11px] text-zinc-500 dark:text-zinc-400">{blockStatus?.sites.length || 0} site(s) {blockStatus?.active ? "blocked" : "configured"}</dd>
                    </div>
                    <div className="rounded-md border border-zinc-200 dark:border-zinc-700 p-3">
                      <dt className="font-bold text-zinc-700">Blocked sites</dt>
                      <dd className="mt-1 text-[11px] text-zinc-600 break-words">{blockStatus?.sites.join(", ") || "None"}</dd>
                    </div>
                  </dl>
                  {blockStatus?.sites && blockStatus.sites.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{blockStatus.sites.map((s) => <span key={s} className="px-2 py-1 rounded bg-red-50 border border-red-200 text-red-700 text-xs">{s}</span>)}</div>}
                  <div className="mt-4">
                    <p className="text-xs font-bold tracking-widest text-zinc-500 dark:text-zinc-400">/etc/hosts preview</p>
                    <pre className="mt-2 max-h-[220px] overflow-auto rounded-md bg-zinc-900 dark:bg-zinc-700 text-zinc-100 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words">{hostsPreview ? hostsPreview.slice(0, 6000) : "Loading hosts file…"}</pre>
                    <p className="text-xs text-zinc-400 mt-2">Focus Block manages the section between <code className="px-1 py-0.5 bg-white dark:bg-zinc-900 dark:bg-zinc-700 border rounded"># BEGIN FOCUSBLOCKER</code> and <code className="px-1 py-0.5 bg-white dark:bg-zinc-900 dark:bg-zinc-700 border rounded"># END FOCUSBLOCKER</code>.</p>
                  </div>
                </section>
              </div>

              <section className="border-b border-zinc-200 dark:border-zinc-700 pb-6" aria-labelledby="help-heading">
                <h3 id="help-heading" className="font-bold text-base">How blocking works</h3>
                <ul className="mt-3 grid gap-2 text-sm text-zinc-600 lg:grid-cols-2 list-disc pl-5">
                  <li>Create a task with a duration and optional task-specific domains.</li>
                  <li>Starting a task combines global and task-specific domains, including supported aliases.</li>
                  <li>Focus Block updates <code className="px-1 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded border">/etc/hosts</code> so every browser is blocked.</li>
                  <li>Blocks are removed when the timer ends or the window closes.</li>
                </ul>
              </section>
            </div>
          </>
        )}

        <footer className="pt-2 pb-6 text-center text-[11px] text-zinc-400">
          Focus Block · Tauri + React · Domain blocking via <code className="px-1 py-0.5 bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 rounded">/etc/hosts</code>
        </footer>
      </main>
      </div>

      {/* Add/Edit Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="task-dialog-heading">
          <div className="absolute inset-0 bg-zinc-900 dark:bg-zinc-700/60 backdrop-blur-sm" aria-hidden="true" onClick={() => setShowAdd(false)} />
          <form
            ref={modalRef}
            onSubmit={submitForm}
            className="relative w-full max-w-[520px] rounded-md bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-700 p-6 space-y-4 max-h-[90vh] overflow-auto"
          >
            <div className="flex items-center justify-between">
              <h3 id="task-dialog-heading" className="text-lg font-extrabold tracking-tight">{editing ? "Edit task" : "New task"}</h3>
              <button type="button" onClick={() => setShowAdd(false)} aria-label="Close task dialog" className="min-w-11 min-h-11 grid place-items-center rounded-md bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200">
                ×
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="text-xs font-bold tracking-widest text-zinc-500 dark:text-zinc-400">Task title</span>
                <input
                  ref={titleInputRef}
                  id="task-title"
                  name="title"
                  type="text"
                  value={formTitle}
                  onChange={(e) => { setFormTitle(e.target.value); if (formError?.field === "title") setFormError(null); }}
                  placeholder="Example: write project proposal"
                  autoFocus
                  maxLength={80}
                  aria-invalid={formError?.field === "title" ? "true" : undefined}
                  aria-describedby={formError?.field === "title" ? "task-title-error" : undefined}
                  className="mt-1 w-full px-3.5 py-3 rounded-md bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:bg-white dark:bg-zinc-900 dark:bg-zinc-700 focus:border-violet-300 text-sm"
                />
                {formError?.field === "title" && <p id="task-title-error" className="mt-1 text-xs text-red-700">{formError.message}</p>}
              </label>

              <label className="block">
                <span className="text-xs font-bold tracking-widest text-zinc-500 dark:text-zinc-400">Duration in minutes</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    ref={durationInputRef}
                    id="task-duration"
                    name="duration"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={480}
                    value={formDuration}
                    onChange={(e) => { setFormDuration(parseInt(e.target.value) || 0); if (formError?.field === "duration") setFormError(null); }}
                    aria-invalid={formError?.field === "duration" ? "true" : undefined}
                    aria-describedby={formError?.field === "duration" ? "task-duration-error" : "task-duration-help"}
                    className="flex-1 px-3.5 py-3 rounded-md bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:bg-white dark:bg-zinc-900 dark:bg-zinc-700 focus:border-violet-300 text-sm tabular-nums"
                  />
                  <div className="flex gap-1">
                    {[15, 25, 45, 60].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => { setFormDuration(m); if (formError?.field === "duration") setFormError(null); }}
                        aria-pressed={formDuration === m}
                        className={`min-h-11 px-2.5 py-2 rounded-md text-xs font-bold border ${formDuration === m ? "bg-zinc-900 dark:bg-zinc-700 text-white border-zinc-900" : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50"}`}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                </div>
                <span id="task-duration-help" className="text-[11px] text-zinc-500 dark:text-zinc-400">The timer cannot be paused or stopped once it starts.</span>
                {formError?.field === "duration" && <p id="task-duration-error" className="mt-1 text-xs text-red-700">{formError.message}</p>}
              </label>

              <fieldset>
                <legend className="text-xs font-bold tracking-widest text-zinc-500 dark:text-zinc-400">Task-specific domains</legend>
                <p id="task-sites-help" className="text-[11px] text-zinc-500 dark:text-zinc-400">Blocked together with global list when this task runs. Example: twitter.com, youtube.com, reddit.com</p>
                <div className="mt-2 flex gap-2">
                  <div className="flex-1">
                    <label htmlFor="task-site" className="sr-only">Blocked domain for this task</label>
                    <input
                      id="task-site"
                      name="site"
                      type="text"
                      autoComplete="off"
                      value={formSiteInput}
                      onChange={(e) => { setFormSiteInput(e.target.value); if (formError?.field === "site") setFormError(null); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addFormSite();
                        }
                      }}
                      placeholder="youtube.com"
                      aria-invalid={formError?.field === "site" ? "true" : undefined}
                      aria-describedby={formError?.field === "site" ? "task-site-error" : "task-sites-help"}
                      className="w-full px-3.5 py-2.5 rounded-md bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:bg-white dark:bg-zinc-900 dark:bg-zinc-700 focus:border-violet-300 text-sm"
                    />
                    {formError?.field === "site" && <p id="task-site-error" className="mt-1 text-xs text-red-700">{formError.message}</p>}
                  </div>
                  <button type="button" onClick={addFormSite} className="min-h-11 px-4 py-2.5 rounded-md bg-zinc-900 dark:bg-zinc-700 text-white text-sm font-semibold">
                    Add domain
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2 min-h-[28px]">
                  {formSites.length === 0 ? (
                    <span className="text-xs text-zinc-400 italic">No task-specific domains</span>
                  ) : (
                    formSites.map((s) => (
                      <span key={s} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium">
                        {s}
                        <button type="button" onClick={() => removeFormSite(s)} aria-label={`Remove ${s} from this task`} className="compact-hit grid place-items-center rounded bg-white dark:bg-zinc-900 dark:bg-zinc-700 border border-amber-200">
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>
                {globalBlocks.length > 0 && (
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">{globalBlocks.length} global domain(s) will also be blocked: {globalBlocks.join(", ")}</p>
                )}
              </fieldset>
            </div>

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setShowAdd(false)} className="flex-1 min-h-11 py-3 rounded-md bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 font-semibold text-sm">
                Cancel
              </button>
              <button type="submit" className="flex-1 min-h-11 py-3 rounded-md bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm">
                {editing ? "Save changes" : "Create task"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-zinc-900 dark:bg-zinc-700 text-white text-sm font-medium shadow-xl flex items-center gap-2 max-w-[90vw]" role="status">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="truncate">{toast}</span>
        </div>
      )}
    </div>
  );
}
