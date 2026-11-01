import { useEffect, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { ArrowRight, Check, Layers2, Mail, ShieldCheck } from "lucide-react";
import { ApiError, auth, request } from "./api";
import { Button, ErrorState, Field, Form, Loading, useLoad } from "./ui";
export function Brand() {
  return (
    <div className="brand" translate="no">
      <span className="brand-mark">
        <Layers2 size={20} strokeWidth={2} />
      </span>
      <span className="brand-name">
        UCaseLab<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
export function AuthPage({ onLogin }: { onLogin: () => Promise<void> }) {
  const location = useLocation(),
    navigate = useNavigate(),
    [params] = useSearchParams();
  const kind = location.pathname.split("/").pop() || "login";
  const token = params.get("token");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const consumed = useRef("");
  const invalidLink = (e: unknown) => e instanceof ApiError &&
    (e.code === "INVALID_LINK" || (e.code === "VALIDATION_ERROR" && /(?:^|; )body\.token:/.test(e.message)));
  const linkFailure = (e: unknown) => {
    if (invalidLink(e))
      return "Ссылка повреждена, уже использована или срок её действия истёк.";
    if (e instanceof ApiError && e.code === "VALIDATION_ERROR" && /(?:^|; )body\.password:/.test(e.message))
      return "Пароль должен содержать от 10 до 128 символов.";
    return e instanceof Error ? e.message : "Не удалось проверить ссылку. Попробуйте ещё раз.";
  };
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const config = useLoad(
    () => request<{ email_enabled: boolean }>("/auth/config"),
    [],
  );
  const registration = kind === "register",
    reset = kind === "reset",
    link = kind === "link",
    resend = kind === "verify" && !token;
  useEffect(() => {
    setMessage("");
    setError("");
  }, [kind]);
  useEffect(() => {
    if (token && kind !== "reset" && consumed.current !== token) {
      consumed.current = token;
      auth("consume", { token })
        .then(async () => {
          if (!active.current) return;
          await onLogin();
          if (!active.current) return;
          navigate(sessionStorage.getItem("after_login") || "/", {
            replace: true,
          });
          sessionStorage.removeItem("after_login");
        })
        .catch((e) => {
          if (active.current) setError(linkFailure(e));
        });
    }
  }, [token, kind]);
  if (!config.data)
    return config.error ? (
      <ErrorState error={config.error} retry={config.reload} />
    ) : (
      <Loading />
    );
  const mailEnabled = config.data.email_enabled;
  const mailUnavailable = !mailEnabled && (reset || link || resend) && !token;
  const heading = token
    ? reset
      ? "Новый пароль"
      : "Подтверждаем почту"
    : registration
      ? "Создайте рабочее пространство"
      : reset
        ? "Восстановление доступа"
        : link
          ? "Вход по ссылке"
          : resend
            ? "Подтвердите почту"
            : "С возвращением";
  return (
    <div className="auth-layout">
      <aside className="auth-aside">
        <Link to="/">
          <Brand />
        </Link>
        <div className="auth-story">
          <span className="auth-pill">
            <span />
            Рабочее пространство команды
          </span>
          <h1>
            От сценария
            <br />к проверенному
            <br />
            <em>результату.</em>
          </h1>
          <p>
            Функционал, данные и история проверок — в одном месте. Для вашей
            команды и ИИ-агентов.
          </p>
          <div className="auth-diagram">
            <div>
              <span>01</span>
              <strong>Юзер-кейс</strong>
              <small>Что должно происходить</small>
            </div>
            <i />
            <div>
              <span>02</span>
              <strong>План и проверка</strong>
              <small>Что произошло на самом деле</small>
            </div>
            <i />
            <div>
              <span>03</span>
              <strong>Отчёт</strong>
              <small>Результат, которому можно доверять</small>
            </div>
          </div>
        </div>
        <span className="auth-footer">Сценарии. Данные. Доказательства.</span>
      </aside>
      <main className="auth-main">
        <div className="auth-form">
          <div className="auth-icon">
            {message ? (
              <Check size={28} />
            ) : reset ? (
              <ShieldCheck size={28} />
            ) : (
              <Mail size={28} />
            )}
          </div>
          <h2>{heading}</h2>
          <p>
            {registration
              ? mailEnabled
                ? "Зарегистрируйтесь по рабочей почте. После подтверждения адреса можно создать проект и пригласить команду."
                : "Укажите email для входа и придумайте пароль. После регистрации можно сразу создать проект и пригласить команду."
              : mailUnavailable
                ? "Отправка писем отключена. Для входа используйте email и пароль. Если пароль потерян, обратитесь к владельцу сервера."
                : reset
                  ? token ? "Установите новый пароль для вашего аккаунта." : "Отправим ссылку для установки нового пароля."
                  : link
                    ? "Войдите без пароля: отправим одноразовую ссылку на почту."
                    : resend
                      ? "Отправим новую ссылку подтверждения."
                      : "Продолжите работу с проектами и сценариями."}
          </p>
          {mailUnavailable ? (
            <Link to="/auth/login" className="text-link">
              Вернуться ко входу
            </Link>
          ) : message ? (
            <div className="stack">
              <div className="note">{message}</div>
              <Link to="/auth/login" className="text-link">
                Вернуться ко входу
              </Link>
            </div>
          ) : token && !reset ? (
            <>
              {error ? (
                <div className="error auth-link-error" role="alert">
                  <span>{error}</span>
                  {mailEnabled ? <Link to={kind === "link" || kind === "login" ? "/auth/link" : "/auth/verify"}>Запросить новую ссылку</Link> : <span>Отправка писем отключена. Войдите по паролю или обратитесь к владельцу сервера.</span>}
                  <Link to="/auth/login">Вернуться ко входу</Link>
                </div>
              ) : (
                <Loading />
              )}
            </>
          ) : (
            <Form
              onSubmit={async () => {
                if (token && reset) {
                  if (Array.from(password).length < 10 || Array.from(password).length > 128)
                    throw new Error("Пароль должен содержать от 10 до 128 символов.");
                  try {
                    await auth("consume", { token, password });
                  } catch (e) {
                    throw new Error(linkFailure(e) + (invalidLink(e) ? (mailEnabled
                      ? " Запросите новую ссылку на странице восстановления доступа."
                      : " Отправка писем отключена. Войдите по паролю или обратитесь к владельцу сервера.") : ""));
                  }
                  if (!active.current) return;
                  await onLogin();
                  if (!active.current) return;
                  navigate("/");
                  return;
                }
                if (registration) {
                  const r = await auth("register", { email, name, password });
                  if (!active.current) return;
                  setMessage(r.message || "Проверьте почту");
                  return;
                }
                if (reset || link || resend) {
                  const r = await auth("email", {
                    email,
                    kind: reset ? "reset" : link ? "login" : "verify",
                  });
                  if (!active.current) return;
                  setMessage(r.message || "Проверьте почту");
                  return;
                }
                await auth("login", { email, password });
                if (!active.current) return;
                await onLogin();
                if (!active.current) return;
                navigate(sessionStorage.getItem("after_login") || "/");
                sessionStorage.removeItem("after_login");
              }}
            >
              {registration && (
                <Field label="Как вас зовут">
                  <input
                    required
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Имя и фамилия"
                    maxLength={120}
                  />
                </Field>
              )}
              {!token && (
                <Field label="Электронная почта">
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.ru"
                  />
                </Field>
              )}
              {((!reset && !link && !resend) || (token && reset)) && (
                <Field
                  label={token ? "Новый пароль" : "Пароль"}
                  hint={
                    registration || reset ? "Не менее 10 символов" : undefined
                  }
                >
                  <input
                    required
                    type="password"
                    autoComplete={
                      registration || reset
                        ? "new-password"
                        : "current-password"
                    }
                    minLength={registration || reset ? 10 : 1}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      registration
                        ? "Придумайте надёжный пароль"
                        : "Введите пароль"
                    }
                  />
                </Field>
              )}
              {mailEnabled && !registration && !reset && !link && !resend && (
                <div className="auth-links">
                  <Link to="/auth/link">Войти по ссылке</Link>
                  <Link to="/auth/reset">Забыли пароль?</Link>
                </div>
              )}
              <Button type="submit" className="full">
                {registration
                  ? "Создать аккаунт"
                  : reset && token
                    ? "Сохранить пароль"
                    : reset || link || resend
                    ? "Отправить ссылку"
                    : "Войти"}
                <ArrowRight size={16} />
              </Button>
              {token && reset && mailEnabled && <Link to="/auth/reset" className="text-link">Запросить новую ссылку</Link>}
              {registration ? (
                <p className="auth-switch">
                  Уже есть аккаунт? <Link to="/auth/login">Войти</Link>
                </p>
              ) : !reset && !link && !resend ? (
                <>
                  <p className="auth-switch">
                    Ещё нет аккаунта?{" "}
                    <Link to="/auth/register">Зарегистрироваться</Link>
                  </p>
                  {mailEnabled && (
                    <Link className="auth-confirm" to="/auth/verify">
                      Не пришло подтверждение почты
                    </Link>
                  )}
                </>
              ) : (
                <p className="auth-switch">
                  <Link to="/auth/login">Вернуться ко входу</Link>
                </p>
              )}
            </Form>
          )}
        </div>
        <small className="auth-main-footer">
          UCaseLab — сценарии и результаты проверок
        </small>
      </main>
    </div>
  );
}
