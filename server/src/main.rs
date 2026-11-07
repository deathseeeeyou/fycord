use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

const ADMIN_NICK: &str = "deathseeyou";

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<String>,
    online: Arc<Mutex<HashMap<i64, usize>>>,
}

#[derive(Clone)]
struct User {
    id: i64,
    username: String,
    nickname: String,
    handle: String,
    avatar: Option<String>,
}

#[derive(Deserialize)]
struct Creds { username: String, password: String }
#[derive(Serialize)]
struct AuthResp { token: String, username: String, nickname: String, handle: String, avatar: Option<String> }
#[derive(Serialize)]
struct ChatMsg { id: i64, channel: i64, user: String, text: String, ts: i64 }
#[derive(Serialize)]
struct DM { id: i64, sender: String, receiver: String, text: String, ts: i64 }
#[derive(Serialize)]
struct Channel { id: i64, server_id: i64, name: String }
#[derive(Serialize)]
struct ServerObj { id: i64, name: String, is_owner: bool }
#[derive(Serialize)]
struct PersonInfo { username: String, handle: String, online: bool, avatar: Option<String> }
#[derive(Deserialize)]
struct HandleBody { handle: String }
#[derive(Deserialize)]
struct ProfileBody { nickname: String, avatar: Option<String> }
#[derive(Deserialize)]
struct ChannelBody { server_id: i64, name: String }
#[derive(Deserialize)]
struct ServerBody { name: String }
#[derive(Deserialize)]
struct WsQuery { token: String }

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Send { channel: i64, text: String },
    History { channel: i64 },
    DmSend { receiver: String, text: String },
    DmHistory { receiver: String },
}

type ApiErr = (StatusCode, String);
fn err500<E>(_: E) -> ApiErr { (StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера".into()) }
fn bad(msg: &str) -> ApiErr { (StatusCode::BAD_REQUEST, msg.into()) }
fn conflict(msg: &str) -> ApiErr { (StatusCode::CONFLICT, msg.into()) }
fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64 }
fn new_token() -> String { rand::thread_rng().sample_iter(&Alphanumeric).take(48).map(char::from).collect() }
fn push(st: &AppState, v: Value) { let _ = st.tx.send(v.to_string()); }
fn norm_handle(s: &str) -> String { s.trim().trim_start_matches('@').to_lowercase() }
fn valid_handle(h: &str) -> bool { let n = h.chars().count(); (3..=32).contains(&n) && !h.chars().any(|c| c.is_whitespace()) }

fn user_by_token(st: &AppState, token: &str) -> Option<User> {
    let db = st.db.lock().unwrap();
    db.query_row(
        "SELECT u.id, u.username, u.nickname, COALESCE(u.handle, lower(u.username)), u.avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1",
        params![token], |r| Ok(User { id: r.get(0)?, username: r.get(1)?, nickname: r.get(2)?, handle: r.get(3)?, avatar: r.get(4)? }),
    ).ok()
}

fn auth(st: &AppState, headers: &HeaderMap) -> Result<User, ApiErr> {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
        .ok_or((StatusCode::UNAUTHORIZED, "Нужно войти".to_string()))?;
    user_by_token(st, token).ok_or((StatusCode::UNAUTHORIZED, "Сессия недействительна".to_string()))
}

fn presence_value(st: &AppState) -> Value {
    let ids: Vec<i64> = st.online.lock().unwrap().keys().copied().collect();
    let db = st.db.lock().unwrap();
    let mut users = Vec::new();
    for id in ids {
        if let Ok((username, handle, avatar)) = db.query_row("SELECT username, COALESCE(handle, lower(username)), avatar FROM users WHERE id = ?1", params![id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,Option<String>>(2)?))) {
            users.push(json!({ "username": username, "handle": handle, "avatar": avatar }));
        }
    }
    json!({ "type": "presence", "users": users })
}

