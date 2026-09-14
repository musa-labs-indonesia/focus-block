import { useEffect, useState, useRef, useMemo, useId } from "react";
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

/* ── design-system primitives ──────────────────────────────────────────────────────────────────
 * Small, local, no dependency. They exist so the rules in design.md are enforced by the markup
 * instead of by remembering them: two button shapes, hairline chips, one dot per status, roman
 * headings, and no emoji anywhere (emoji render differently on every OS).
 */

type IconName =
  | "clock"
  | "sliders"
  | "sun"
  | "moon"
  | "plus"
  | "pencil"
  | "close"
  | "info"
  | "alert";

const ICONS: Record<IconName, React.ReactElement> = {
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8.2l2.4 1.4" />
    </>
  ),
  sliders: (
    <>
      <path d="M2 5.5h12M2 10.5h12" />
      <circle cx="5.5" cy="5.5" r="1.6" />
      <circle cx="10.5" cy="10.5" r="1.6" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </>
  ),
  moon: <path d="M14 8.5A6 6 0 1 1 7.5 2 4.7 4.7 0 0 0 14 8.5z" />,
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  pencil: <path d="M3 13l.7-3 6.9-6.9 2.3 2.3L6 12.3z" />,
  close: <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.4v3.4" />
      <path d="M8 5.3h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.9v3.6" />
      <path d="M8 11.2h.01" />
    </>
  ),
};

function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {ICONS[name]}
    </svg>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 min-h-11 rounded-md px-4 text-sm font-semibold transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed";

const BUTTON_VARIANTS = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover",
  secondary: "border border-rule-2 bg-paper text-ink hover:bg-paper-2",
  danger: "border border-rule-2 bg-paper text-danger hover:border-danger hover:bg-danger-paper",
  quiet: "text-ink-2 hover:bg-paper-2 hover:text-ink",
} as const;

function Button({
  variant = "secondary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return <button type="button" {...rest} className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`} />;
}

function StatusDot({ tone }: { tone: "accent" | "ok" | "muted" | "danger" }) {
  const fill = { accent: "bg-accent", ok: "bg-ok", danger: "bg-danger", muted: "bg-ink-3/40" }[tone];
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${fill}`} />;
}

/** A domain, a count or a state — hairline, never a filled pill. */
function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm border border-rule bg-paper px-1.5 py-0.5 text-xs text-ink-2 ${className}`}>
      {children}
    </span>
  );
}

/** The mechanism goes here, not in the main flow: a small icon that explains on click or focus. */
function Info({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
        className="grid h-6 w-6 place-items-center rounded-sm text-ink-3 transition-colors duration-150 hover:text-ink"
      >
        <Icon name="info" className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-0 top-8 z-40 w-[min(20rem,80vw)] rounded-md border border-rule bg-paper p-3 text-xs font-normal leading-relaxed text-ink-2 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** A hairline rule with a small caps label — the only section divider in the app. */
function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h3 id={id} className="border-b border-rule pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">
      {children}
    </h3>
  );
}

function NavTab({
  current,
  onClick,
  icon,
  badge,
  children,
}: {
  current: boolean;
  onClick: () => void;
  icon: IconName;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      className={`relative inline-flex min-h-11 items-center gap-2 px-2.5 text-sm font-medium transition-colors duration-150 ${
        current ? "text-ink" : "text-ink-2 hover:text-ink"
      }`}
    >
      <Icon name={icon} />
      {children}
      {badge ? <span className="tabular rounded-sm bg-paper-3 px-1.5 text-[11px] font-semibold text-ink-2">{badge}</span> : null}
      <span aria-hidden="true" className={`absolute inset-x-2 bottom-0 h-px ${current ? "bg-accent" : "bg-transparent"}`} />
    </button>
  );
}

// Main Component
type Schedule = {
  id: string;
  startHour: number;
  endHour: number;
  sites: string[];
  createdAt: number;
};

// start options 0-23 and end options 1-24: a window always moves forward, which keeps "cannot overlap"
// unambiguous, and matches the backend's CHECK constraints
const START_HOURS = Array.from({ length: 24 }, (_, i) => i);
const END_HOURS = Array.from({ length: 24 }, (_, i) => i + 1);
const MAX_SCHEDULES = 2;

