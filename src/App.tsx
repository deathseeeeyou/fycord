import { useCallback, useEffect, useRef, useState } from "react";

const SERVER = "de1-free.witchly.host:41600";
const HTTP_URL = `http://${SERVER}`;
const WS_URL = `ws://${SERVER}`;

type Session = { token: string; username: string; nickname: string; handle: string; avatar: string | null };
type Server = { id: number; name: string; is_owner: boolean };
type Channel = { id: number; server_id: number; name: string };
type ChatMessage = { id: number; channel: number; user: string; text: string; ts: number };
type DMMessage = { id: number; sender: string; receiver: string; text: string; ts: number };
type Person = { username: string; handle: string; online?: boolean; avatar?: string | null };
type FriendsData = { friends: Person[]; incoming: Person[]; outgoing: Person[] };

async function api<T = unknown>(path: string, token: string | null, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(`${HTTP_URL}${path}`, {
    method: hasBody ? "POST" : "GET",
    headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.text()) || "Ошибка");
  return res.json() as Promise<T>;
}

function errText(e: unknown): string { return e instanceof TypeError ? "Не удалось подключиться" : e instanceof Error ? e.message : "Ошибка"; }
function hue(name: string): number { let h = 0; for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (ts: number) => {
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Сегодня";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
};

/* ───────────── Базовые компоненты ───────────── */

function Avatar({ name, avatar, size = 40, online }: { name: string; avatar?: string | null; size?: number; online?: boolean }) {
  const h = hue(name);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {avatar ? (
        <img src={avatar} alt={name} className="w-full h-full rounded-full object-cover" />
      ) : (
        <div className="w-full h-full rounded-full flex items-center justify-center font-bold text-white select-none" style={{ background: `linear-gradient(135deg, hsl(${h} 65% 55%), hsl(${(h + 40) % 360} 65% 40%))`, fontSize: size * 0.42 }}>
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      {online !== undefined && <span className={`absolute -bottom-0.5 -right-0.5 rounded-full border-[3px] border-[#2b2d31] ${online ? "bg-[#23a559]" : "bg-[#80848e]"}`} style={{ width: size * 0.4, height: size * 0.4 }} />}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onMouseDown={onClose}>
      <div className="animate-pop w-full max-w-[420px] rounded-xl bg-[#313338] shadow-2xl shadow-black/50" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5"><h2 className="text-lg font-semibold text-white">{title}</h2><button onClick={onClose} className="w-8 h-8 rounded-md text-[#949ba4] hover:text-white hover:bg-white/5 transition-colors">✕</button></div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, type = "text", value, onChange, error, placeholder, autoComplete, right, disabled }: { label: string; type?: string; value: string; onChange: (v: string) => void; error?: string; placeholder?: string; autoComplete?: string; right?: React.ReactNode; disabled?: boolean; }) {
  return (
    <label className="block">
      <span className={`text-sm font-semibold mb-2 block transition-colors duration-200 ${error ? "text-[#f23f42]" : "text-[#b5bac1]"}`}>
        {label}
        {error && <span key={error} className="animate-fade font-normal italic text-[#f23f42]"> — {error}</span>}
      </span>
      <div className="relative">
        <input type={type} value={value} autoComplete={autoComplete} disabled={disabled} tabIndex={disabled ? -1 : 0} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`w-full h-11 px-3 pr-11 bg-[#1e1f22] rounded-md text-[#dbdee1] placeholder-[#4e5058] outline-none transition-shadow duration-200 ${error ? "ring-1 ring-[#f23f42]" : "focus:ring-2 focus:ring-[#5865f2]"}`} />
        {right && <div className="absolute inset-y-0 right-0 flex items-center pr-3">{right}</div>}
      </div>
    </label>
  );
}

const Icon = {
  hash: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></svg>),
  users: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>),
  gear: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>),
  logout: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>),
  eye: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>),
  eyeOff: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
};