// ───── auth & profile ─────
async fn register(State(st): State<AppState>, Json(c): Json<Creds>) -> Result<Json<AuthResp>, ApiErr> {
    let username = c.username.trim().to_string();
    if !(3..=32).contains(&username.chars().count()) { return Err(bad("Имя должно быть от 3 до 32 символов")); }
    if c.password.len() < 6 { return Err(bad("Пароль должен быть не короче 6 символов")); }
    let pw = c.password;
    let hash = tokio::task::spawn_blocking(move || { let salt = SaltString::generate(&mut OsRng); Argon2::default().hash_password(pw.as_bytes(), &salt).map(|h| h.to_string()) }).await.map_err(err500)?.map_err(err500)?;
    let handle = username.to_lowercase();
    let token = new_token();
    {
        let db = st.db.lock().unwrap();
        if db.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE username = ?1 OR handle = ?2)", params![username, handle], |r| r.get::<_, bool>(0)).map_err(err500)? {
            return Err(conflict("Это имя уже занято"));
        }
        db.execute("INSERT INTO users (username, nickname, handle, password_hash, created_at) VALUES (?1, ?1, ?2, ?3, ?4)", params![username, handle, hash, now()]).map_err(err500)?;
        let uid = db.last_insert_rowid();
        db.execute("INSERT INTO sessions (token, user_id) VALUES (?1, ?2)", params![token, uid]).map_err(err500)?;
    }
    Ok(Json(AuthResp { token, username: username.clone(), nickname: username, handle, avatar: None }))
}

async fn login(State(st): State<AppState>, Json(c): Json<Creds>) -> Result<Json<AuthResp>, ApiErr> {
    let bad_creds = || (StatusCode::UNAUTHORIZED, "Неверное имя или пароль".to_string());
    let row = { let db = st.db.lock().unwrap(); db.query_row("SELECT id, username, nickname, COALESCE(handle, lower(username)), avatar, password_hash FROM users WHERE username = ?1", params![c.username.trim()], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?, r.get::<_,Option<String>>(4)?, r.get::<_,String>(5)?))).optional().map_err(err500)? };
    let (uid, username, nickname, handle, avatar, hash) = row.ok_or_else(bad_creds)?;
    let pw = c.password;
    let ok = tokio::task::spawn_blocking(move || PasswordHash::new(&hash).map(|p| Argon2::default().verify_password(pw.as_bytes(), &p).is_ok()).unwrap_or(false)).await.map_err(err500)?;
    if !ok { return Err(bad_creds()); }
    let token = new_token();
    { let db = st.db.lock().unwrap(); db.execute("INSERT INTO sessions (token, user_id) VALUES (?1, ?2)", params![token, uid]).map_err(err500)?; }
    Ok(Json(AuthResp { token, username, nickname, handle, avatar }))
}

async fn set_profile(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<ProfileBody>) -> Result<Json<Value>, ApiErr> {
    let u = auth(&st, &headers)?;
    let nickname = b.nickname.trim().to_string();
    if nickname.is_empty() || nickname.chars().count() > 32 { return Err(bad("Никнейм: от 1 до 32 символов")); }
    { let db = st.db.lock().unwrap(); db.execute("UPDATE users SET nickname = ?1, avatar = ?2 WHERE id = ?3", params![nickname, b.avatar, u.id]).map_err(err500)?; }
    push(&st, presence_value(&st));
    Ok(Json(json!({ "ok": true })))
}

async fn set_handle(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<HandleBody>) -> Result<Json<Value>, ApiErr> {
    let u = auth(&st, &headers)?;
    let handle = norm_handle(&b.handle);
    if !valid_handle(&handle) { return Err(bad("Юзернейм: от 3 до 32 символов, без пробелов")); }
    { let db = st.db.lock().unwrap(); if db.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE handle = ?1 AND id != ?2)", params![handle, u.id], |r| r.get::<_, bool>(0)).map_err(err500)? { return Err(conflict("Этот юзернейм уже занят")); } db.execute("UPDATE users SET handle = ?1 WHERE id = ?2", params![handle, u.id]).map_err(err500)?; }
    push(&st, presence_value(&st));
    Ok(Json(json!({ "handle": handle })))
}

