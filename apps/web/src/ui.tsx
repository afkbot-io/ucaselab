import {
  Children,
  cloneElement,
  isValidElement,
  createContext,
  useId,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ButtonHTMLAttributes,
  FormEvent,
  ReactNode,
  ReactElement,
  Ref,
  RefObject,
} from "react";
import {
  AlertCircle,
  Check,
  Inbox,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { statusLabels } from "./types";
import { useSearchParams } from "react-router-dom";

const pluralRules = new Intl.PluralRules("ru-RU");
/** Russian count labels for summaries, including 1, 2–4 and 11–14. */
export function quantity(count: number, forms: [string, string, string]) {
  const rule = pluralRules.select(count);
  return `${count.toLocaleString("ru-RU")} ${forms[rule === "one" ? 0 : rule === "few" ? 1 : 2]}`;
}

const ToastContext = createContext<
  (message: string, kind?: "success" | "error") => void
>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, set] = useState<{ id: number; text: string; kind: string }[]>(
    [],
  );
  const add = useCallback((text: string, kind = "success") => {
    const id = Date.now() + Math.random();
    set((t) => [...t, { id, text, kind }]);
    setTimeout(() => set((t) => t.filter((v) => v.id !== id)), 6000);
  }, []);
  return (
    <ToastContext.Provider value={add}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind}>
            {t.kind === "error" ? (
              <AlertCircle size={18} />
            ) : (
              <Check size={18} />
            )}
            <span>{t.text}</span>
            <button
              className="icon-button"
              aria-label="Закрыть уведомление"
              onClick={() => set((s) => s.filter((v) => v.id !== t.id))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export function useToast() {
  return useContext(ToastContext);
}
export function Button({
  variant = "primary",
  className = "",
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      {...props}
      className={"button " + variant + " " + className}
      onClick={(event) => {
        // Safari does not focus a clicked button; dialogs need a reliable return target.
        event.currentTarget.focus({ preventScroll: true });
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
export function AsyncButton({
  onAction,
  children,
  ...props
}: Omit<Parameters<typeof Button>[0], "onClick"> & {
  onAction: () => Promise<unknown>;
}) {
  const [pending, set] = useState(false);
  const toast = useToast();
  return (
    <Button
      {...props}
      disabled={pending || props.disabled}
      onClick={async () => {
        set(true);
        try {
          await onAction();
        } catch (e) {
          toast((e as Error).message, "error");
        } finally {
          set(false);
        }
      }}
    >
      {pending ? <LoaderCircle className="spin" size={16} /> : null}
      {children}
    </Button>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const hintId = generatedId + "-hint";
  let controlId: string | undefined;
  type ControlProps = {
    id?: string;
    children?: ReactNode;
    "aria-describedby"?: string;
  };
  const connect = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (node) => {
      if (!isValidElement(node)) return node;
      const element = node as ReactElement<ControlProps>;
      if (
        !controlId &&
        typeof element.type === "string" &&
        ["input", "textarea", "select"].includes(element.type)
      ) {
        controlId = element.props.id || generatedId;
        return cloneElement(element, {
          id: controlId,
          "aria-describedby":
            [element.props["aria-describedby"], hint ? hintId : undefined]
              .filter(Boolean)
              .join(" ") || undefined,
        });
      }
      if (!controlId && element.props.children)
        return cloneElement(
          element,
          undefined,
          connect(element.props.children),
        );
      return node;
    });
  const controls = connect(children);
  return (
    <div
      className="field"
      role={controlId ? undefined : "group"}
      aria-labelledby={controlId ? undefined : generatedId}
    >
      {controlId ? (
        <label htmlFor={controlId}>{label}</label>
      ) : (
        <span id={generatedId}>{label}</span>
      )}
      {controls}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}

export function Form({
  onSubmit,
  children,
  className = "",
  pendingLabel = "Сохраняем…",
}: {
  onSubmit: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const [error, setError] = useState("");
  const [pending, set] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError("");
    set(true);
    try {
      await onSubmit();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      set(false);
    }
  }
  return (
    <form className={className + " form"} onSubmit={submit}>
      <fieldset disabled={pending}>
        {children}
        {error && (
          <div className="error" role="alert" ref={errorRef} tabIndex={-1}>
            <AlertCircle size={18} />
            {error}
          </div>
        )}
        {pending && (
          <div className="saving" role="status">
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
            {pendingLabel}
          </div>
        )}
      </fieldset>
    </form>
  );
}
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
  className = "",
  focusField = true,
  modal = true,
  actions,
  focusReturnRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  focusField?: boolean;
  modal?: boolean;
  actions?: ReactNode;
  focusReturnRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useLayoutEffect(() => {
    if (
      !returnFocus.current &&
      !ref.current?.contains(document.activeElement)
    ) {
      returnFocus.current = document.activeElement as HTMLElement;
    }
    const dialog = ref.current!;
    if (modal) dialog.showModal();
    else dialog.show();
    // Nonmodal drawers share Escape with their surrounding page or modal. A
    // child modal (or an autocomplete consuming Escape) always gets priority.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const modals = [...document.querySelectorAll("dialog:modal")];
      const top = modals.at(-1);
      if (top && !top.contains(dialog)) return;
      event.preventDefault();
      closeHandler.current();
    };
    if (!modal) document.addEventListener("keydown", escape);
    if (focusField) {
      ref.current
        ?.querySelector<HTMLInputElement>(
          "input:not([type=checkbox]):not([type=file]):not([readonly]):not([disabled]),textarea:not([disabled])",
        )
        ?.focus();
    } else {
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    return () => {
      document.removeEventListener("keydown", escape);
      const restore = modal || dialog.contains(document.activeElement);
      dialog.close();
      const destination = focusReturnRef?.current || returnFocus.current;
      if (restore && destination?.isConnected)
        destination.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "wide" : ""} ${className}`}
      onCancel={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-inner">
        <div className="dialog-head">
          <h2>{title}</h2>
          <div className="dialog-actions">
            {actions}
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Закрыть окно"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        {icon || <Inbox size={26} strokeWidth={1.5} />}
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} />
      Загружаем…
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => void;
}) {
  return (
    <Empty
      title="Не удалось загрузить данные"
      description={error?.message}
      action={
        <Button variant="secondary" onClick={retry}>
          Повторить
        </Button>
      }
    />
  );
}
export function Badge({
  status,
  children,
}: {
  status?: string;
  children?: ReactNode;
}) {
  return (
    <span className={"badge " + (status || "neutral")}>
      {children || statusLabels[status || ""] || status}
    </span>
  );
}
export function PageHead({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-heading">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { key: string; label: string; count?: number }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label="Разделы страницы"
      ref={root}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const current = items.findIndex((i) => i.key === value);
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : (current + (e.key === "ArrowRight" ? 1 : -1) + items.length) %
                items.length;
        onChange(items[next].key);
        root.current
          ?.querySelectorAll<HTMLButtonElement>("button")
          [next]?.focus();
      }}
    >
      {items.map((i) => (
        <button
          key={i.key}
          role="tab"
          tabIndex={value === i.key ? 0 : -1}
          aria-selected={value === i.key}
          className={value === i.key ? "active" : ""}
          onClick={() => onChange(i.key)}
        >
          {i.label}
          {i.count !== undefined && <span>{i.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loader()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [...deps, version]);
  return { data, error, loading, reload, setData };
}
export function date(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("ru", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}
export function percent(value: number | null) {
  return value === null ? "—" : Math.round(value * 100) + "%";
}

export function useDebounced<T>(value: T, delay = 250) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return current;
}

export function CatalogToolbar({
  placeholder = "Найти…",
  statuses,
  kinds,
  children,
  searchRef,
}: {
  placeholder?: string;
  statuses?: [string, string][];
  kinds?: [string, string][];
  children?: ReactNode;
  searchRef?: Ref<HTMLInputElement>;
}) {
  const [params, setParams] = useSearchParams();
  function change(key: string, value: string) {
    setParams(
      (p) => {
        value ? p.set(key, value) : p.delete(key);
        p.delete("page");
        return p;
      },
      { replace: true },
    );
  }
  return (
    <div className="toolbar catalog-toolbar">
      <div className="search-input">
        <Search size={15} aria-hidden="true" />
        <input
          ref={searchRef}
          aria-label="Поиск в списке"
          value={params.get("q") || ""}
          onChange={(e) => change("q", e.target.value)}
          placeholder={placeholder}
        />
      </div>
      {statuses && (
        <select
          className="input filter-select"
          aria-label="Фильтр статуса"
          value={params.get("status") || ""}
          onChange={(e) => change("status", e.target.value)}
        >
          <option value="">Все статусы</option>
          {statuses.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      )}
      {kinds && (
        <select
          className="input filter-select"
          aria-label="Тип предложения"
          value={params.get("kind") || ""}
          onChange={(e) => change("kind", e.target.value)}
        >
          <option value="">Все типы</option>
          {kinds.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      )}
      <select
        className="input filter-select sort-select"
        aria-label="Сортировка"
        value={params.get("sort") || "created_desc"}
        onChange={(e) => change("sort", e.target.value)}
      >
        <option value="created_desc">Сначала новые</option>
        <option value="created">Сначала старые</option>
        <option value="title">По названию: А–Я</option>
        <option value="title_desc">По названию: Я–А</option>
      </select>
      {children}
    </div>
  );
}

export function NoMatches({ onReset }: { onReset?: () => void } = {}) {
  const [params, setParams] = useSearchParams();
  return (
    <Empty
      title="Ничего не найдено"
      description="Попробуйте другой запрос или снимите часть фильтров."
      action={
        <Button
          variant="secondary"
          onClick={() => {
            if (onReset) {
              onReset();
              return;
            }
            const p = new URLSearchParams(params);
            [
              "q",
              "status",
              "kind",
              "tag",
              "platform",
              "priority",
              "page",
            ].forEach((k) => p.delete(k));
            setParams(p);
          }}
        >
          Сбросить поиск и фильтры
        </Button>
      }
    />
  );
}
export function hasCatalogFilters(params: URLSearchParams) {
  return ["q", "status", "kind", "tag", "platform", "priority", "page"].some(
    (k) => params.has(k),
  );
}

export function CatalogPagination({
  total,
  size = 50,
}: {
  total: number;
  size?: number;
}) {
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, Number(params.get("page")) || 0);
  if (total <= size && page === 0)
    return total ? <div className="catalog-count">Всего: {total}</div> : null;
  function go(n: number) {
    setParams((p) => {
      n ? p.set("page", String(n)) : p.delete("page");
      return p;
    });
  }
  return (
    <div className="pagination">
      <span>
        {total
          ? `${Math.min(page * size + 1, total)}–${Math.min((page + 1) * size, total)} из ${total}`
          : "Ничего не найдено"}
      </span>
      <div className="inline">
        <Button
          variant="secondary"
          disabled={page === 0}
          onClick={() => go(page - 1)}
        >
          Назад
        </Button>
        <Button
          variant="secondary"
          disabled={(page + 1) * size >= total}
          onClick={() => go(page + 1)}
        >
          Далее
        </Button>
      </div>
    </div>
  );
}
