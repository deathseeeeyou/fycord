import { useEffect, useRef, useState } from "react";

// Публичный адрес сервера из панели Witchly (IP:порт)
const SERVER = "127.0.0.1:41600";
const HTTP_URL = `http://${SERVER}`;
const WS_URL = `ws://${SERVER}`;

type ChatMessage = { id: number; user: string; text: string; ts: number };

type Errors = { username?: string; password?: string; confirm?: string; form?: string };

function Field({
  label, type = "text", value, onChange, error, placeholder, autoComplete, right, disabled,
}: {
  label: string; type?: string; value: string; onChange: (v: string) => void;
  error?: string; placeholder?: string; autoComplete?: string; right?: React.ReactNode; disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className={`text-sm font-semibold mb-2 block transition-colors duration-200 ${error ? "text-[#f23f42]" : "text-[#b5bac1]"}`}>
        {label}
        {error && <span key={error} className="animate-fade font-normal italic text-[#f23f42]"> — {error}</span>}
      </span>
      <div className="relative">
        <input
          type={type}
          value={value}
          autoComplete={autoComplete}
          disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full h-11 px-3 pr-11 bg-[#1e1f22] rounded-md text-[#dbdee1] placeholder-[#4e5058] outline-none transition-shadow duration-200
            ${error ? "ring-1 ring-[#f23f42]" : "focus:ring-2 focus:ring-[#5865f2]"}`}
        />
        {right && <div className="absolute inset-y-0 right-0 flex items-center pr-3">{right}</div>}
      </div>
    </label>
  );
}

export default function App() {
  const [isLogin, setIsLogin] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [shake, setShake] = useState(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");

  const validate = (): Errors => {
    const e: Errors = {};
    if (!username.trim()) e.username = "введи имя";
    else if (!isLogin && username.trim().length < 3) e.username = "минимум 3 символа";
    if (!password) e.password = "введи пароль";
    else if (!isLogin && password.length < 6) e.password = "минимум 6 символов";
    if (!isLogin && password !== confirmPassword) e.confirm = "пароли не совпадают";
    return e;
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      doShake();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${HTTP_URL}/api/${isLogin ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!res.ok) {
        setErrors({ form: await res.text() });
        doShake();
        return;
      }
      const data: { token: string; username: string } = await res.json();
      setUsername(data.username);
      setToken(data.token);
      setIsLoggedIn(true);
    } catch {
      setErrors({ form: "Не удалось подключиться к серверу" });
      doShake();
    } finally {
      setLoading(false);
    }
  };

  const doShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  const logout = () => {
    setIsLoggedIn(false);
    setToken(null);
    setMessages([]);
    setPassword("");
  };

  // подключение к чату
  useEffect(() => {
    if (!isLoggedIn || !token) return;
    const ws = new WebSocket(`${WS_URL}/ws?token=${token}`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "history") setMessages(data.messages);
      else if (data.type === "message") setMessages((prev) => [...prev, data.message]);
    };
    ws.onclose = (ev) => {
      if (ev.code !== 1000 && wsRef.current === ws) logout();
    };
    return () => {
      ws.onclose = null;
      ws.close(1000);
      wsRef.current = null;
    };
  }, [isLoggedIn, token]);

  // прокрутка вниз при новых сообщениях
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const switchMode = () => {
    setIsLogin(!isLogin);
    setErrors({});
    setConfirmPassword("");
  };

  const sendMessage = () => {
    if (input.trim() === "" || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(input);
    setInput("");
  };

  // --- АВТОРИЗАЦИЯ / РЕГИСТРАЦИЯ ---
  if (!isLoggedIn) {
    return (
      <div className="relative flex items-center justify-center min-h-screen bg-[#1e1f22] p-4 overflow-hidden">
        {/* фон */}
        <div className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full bg-[#5865f2] blur-3xl opacity-20" />
        <div className="absolute -bottom-40 -right-24 w-[520px] h-[520px] rounded-full bg-[#23a559] blur-3xl opacity-10" />

        <div className="animate-card-in relative z-10 w-full max-w-[820px] flex rounded-lg overflow-hidden bg-[#313338] shadow-2xl shadow-black/40">
          {/* Форма */}
          <form onSubmit={handleSubmit} noValidate className={`flex-1 p-8 sm:p-10 min-w-0 ${shake ? "animate-shake" : ""}`}>
            <div key={String(isLogin)} className="animate-fade text-center mb-7">
              <h1 className="text-2xl font-semibold text-white">
                {isLogin ? "С возвращением!" : "Создать аккаунт"}
              </h1>
              <p className="text-[#b5bac1] mt-2">
                {isLogin ? "Мы так рады видеть тебя снова!" : "Присоединяйся к Fycord"}
              </p>
            </div>

            <div className="flex flex-col gap-5">
              <Field
                label="Имя пользователя"
                value={username}
                onChange={setUsername}
                error={errors.username}
                autoComplete="username"
              />
              <Field
                label="Пароль"
                type={showPass ? "text" : "password"}
                value={password}
                onChange={setPassword}
                error={errors.password}
                autoComplete={isLogin ? "current-password" : "new-password"}
                right={
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    aria-label={showPass ? "Скрыть пароль" : "Показать пароль"}
                    className="text-white/80 hover:text-white transition-colors"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {showPass ? (
                        <>
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </>
                      ) : (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      )}
                    </svg>
                  </button>
                }
              />
              <div
                aria-hidden={isLogin}
                className={`grid transition-all duration-300 ease-out ${
                  isLogin ? "grid-rows-[0fr] opacity-0 -mt-5" : "grid-rows-[1fr] opacity-100"
                }`}
              >
                <div className={`overflow-hidden -mx-1 px-1 transition-[padding] duration-300 ${isLogin ? "" : "pb-1"}`}>
                  <Field
                    label="Повтори пароль"
                    type={showPass ? "text" : "password"}
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    error={errors.confirm}
                    autoComplete="new-password"
                    disabled={isLogin}
                  />
                </div>
              </div>
            </div>

            {errors.form && (
              <p key={errors.form} className="animate-fade mt-5 text-sm text-[#f23f42]">
                {errors.form}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 mt-6 rounded-md bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-70 disabled:cursor-wait text-white font-medium transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {loading && (
                <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              )}
              {loading ? "Подожди…" : isLogin ? "Войти" : "Создать аккаунт"}
            </button>

            <p className="mt-4 text-sm text-[#949ba4]">
              {isLogin ? "Нужен аккаунт?" : "Уже есть аккаунт?"}{" "}
              <button type="button" onClick={switchMode} className="text-[#00a8fc] hover:underline">
                {isLogin ? "Зарегистрироваться" : "Войти"}
              </button>
            </p>
          </form>

          {/* Правая панель */}
          <div className="hidden md:flex w-[280px] shrink-0 flex-col items-center justify-center text-center gap-6 p-8 bg-[#2b2d31] border-l border-[#232428]">
            <div className="animate-float w-32 h-32 rounded-[36px] bg-gradient-to-br from-[#7983f5] to-[#4752c4] flex items-center justify-center text-6xl font-extrabold text-white shadow-xl shadow-[#5865f2]/30">
              F
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">Fycord</h2>
              <p className="text-sm text-[#b5bac1] mt-2 leading-relaxed">
                Место, где можно просто поболтать с друзьями.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- ЧАТ ---
  return (
    <div className="animate-chat-in flex h-screen bg-[#313338] text-[#dbdee1] font-sans">
      <div className="w-[72px] bg-[#1e1f22] flex flex-col items-center py-3 gap-2">
        <div className="w-12 h-12 bg-[#5865f2] rounded-[16px] flex items-center justify-center font-bold text-white cursor-pointer hover:rounded-full transition-all duration-200">F</div>
        <div className="w-12 h-12 bg-[#313338] rounded-full flex items-center justify-center text-[#23a559] text-2xl cursor-pointer hover:bg-[#23a559] hover:text-white hover:rounded-[16px] transition-all duration-200">+</div>
      </div>

      <div className="w-[240px] bg-[#2b2d31] flex flex-col">
        <div className="h-12 flex items-center justify-between px-4 font-bold shadow-sm shadow-black/20">
          <span>FYCORD</span>
          <button onClick={logout} className="text-xs text-red-400 hover:text-red-300">Выйти</button>
        </div>
        <div className="p-2 flex-1">
          <div className="px-2 py-1 mt-2 text-xs font-bold text-[#949ba4] uppercase">Текстовые каналы</div>
          <div className="px-2 py-2 mt-1 bg-[#404249] text-white rounded cursor-pointer flex items-center gap-1.5"><span className="text-xl">#</span> общий</div>
        </div>
        <div className="h-14 bg-[#232428] flex items-center px-2 gap-2">
          <div className="w-8 h-8 rounded-full bg-[#5865f2] flex items-center justify-center text-sm font-bold text-white">
            {username.charAt(0).toUpperCase()}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-white truncate">{username}</span>
            <span className="text-xs text-[#949ba4]">В сети</span>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-12 flex items-center px-4 font-bold shadow-sm shadow-black/20">
          <span className="text-2xl text-[#80848e] mr-2">#</span> общий
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {messages.map((msg) => (
            <div key={msg.id} className="animate-msg-in flex gap-4 hover:bg-[#2e3035] p-2 -mx-2 rounded group transition-colors">
              <div className="w-10 h-10 rounded-full bg-[#5865f2] flex flex-shrink-0 items-center justify-center font-bold text-white">
                {msg.user.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-white hover:underline cursor-pointer">{msg.user}</span>
                  <span className="text-xs text-[#949ba4]">{new Date(msg.ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <p className="text-[#dbdee1] mt-0.5">{msg.text}</p>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="p-4 pt-0">
          <div className="bg-[#383a40] rounded-lg flex items-center pr-4">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Написать в #общий"
              className="w-full bg-transparent p-3 outline-none text-white placeholder-[#6d6f78]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}