// ───── servers ─────
async fn list_servers(State(st): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<ServerObj>>, ApiErr> {
    let u = auth(&st, &headers)?;
    let db = st.db.lock().unwrap();
    let mut stmt = db.prepare("SELECT s.id, s.name, (s.owner_id = ?1) FROM servers s JOIN server_members m ON m.server_id = s.id WHERE m.user_id = ?1 ORDER BY s.id").map_err(err500)?;
    let rows = stmt.query_map(params![u.id], |r| Ok(ServerObj { id: r.get(0)?, name: r.get(1)?, is_owner: r.get(2)? })).map_err(err500)?;
    Ok(Json(rows.filter_map(Result::ok).collect()))
}

async fn create_server(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<ServerBody>) -> Result<Json<ServerObj>, ApiErr> {
    let u = auth(&st, &headers)?;
    let name = b.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 32 { return Err(bad("Название сервера: от 1 до 32 символов")); }
    let server = {
        let db = st.db.lock().unwrap();
        db.execute("INSERT INTO servers (name, owner_id, created_at) VALUES (?1, ?2, ?3)", params![name, u.id, now()]).map_err(err500)?;
        let sid = db.last_insert_rowid();
        db.execute("INSERT INTO server_members (server_id, user_id) VALUES (?1, ?2)", params![sid, u.id]).map_err(err500)?;
        db.execute("INSERT INTO channels (server_id, name, created_at) VALUES (?1, 'общий', ?2)", params![sid, now()]).map_err(err500)?;
        ServerObj { id: sid, name, is_owner: true }
    };
    push(&st, json!({ "type": "server_update" }));
    Ok(Json(server))
}

async fn delete_server(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<Value>) -> Result<Json<Value>, ApiErr> {
    let u = auth(&st, &headers)?;
    let sid = b["server_id"].as_i64().ok_or(bad("Нужен server_id"))?;
    { let db = st.db.lock().unwrap(); let is_owner: bool = db.query_row("SELECT owner_id = ?1 FROM servers WHERE id = ?2", params![u.id, sid], |r| r.get(0)).map_err(err500)?; if !is_owner { return Err(bad("Вы не владелец")); } db.execute("DELETE FROM servers WHERE id = ?1", params![sid]).map_err(err500)?; db.execute("DELETE FROM server_members WHERE server_id = ?1", params![sid]).map_err(err500)?; db.execute("DELETE FROM channels WHERE server_id = ?1", params![sid]).map_err(err500)?; }
    Ok(Json(json!({ "ok": true })))
}

async fn leave_server(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<Value>) -> Result<Json<Value>, ApiErr> {
    let u = auth(&st, &headers)?;
    let sid = b["server_id"].as_i64().ok_or(bad("Нужен server_id"))?;
    { let db = st.db.lock().unwrap(); db.execute("DELETE FROM server_members WHERE server_id = ?1 AND user_id = ?2", params![sid, u.id]).map_err(err500)?; }
    Ok(Json(json!({ "ok": true })))
}

// ───── channels ─────
async fn list_channels(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Result<Json<Vec<Channel>>, ApiErr> {
    let u = auth(&st, &headers)?;
    let sid: i64 = q.get("server_id").and_then(|s| s.parse().ok()).ok_or_else(|| bad("Нужен server_id"))?;
    let db = st.db.lock().unwrap();
    let is_member: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = ?1 AND user_id = ?2)", params![sid, u.id], |r| r.get(0)).map_err(err500)?;
    if !is_member { return Err((StatusCode::FORBIDDEN, "Нет доступа".to_string())); }
    let mut stmt = db.prepare("SELECT id, server_id, name FROM channels WHERE server_id = ?1 ORDER BY id").map_err(err500)?;
    Ok(Json(stmt.query_map(params![sid], |r| Ok(Channel { id: r.get(0)?, server_id: r.get(1)?, name: r.get(2)? })).map_err(err500)?.filter_map(Result::ok).collect()))
}

async fn create_channel(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<ChannelBody>) -> Result<Json<Channel>, ApiErr> {
    let u = auth(&st, &headers)?;
    let name = b.name.trim().trim_start_matches('#').split_whitespace().collect::<Vec<_>>().join("-").to_lowercase();
    if !(1..=32).contains(&name.chars().count()) { return Err(bad("Название канала: от 1 до 32 символов")); }
    let channel = {
        let db = st.db.lock().unwrap();
        let is_member: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = ?1 AND user_id = ?2)", params![b.server_id, u.id], |r| r.get(0)).map_err(err500)?;
        if !is_member { return Err(bad("Нет доступа")); }
        db.execute("INSERT INTO channels (server_id, name, created_at) VALUES (?1, ?2, ?3)", params![b.server_id, name, now()]).map_err(|e| if let rusqlite::Error::SqliteFailure(err, _) = e { if err.code == rusqlite::ErrorCode::ConstraintViolation { conflict("Такой канал уже есть") } else { err500(e) } } else { err500(e) })?;
        Channel { id: db.last_insert_rowid(), server_id: b.server_id, name }
    };
    push(&st, json!({ "type": "channel", "channel": channel }));
    Ok(Json(channel))
}