/* ───────────── Красивый экран входа ───────────── */

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

  const doShake = () => { setShake(true); setTimeout(() => setShake(false), 400); };

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
    if (Object.keys(e).length) { doShake(); return; }
    setLoading(true);
    try {
      const data = await api<Session>(`/api/${isLogin ? "login" : "register"}`, null, { username: username.trim(), password });
      onAuth(data);
    } catch (err) {
      setErrors({ form: errText(err) });
      doShake();
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => { setIsLogin(!isLogin); setErrors({}); setConfirmPassword(""); };

  return (
    <div className="relative flex items-center justify-center min-h-screen bg-[#1e1f22] p-4 overflow-hidden select-none">
      <div className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full bg-[#5865f2] blur-3xl opacity-20" />
      <div className="absolute -bottom-40 -right-24 w-[520px] h-[520px] rounded-full bg-[#23a559] blur-3xl opacity-10" />
      <div className="animate-card-in relative z-10 w-full max-w-[820px] flex rounded-lg overflow-hidden bg-[#313338] shadow-2xl shadow-black/40">
        <form onSubmit={handleSubmit} noValidate className={`flex-1 p-8 sm:p-10 min-w-0 ${shake ? "animate-shake" : ""}`}>
          <div key={String(isLogin)} className="animate-fade text-center mb-7">
            <h1 className="text-2xl font-semibold text-white">{isLogin ? "С возвращением!" : "Создать аккаунт"}</h1>
            <p className="text-[#b5bac1] mt-2">{isLogin ? "Мы так рады видеть тебя снова!" : "Присоединяйся к Fycord"}</p>
          </div>
          <div className="flex flex-col gap-5">
            <Field label="Имя пользователя" value={username} onChange={setUsername} error={errors.username} autoComplete="username" />
            <Field label="Пароль" type={showPass ? "text" : "password"} value={password} onChange={setPassword} error={errors.password} autoComplete={isLogin ? "current-password" : "new-password"} right={<button type="button" onClick={() => setShowPass(!showPass)} className="text-white/80 hover:text-white transition-colors">{showPass ? Icon.eyeOff : Icon.eye}</button>} />
            <div aria-hidden={isLogin} className={`grid transition-all duration-300 ease-out ${isLogin ? "grid-rows-[0fr] opacity-0 -mt-5" : "grid-rows-[1fr] opacity-100"}`}>
              <div className={`overflow-hidden -mx-1 px-1 transition-[padding] duration-300 ${isLogin ? "" : "pb-1"}`}>
                <Field label="Повтори пароль" type={showPass ? "text" : "password"} value={confirmPassword} onChange={setConfirmPassword} error={errors.confirm} autoComplete="new-password" disabled={isLogin} />
              </div>
            </div>
          </div>
          {errors.form && <p key={errors.form} className="animate-fade mt-5 text-sm text-[#f23f42]">{errors.form}</p>}
          <button type="submit" disabled={loading} className="w-full h-11 mt-6 rounded-md bg-[#5865f2] hover:bg-[#4752c4] disabled:opacity-70 disabled:cursor-wait text-white font-medium transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2">
            {loading && <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
            {loading ? "Подожди…" : isLogin ? "Войти" : "Создать аккаунт"}
          </button>
          <p className="mt-4 text-sm text-[#949ba4]">{isLogin ? "Нужен аккаунт?" : "Уже есть аккаунт?"}{" "}<button type="button" onClick={switchMode} className="text-[#00a8fc] hover:underline">{isLogin ? "Зарегистрироваться" : "Войти"}</button></p>
        </form>
        <div className="hidden md:flex w-[280px] shrink-0 flex-col items-center justify-center text-center gap-6 p-8 bg-[#2b2d31] border-l border-[#232428]">
          <div className="animate-float w-32 h-32 rounded-[36px] bg-gradient-to-br from-[#7983f5] to-[#4752c4] flex items-center justify-center text-6xl font-extrabold text-white shadow-xl shadow-[#5865f2]/30">F</div>
          <div><h2 className="text-xl font-semibold text-white">Fycord</h2><p className="text-sm text-[#b5bac1] mt-2 leading-relaxed">Место, где можно просто поболтать с друзьями.</p></div>
        </div>
      </div>
    </div>
  );
}

/* ───────────── Настройки, Каналы, Сервера ───────────── */

function SettingsModal({ session, onClose, onSaved }: { session: Session; onClose: () => void; onSaved: (s: Session) => void }) {
  const [nickname, setNickname] = useState(session.nickname);
  const [handle, setHandle] = useState(session.handle);
  const [avatar, setAvatar] = useState(session.avatar || "");
  const [err, setErr] = useState("");

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try {
      await api("/api/profile", session.token, { nickname, avatar: avatar || null });
      const h = await api<{ handle: string }>("/api/handle", session.token, { handle });
      onSaved({ ...session, nickname, handle: h.handle, avatar: avatar || null });
      onClose();
    } catch (error) { setErr(errText(error)); }
  };

  return (
    <Modal title="Настройки профиля" onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <Avatar name={nickname} avatar={avatar} size={64} />
          <div className="flex-1">
            <label className="text-xs font-bold text-[#b5bac1] uppercase mb-1 block">Ссылка на аватарку</label>
            <input value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="https://..." className="w-full h-9 px-2 bg-[#1e1f22] rounded text-white text-sm outline-none" />
          </div>
        </div>
        <div>
          <label className="text-xs font-bold text-[#b5bac1] uppercase mb-1 block">Никнейм</label>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={32} className="w-full h-10 px-3 bg-[#1e1f22] rounded text-white outline-none" />
        </div>
        <div>
          <label className="text-xs font-bold text-[#b5bac1] uppercase mb-1 block">Юзернейм</label>
          <input value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={32} className="w-full h-10 px-3 bg-[#1e1f22] rounded text-white outline-none" />
        </div>
        {err && <p className="text-sm text-[#f23f42]">{err}</p>}
        <button type="submit" className="h-10 mt-2 rounded bg-[#5865f2] text-white font-medium">Сохранить</button>
      </form>
    </Modal>
  );
}

function ChannelModal({ token, serverId, onClose, onCreated }: { token: string; serverId: number; onClose: () => void; onCreated: (c: Channel) => void }) {
  const [name, setName] = useState(""); const [err, setErr] = useState("");
  const create = async (e: React.FormEvent) => { e.preventDefault(); try { const c = await api<Channel>("/api/channels", token, { server_id: serverId, name }); onCreated(c); onClose(); } catch (error) { setErr(errText(error)); } };
  return (
    <Modal title="Новый канал" onClose={onClose}>
      <form onSubmit={create}>
        <div className="flex items-center h-11 rounded bg-[#1e1f22] px-3"><span className="text-[#949ba4] mr-1">#</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="новый-канал" className="flex-1 bg-transparent outline-none text-white" autoFocus /></div>
        {err && <p className="text-sm text-[#f23f42] mt-2">{err}</p>}
        <button type="submit" disabled={!name.trim()} className="w-full h-10 mt-4 rounded bg-[#5865f2] text-white font-medium disabled:opacity-50">Создать</button>
      </form>
    </Modal>
  );
}

function ServerModal({ token, onClose, onCreated }: { token: string; onClose: () => void; onCreated: (s: Server) => void }) {
  const [name, setName] = useState(""); const [err, setErr] = useState("");
  const create = async (e: React.FormEvent) => { e.preventDefault(); try { const s = await api<Server>("/api/servers", token, { name }); onCreated(s); onClose(); } catch (error) { setErr(errText(error)); } };
  return (
    <Modal title="Создать сервер" onClose={onClose}>
      <form onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Мой сервер" className="w-full h-11 px-3 bg-[#1e1f22] rounded text-white outline-none" autoFocus />
        {err && <p className="text-sm text-[#f23f42] mt-2">{err}</p>}
        <button type="submit" disabled={!name.trim()} className="w-full h-10 mt-4 rounded bg-[#5865f2] text-white font-medium disabled:opacity-50">Создать</button>
      </form>
    </Modal>
  );
}

/* ───────────── Элемент сервера с тултипом ───────────── */

function ServerItem({ server, active, onClick, onContextMenu }: { server: Server; active: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void }) {
  const [show, setShow] = useState(false);
  const timer = useRef<number>();
  return (
    <div className="relative flex items-center justify-center w-full group"
      onMouseEnter={() => { timer.current = window.setTimeout(() => setShow(true), 1000); }}
      onMouseLeave={() => { clearTimeout(timer.current); setShow(false); }}
    >
      <div className={`absolute left-0 w-1 bg-white rounded-r transition-all duration-200 ${active ? "h-10" : "h-0 group-hover:h-5"}`} />
      <div onClick={onClick} onContextMenu={onContextMenu} className={`w-12 h-12 flex items-center justify-center font-bold text-white cursor-pointer transition-all duration-200 ${active ? "bg-[#5865f2] rounded-[16px]" : "bg-[#313338] rounded-full hover:bg-[#5865f2] hover:rounded-[16px]"}`}>
        {server.name.charAt(0).toUpperCase()}
      </div>
      {show && (
        <div className="absolute left-[72px] px-3 py-2 bg-black text-white text-sm font-medium rounded shadow-lg z-50 whitespace-nowrap pointer-events-none animate-fade">
          {server.name}
          <div className="absolute top-1/2 -left-1 -translate-y-1/2 w-2 h-2 bg-black rotate-45" />
        </div>
      )}
    </div>
  );
}

/* ───────────── Друзья ───────────── */

function FriendsView({ token, data, onChanged, onOpenDM }: { token: string; data: FriendsData; onChanged: () => void; onOpenDM: (p: Person) => void }) {
  const [tab, setTab] = useState<"all" | "pending" | "add">("all");
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const act = async (path: string, h: string) => { try { await api(path, token, { handle: h }); onChanged(); } catch (e) { setNote({ ok: false, text: errText(e) }); } };
  const addFriend = async (e: React.FormEvent) => { e.preventDefault(); if (!handle.trim()) return; try { await api("/api/friends/request", token, { handle }); setNote({ ok: true, text: `Заявка отправлена` }); setHandle(""); onChanged(); } catch (err) { setNote({ ok: false, text: errText(err) }); } };

  const row = (p: Person, actions: React.ReactNode, clickable = false) => (
    <div key={p.handle} onClick={() => clickable && onOpenDM(p)} className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg border-t border-[#3f4147] first:border-t-0 ${clickable ? "hover:bg-[#35373c] cursor-pointer" : "hover:bg-[#35373c]"}`}>
      <Avatar name={p.username} avatar={p.avatar} size={36} online={!!p.online} />
      <div className="min-w-0 flex-1"><div className="font-semibold text-white truncate">{p.username}</div><div className="text-xs text-[#949ba4] truncate">@{p.handle}</div></div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );

  const btn = (label: string, onClick: (e: React.MouseEvent) => void, tone: "ok" | "bad") => (
    <button onClick={(e) => { e.stopPropagation(); onClick(e); }} className={`h-8 px-3 rounded text-sm font-medium ${tone === "ok" ? "bg-[#23a559] text-white" : "bg-[#2b2d31] hover:bg-[#f23f42] text-[#dbdee1] hover:text-white"}`}>{label}</button>
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#313338]">
      <div className="h-12 shrink-0 flex items-center gap-4 px-4 shadow-sm shadow-black/20">
        <div className="font-bold text-white flex items-center gap-2"><span className="text-[#80848e]">{Icon.users}</span> Друзья</div>
        <div className="w-px h-5 bg-[#3f4147]" />
        <div className="flex gap-1.5">
          {["all", "pending", "add"].map((t) => (
            <button key={t} onClick={() => setTab(t as any)} className={`h-7 px-3 rounded text-sm font-medium ${tab === t ? "bg-[#404249] text-white" : "text-[#b5bac1] hover:bg-[#35373c]"}`}>
              {t === "all" ? "Все" : t === "pending" ? `Заявки (${data.incoming.length})` : "Добавить"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "all" && (
          <>
            <div className="text-xs font-bold uppercase text-[#949ba4] mb-3">Друзья — {data.friends.length}</div>
            {data.friends.length === 0 ? <p className="text-sm text-[#949ba4]">Пока никого нет.</p> : data.friends.map((p) => row(p, btn("Удалить", () => act("/api/friends/remove", p.handle), "bad"), true))}
          </>
        )}
        {tab === "pending" && (
          <>
            <div className="text-xs font-bold uppercase text-[#949ba4] mb-3">Входящие — {data.incoming.length}</div>
            {data.incoming.map((p) => row(p, <>{btn("Принять", () => act("/api/friends/accept", p.handle), "ok")}{btn("Отклонить", () => act("/api/friends/remove", p.handle), "bad")}</>))}
            <div className="text-xs font-bold uppercase text-[#949ba4] mt-8 mb-3">Исходящие — {data.outgoing.length}</div>
            {data.outgoing.map((p) => row(p, btn("Отменить", () => act("/api/friends/remove", p.handle), "bad")))}
          </>
        )}
        {tab === "add" && (
          <form onSubmit={addFriend} className="max-w-xl">
            <h2 className="text-lg font-semibold text-white mb-2">Добавить в друзья</h2>
            <div className="flex items-center h-12 rounded-lg bg-[#1e1f22] pl-4 pr-2"><span className="text-[#949ba4] mr-1">@</span><input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="юзернейм" className="flex-1 bg-transparent outline-none text-white" autoFocus /><button type="submit" disabled={!handle.trim()} className="h-8 px-4 rounded bg-[#5865f2] text-white text-sm font-medium disabled:opacity-50">Отправить</button></div>
            {note && <p className={`mt-3 text-sm ${note.ok ? "text-[#23a559]" : "text-[#f23f42]"}`}>{note.text}</p>}
          </form>
        )}
      </div>
    </div>
  );
}

/* ───────────── Основной чат ───────────── */

function ChatApp({ session: initialSession, onLogout }: { session: Session; onLogout: () => void }) {
  const [session, setSession] = useState(initialSession);
  const { token, nickname, handle, avatar } = session;

  const [servers, setServers] = useState<Server[]>([]);
  const [activeServerId, setActiveServerId] = useState<number | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [view, setView] = useState<"chat" | "friends" | "dm">("friends");
  const [activeId, setActiveId] = useState(0);
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [dms, setDms] = useState<DMMessage[]>([]);
  const [activeDM, setActiveDM] = useState<Person | null>(null);
  
  const [friends, setFriends] = useState<FriendsData>({ friends: [], incoming: [], outgoing: [] });
  const [input, setInput] = useState("");
  const [modal, setModal] = useState<null | "channel" | "profile" | "server">(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; server: Server } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(activeId);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sendWs = useCallback((payload: unknown) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload)); }, []);
  const loadFriends = useCallback(() => { api<FriendsData>("/api/friends", token).then(setFriends).catch(() => {}); }, [token]);

  // Отключаем меню ПКМ
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  useEffect(() => {
    api<Server[]>("/api/servers", token).then((s) => { setServers(s); if (s.length > 0) setActiveServerId(s[0].id); }).catch(() => {});
    loadFriends();
  }, [token, loadFriends]);

  useEffect(() => {
    if (activeServerId === null) { setChannels([]); if (view !== "dm") setView("friends"); return; }
    api<Channel[]>(`/api/channels?server_id=${activeServerId}`, token).then((c) => {
      setChannels(c);
      if (c.length > 0) { activeRef.current = c[0].id; setActiveId(c[0].id); setMessages([]); sendWs({ type: "history", channel: c[0].id }); setView("chat"); }
      else { setView("chat"); setActiveId(0); setMessages([]); }
    }).catch(() => {});
  }, [activeServerId, token, sendWs]);

  useEffect(() => {
    let closedByUs = false; let retry: number | undefined; let ws: WebSocket | null = null;
    const connect = () => {
      const socket = new WebSocket(`${WS_URL}/ws?token=${token}`);
      ws = socket; wsRef.current = socket;
      socket.onopen = () => { if (activeRef.current) socket.send(JSON.stringify({ type: "history", channel: activeRef.current })); loadFriends(); };
      socket.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.type === "history") { if (data.channel === activeRef.current) setMessages(data.messages); }
        else if (data.type === "message") { const m: ChatMessage = data.message; if (m.channel === activeRef.current) setMessages((p) => p.some((x) => x.id === m.id) ? p : [...p, m]); }
        else if (data.type === "dm_history") { if (data.with === activeDM?.handle) setDms(data.messages); }
        else if (data.type === "dm") { const m: DMMessage = data.message; if (activeDM && (m.sender === activeDM.handle || m.receiver === activeDM.handle)) setDms((p) => p.some((x) => x.id === m.id) ? p : [...p, m]); }
        else if (data.type === "friends_update" || data.type === "presence") loadFriends();
      };
      socket.onclose = () => { if (!closedByUs) retry = window.setTimeout(connect, 2000); };
    };
    connect();
    return () => { closedByUs = true; window.clearTimeout(retry); ws?.close(); };
  }, [token, loadFriends, activeDM]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, dms, view]);

  const openChannel = (id: number) => { setView("chat"); activeRef.current = id; setActiveId(id); setMessages([]); sendWs({ type: "history", channel: id }); };
  const openDM = (p: Person) => { setView("dm"); setActiveDM(p); setDms([]); sendWs({ type: "dm_history", receiver: p.handle }); };

  const sendMessage = () => {
    if (!input.trim()) return;
    if (view === "chat" && activeId) sendWs({ type: "send", channel: activeId, text: input });
    if (view === "dm" && activeDM) sendWs({ type: "dm_send", receiver: activeDM.handle, text: input });
    setInput("");
  };

  const handleServerContextMenu = (e: React.MouseEvent, server: Server) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, server });
  };

  const deleteServer = async () => {
    if (!ctxMenu) return;
    await api("/api/servers/delete", token, { server_id: ctxMenu.server.id });
    setServers((s) => s.filter((x) => x.id !== ctxMenu.server.id));
    setActiveServerId(null); setView("friends"); setCtxMenu(null);
  };
  const leaveServer = async () => {
    if (!ctxMenu) return;
    await api("/api/servers/leave", token, { server_id: ctxMenu.server.id });
    setServers((s) => s.filter((x) => x.id !== ctxMenu.server.id));
    setActiveServerId(null); setView("friends"); setCtxMenu(null);
  };

  const activeChannel = channels.find((c) => c.id === activeId);

  return (
    <div className="flex h-screen bg-[#313338] text-[#dbdee1] font-sans select-none">
      
      {/* Меню ПКМ */}
      {ctxMenu && (
        <div className="fixed z-50 bg-[#111214] rounded-md shadow-xl py-1.5 w-48 border border-[#2b2d31]" style={{ top: ctxMenu.y, left: ctxMenu.x }} onMouseLeave={() => setCtxMenu(null)}>
          {ctxMenu.server.is_owner ? (
            <>
              <button className="w-full text-left px-3 py-1.5 text-sm text-[#b5bac1] hover:bg-[#5865f2] hover:text-white">Настройки сервера</button>
              <button onClick={deleteServer} className="w-full text-left px-3 py-1.5 text-sm text-[#f23f42] hover:bg-[#f23f42] hover:text-white">Удалить сервер</button>
            </>
          ) : (
            <button onClick={leaveServer} className="w-full text-left px-3 py-1.5 text-sm text-[#f23f42] hover:bg-[#f23f42] hover:text-white">Покинуть сервер</button>
          )}
        </div>
      )}

      {/* Сервера */}
      <div className="w-[72px] shrink-0 bg-[#1e1f22] flex flex-col items-center py-3 gap-2 overflow-y-auto">
        <div onClick={() => { setActiveServerId(null); setView("friends"); }} className={`w-12 h-12 flex items-center justify-center font-bold text-white cursor-pointer transition-all duration-200 ${activeServerId === null && view !== "dm" ? "bg-[#5865f2] rounded-[16px]" : "bg-[#313338] rounded-full hover:bg-[#5865f2] hover:rounded-[16px]"}`}>F</div>
        <div className="w-8 h-0.5 rounded bg-[#35363c] my-1" />
        
        {servers.map((s) => (
          <ServerItem key={s.id} server={s} active={activeServerId === s.id} onClick={() => { setActiveServerId(s.id); setActiveDM(null); }} onContextMenu={(e) => handleServerContextMenu(e, s)} />
        ))}
        
        <button onClick={() => setModal("server")} className="w-12 h-12 bg-[#313338] rounded-full flex items-center justify-center text-[#23a559] text-2xl cursor-pointer hover:bg-[#23a559] hover:text-white hover:rounded-[16px] transition-all duration-200 mt-2">+</button>
      </div>

      {/* Каналы / Личка */}
      <div className="w-[240px] shrink-0 bg-[#2b2d31] flex flex-col">
        <div className="h-12 shrink-0 flex items-center px-4 font-bold text-white shadow-sm shadow-black/20 truncate">
          {view === "dm" ? "Личные сообщения" : activeServerId === null ? "Личные сообщения" : servers.find(s => s.id === activeServerId)?.name}
        </div>
        <div className="p-2 flex-1 overflow-y-auto">
          {view === "dm" || activeServerId === null ? (
            <button onClick={() => setView("friends")} className={`w-full flex items-center gap-3 px-2.5 py-2 rounded transition-colors ${view === "friends" ? "bg-[#404249] text-white" : "text-[#949ba4] hover:bg-[#35373c]"}`}>
              {Icon.users}<span className="font-medium flex-1 text-left">Друзья</span>
              {friends.incoming.length > 0 && <span className="min-w-5 h-5 bg-[#f23f42] text-white text-xs rounded-full flex items-center justify-center">{friends.incoming.length}</span>}
            </button>
          ) : (
            <>
              <div className="flex items-center justify-between px-2 pt-2 pb-1"><span className="text-xs font-bold text-[#949ba4] uppercase">Текстовые каналы</span><button onClick={() => setModal("channel")} className="text-[#949ba4] hover:text-white text-lg">+</button></div>
              {channels.map((c) => (
                <button key={c.id} onClick={() => openChannel(c.id)} className={`w-full flex items-center gap-2 px-2 py-1.5 mt-0.5 rounded transition-colors ${view === "chat" && c.id === activeId ? "bg-[#404249] text-white" : "text-[#949ba4] hover:bg-[#35373c]"}`}>
                  <span className="text-[#80848e]">{Icon.hash}</span><span className="truncate flex-1 text-left">{c.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
        
        {/* Профиль снизу */}
        <div className="h-[52px] shrink-0 bg-[#232428] flex items-center px-2 gap-2">
          <button onClick={() => setModal("profile")} className="flex items-center gap-2 flex-1 min-w-0 p-1 rounded hover:bg-white/5 transition-colors text-left">
            <Avatar name={nickname} avatar={avatar} size={32} />
            <div className="min-w-0 leading-tight"><div className="text-sm font-semibold text-white truncate">{nickname}</div><div className="text-xs text-[#949ba4] truncate">@{handle}</div></div>
          </button>
          <button onClick={onLogout} title="Выйти" className="w-8 h-8 flex items-center justify-center rounded text-[#b5bac1] hover:text-[#f23f42]">{Icon.logout}</button>
        </div>
      </div>

      {/* Основной экран */}
      {view === "friends" ? (
        <FriendsView token={token} data={friends} onChanged={loadFriends} onOpenDM={openDM} />
      ) : view === "dm" && activeDM ? (
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-12 shrink-0 flex items-center px-4 font-bold text-white shadow-sm shadow-black/20 border-b border-[#232428]">
            <Avatar name={activeDM.username} avatar={activeDM.avatar} size={24} online={!!activeDM.online} />
            <span className="ml-3">{activeDM.username}</span>
          </div>
          <div className="flex-1 overflow-y-auto py-4 px-4 flex flex-col gap-4">
            {dms.map((m) => (
              <div key={m.id} className={`flex gap-4 ${m.sender === handle ? "flex-row-reverse" : ""}`}>
                <div className="flex flex-col gap-1 max-w-[70%]">
                  <div className={`px-3 py-2 rounded-lg text-sm ${m.sender === handle ? "bg-[#5865f2] text-white" : "bg-[#2b2d31] text-[#dbdee1]"}`}>{m.text}</div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="px-4 pb-6 pt-1">
            <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMessage()} placeholder={`Написать @${activeDM.handle}`} className="w-full bg-[#383a40] rounded-lg px-4 py-3 outline-none text-white" />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-12 shrink-0 flex items-center px-4 font-bold text-white shadow-sm shadow-black/20"><span className="text-[#80848e] mr-2">{Icon.hash}</span>{activeChannel?.name}</div>
          <div className="flex-1 overflow-y-auto py-4">
            {messages.map((m) => (
              <div key={m.id} className="group flex gap-4 px-4 py-2 hover:bg-[#2e3035]">
                <Avatar name={m.user} size={40} />
                <div className="min-w-0"><div className="flex items-baseline gap-2"><span className="font-medium text-white">{m.user}</span><span className="text-xs text-[#949ba4]">{fmtTime(m.ts)}</span></div><p className="text-[#dbdee1] whitespace-pre-wrap">{m.text}</p></div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="px-4 pb-6 pt-1"><input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMessage()} placeholder={`Написать в #${activeChannel?.name || ""}`} className="w-full bg-[#383a40] rounded-lg px-4 py-3 outline-none text-white" /></div>
        </div>
      )}

      {/* Модалки */}
      {modal === "profile" && <SettingsModal session={session} onClose={() => setModal(null)} onSaved={setSession} />}
      {modal === "channel" && activeServerId !== null && <ChannelModal token={token} serverId={activeServerId} onClose={() => setModal(null)} onCreated={(c) => { setChannels((p) => [...p, c]); openChannel(c.id); }} />}
      {modal === "server" && <ServerModal token={token} onClose={() => setModal(null)} onCreated={(s) => { setServers((p) => [...p, s]); setActiveServerId(s.id); }} />}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  if (!session) return <AuthScreen onAuth={setSession} />;
  return <ChatApp key={session.token} session={session} onLogout={() => setSession(null)} />;
}