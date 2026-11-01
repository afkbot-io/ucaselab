import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import { action } from "./api";
import { useProject } from "./context";

export type Choice = {
  id: string;
  label: string;
  detail?: string;
  revision_id?: string;
};
type ChoicePage = {
  items: Choice[];
  total: number;
  next_offset: number | null;
};

/** A bounded async combobox shared by tags, references and large catalogs. */
export function SearchPicker({
  label,
  values,
  onChange,
  loadOptions,
  multiple = true,
  allowCreate = false,
  placeholder = "Найти…",
  hint,
  maxSelected = 100,
  canRemove = true,
}: {
  label: string;
  values: Choice[];
  onChange: (v: Choice[]) => void;
  loadOptions: (query: string, offset: number) => Promise<ChoicePage>;
  multiple?: boolean;
  allowCreate?: boolean;
  placeholder?: string;
  hint?: string;
  maxSelected?: number;
  canRemove?: boolean;
}) {
  const id = useId(),
    root = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const loader = useRef(loadOptions);
  loader.current = loadOptions;
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [options, setOptions] = useState<Choice[]>([]),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [next, setNext] = useState<number | null>(null),
    [active, setActive] = useState(0),
    [version, setVersion] = useState(0);
  const generation = useRef(0);
  const queuedEnter = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    setPending(true);
    setError("");
    setNext(null);
    setOptions([]);
    setActive(0);
    const timer = setTimeout(() => {
      loader
        .current(query, 0)
        .then((r) => {
          if (current !== generation.current) return;
          setOptions(r.items);
          setNext(r.next_offset);
        })
        .catch((e) => {
          if (current === generation.current) setError(e.message);
        })
        .finally(() => {
          if (current === generation.current) setPending(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [query, open, version]);
  const available = options.filter(
    (o) =>
      !values.some(
        (v) => v.id.toLocaleLowerCase() === o.id.toLocaleLowerCase(),
      ),
  );
  const clean = query.trim().replace(/\s+/g, " ");
  const create =
    allowCreate &&
    !pending &&
    !!clean &&
    clean.length <= 80 &&
    ![...options, ...values].some(
      (o) => o.label.toLocaleLowerCase() === clean.toLocaleLowerCase(),
    );
  const count = available.length + (create ? 1 : 0);
  useEffect(() => {
    // A fast Enter during the debounce must select once the matching page arrives.
    // Bind it to the query so an older response cannot select a different value.
    if (pending || !open || queuedEnter.current === null) return;
    const submitted = queuedEnter.current;
    queuedEnter.current = null;
    if (submitted !== clean || error) return;
    if (available[active]) choose(available[active]);
    else if (create) choose({ id: clean, label: clean });
  }, [pending, open, clean, error, options, active, create]);
  useEffect(() => {
    if (open)
      document
        .getElementById(id + "-option-" + active)
        ?.scrollIntoView({ block: "nearest" });
  }, [id, open, active, options.length]);
  function choose(option: Choice) {
    if (values.length >= maxSelected && multiple) return;
    onChange(multiple ? [...values, option] : [option]);
    setQuery("");
    setActive(0);
    if (!multiple) setOpen(false);
    input.current?.focus();
  }
  return (
    <div
      className="picker"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          queuedEnter.current = null;
          setOpen(false);
        }
      }}
    >
      <label className="picker-label" htmlFor={id}>
        {label}
      </label>
      <div
        className={"picker-control " + (open ? "is-open" : "")}
        onClick={() => input.current?.focus()}
      >
        {values.map((v) => (
          <span className="picker-chip" key={v.id}>
            <span title={v.label}>{v.label}</span>
            {canRemove && <button
              type="button"
              aria-label={`Убрать ${v.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(values.filter((x) => x.id !== v.id));
              }}
            >
              <X size={12} />
            </button>}
          </span>
        ))}
        <div className="picker-entry">
          <Search size={14} aria-hidden="true" />
          <input
            ref={input}
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={id + "-list"}
            aria-activedescendant={
              open && count
                ? id + "-option-" + Math.min(active, count - 1)
                : undefined
            }
            autoComplete="off"
            spellCheck={false}
            value={query}
            maxLength={500}
            placeholder={
              values.length
                ? multiple
                  ? "Добавить…"
                  : "Выбрать другой…"
                : placeholder
            }
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              queuedEnter.current = null;
              setQuery(e.target.value);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && open) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                queuedEnter.current = null;
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setOpen(true);
                setActive((i) =>
                  count
                    ? (i + (e.key === "ArrowDown" ? 1 : -1) + count) % count
                    : 0,
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (
                  pending && allowCreate && clean && clean.length <= 80 &&
                  !values.some((v) => v.label.toLocaleLowerCase() === clean.toLocaleLowerCase())
                ) choose({ id: clean, label: clean });
                else if (pending) queuedEnter.current = clean;
                else if (open && available[active]) choose(available[active]);
                else if (create && !pending)
                  choose({ id: clean, label: clean });
                else setOpen(true);
              } else if (e.key === "Backspace" && !query && values.length)
                onChange(values.slice(0, -1));
            }}
          />
          <ChevronDown size={13} aria-hidden="true" />
        </div>
      </div>
      {hint && (
        <p className="field-hint" id={id + "-hint"}>
          {hint}
        </p>
      )}
      {open && (
        <div className="picker-popup">
          <div
            className="picker-options"
            id={id + "-list"}
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple}
          >
            {available.map((o, i) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                id={id + "-option-" + i}
                key={o.id}
                tabIndex={-1}
                className={"picker-option " + (active === i ? "active" : "")}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                <span>
                  <strong>{o.label}</strong>
                  {o.detail && <small>{o.detail}</small>}
                </span>
                <Plus size={14} />
              </button>
            ))}
            {create && !pending && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                id={id + "-option-" + available.length}
                tabIndex={-1}
                className={
                  "picker-option create " +
                  (active === available.length ? "active" : "")
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose({ id: clean, label: clean })}
              >
                <Plus size={14} />
                <span>Добавить «{clean}»</span>
              </button>
            )}
          </div>
          {pending && (
            <div className="picker-message" role="status">
              <LoaderCircle className="spin" size={14} />
              Ищем…
            </div>
          )}
          {error && (
            <div className="picker-message error" role="alert">
              {error}
              <button
                type="button"
                className="text-link"
                onClick={() => setVersion((v) => v + 1)}
              >
                Повторить
              </button>
            </div>
          )}
          {!pending && !error && !count && (
            <div className="picker-message">
              {values.length ? (
                <>
                  <Check size={14} />
                  Совпадений больше нет
                </>
              ) : (
                "Ничего не найдено. Попробуйте другое название."
              )}
            </div>
          )}
          {next !== null && (
            <button
              type="button"
              disabled={pending}
              className="picker-more"
              onMouseDown={(e) => e.preventDefault()}
              onClick={async () => {
                const current = generation.current;
                setPending(true);
                try {
                  const r = await loader.current(query, next);
                  if (current === generation.current) {
                    setOptions((o) => [...o, ...r.items]);
                    setNext(r.next_offset);
                  }
                } catch (e) {
                  if (current === generation.current)
                    setError((e as Error).message);
                } finally {
                  if (current === generation.current) setPending(false);
                }
              }}
            >
              Показать ещё
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function LabelPicker({
  scope,
  label,
  values,
  onChange,
  create = true,
  hint,
}: {
  scope: "use_cases" | "specifications" | "platforms";
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  create?: boolean;
  hint?: string;
}) {
  const { project } = useProject();
  return (
    <SearchPicker
      label={label}
      values={values.map((v) => ({ id: v, label: v }))}
      onChange={(v) => onChange(v.map((o) => o.label))}
      allowCreate={create}
      hint={hint}
      maxSelected={scope === "platforms" ? 20 : 30}
      placeholder={
        scope === "platforms"
          ? "Web, iOS, Android…"
          : create
            ? "Найти или добавить тег…"
            : "Найти тег…"
      }
      loadOptions={async (search, offset) => {
        const r = await action<{
          items: string[];
          total: number;
          next_offset: number | null;
        }>("list_tags", project.id, { scope, search, offset, limit: 20 });
        return { ...r, items: r.items.map((v) => ({ id: v, label: v })) };
      }}
    />
  );
}

export function CasePicker({
  values,
  onChange,
  multiple = false,
  label = "Какой юзер-кейс изменить?",
  publishedOnly = false,
}: {
  values: Choice[];
  onChange: (v: Choice[]) => void;
  multiple?: boolean;
  label?: string;
  publishedOnly?: boolean;
}) {
  const { project } = useProject();
  return (
    <SearchPicker
      label={label}
      values={values}
      onChange={onChange}
      multiple={multiple}
      placeholder="Введите название или номер кейса…"
      loadOptions={async (search, offset) => {
        const r = await action<{
          items: { id: string; title: string; key: string }[];
          total: number;
          next_offset: number | null;
        }>("list_use_cases", project.id, {
          search,
          offset,
          limit: 20,
          sort: "title",
          status: publishedOnly ? "published" : "all",
        });
        return {
          ...r,
          items: r.items.map((c) => ({
            id: c.id,
            label: c.title,
            detail: c.key,
          })),
        };
      }}
    />
  );
}

export function SpecificationPicker({
  links,
  onChange,
}: {
  links: { specification_id: string; revision_id?: string | null }[];
  onChange: (
    v: { specification_id: string; revision_id?: string | null }[],
  ) => void;
}) {
  const { project } = useProject();
  const [names, setNames] = useState<Record<string, string>>({});
  const signature = links
    .map((s) => s.specification_id + ":" + s.revision_id)
    .join();
  useEffect(() => {
    let active = true;
    Promise.all(
      links.map((s) =>
        (s.revision_id
          ? action<{ number: number; content: { title: string } }>(
              "get_specification_revision",
              project.id,
              {
                specification_id: s.specification_id,
                revision_id: s.revision_id,
              },
            ).then((r) => ({ title: r.content.title + " · r" + r.number }))
          : action<{ title: string }>("get_specification", project.id, {
              specification_id: s.specification_id,
            })
        )
          .then((v) => [s.specification_id, v.title])
          .catch(() => [s.specification_id, "Недоступная спецификация"]),
      ),
    ).then((pairs) => {
      if (active) setNames(Object.fromEntries(pairs));
    });
    return () => {
      active = false;
    };
  }, [project.id, signature]);
  return (
    <SearchPicker
      label="Спецификации"
      values={links.map((s) => ({
        id: s.specification_id,
        label: names[s.specification_id] || "Загружаем название…",
      }))}
      placeholder="Найти требование по названию или тегу…"
      hint="Новая связь закрепляет текущую ревизию. Уже добавленные требования сохраняют выбранные версии."
      onChange={(v) =>
        onChange(
          v.map(
            (o) =>
              links.find((s) => s.specification_id === o.id) || {
                specification_id: o.id,
                revision_id: o.revision_id,
              },
          ),
        )
      }
      loadOptions={async (search, offset) => {
        const r = await action<{
          items: {
            id: string;
            title: string;
            current_revision_id: string;
            tags: string[];
          }[];
          total: number;
          next_offset: number | null;
        }>("list_specifications", project.id, {
          search,
          offset,
          limit: 20,
          sort: "title",
        });
        return {
          ...r,
          items: r.items.map((s) => ({
            id: s.id,
            label: s.title,
            revision_id: s.current_revision_id,
            detail: s.tags.join(", "),
          })),
        };
      }}
    />
  );
}