// ───── friends ─────
fn query_people(db: &Connection, sql: &str, me: i64, online: &HashMap<i64, usize>) -> Result<Vec<PersonInfo>, rusqlite::Error> {
    let mut stmt = db.prepare(sql)?;
    let rows = stmt.query_map(params![me], |r| Ok(PersonInfo { username: r.get(1)?, handle: r.get(2)?, online: online.contains_key(&r.get::<_, i64>(0)?), avatar: r.get(3)? }))?;
    rows.collect()
}

async fn friends_list(State(st): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    let online = st.online.lock().unwrap().clone();
    let db = st.db.lock().unwrap();
    let friends = query_people(&db, "SELECT u.id, u.username, COALESCE(u.handle, lower(u.username)), u.avatar FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END WHERE f.status = 'accepted' AND (f.requester_id = ?1 OR f.addressee_id = ?1) ORDER BY u.username", me.id, &online).map_err(err500)?;
    let incoming = query_people(&db, "SELECT u.id, u.username, COALESCE(u.handle, lower(u.username)), u.avatar FROM friendships f JOIN users u ON u.id = f.requester_id WHERE f.status = 'pending' AND f.addressee_id = ?1 ORDER BY f.created_at", me.id, &online).map_err(err500)?;
    let outgoing = query_people(&db, "SELECT u.id, u.username, COALESCE(u.handle, lower(u.username)), u.avatar FROM friendships f JOIN users u ON u.id = f.addressee_id WHERE f.status = 'pending' AND f.requester_id = ?1 ORDER BY f.created_at", me.id, &online).map_err(err500)?;
    Ok(Json(json!({ "friends": friends, "incoming": incoming, "outgoing": outgoing })))
}

async fn friend_request(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<HandleBody>) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    let handle = norm_handle(&b.handle);
    { let db = st.db.lock().unwrap(); let target = db.query_row("SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1", params![handle], |r| r.get::<_, i64>(0)).optional().map_err(err500)?.ok_or((StatusCode::NOT_FOUND, "Пользователь не найден".to_string()))?; if target == me.id { return Err(bad("Нельзя добавить самого себя")); }
    let existing = db.query_row("SELECT requester_id, status FROM friendships WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)", params![me.id, target], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?))).optional().map_err(err500)?;
    match existing { Some((_, s)) if s == "accepted" => return Err(conflict("Вы уже друзья")), Some((req, _)) if req == me.id => return Err(conflict("Заявка отправлена")), Some(_) => { db.execute("UPDATE friendships SET status = 'accepted' WHERE requester_id = ?1 AND addressee_id = ?2", params![target, me.id]).map_err(err500)?; }, None => { db.execute("INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?1, ?2, 'pending', ?3)", params![me.id, target, now()]).map_err(err500)?; } } }
    push(&st, json!({ "type": "friends_update" }));
    Ok(Json(json!({ "ok": true })))
}