/** Mirrors the backend rule so the UI can refuse an overlap before a round trip. */
function validateSchedules(list: Schedule[]): string | null {
  if (list.length > MAX_SCHEDULES) return `At most ${MAX_SCHEDULES} scheduled blocks.`;
  for (const r of list) {
    if (r.startHour >= r.endHour) return "Each rule needs a start hour before its end hour.";
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.startHour < b.endHour && b.startHour < a.endHour) return "Scheduled blocks cannot overlap.";
    }
  }
  return null;
}

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
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [ruleInputs, setRuleInputs] = useState<Record<string, string>>({});
  const [activeRuleIds, setActiveRuleIds] = useState<string[]>([]);
  const [savedAuth, setSavedAuth] = useState<{ enabled: boolean; platform: string; helper_version: number } | null>(null);
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
        const [t, g, s, sch] = await Promise.all([
          invoke<Todo[]>("get_todos"),
          invoke<string[]>("get_global_blocks"),
          invoke<ActiveSession | null>("get_active_session"),
          invoke<Schedule[]>("get_schedules"),
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
        setSchedules(sch);
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
    // the backend validates as well; a rejected list (overlap, too many) is reported and the previously
    // stored one stays in force
    invoke("save_schedules", { schedules }).catch((e) =>
      showToast(`Scheduled blocks were not saved: ${String(e).slice(0, 120)}`),
    );
  }, [schedules, dbLoaded]);

  // Schedules only apply while the app is open, so recompute what should be blocked every half minute
  // and after anything that changes it. sync_blocks writes only when the file would actually differ, so
  // a tick that changes nothing costs nothing and asks for no password.
  const sessionSitesRef = useRef<string[]>([]);
  sessionSitesRef.current = active
    ? Array.from(new Set([...globalBlocks, ...(todos.find((t) => t.id === active.todoId)?.blockedSites ?? [])]))
    : [];
  useEffect(() => {
    if (!dbLoaded) return;
    let cancelled = false;
    async function sync() {
      try {
        const res = await invoke<{ changed: boolean; blocked: number; activeRuleIds: string[] }>("sync_blocks", {
          hour: new Date().getHours(),
          sessionSites: sessionSitesRef.current,
        });
        if (cancelled) return;
        setActiveRuleIds(res.activeRuleIds);
        if (res.changed) {
          await refreshBlockStatus();
          await refreshHostsPreview();
        }
      } catch {}
    }
    sync();
    const id = window.setInterval(sync, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [dbLoaded, schedules, globalBlocks, active]);
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
          // recompute what should be blocked rather than assuming nothing should be: a scheduled window
          // may legitimately be running right now, in which case the block is not an orphan
          try {
            const res = await invoke<{ changed: boolean; blocked: number }>("sync_blocks", {
              hour: new Date().getHours(),
              sessionSites: [],
            });
            await refreshBlockStatus();
            await refreshHostsPreview();
            if (res.changed) {
              showToast(
                res.blocked === 0
                  ? "Leftover block from a previous session cleared"
                  : `A scheduled window is still holding ${res.blocked} ${res.blocked === 1 ? "site" : "sites"}`,
              );
            }
          } catch (e: any) {
            showToast(`Could not clean up the leftover block: ${String(e).slice(0, 120)} — clear manually in Settings`);
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
      const res = await invoke<{ enabled: boolean; platform: string; helper_version: number }>("check_saved_auth");
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
        // The same writer that opened the session closes it: sync_blocks recomputes the union without
        // this session, so a scheduled window that is open right now keeps its domains instead of being
        // wiped by a blind clear, and the toast reports what was actually written.
        invoke<{ changed: boolean; blocked: number; activeRuleIds: string[] }>("sync_blocks", {
          hour: new Date().getHours(),
          sessionSites: [],
        })
          .then((res) => {
            setActiveRuleIds(res.activeRuleIds);
            setToast(
              res.blocked === 0
                ? `✓ "${activeTodo?.title || "Task"}" is complete. Blocks cleared.`
                : `✓ "${activeTodo?.title || "Task"}" is complete. ${res.blocked} ${res.blocked === 1 ? "site" : "sites"} still blocked by a scheduled window.`,
            );
          })
          .catch((e) => setToast(`Session ended, but blocks were not cleared: ${String(e).slice(0, 120)}`));
        setTimeout(() => refreshBlockStatus(), 300);
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
    try {
      getCurrentWindow()
        .onCloseRequested((event) => {
          // rust also prevents, this is for toast UX
          event.preventDefault();
          showToast("Cannot close — session running. Timer must finish. No pause, no escape.");
        })
        .then((fn) => (unlisten = fn))
        .catch(() => {});
    } catch {
      // `npm run dev` in a plain browser has no native window, and this call throws synchronously when
      // it is missing — inside an effect, so it took the whole tree down with it. The rust close handler
      // is the real guard; this listener only adds the toast.
      return;
    }
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

  // --- scheduled blocks ---
  function commitSchedules(next: Schedule[]) {
    const problem = validateSchedules(next);
    if (problem) {
      setScheduleError(problem);
      showToast(problem);
      return;
    }
    setScheduleError(null);
    setSchedules(next);
  }
  function addRule() {
    if (schedules.length >= MAX_SCHEDULES) {
      showToast(`At most ${MAX_SCHEDULES} scheduled blocks.`);
      return;
    }
    // offer a three hour window that cannot overlap what is already there
    const clashes = (start: number) => schedules.some((r) => start < r.endHour && r.startHour < start + 3);
    const start = [7, 12, 17, 20, 0].find((s) => !clashes(s));
    if (start === undefined) {
      showToast("No free window left — adjust or remove a rule first.");
      return;
    }
    const now = Date.now();
    commitSchedules([
      ...schedules,
      { id: `sch_${now}`, startHour: start, endHour: start + 3, sites: [], createdAt: now },
    ]);
  }
  function updateRule(id: string, patch: Partial<Schedule>) {
    commitSchedules(schedules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRule(id: string) {
    setRuleInputs((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
    commitSchedules(schedules.filter((r) => r.id !== id));
  }
  function addRuleSite(id: string) {
    const rule = schedules.find((r) => r.id === id);
    if (!rule) return;
    const site = normalizeInputSite(ruleInputs[id] ?? "");
    if (!site) {
      showToast("Enter a valid domain, such as youtube.com.");
      return;
    }
    if (rule.sites.includes(site)) {
      showToast("That domain is already in this rule.");
      return;
    }
    commitSchedules(schedules.map((r) => (r.id === id ? { ...r, sites: [...r.sites, site] } : r)));
    setRuleInputs((p) => ({ ...p, [id]: "" }));
  }
  function removeRuleSite(id: string, site: string) {
    commitSchedules(schedules.map((r) => (r.id === id ? { ...r, sites: r.sites.filter((s) => s !== site) } : r)));
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
    // no toast: the row disappearing is the feedback. Success stays quiet, refusals speak up.
    setTodos((p) => p.filter((t) => t.id !== id));
  }

  async function startTodo(todo: Todo) {
    if (active) {
      showToast("A session is already running. Finish it before starting another.");
      return;
    }
    const merged = Array.from(new Set([...globalBlocks, ...todo.blockedSites]));
    // sync_blocks is the only writer: it unions globals, this task's domains and every open scheduled
    // window, so starting a session adds to a window's block instead of replacing it. It also skips the
    // privileged write when the file already says this, so a start that changes nothing costs nothing.
    // No block = no session: a rejected write, or a list where nothing survives validation, aborts.
    try {
      const res = await invoke<{ changed: boolean; blocked: number; activeRuleIds: string[] }>("sync_blocks", {
        hour: new Date().getHours(),
        sessionSites: merged,
      });
      setActiveRuleIds(res.activeRuleIds);
      if (merged.length > 0 && res.blocked === 0) {
        showToast("Nothing in that list is a usable domain — session not started");
        return;
      }
      await refreshBlockStatus();
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
  // what a running session is actually holding shut, for the instrument's domain list
  const runningSites = active && activeTodo ? Array.from(new Set([...globalBlocks, ...activeTodo.blockedSites])) : [];

  return (
    <div className="min-h-screen bg-[#fafaf9] dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 selection:bg-violet-200">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <div ref={appContentRef}>
        <div role="status" className="sr-only" aria-live="polite">{toast ?? ""}</div>
        {/* Shell */}
        <header className="sticky top-0 z-30 border-b border-rule bg-paper/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1100px] items-center gap-6 px-6">
            <div className="flex items-center gap-2.5">
              <img src="/logo.svg" alt="" className="h-6 w-6" />
              <h1 className="font-display text-base font-semibold tracking-tight">Focus Block</h1>
            </div>
            <nav className="flex items-center gap-1" aria-label="Primary">
              <NavTab current={page === "focus"} onClick={() => setPage("focus")} icon="clock">
                Focus
              </NavTab>
              <NavTab current={page === "settings"} onClick={() => setPage("settings")} icon="sliders" badge={globalBlocks.length}>
                Settings
              </NavTab>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {blockStatus && (
                <span className="mr-2 hidden items-center gap-2 text-xs text-ink-2 lg:flex">
                  <StatusDot tone={blockStatus.active ? "accent" : "muted"} />
                  {blockStatus.active ? `${blockStatus.sites.length} site${blockStatus.sites.length === 1 ? "" : "s"} blocked` : "Nothing blocked"}
                </span>
              )}
              <button
                type="button"
                onClick={() => setDark((v) => !v)}
                aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
                title={dark ? "Light mode" : "Dark mode"}
                className="grid h-11 w-11 place-items-center rounded-md text-ink-2 transition-colors duration-150 hover:bg-paper-2 hover:text-ink"
              >
                <Icon name={dark ? "sun" : "moon"} />
              </button>
              <Button variant="primary" onClick={openAdd} disabled={!!active}>
                <Icon name="plus" /> New task
              </Button>
            </div>
          </div>
        </header>

      <main id="main-content" className="mx-auto max-w-[1100px] px-6 pb-16 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
          <div>
            <h2 ref={pageHeadingRef} tabIndex={-1} className="text-2xl font-semibold">
              {page === "focus" ? "Focus" : "Settings"}
            </h2>
            <p className="mt-1 text-sm text-ink-2">
              {page === "focus"
                ? "Pick one task. The timer cannot be paused or stopped."
                : "What gets blocked, when, and whether Focus Block can act without a password."}
            </p>
          </div>
          {page === "focus" && (
            <p className="flex items-center gap-3 text-xs text-ink-2">
              <span className="tabular">
                {todos.length} {todos.length === 1 ? "task" : "tasks"}
              </span>
              <span aria-hidden="true" className="h-3 w-px bg-rule-2" />
              <span className="tabular">{totalMinutes} min</span>
            </p>
          )}
        </div>
        {/* The instrument: expanded while a session runs, one quiet line when idle */}
        {active && activeTodo ? (
          <section
            className="mt-6 overflow-hidden rounded-md border border-l-2 border-rule border-l-accent bg-paper-2"
            aria-labelledby="active-session-heading"
          >
            <div className="flex flex-wrap items-start justify-between gap-6 p-6">
              <div className="min-w-0 space-y-3">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-2">
                  <StatusDot tone="accent" /> Running
                </p>
                <h3 id="active-session-heading" className="truncate text-xl font-semibold">
                  {activeTodo.title}
                </h3>
                <p className="text-sm text-ink-2">
                  {activeTodo.durationMinutes} minute session · ends at{" "}
                  {new Date(active.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · no pause, no stop
                </p>
                {runningSites.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-ink-3">Blocked in every browser:</span>
                    {runningSites.map((s) => (
                      <Chip key={s}>{s}</Chip>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-ink-3">This task has no domains of its own, so nothing is blocked while it runs.</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <div
                  className="timer-digits text-timer leading-none"
                  role="timer"
                  aria-label={`${formatTime(remaining)} remaining`}
                  aria-live="off"
                >
                  {formatTime(remaining)}
                </div>
                <p className="text-xs uppercase tracking-[0.14em] text-ink-3">remaining</p>
              </div>
            </div>
            <div
              className="h-0.5 w-full bg-rule"
              role="progressbar"
              aria-label="Focus session progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <div className="h-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
            </div>
          </section>
        ) : (
          <section
            className={`mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3 ${page === "settings" ? "max-w-[68ch]" : ""}`}
            aria-label="Session status"
          >
            <p className="flex items-center gap-2 text-sm text-ink-2">
              <StatusDot tone={blockStatus?.active ? "accent" : "muted"} />
              {blockStatus?.active
                ? `${blockStatus.sites.length} ${blockStatus.sites.length === 1 ? "site" : "sites"} blocked right now`
                : "Nothing is blocked right now"}
            </p>
            <p className="text-xs text-ink-3">
              {blockStatus?.active ? "Clears when the window ends." : "Start a task to block its domains."}
            </p>
          </section>
        )}

        {page === "focus" ? (
          <>
            {/* Search */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
              <label className="relative w-full max-w-sm">
                <span className="sr-only">Find a task</span>
                <input
                  id="task-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a task"
                  className="w-full rounded-md border border-rule-2 bg-paper px-3 py-2.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-accent"
                />
              </label>
              <p className="flex items-center gap-3 text-xs text-ink-3">
                {globalBlocks.length > 0 && (
                  <>
                    <span className="tabular">{globalBlocks.length} global</span>
                    <span aria-hidden="true" className="h-3 w-px bg-rule-2" />
                  </>
                )}
                <span>{blockStatus?.active ? `${blockStatus.sites.length} blocked now` : "idle"}</span>
              </p>
            </div>

            {/* Ledger — one row per task, hairlines between, no card chrome */}
            {filteredTodos.length === 0 ? (
              <div className="mt-8 border-y border-rule py-16 text-center">
                <h3 className="text-lg font-semibold">{todos.length === 0 ? "No tasks yet" : "No matches"}</h3>
                <p className="mx-auto mt-1 max-w-[46ch] text-sm text-ink-2">
                  {todos.length === 0
                    ? "A task is a length of time plus the sites to shut while it runs."
                    : `Nothing matches \u201c${query}\u201d.`}
                </p>
                {todos.length === 0 && (
                  <Button variant="primary" className="mt-5" onClick={openAdd}>
                    <Icon name="plus" /> New task
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="mt-8 hidden items-center gap-4 border-b border-rule pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-3 sm:flex">
                  <span className="flex-1">Task</span>
                  <span className="w-16 text-right">Length</span>
                  <span className="w-[38%]">Domains</span>
                  <span className="w-[136px] text-right">Actions</span>
                </div>
                <ul className="divide-y divide-rule">
                  {filteredTodos.map((todo) => {
                    const isRunning = active?.todoId === todo.id;
                    const isLocked = !!active;
                    const isThisLocked = isRunning || isLocked;
                    const mergedCount = new Set([...globalBlocks, ...todo.blockedSites]).size;
                    return (
                      <li
                        key={todo.id}
                        className={`flex flex-wrap items-center gap-x-4 gap-y-2 py-3 ${isRunning ? "bg-accent-paper/50" : ""}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 truncate font-medium text-ink">
                            {isRunning && <StatusDot tone="accent" />}
                            {todo.title}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-3">
                            {mergedCount > 0
                              ? `${mergedCount} ${mergedCount === 1 ? "site" : "sites"} blocked`
                              : "nothing blocked"}
                            {isRunning && " · running now"}
                          </p>
                        </div>
                        <span className="tabular w-16 text-right text-sm text-ink-2">{todo.durationMinutes}m</span>
                        <div className="flex w-[38%] min-w-0 flex-wrap items-center gap-1">
                          {todo.blockedSites.slice(0, 3).map((s) => (
                            <Chip key={s}>{s}</Chip>
                          ))}
                          {todo.blockedSites.length > 3 && <span className="text-xs text-ink-3">+{todo.blockedSites.length - 3}</span>}
                          {todo.blockedSites.length === 0 && (
                            <span className="text-xs text-ink-3">{globalBlocks.length > 0 ? "your global list only" : "\u2014"}</span>
                          )}
                        </div>
                        <div className="flex w-[136px] items-center justify-end gap-1">
                          <Button
                            variant={isRunning ? "secondary" : "primary"}
                            onClick={() => startTodo(todo)}
                            disabled={!!active}
                            className="min-w-[92px] px-3"
                          >
                            {isRunning ? "Running" : "Start"}
                          </Button>
                          <button
                            type="button"
                            onClick={() => openEdit(todo)}
                            disabled={isThisLocked}
                            aria-label={`Edit ${todo.title}`}
                            title={isThisLocked ? "Locked while a session runs" : "Edit"}
                            className="grid h-11 w-11 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-paper-2 hover:text-ink disabled:opacity-45 disabled:cursor-not-allowed"
                          >
                            <Icon name="pencil" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteTodo(todo.id)}
                            disabled={isThisLocked}
                            aria-label={`Delete ${todo.title}`}
                            title={isThisLocked ? "Locked while a session runs" : "Delete"}
                            className="grid h-11 w-11 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-danger-paper hover:text-danger disabled:opacity-45 disabled:cursor-not-allowed"
                          >
                            <Icon name="close" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        ) : (
          <>
            <div className="mt-8 max-w-[68ch] space-y-10">
              <section className="space-y-4" aria-labelledby="global-blocks-heading">
                <SectionLabel id="global-blocks-heading">Blocking</SectionLabel>
                <p className="text-sm text-ink-2">
                  These sites are shut in every session. A task can add its own list on top of this one.
                </p>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="global-site" className="sr-only">Site to block everywhere</label>
                    <input id="global-site" name="global-site" type="text" autoComplete="off" value={globalInput} onChange={(e) => { setGlobalInput(e.target.value); setGlobalError(null); }} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addGlobalSite())} placeholder="youtube.com" disabled={!!active} aria-invalid={globalError ? "true" : undefined} aria-describedby={globalError ? "global-site-error" : undefined} className="w-full rounded-md border border-rule-2 bg-paper px-3 py-2.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-accent disabled:opacity-45" />
                    {globalError && <p id="global-site-error" role="alert" className="mt-1.5 text-xs text-danger">{globalError}</p>}
                  </div>
                  <Button variant="secondary" onClick={addGlobalSite} disabled={!!active}>Add</Button>
                </div>
                {active && <p className="text-xs text-ink-3">Locked while a session runs.</p>}
                <div className="flex flex-wrap items-center gap-1.5">
                  {globalBlocks.length === 0 ? (
                    <span className="text-sm text-ink-3">Nothing is blocked everywhere yet.</span>
                  ) : (
                    globalBlocks.map((s) => (
                      <Chip key={s}>
                        {s}
                        <button
                          type="button"
                          onClick={() => removeGlobalSite(s)}
                          disabled={!!active}
                          aria-label={`Remove ${s} from the global list`}
                          className="compact-hit grid place-items-center rounded-sm text-ink-3 transition-colors duration-150 hover:text-danger disabled:opacity-45"
                        >
                          <Icon name="close" className="h-3 w-3" />
                        </button>
                      </Chip>
                    ))
                  )}
                </div>
              </section>

              <div className="space-y-10">
                <section className="space-y-4" aria-labelledby="saved-auth-heading">
                  <SectionLabel id="saved-auth-heading">Authorization</SectionLabel>
                  <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                    <StatusDot tone={savedAuth?.enabled ? "ok" : "muted"} />
                    {savedAuth?.enabled
                      ? "Focus Block can change blocking without asking for a password."
                      : savedAuth?.platform === "linux"
                        ? "Focus Block will ask for your password when a block starts and stops."
                        : savedAuth
                          ? "Focus Block will ask for permission when a block starts and stops."
                          : "Checking…"}
                    <Info label="authorization">
                      Enabling installs a small program at <code>/usr/local/bin/focusblock-apply</code> and a rule at{" "}
                      <code>/etc/sudoers.d/focusblock</code> that lets it run as the system administrator. The rule
                      allows exactly two things: block a list of sites, or clear them. Disabling removes both files.
                    </Info>
                  </p>
                  {savedAuth?.helper_version === 1 && (
                    <p className="border-l-2 border-warn pl-3 text-sm text-warn">
                      An older version of Focus Block installed this. Press Enable to replace it — one password.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {savedAuth?.platform === "linux" &&
                      (savedAuth?.enabled ? (
                        <Button variant="secondary" onClick={disableSavedAuth}>Disable</Button>
                      ) : (
                        <Button variant="primary" onClick={enableSavedAuth}>Enable</Button>
                      ))}
                    <Button
                      variant="quiet"
                      onClick={() => {
                        refreshBlockStatus();
                        refreshSavedAuth();
                        refreshHostsPreview();
                      }}
                    >
                      Refresh
                    </Button>
                  </div>
                </section>

                <section className="space-y-4" aria-labelledby="schedule-heading">
                  <SectionLabel id="schedule-heading">Scheduled blocks</SectionLabel>
                  <p className="text-sm text-ink-2">
                    Up to {MAX_SCHEDULES} windows a day. While one is open, its sites and your global list are
                    blocked. They cannot overlap.
                  </p>
                  {scheduleError && <p role="alert" className="border-l-2 border-danger pl-3 text-sm text-danger">{scheduleError}</p>}
                  <div className="space-y-5">
                    {schedules.map((rule) => {
                      const blockedNow = activeRuleIds.includes(rule.id);
                      return (
                        <div key={rule.id} className={`space-y-3 border-l-2 pl-3 ${blockedNow ? "border-accent" : "border-rule"}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <label htmlFor={`start-${rule.id}`} className="sr-only">Start hour</label>
                            <select id={`start-${rule.id}`} value={rule.startHour} onChange={(e) => updateRule(rule.id, { startHour: Number(e.target.value) })} className="tabular rounded-md border border-rule-2 bg-paper px-2 py-2 text-sm text-ink outline-none transition-colors duration-150 focus:border-accent">
                              {START_HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                            </select>
                            <span className="text-sm text-ink-3">to</span>
                            <label htmlFor={`end-${rule.id}`} className="sr-only">End hour</label>
                            <select id={`end-${rule.id}`} value={rule.endHour} onChange={(e) => updateRule(rule.id, { endHour: Number(e.target.value) })} className="tabular rounded-md border border-rule-2 bg-paper px-2 py-2 text-sm text-ink outline-none transition-colors duration-150 focus:border-accent">
                              {END_HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                            </select>
                            <span className="text-sm text-ink-3">every day</span>
                            {blockedNow && (
                              <span className="flex items-center gap-2 text-xs font-semibold text-accent">
                                <StatusDot tone="accent" /> blocked now
                              </span>
                            )}
                            <Button variant="quiet" className="ml-auto px-2 text-xs" onClick={() => removeRule(rule.id)}>
                              Remove
                            </Button>
                          </div>
                          <div className="flex flex-wrap items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <label htmlFor={`site-${rule.id}`} className="sr-only">Site for this window</label>
                              <input id={`site-${rule.id}`} type="text" autoComplete="off" value={ruleInputs[rule.id] ?? ""} onChange={(e) => setRuleInputs((p) => ({ ...p, [rule.id]: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRuleSite(rule.id))} placeholder="x.com" className="w-full rounded-md border border-rule-2 bg-paper px-3 py-2.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-accent" />
                            </div>
                            <Button variant="secondary" onClick={() => addRuleSite(rule.id)}>Add</Button>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {rule.sites.length === 0 ? (
                              <span className="text-xs text-ink-3">No sites of its own — the global list still applies in this window.</span>
                            ) : (
                              rule.sites.map((s) => (
                                <Chip key={s}>
                                  {s}
                                  <button
                                    type="button"
                                    onClick={() => removeRuleSite(rule.id, s)}
                                    aria-label={`Remove ${s} from this window`}
                                    className="compact-hit grid place-items-center rounded-sm text-ink-3 transition-colors duration-150 hover:text-danger"
                                  >
                                    <Icon name="close" className="h-3 w-3" />
                                  </button>
                                </Chip>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {schedules.length < MAX_SCHEDULES && (
                      <Button variant="secondary" onClick={addRule}>
                        <Icon name="plus" /> Add window
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-ink-3">
                    A window applies while Focus Block is open — closing the app releases it.
                    {savedAuth && !savedAuth.enabled && " Without authorization, opening and closing a window each asks for a password."}
                  </p>
                </section>

                <section className="space-y-3" aria-labelledby="hosts-heading">
                  <SectionLabel id="hosts-heading">Technical details</SectionLabel>
                  <p className="text-sm text-ink-2">
                    Everything above works through one system file. Nothing here needs your attention unless you are
                    troubleshooting.
                  </p>
                  <details className="mt-1">
                    <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink-2 transition-colors duration-150 hover:text-ink">
                      <span className="tabular">{blockStatus?.active ? `${blockStatus.sites.length} blocked` : "nothing blocked"}</span>
                      <span className="text-ink-3">· show the file Focus Block manages</span>
                    </summary>
                    <div className="mt-4 space-y-3">
                      <p className="text-xs text-ink-3">
                        The managed region is the part between <code># BEGIN FOCUSBLOCKER</code> and{" "}
                        <code># END FOCUSBLOCKER</code> in <code>/etc/hosts</code>.
                        {savedAuth?.platform ? ` System: ${savedAuth.platform}.` : ""}
                        {savedAuth?.helper_version ? ` Helper protocol: v${savedAuth.helper_version}.` : ""}
                      </p>
                      <p className="text-xs text-ink-3">Blocked right now: {blockStatus?.sites.join(", ") || "none"}</p>
                      <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-rule bg-paper-2 p-3 font-mono text-[11px] leading-relaxed text-ink-2">
                        {hostsPreview ? hostsPreview.slice(0, 6000) : "Reading the file…"}
                      </pre>
                      <Button variant="secondary" onClick={refreshHostsPreview}>Reload</Button>
                    </div>
                  </details>
                </section>
              </div>

              <section className="space-y-3" aria-labelledby="help-heading">
                <SectionLabel id="help-heading">How it works</SectionLabel>
                <ol className="ml-4 list-decimal space-y-1.5 text-sm text-ink-2">
                  <li>Pick a task. Focus Block hides its sites until the timer runs out.</li>
                  <li>Every browser is covered, including tabs you already have open.</li>
                  <li>When the timer ends, the sites come back.</li>
                </ol>
              </section>
            </div>
          </>
        )}

        <footer className="mt-16 border-t border-rule pt-4 text-xs text-ink-3">
          Focus Block · runs on this computer only. No account, nothing sent anywhere.
        </footer>
      </main>
      </div>

      {/* Add/Edit Modal — a raised sheet on a scrim, one column, label above field */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="task-dialog-heading">
          <div className="absolute inset-0 bg-ink/45 backdrop-blur-sm" aria-hidden="true" onClick={() => setShowAdd(false)} />
          <form
            ref={modalRef}
            onSubmit={submitForm}
            className="relative max-h-[90vh] w-full max-w-[520px] space-y-5 overflow-auto rounded-lg border border-rule bg-paper p-6 shadow-[var(--t-shadow-sheet)]"
          >
            <div className="flex items-center justify-between gap-4">
              <h3 id="task-dialog-heading" className="text-lg font-semibold">{editing ? "Edit task" : "New task"}</h3>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                aria-label="Close task dialog"
                className="grid h-11 w-11 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-paper-2 hover:text-ink"
              >
                <Icon name="close" />
              </button>
            </div>

            <div className="space-y-4">
              <label className="block" htmlFor="task-title">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">Task title</span>
                <input
                  ref={titleInputRef}
                  id="task-title"
                  name="title"
                  type="text"
                  value={formTitle}
                  onChange={(e) => { setFormTitle(e.target.value); if (formError?.field === "title") setFormError(null); }}
                  placeholder="Write the project proposal"
                  autoFocus
                  maxLength={80}
                  aria-invalid={formError?.field === "title" ? "true" : undefined}
                  aria-describedby={formError?.field === "title" ? "task-title-error" : undefined}
                  className="mt-1.5 w-full rounded-md border border-rule-2 bg-paper px-3 py-2.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-accent"
                />
                {formError?.field === "title" && <p id="task-title-error" role="alert" className="mt-1.5 text-xs text-danger">{formError.message}</p>}
              </label>

              <div>
                <label className="block" htmlFor="task-duration">
                  <span className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">Minutes</span>
                </label>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
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
                    className="tabular w-24 rounded-md border border-rule-2 bg-paper px-3 py-2.5 text-sm text-ink outline-none transition-colors duration-150 focus:border-accent"
                  />
                  <div className="flex gap-1">
                    {[15, 25, 45, 60].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => { setFormDuration(m); if (formError?.field === "duration") setFormError(null); }}
                        aria-pressed={formDuration === m}
                        className={`tabular min-h-11 rounded-md border px-2.5 text-xs font-semibold transition-colors duration-150 ${
                          formDuration === m
                            ? "border-accent bg-accent-paper text-ink"
                            : "border-rule-2 bg-paper text-ink-2 hover:bg-paper-2"
                        }`}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                </div>
                <span id="task-duration-help" className="mt-1.5 block text-xs text-ink-3">
                  The timer cannot be paused or stopped once it starts.
                </span>
                {formError?.field === "duration" && <p id="task-duration-error" role="alert" className="mt-1.5 text-xs text-danger">{formError.message}</p>}
              </div>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">Sites for this task</legend>
                <p id="task-sites-help" className="text-xs text-ink-3">
                  Added to your global list while this task runs. Example: twitter.com, youtube.com
                </p>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="task-site" className="sr-only">Site to block for this task</label>
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
                      className="w-full rounded-md border border-rule-2 bg-paper px-3 py-2.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-accent"
                    />
                    {formError?.field === "site" && <p id="task-site-error" role="alert" className="mt-1.5 text-xs text-danger">{formError.message}</p>}
                  </div>
                  <Button variant="secondary" onClick={addFormSite}>Add</Button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {formSites.length === 0 ? (
                    <span className="text-xs text-ink-3">No sites of its own yet.</span>
                  ) : (
                    formSites.map((s) => (
                      <Chip key={s}>
                        {s}
                        <button
                          type="button"
                          onClick={() => removeFormSite(s)}
                          aria-label={`Remove ${s} from this task`}
                          className="compact-hit grid place-items-center rounded-sm text-ink-3 transition-colors duration-150 hover:text-danger"
                        >
                          <Icon name="close" className="h-3 w-3" />
                        </button>
                      </Chip>
                    ))
                  )}
                </div>
                {globalBlocks.length > 0 && (
                  <p className="text-xs text-ink-3">
                    Your global list is blocked as well ({globalBlocks.length} site{globalBlocks.length === 1 ? "" : "s"}).
                  </p>
                )}
              </fieldset>
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="secondary" className="flex-1" onClick={() => setShowAdd(false)}>Cancel</Button>
              <button type="submit" className={`${BUTTON_BASE} flex-1 ${BUTTON_VARIANTS.primary}`}>
                {editing ? "Save changes" : "Create task"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Toast — reserved for an outcome the user cannot see otherwise: a privileged write, a refusal */}
      {toast && (
        <div
          className="fixed bottom-5 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-2.5 rounded-md border border-rule bg-paper px-4 py-3 text-sm text-ink shadow-[var(--t-shadow-sheet)]"
          role="status"
        >
          <StatusDot tone="accent" />
          <span className="truncate">{toast}</span>
        </div>
      )}
    </div>
  );
}
