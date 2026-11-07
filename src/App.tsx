import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Публичный адрес сервера (хост и порт из панели Witchly)
const SERVER = "de1-free.witchly.host:41600";
const HTTP_URL = `http://${SERVER}`;
const WS_URL = `ws://${SERVER}`;

type Session = { token: string; username: string; handle: string };
type Server = { id: number; name: string };
type Channel = { id: number; server_id: number; name: string };
type ChatMessage = { id: number; channel: number; user: string; text: string; ts: number };
type Person = { username: string; handle: string; online?: boolean };
type FriendsData = { friends: Person[]; incoming: Person[]; outgoing: Person[] };

/* ───────────── вспомогательное ───────────── */

async function api<T = unknown>(path: string, token: string | null, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(`${HTTP_URL}${path}`, {
    method: hasBody ? "POST" : "GET",
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.text()) || "Ошибка");
  return res.json() as Promise<T>;
}

function errText(e: unknown): string {
  if (e instanceof TypeError) return "Не удалось подключиться к серверу";
  return e instanceof Error ? e.message : "Что-то пошло не так";
}

function hue(name: string): number {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Сегодня";
  if (d.toDateString() === yesterday.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

/* ───────────── мелкие компоненты ───────────── */

function Avatar({ name, size = 40, online }: { name: string; size?: number; online?: boolean }) {
  const h = hue(name);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="w-full h-full rounded-full flex items-center justify-center font-bold text-white select-none"
        style={{
          background: `linear-gradient(135deg, hsl(${h} 65% 55%), hsl(${(h + 40) % 360} 65% 40%))`,
          fontSize: size * 0.42,
        }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-[3px] border-[#2b2d31] ${
            online ? "bg-[#23a559]" : "bg-[#80848e]"
          }`}
          style={{ width: size * 0.4, height: size * 0.4 }}
        />
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="animate-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
      onMouseDown={onClose}
    >
      <div
        className="animate-pop w-full max-w-[420px] rounded-xl bg-[#313338] shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="w-8 h-8 rounded-md text-[#949ba4] hover:text-white hover:bg-white/5 transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

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

const Icon = {
  hash: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  ),
  users: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  gear: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  logout: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  eye: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  eyeOff: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ),
};

/* ───────────── экран входа / регистрации ───────────── */

type Errors = { username?: string; password?: string; confirm?: string; form?: string };

function AuthScreen({ onAuth }: { onAuth: (s: Session) => void }) {
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [shake, setShake] = useState(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  const doShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

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
      const data = await api<Session>(`/api/${isLogin ? "login" : "register"}`, null, {
        username: username.trim(),
        password,
      });
      onAuth(data);
    } catch (err) {
      setErrors({ form: errText(err) });
      doShake();
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setIsLogin(!isLogin);
    setErrors({});
    setConfirmPassword("");
  };

  return (
    <div className="relative flex items-center justify-center min-h-screen bg-[#1e1f22] p-4 overflow-hidden">
      <div className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full bg-[#5865f2] blur-3xl opacity-20" />
      <div className="absolute -bottom-40 -right-24 w-[520px] h-[520px] rounded-full bg-[#23a559] blur-3xl opacity-10" />

      <div className="animate-card-in relative z-10 w-full max-w-[820px] flex rounded-lg overflow-hidden bg-[#313338] shadow-2xl shadow-black/40">
        <form onSubmit={handleSubmit} noValidate className={`flex-1 p-8 sm:p-10 min-w-0 ${shake ? "animate-shake" : ""}`}>
          <div key={String(isLogin)} className="animate-fade text-center mb-7">
            <h1 className="text-2xl font-semibold text-white">{isLogin ? "С возвращением!" : "Создать аккаунт"}</h1>
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
                  {showPass ? Icon.eyeOff : Icon.eye}
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
            {loading && <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
            {loading ? "Подожди…" : isLogin ? "Войти" : "Создать аккаунт"}
          </button>

          <p className="mt-4 text-sm text-[#949ba4]">
            {isLogin ? "Нужен аккаунт?" : "Уже есть аккаунт?"}{" "}
            <button type="button" onClick={switchMode} className="text-[#00a8fc] hover:underline">
              {isLogin ? "Зарегистрироваться" : "Войти"}
            </button>
          </p>
        </form>

        <div className="hidden md:flex w-[280px] shrink-0 flex-col items-center justify-center text-center gap-6 p-8 bg-[#2b2d31] border-l border-[#232428]">
          <div className="animate-float w-32 h-32 rounded-[36px] bg-gradient-to-br from-[#7983f5] to-[#4752c4] flex items-center justify-center text-6xl font-extrabold text-white shadow-xl shadow-[#5865f2]/30">
            F
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">Fycord</h2>
            <p className="text-sm text-[#b5bac1] mt-2 leading-relaxed">Место, где можно просто поболтать с друзьями.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────── окна: профиль, сервер, канал ───────────── */

function ProfileModal({ session, onClose, onSaved }: { session: Session; onClose: () => void; onSaved: (handle: string) => void }) {
  const [value, setValue] = useState(session.handle);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    try {
      const r = await api<{ handle: string }>("/api/profile", session.token, { handle: value });
      onSaved(r.handle);
      onClose();
    } catch (error) {
      setErr(errText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Мой профиль" onClose={onClose}>
      <form onSubmit={save}>
        <div className="flex items-center gap-4 mb-5">
          <Avatar name={session.username} size={64} />
          <div className="min-w-0">
            <div className="text-xl font-semibold text-white truncate">{session.username}</div>
            <div className="text-sm text-[#949ba4]">Ник нельзя изменить</div>
          </div>
        </div>

        <span className="text-sm font-semibold mb-2 block text-[#b5bac1]">Юзернейм</span>
        <div className={`flex items-center h-11 rounded-md bg-[#1e1f22] px-3 ${err ? "ring-1 ring-[#f23f42]" : "focus-within:ring-2 focus-within:ring-[#5865f2]"}`}>
          <span className="text-[#949ba4] mr-1">@</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} className="flex-1 bg-transparent outline-none text-white" autoFocus />
        </div>
        <p className="text-xs text-[#949ba4] mt-2">По юзернейму тебя добавляют в друзья.</p>
        {err && <p key={err} className="animate-fade text-sm text-[#f23f42] mt-3">{err}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="h-10 px-4 rounded-md text-white hover:underline">Отмена</button>
          <button type="submit" disabled={saving} className="h-10 px-5 rounded-md bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-70 text-white font-medium transition-colors">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}

function ChannelModal({ token, serverId, onClose, onCreated }: { token: string; serverId: number; onClose: () => void; onCreated: (c: Channel) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    try {
      const c = await api<Channel>("/api/channels", token, { server_id: serverId, name });
      onCreated(c);
      onClose();
    } catch (error) {
      setErr(errText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Новый канал" onClose={onClose}>
      <form onSubmit={create}>
        <span className="text-sm font-semibold mb-2 block text-[#b5bac1]">Название канала</span>
        <div className={`flex items-center h-11 rounded-md bg-[#1e1f22] px-3 ${err ? "ring-1 ring-[#f23f42]" : "focus-within:ring-2 focus-within:ring-[#5865f2]"}`}>
          <span className="text-[#949ba4] mr-1">#</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="новый-канал" maxLength={32} className="flex-1 bg-transparent outline-none text-white placeholder-[#4e5058]" autoFocus />
        </div>
        {err && <p key={err} className="animate-fade text-sm text-[#f23f42] mt-3">{err}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="h-10 px-4 rounded-md text-white hover:underline">Отмена</button>
          <button type="submit" disabled={saving || !name.trim()} className="h-10 px-5 rounded-md bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-60 text-white font-medium transition-colors">Создать</button>
        </div>
      </form>
    </Modal>
  );
}

function ServerModal({ token, onClose, onCreated }: { token: string; onClose: () => void; onCreated: (s: Server) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    try {
      const s = await api<Server>("/api/servers", token, { name });
      onCreated(s);
      onClose();
    } catch (error) {
      setErr(errText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Создать сервер" onClose={onClose}>
      <form onSubmit={create}>
        <span className="text-sm font-semibold mb-2 block text-[#b5bac1]">Название сервера</span>
        <div className={`flex items-center h-11 rounded-md bg-[#1e1f22] px-3 ${err ? "ring-1 ring-[#f23f42]" : "focus-within:ring-2 focus-within:ring-[#5865f2]"}`}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Мой сервер" maxLength={32} className="flex-1 bg-transparent outline-none text-white placeholder-[#4e5058]" autoFocus />
        </div>
        {err && <p key={err} className="animate-fade text-sm text-[#f23f42] mt-3">{err}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="h-10 px-4 rounded-md text-white hover:underline">Отмена</button>
          <button type="submit" disabled={saving || !name.trim()} className="h-10 px-5 rounded-md bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-60 text-white font-medium transition-colors">Создать</button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────── друзья ───────────── */

function FriendsView({ token, data, onChanged }: { token: string; data: FriendsData; onChanged: () => void }) {
  const [tab, setTab] = useState<"all" | "pending" | "add">("all");
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const pendingCount = data.incoming.length;

  const act = async (path: string, h: string) => {
    try { await api(path, token, { handle: h }); onChanged(); } catch (e) { setNote({ ok: false, text: errText(e) }); }
  };

  const addFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim()) return;
    try {
      await api("/api/friends/request", token, { handle });
      setNote({ ok: true, text: `Заявка для @${handle.trim().replace(/^@/, "").toLowerCase()} отправлена` });
      setHandle(""); onChanged();
    } catch (err) { setNote({ ok: false, text: errText(err) }); }
  };

  const sortedFriends = [...data.friends].sort((a, b) => Number(!!b.online) - Number(!!a.online) || a.username.localeCompare(b.username));
  const tabBtn = (id: typeof tab, label: string, badge?: number) => (
    <button onClick={() => { setTab(id); setNote(null); }} className={`h-7 px-3 rounded-md text-sm font-medium flex items-center gap-2 transition-colors ${tab === id ? "bg-[#404249] text-white" : "text-[#b5bac1] hover:bg-[#35373c] hover:text-white"}`}>
      {label}
      {!!badge && <span className="min-w-4 h-4 px-1 rounded-full bg-[#f23f42] text-white text-[11px] leading-4 text-center">{badge}</span>}
    </button>
  );

  const row = (p: Person, actions: React.ReactNode, showStatus = false) => (
    <div key={p.handle} className="animate-msg-in group flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[#35373c] border-t border-[#3f4147] first:border-t-0">
      <Avatar name={p.username} size={36} online={showStatus ? !!p.online : undefined} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-white truncate">{p.username}</div>
        <div className="text-xs text-[#949ba4] truncate">@{p.handle}{showStatus && <> · {p.online ? "в сети" : "не в сети"}</>}</div>
      </div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );

  const iconBtn = (label: string, onClick: () => void, tone: "ok" | "bad") => (
    <button onClick={onClick} className={`h-8 px-3 rounded-md text-sm font-medium transition-colors ${tone === "ok" ? "bg-[#23a559] hover:bg-[#1a8a49] text-white" : "bg-[#2b2d31] hover:bg-[#f23f42] text-[#dbdee1] hover:text-white"}`}>{label}</button>
  );

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="h-12 shrink-0 flex items-center gap-4 px-4 shadow-sm shadow-black/20">
        <div className="flex items-center gap-2 font-bold text-white"><span className="text-[#80848e]">{Icon.users}</span> Друзья</div>
        <div className="w-px h-5 bg-[#3f4147]" />
        <div className="flex gap-1.5">{tabBtn("all", "Все")}{tabBtn("pending", "Заявки", pendingCount)}{tabBtn("add", "Добавить")}</div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === "all" && (<><div className="text-xs font-bold uppercase text-[#949ba4] mb-3">Друзья — {sortedFriends.length}</div>{sortedFriends.length === 0 ? (<EmptyState title="Пока никого нет" text="Добавь друга по юзернейму во вкладке «Добавить»." />) : (sortedFriends.map((p) => row(p, iconBtn("Удалить", () => act("/api/friends/remove", p.handle), "bad"), true)))}</>)}
        {tab === "pending" && (<><div className="text-xs font-bold uppercase text-[#949ba4] mb-3">Входящие — {data.incoming.length}</div>{data.incoming.length === 0 && <p className="text-sm text-[#949ba4] mb-6">Новых заявок нет.</p>}{data.incoming.map((p) => row(p, (<>{iconBtn("Принять", () => act("/api/friends/accept", p.handle), "ok")}{iconBtn("Отклонить", () => act("/api/friends/remove", p.handle), "bad")}</>)))}<div className="text-xs font-bold uppercase text-[#949ba4] mt-8 mb-3">Исходящие — {data.outgoing.length}</div>{data.outgoing.length === 0 && <p className="text-sm text-[#949ba4]">Ты никому не отправлял заявки.</p>}{data.outgoing.map((p) => row(p, iconBtn("Отменить", () => act("/api/friends/remove", p.handle), "bad")))}</>)}
        {tab === "add" && (<form onSubmit={addFriend} className="max-w-xl"><h2 className="text-lg font-semibold text-white">Добавить в друзья</h2><p className="text-sm text-[#b5bac1] mt-1 mb-4">Введи юзернейм друга — его можно посмотреть в профиле.</p><div className={`flex items-center h-12 rounded-lg bg-[#1e1f22] pl-4 pr-2 ${note && !note.ok ? "ring-1 ring-[#f23f42]" : note?.ok ? "ring-1 ring-[#23a559]" : "focus-within:ring-2 focus-within:ring-[#5865f2]"}`}><span className="text-[#949ba4] mr-1">@</span><input value={handle} onChange={(e) => { setHandle(e.target.value); setNote(null); }} placeholder="юзернейм" className="flex-1 bg-transparent outline-none text-white placeholder-[#4e5058]" autoFocus /><button type="submit" disabled={!handle.trim()} className="h-8 px-4 rounded-md bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">Отправить заявку</button></div></form>)}
        {note && tab !== "add" && <p key={note.text} className="animate-fade mt-4 text-sm text-[#f23f42]">{note.text}</p>}
        {note && tab === "add" && (<p key={note.text} className={`animate-fade mt-3 text-sm ${note.ok ? "text-[#23a559]" : "text-[#f23f42]"}`}>{note.text}</p>)}
      </div>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16">
      <div className="w-20 h-20 rounded-full bg-[#2b2d31] flex items-center justify-center text-[#80848e] mb-4">{Icon.users}</div>
      <div className="text-white font-semibold">{title}</div>
      <div className="text-sm text-[#949ba4] mt-1 max-w-xs">{text}</div>
    </div>
  );
}

/* ───────────── сам чат ───────────── */

function ChatApp({ session, onLogout, onHandleChange }: { session: Session; onLogout: () => void; onHandleChange: (h: string) => void }) {
  const { token, username, handle } = session;

  const [servers, setServers] = useState<Server[]>([]);
  const [activeServerId, setActiveServerId] = useState<number | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [view, setView] = useState<"chat" | "friends">("friends");
  const [activeId, setActiveId] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<Person[]>([]);
  const [unread, setUnread] = useState<Record<number, boolean>>({});
  const [friends, setFriends] = useState<FriendsData>({ friends: [], incoming: [], outgoing: [] });
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [modal, setModal] = useState<null | "channel" | "profile" | "server">(null);

  const wsRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(activeId);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sendWs = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  const loadFriends = useCallback(() => {
    api<FriendsData>("/api/friends", token).then(setFriends).catch(() => {});
  }, [token]);

  // Загрузка серверов
  useEffect(() => {
    api<Server[]>("/api/servers", token).then((s) => {
      setServers(s);
      if (s.length > 0) setActiveServerId(s[0].id);
    }).catch(() => {});
    loadFriends();
  }, [token, loadFriends]);

  // Загрузка каналов при смене сервера
  useEffect(() => {
    if (activeServerId === null) {
      setChannels([]);
      return;
    }
    api<Channel[]>(`/api/channels?server_id=${activeServerId}`, token).then((c) => {
      setChannels(c);
      if (c.length > 0) {
        activeRef.current = c[0].id;
        setActiveId(c[0].id);
        setMessages([]);
        sendWs({ type: "history", channel: c[0].id });
        setView("chat");
      } else {
        setView("chat");
        setActiveId(0);
      }
    }).catch(() => {});
  }, [activeServerId, token, sendWs]);

  // WebSocket соединение
  useEffect(() => {
    let closedByUs = false;
    let retry: number | undefined;
    let ws: WebSocket | null = null;

    const connect = () => {
      const socket = new WebSocket(`${WS_URL}/ws?token=${token}`);
      ws = socket;
      wsRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        if (activeRef.current) {
          socket.send(JSON.stringify({ type: "history", channel: activeRef.current }));
        }
        loadFriends();
      };
      socket.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        switch (data.type) {
          case "history":
            if (data.channel === activeRef.current) setMessages(data.messages);
            break;
          case "message": {
            const m: ChatMessage = data.message;
            if (m.channel === activeRef.current) setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            else if (m.user !== username) setUnread((u) => ({ ...u, [m.channel]: true }));
            break;
          }
          case "presence": setOnline(data.users); break;
          case "channel": setChannels((prev) => (prev.some((c) => c.id === data.channel.id) ? prev : [...prev, data.channel])); break;
          case "friends_update": loadFriends(); break;
        }
      };
      socket.onclose = () => { setConnected(false); if (!closedByUs) retry = window.setTimeout(connect, 2000); };
    };

    connect();
    return () => { closedByUs = true; window.clearTimeout(retry); ws?.close(); wsRef.current = null; };
  }, [token, username, loadFriends]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, activeId, view]);

  const openChannel = (id: number) => {
    setView("chat");
    if (id !== activeRef.current) {
      activeRef.current = id; setActiveId(id); setMessages([]); sendWs({ type: "history", channel: id });
    }
    setUnread((u) => ({ ...u, [id]: false }));
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text || !activeId) return;
    sendWs({ type: "send", channel: activeId, text });
    setInput("");
  };

  const activeChannel = channels.find((c) => c.id === activeId);

  const items = useMemo(() => {
    const out: Array<{ kind: "day"; key: string; label: string } | { kind: "msg"; msg: ChatMessage; head: boolean }> = [];
    let prev: ChatMessage | undefined;
    for (const m of messages) {
      const newDay = !prev || new Date(prev.ts * 1000).toDateString() !== new Date(m.ts * 1000).toDateString();
      if (newDay) out.push({ kind: "day", key: `d${m.id}`, label: dayLabel(m.ts) });
      const head = newDay || !prev || prev.user !== m.user || m.ts - prev.ts > 420;
      out.push({ kind: "msg", msg: m, head });
      prev = m;
    }
    return out;
  }, [messages]);

  const onlineSorted = useMemo(() => [...online].sort((a, b) => a.username.localeCompare(b.username)), [online]);

  return (
    <div className="animate-chat-in flex h-screen bg-[#313338] text-[#dbdee1] font-sans">
      
      {/* полоса серверов */}
      <div className="w-[72px] shrink-0 bg-[#1e1f22] flex flex-col items-center py-3 gap-2 overflow-y-auto">
        {servers.map((s) => (
          <div
            key={s.id}
            onClick={() => setActiveServerId(s.id)}
            className={`w-12 h-12 flex items-center justify-center font-bold text-white cursor-pointer transition-all duration-200 ${activeServerId === s.id ? "bg-[#5865f2] rounded-[16px]" : "bg-[#313338] rounded-full hover:bg-[#5865f2] hover:rounded-[16px]"}`}
            title={s.name}
          >
            {s.name.charAt(0).toUpperCase()}
          </div>
        ))}
        <div className="w-8 h-0.5 rounded bg-[#35363c] my-1" />
        <button onClick={() => setModal("server")} className="w-12 h-12 bg-[#313338] rounded-full flex items-center justify-center text-[#23a559] text-2xl cursor-pointer hover:bg-[#23a559] hover:text-white hover:rounded-[16px] transition-all duration-200" title="Создать сервер">+</button>
      </div>

      {/* панель каналов */}
      <div className="w-[240px] shrink-0 bg-[#2b2d31] flex flex-col">
        <div className="h-12 shrink-0 flex items-center px-4 font-bold text-white shadow-sm shadow-black/20">
          {servers.find(s => s.id === activeServerId)?.name || "FYCORD"}
        </div>

        <div className="p-2 flex-1 overflow-y-auto">
          <button onClick={() => setView("friends")} className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors ${view === "friends" ? "bg-[#404249] text-white" : "text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]"}`}>
            {Icon.users}
            <span className="font-medium flex-1 text-left">Друзья</span>
            {friends.incoming.length > 0 && (<span className="min-w-5 h-5 px-1.5 rounded-full bg-[#f23f42] text-white text-xs leading-5 text-center">{friends.incoming.length}</span>)}
          </button>

          {activeServerId && (
            <>
              <div className="flex items-center justify-between px-2 pt-5 pb-1 group">
                <span className="text-xs font-bold text-[#949ba4] uppercase tracking-wide">Текстовые каналы</span>
                <button onClick={() => setModal("channel")} title="Создать канал" className="w-5 h-5 flex items-center justify-center rounded text-[#949ba4] hover:text-white text-lg leading-none transition-colors">+</button>
              </div>

              {channels.map((c) => {
                const active = view === "chat" && c.id === activeId;
                return (
                  <button key={c.id} onClick={() => openChannel(c.id)} className={`w-full flex items-center gap-2 px-2 py-1.5 mt-0.5 rounded-md transition-colors ${active ? "bg-[#404249] text-white" : unread[c.id] ? "text-white hover:bg-[#35373c]" : "text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]"}`}>
                    <span className="text-[#80848e] shrink-0">{Icon.hash}</span>
                    <span className={`truncate flex-1 text-left ${unread[c.id] && !active ? "font-semibold" : ""}`}>{c.name}</span>
                    {unread[c.id] && !active && <span className="w-2 h-2 rounded-full bg-white shrink-0" />}
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* карточка пользователя */}
        <div className="h-[52px] shrink-0 bg-[#232428] flex items-center px-2 gap-2">
          <button onClick={() => setModal("profile")} className="flex items-center gap-2 flex-1 min-w-0 p-1 rounded-md hover:bg-white/5 transition-colors text-left">
            <Avatar name={username} size={32} online={connected} />
            <div className="min-w-0 leading-tight">
              <div className="text-sm font-semibold text-white truncate">{username}</div>
              <div className="text-xs text-[#949ba4] truncate">{connected ? `@${handle}` : "Подключение…"}</div>
            </div>
          </button>
          <button onClick={() => setModal("profile")} title="Профиль" className="w-8 h-8 flex items-center justify-center rounded-md text-[#b5bac1] hover:bg-white/5 hover:text-white transition-colors">{Icon.gear}</button>
          <button onClick={onLogout} title="Выйти" className="w-8 h-8 flex items-center justify-center rounded-md text-[#b5bac1] hover:bg-white/5 hover:text-[#f23f42] transition-colors">{Icon.logout}</button>
        </div>
      </div>

      {/* основная область */}
      {view === "friends" ? (
        <FriendsView token={token} data={friends} onChanged={loadFriends} />
      ) : (
        <>
          <div className="flex-1 flex flex-col min-w-0">
            <div className="h-12 shrink-0 flex items-center px-4 font-bold text-white shadow-sm shadow-black/20">
              <span className="text-[#80848e] mr-2">{Icon.hash}</span>
              {activeChannel?.name ?? "Канал"}
            </div>

            {!connected && (<div className="shrink-0 bg-[#f0b232]/15 text-[#f0b232] text-sm px-4 py-1.5">Переподключение к серверу…</div>)}

            <div className="flex-1 overflow-y-auto py-4">
              {!activeChannel && <div className="flex h-full items-center justify-center text-[#949ba4]">Выберите или создайте канал</div>}

              {messages.length === 0 && activeChannel && (
                <div className="px-4 pb-4">
                  <div className="w-16 h-16 rounded-full bg-[#41434a] flex items-center justify-center text-white mb-3 scale-125 origin-left ml-2">{Icon.hash}</div>
                  <h2 className="text-3xl font-bold text-white mt-5">Добро пожаловать в #{activeChannel.name}!</h2>
                  <p className="text-[#b5bac1] mt-1">Это начало канала. Напиши первое сообщение.</p>
                </div>
              )}

              {items.map((it) =>
                it.kind === "day" ? (
                  <div key={it.key} className="flex items-center gap-3 mx-4 my-4 text-xs font-semibold text-[#949ba4]"><div className="flex-1 h-px bg-[#3f4147]" />{it.label}<div className="flex-1 h-px bg-[#3f4147]" /></div>
                ) : (
                  <div key={it.msg.id} className={`animate-msg-in group flex gap-4 px-4 py-0.5 hover:bg-[#2e3035] ${it.head ? "mt-4" : ""}`}>
                    {it.head ? (<Avatar name={it.msg.user} />) : (<div className="w-10 shrink-0 text-[10px] leading-[22px] text-center text-[#949ba4] opacity-0 group-hover:opacity-100 select-none">{fmtTime(it.msg.ts)}</div>)}
                    <div className="min-w-0">
                      {it.head && (<div className="flex items-baseline gap-2"><span className="font-medium" style={{ color: `hsl(${hue(it.msg.user)} 75% 72%)` }}>{it.msg.user}</span><span className="text-xs text-[#949ba4]">{fmtTime(it.msg.ts)}</span></div>)}
                      <p className="text-[#dbdee1] break-words whitespace-pre-wrap leading-[1.4]">{it.msg.text}</p>
                    </div>
                  </div>
                )
              )}
              <div ref={bottomRef} />
            </div>

            <div className="px-4 pb-6 pt-1 shrink-0">
              <div className="bg-[#383a40] rounded-lg flex items-center px-4 focus-within:ring-1 focus-within:ring-[#5865f2]/60 transition-shadow">
                <input type="text" value={input} maxLength={2000} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMessage()} placeholder={activeChannel ? `Написать в #${activeChannel.name}` : "Выберите канал"} disabled={!activeChannel} className="w-full bg-transparent py-3 outline-none text-white placeholder-[#6d6f78] disabled:opacity-50" />
              </div>
            </div>
          </div>

          {/* участники онлайн */}
          <div className="hidden lg:flex w-[240px] shrink-0 flex-col bg-[#2b2d31] overflow-y-auto">
            <div className="px-4 pt-6 pb-2 text-xs font-bold uppercase text-[#949ba4]">В сети — {onlineSorted.length}</div>
            <div className="px-2 pb-4">
              {onlineSorted.map((p) => (
                <div key={p.handle} className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-[#35373c] transition-colors">
                  <Avatar name={p.username} size={32} online />
                  <div className="min-w-0 leading-tight">
                    <div className="font-medium truncate" style={{ color: `hsl(${hue(p.username)} 75% 72%)` }}>{p.username}</div>
                    <div className="text-xs text-[#949ba4] truncate">@{p.handle}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {modal === "profile" && (<ProfileModal session={session} onClose={() => setModal(null)} onSaved={onHandleChange} />)}
      {modal === "channel" && activeServerId && (
        <ChannelModal token={token} serverId={activeServerId} onClose={() => setModal(null)} onCreated={(c) => { setChannels((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c])); openChannel(c.id); }} />
      )}
      {modal === "server" && (
        <ServerModal token={token} onClose={() => setModal(null)} onCreated={(s) => { setServers((prev) => [...prev, s]); setActiveServerId(s.id); }} />
      )}
    </div>
  );
}

/* ───────────── корень ───────────── */

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  if (!session) return <AuthScreen onAuth={setSession} />;
  return <ChatApp key={session.token} session={session} onLogout={() => setSession(null)} onHandleChange={(h) => setSession({ ...session, handle: h })} />;
}