async fn friend_accept(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<HandleBody>) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    let changed = { let db = st.db.lock().unwrap(); db.execute("UPDATE friendships SET status = 'accepted' WHERE requester_id = (SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1) AND addressee_id = ?2 AND status = 'pending'", params![norm_handle(&b.handle), me.id]).map_err(err500)? };
    if changed == 0 { return Err((StatusCode::NOT_FOUND, "Заявка не найдена".to_string())); }
    push(&st, json!({ "type": "friends_update" }));
    Ok(Json(json!({ "ok": true })))
}

async fn friend_remove(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<HandleBody>) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    { let db = st.db.lock().unwrap(); db.execute("DELETE FROM friendships WHERE (requester_id = ?2 AND addressee_id = (SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1)) OR (addressee_id = ?2 AND requester_id = (SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1))", params![norm_handle(&b.handle), me.id]).map_err(err500)?; }
    push(&st, json!({ "type": "friends_update" }));
    Ok(Json(json!({ "ok": true })))
}

// ───── chat ─────
fn history(st: &AppState, channel: i64) -> Vec<ChatMsg> {
    let db = st.db.lock().unwrap();
    let mut stmt = db.prepare("SELECT id, channel_id, username, text, created_at FROM (SELECT * FROM messages WHERE channel_id = ?1 ORDER BY id DESC LIMIT 50) ORDER BY id ASC").unwrap();
    stmt.query_map(params![channel], |r| Ok(ChatMsg { id: r.get(0)?, channel: r.get(1)?, user: r.get(2)?, text: r.get(3)?, ts: r.get(4)? })).unwrap().filter_map(Result::ok).collect()
}

fn dm_history(st: &AppState, me: &str, other: &str) -> Vec<DM> {
    let db = st.db.lock().unwrap();
    let mut stmt = db.prepare("SELECT id, sender, receiver, text, created_at FROM dms WHERE (sender = ?1 AND receiver = ?2) OR (sender = ?2 AND receiver = ?1) ORDER BY id ASC").unwrap();
    stmt.query_map(params![me, other], |r| Ok(DM { id: r.get(0)?, sender: r.get(1)?, receiver: r.get(2)?, text: r.get(3)?, ts: r.get(4)? })).unwrap().filter_map(Result::ok).collect()
}

fn save_message(st: &AppState, user: &User, channel: i64, text: String) -> Option<ChatMsg> {
    let db = st.db.lock().unwrap();
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM channels c JOIN server_members m ON m.server_id = c.server_id WHERE c.id = ?1 AND m.user_id = ?2)", params![channel, user.id], |r| r.get::<_, bool>(0)).ok()? { return None; }
    let ts = now();
    db.execute("INSERT INTO messages (user_id, channel_id, username, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![user.id, channel, user.nickname, text, ts]).ok()?;
    Some(ChatMsg { id: db.last_insert_rowid(), channel, user: user.nickname.clone(), text, ts })
}

fn save_dm(st: &AppState, user: &User, receiver: &str, text: String) -> Option<DM> {
    let db = st.db.lock().unwrap();
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE COALESCE(handle, lower(username)) = ?1)", params![receiver], |r| r.get::<_, bool>(0)).ok()? { return None; }
    let ts = now();
    db.execute("INSERT INTO dms (sender, receiver, text, created_at) VALUES (?1, ?2, ?3, ?4)", params![user.handle, receiver, text, ts]).ok()?;
    Some(DM { id: db.last_insert_rowid(), sender: user.handle.clone(), receiver: receiver.to_string(), text, ts })
}

async fn ws_handler(ws: WebSocketUpgrade, Query(q): Query<WsQuery>, State(st): State<AppState>) -> impl IntoResponse {
    match user_by_token(&st, &q.token) { Some(u) => ws.on_upgrade(move |s| handle_socket(s, st, u)).into_response(), None => StatusCode::UNAUTHORIZED.into_response() }
}

async fn handle_socket(mut socket: WebSocket, st: AppState, user: User) {
    let mut rx = st.tx.subscribe();
    *st.online.lock().unwrap().entry(user.id).or_insert(0) += 1;
    push(&st, presence_value(&st));

    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(raw))) => match serde_json::from_str::<ClientMsg>(&raw) {
                    Ok(ClientMsg::History { channel }) => { let payload = json!({ "type": "history", "channel": channel, "messages": history(&st, channel) }).to_string(); if socket.send(Message::Text(payload)).await.is_err() { break; } }
                    Ok(ClientMsg::Send { channel, text }) => { let text = text.trim().to_string(); if !text.is_empty() && text.chars().count() <= 2000 { if let Some(m) = save_message(&st, &user, channel, text) { push(&st, json!({ "type": "message", "message": m })); } } }
                    Ok(ClientMsg::DmHistory { receiver }) => { let payload = json!({ "type": "dm_history", "with": receiver, "messages": dm_history(&st, &user.handle, &receiver) }).to_string(); if socket.send(Message::Text(payload)).await.is_err() { break; } }
                    Ok(ClientMsg::DmSend { receiver, text }) => { let text = text.trim().to_string(); if !text.is_empty() && text.chars().count() <= 2000 { if let Some(m) = save_dm(&st, &user, &receiver, text) { push(&st, json!({ "type": "dm", "message": m })); } } }
                    _ => {}
                },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
            broadcasted = rx.recv() => match broadcasted { Ok(j) => { if socket.send(Message::Text(j)).await.is_err() { break; } }, Err(_) => break }
        }
    }

    { let mut o = st.online.lock().unwrap(); if let Some(c) = o.get_mut(&user.id) { *c -= 1; if *c == 0 { o.remove(&user.id); } } }
    push(&st, presence_value(&st));
}

fn init_db(conn: &Connection) {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, nickname TEXT NOT NULL, handle TEXT, avatar TEXT, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
         CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS server_members (server_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(server_id, user_id));
         CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS dms (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, receiver TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS friendships (requester_id INTEGER NOT NULL, addressee_id INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (requester_id, addressee_id));
         CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_name ON channels(server_id, name);"
    ).expect("не удалось создать таблицы");

    let _ = conn.execute("ALTER TABLE users ADD COLUMN nickname TEXT", []);
    let _ = conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT", []);
    let _ = conn.execute("ALTER TABLE servers ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 1", []);
    let _ = conn.execute("ALTER TABLE channels ADD COLUMN server_id INTEGER NOT NULL DEFAULT 1", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN channel_id INTEGER NOT NULL DEFAULT 1", []);
}

#[tokio::main]
async fn main() {
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "fycord.db".into());
    let conn = Connection::open(&db_path).expect("не удалось открыть базу");
    init_db(&conn);

    let (tx, _) = broadcast::channel(256);
    let state = AppState { db: Arc::new(Mutex::new(conn)), tx, online: Arc::new(Mutex::new(HashMap::new())) };

    let app = Router::new()
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/profile", post(set_profile))
        .route("/api/handle", post(set_handle))
        .route("/api/servers", get(list_servers).post(create_server))
        .route("/api/servers/delete", post(delete_server))
        .route("/api/servers/leave", post(leave_server))
        .route("/api/channels", get(list_channels).post(create_channel))
        .route("/api/friends", get(friends_list))
        .route("/api/friends/request", post(friend_request))
        .route("/api/friends/accept", post(friend_accept))
        .route("/api/friends/remove", post(friend_remove))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(41600);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    println!("Fycord слушает на {addr}");
    axum::serve(listener, app).await.unwrap();
}