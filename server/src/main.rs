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

/// Ник (регистр не важен), которому доступна страница /admin
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
    handle: String,
}

#[derive(Deserialize)]
struct Creds {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct AuthResp {
    token: String,
    username: String,
    handle: String,
}

#[derive(Serialize)]
struct ChatMsg {
    id: i64,
    channel: i64,
    user: String,
    text: String,
    ts: i64,
}

#[derive(Serialize)]
struct Channel {
    id: i64,
    name: String,
}

#[derive(Serialize)]
struct PersonInfo {
    username: String,
    handle: String,
    online: bool,
}

#[derive(Deserialize)]
struct HandleBody {
    handle: String,
}

#[derive(Deserialize)]
struct ChannelBody {
    name: String,
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Send { channel: i64, text: String },
    History { channel: i64 },
}

type ApiErr = (StatusCode, String);

fn err500<E>(_: E) -> ApiErr {
    (StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера".into())
}

fn bad(msg: &str) -> ApiErr {
    (StatusCode::BAD_REQUEST, msg.into())
}

fn conflict(msg: &str) -> ApiErr {
    (StatusCode::CONFLICT, msg.into())
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn new_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn push(st: &AppState, v: Value) {
    let _ = st.tx.send(v.to_string());
}

fn norm_handle(s: &str) -> String {
    s.trim().trim_start_matches('@').to_lowercase()
}

fn valid_handle(h: &str) -> bool {
    let n = h.chars().count();
    (3..=32).contains(&n) && !h.chars().any(|c| c.is_whitespace())
}

fn is_admin(u: &User) -> bool {
    u.username.to_lowercase() == ADMIN_NICK
}

fn user_by_token(st: &AppState, token: &str) -> Option<User> {
    let db = st.db.lock().unwrap();
    db.query_row(
        "SELECT u.id, u.username, COALESCE(u.handle, lower(u.username)) \
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1",
        params![token],
        |r| {
            Ok(User {
                id: r.get(0)?,
                username: r.get(1)?,
                handle: r.get(2)?,
            })
        },
    )
    .ok()
}

fn auth(st: &AppState, headers: &HeaderMap) -> Result<User, ApiErr> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or((StatusCode::UNAUTHORIZED, "Нужно войти".to_string()))?;
    user_by_token(st, token)
        .ok_or((StatusCode::UNAUTHORIZED, "Сессия недействительна".to_string()))
}

fn presence_value(st: &AppState) -> Value {
    let ids: Vec<i64> = st.online.lock().unwrap().keys().copied().collect();
    let db = st.db.lock().unwrap();
    let mut users = Vec::new();
    for id in ids {
        let row: Option<(String, String)> = db
            .query_row(
                "SELECT username, COALESCE(handle, lower(username)) FROM users WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((username, handle)) = row {
            users.push(json!({ "username": username, "handle": handle }));
        }
    }
    json!({ "type": "presence", "users": users })
}

// ───────────────────────── авторизация ─────────────────────────

async fn register(
    State(st): State<AppState>,
    Json(c): Json<Creds>,
) -> Result<Json<AuthResp>, ApiErr> {
    let username = c.username.trim().to_string();
    let len = username.chars().count();
    if !(3..=32).contains(&len) {
        return Err(bad("Имя должно быть от 3 до 32 символов"));
    }
    if c.password.len() < 6 {
        return Err(bad("Пароль должен быть не короче 6 символов"));
    }

    let pw = c.password;
    let hash = tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(pw.as_bytes(), &salt)
            .map(|h| h.to_string())
    })
    .await
    .map_err(err500)?
    .map_err(err500)?;

    let handle = username.to_lowercase();
    let token = new_token();
    {
        let db = st.db.lock().unwrap();
        let taken: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE username = ?1 OR handle = ?2)",
                params![username, handle],
                |r| r.get(0),
            )
            .map_err(err500)?;
        if taken {
            return Err(conflict("Это имя уже занято"));
        }
        match db.execute(
            "INSERT INTO users (username, handle, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![username, handle, hash, now()],
        ) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                return Err(conflict("Это имя уже занято"));
            }
            Err(e) => return Err(err500(e)),
        }
        let uid = db.last_insert_rowid();
        db.execute(
            "INSERT INTO sessions (token, user_id) VALUES (?1, ?2)",
            params![token, uid],
        )
        .map_err(err500)?;
    }

    Ok(Json(AuthResp {
        token,
        username,
        handle,
    }))
}

async fn login(
    State(st): State<AppState>,
    Json(c): Json<Creds>,
) -> Result<Json<AuthResp>, ApiErr> {
    let bad_creds = || (StatusCode::UNAUTHORIZED, "Неверное имя или пароль".to_string());

    let row: Option<(i64, String, String, String)> = {
        let db = st.db.lock().unwrap();
        db.query_row(
            "SELECT id, username, COALESCE(handle, lower(username)), password_hash \
             FROM users WHERE username = ?1",
            params![c.username.trim()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok()
    };
    let (uid, username, handle, hash) = row.ok_or_else(bad_creds)?;

    let pw = c.password;
    let ok = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|p| Argon2::default().verify_password(pw.as_bytes(), &p).is_ok())
            .unwrap_or(false)
    })
    .await
    .map_err(err500)?;
    if !ok {
        return Err(bad_creds());
    }

    let token = new_token();
    {
        let db = st.db.lock().unwrap();
        db.execute(
            "INSERT INTO sessions (token, user_id) VALUES (?1, ?2)",
            params![token, uid],
        )
        .map_err(err500)?;
    }

    Ok(Json(AuthResp {
        token,
        username,
        handle,
    }))
}

async fn me(State(st): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiErr> {
    let u = auth(&st, &headers)?;
    Ok(Json(json!({
        "username": u.username,
        "handle": u.handle,
        "is_admin": is_admin(&u),
    })))
}

async fn set_profile(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<HandleBody>,
) -> Result<Json<Value>, ApiErr> {
    let u = auth(&st, &headers)?;
    let handle = norm_handle(&b.handle);
    if !valid_handle(&handle) {
        return Err(bad("Юзернейм: от 3 до 32 символов, без пробелов"));
    }
    {
        let db = st.db.lock().unwrap();
        let taken: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE handle = ?1 AND id != ?2)",
                params![handle, u.id],
                |r| r.get(0),
            )
            .map_err(err500)?;
        if taken {
            return Err(conflict("Этот юзернейм уже занят"));
        }
        db.execute(
            "UPDATE users SET handle = ?1 WHERE id = ?2",
            params![handle, u.id],
        )
        .map_err(err500)?;
    }
    push(&st, presence_value(&st));
    push(&st, json!({ "type": "friends_update" }));
    Ok(Json(json!({ "handle": handle })))
}

// ───────────────────────── каналы ─────────────────────────

async fn list_channels(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Channel>>, ApiErr> {
    auth(&st, &headers)?;
    let db = st.db.lock().unwrap();
    let mut stmt = db
        .prepare("SELECT id, name FROM channels ORDER BY id")
        .map_err(err500)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Channel {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(err500)?;
    let v: Vec<Channel> = rows.filter_map(Result::ok).collect();
    Ok(Json(v))
}

async fn create_channel(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<ChannelBody>,
) -> Result<Json<Channel>, ApiErr> {
    auth(&st, &headers)?;
    let name = b
        .name
        .trim()
        .trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    if !(1..=32).contains(&name.chars().count()) {
        return Err(bad("Название канала: от 1 до 32 символов"));
    }
    let channel = {
        let db = st.db.lock().unwrap();
        match db.execute(
            "INSERT INTO channels (name, created_at) VALUES (?1, ?2)",
            params![name, now()],
        ) {
            Ok(_) => Channel {
                id: db.last_insert_rowid(),
                name: name.clone(),
            },
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                return Err(conflict("Такой канал уже есть"));
            }
            Err(e) => return Err(err500(e)),
        }
    };
    push(&st, json!({ "type": "channel", "channel": channel }));
    Ok(Json(channel))
}

// ───────────────────────── друзья ─────────────────────────

fn query_people(
    db: &Connection,
    sql: &str,
    me: i64,
    online: &HashMap<i64, usize>,
) -> Result<Vec<PersonInfo>, rusqlite::Error> {
    let mut stmt = db.prepare(sql)?;
    let rows = stmt.query_map(params![me], |r| {
        let id: i64 = r.get(0)?;
        Ok(PersonInfo {
            username: r.get(1)?,
            handle: r.get(2)?,
            online: online.contains_key(&id),
        })
    })?;
    let v: Result<Vec<PersonInfo>, rusqlite::Error> = rows.collect();
    v
}

async fn friends_list(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    let online: HashMap<i64, usize> = st.online.lock().unwrap().clone();
    let db = st.db.lock().unwrap();

    let friends = query_people(
        &db,
        "SELECT u.id, u.username, COALESCE(u.handle, lower(u.username)) FROM friendships f \
         JOIN users u ON u.id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END \
         WHERE f.status = 'accepted' AND (f.requester_id = ?1 OR f.addressee_id = ?1) \
         ORDER BY u.username",
        me.id,
        &online,
    )
    .map_err(err500)?;
    let incoming = query_people(
        &db,
        "SELECT u.id, u.username, COALESCE(u.handle, lower(u.username)) FROM friendships f \
         JOIN users u ON u.id = f.requester_id \
         WHERE f.status = 'pending' AND f.addressee_id = ?1 ORDER BY f.created_at",
        me.id,
        &online,
    )
    .map_err(err500)?;
    let outgoing = query_people(
        &db,
        "SELECT u.id, u.username, COALESCE(u.handle, lower(u.username)) FROM friendships f \
         JOIN users u ON u.id = f.addressee_id \
         WHERE f.status = 'pending' AND f.requester_id = ?1 ORDER BY f.created_at",
        me.id,
        &online,
    )
    .map_err(err500)?;

    Ok(Json(json!({
        "friends": friends,
        "incoming": incoming,
        "outgoing": outgoing,
    })))
}

async fn friend_request(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<HandleBody>,
) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    let handle = norm_handle(&b.handle);
    {
        let db = st.db.lock().unwrap();
        let target: Option<i64> = db
            .query_row(
                "SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1",
                params![handle],
                |r| r.get(0),
            )
            .optional()
            .map_err(err500)?;
        let target = target.ok_or((StatusCode::NOT_FOUND, "Пользователь не найден".to_string()))?;
        if target == me.id {
            return Err(bad("Нельзя добавить самого себя"));
        }

        let existing: Option<(i64, String)> = db
            .query_row(
                "SELECT requester_id, status FROM friendships \
                 WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)",
                params![me.id, target],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err500)?;

        match existing {
            Some((_, status)) if status == "accepted" => {
                return Err(conflict("Вы уже друзья"));
            }
            Some((requester, _)) if requester == me.id => {
                return Err(conflict("Заявка уже отправлена"));
            }
            Some(_) => {
                // встречная заявка — сразу принимаем
                db.execute(
                    "UPDATE friendships SET status = 'accepted' WHERE requester_id = ?1 AND addressee_id = ?2",
                    params![target, me.id],
                )
                .map_err(err500)?;
            }
            None => {
                db.execute(
                    "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?1, ?2, 'pending', ?3)",
                    params![me.id, target, now()],
                )
                .map_err(err500)?;
            }
        }
    }
    push(&st, json!({ "type": "friends_update" }));
    Ok(Json(json!({ "ok": true })))
}

async fn friend_accept(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<HandleBody>,
) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    let handle = norm_handle(&b.handle);
    let changed = {
        let db = st.db.lock().unwrap();
        db.execute(
            "UPDATE friendships SET status = 'accepted' \
             WHERE requester_id = (SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1) \
             AND addressee_id = ?2 AND status = 'pending'",
            params![handle, me.id],
        )
        .map_err(err500)?
    };
    if changed == 0 {
        return Err((StatusCode::NOT_FOUND, "Заявка не найдена".to_string()));
    }
    push(&st, json!({ "type": "friends_update" }));
    Ok(Json(json!({ "ok": true })))
}

async fn friend_remove(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<HandleBody>,
) -> Result<Json<Value>, ApiErr> {
    let me = auth(&st, &headers)?;
    let handle = norm_handle(&b.handle);
    {
        let db = st.db.lock().unwrap();
        db.execute(
            "DELETE FROM friendships WHERE \
             (requester_id = ?2 AND addressee_id = (SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1)) \
             OR (addressee_id = ?2 AND requester_id = (SELECT id FROM users WHERE COALESCE(handle, lower(username)) = ?1))",
            params![handle, me.id],
        )
        .map_err(err500)?;
    }
    push(&st, json!({ "type": "friends_update" }));
    Ok(Json(json!({ "ok": true })))
}

// ───────────────────────── админка ─────────────────────────

fn rows_json<F>(db: &Connection, sql: &str, f: F) -> Result<Vec<Value>, ApiErr>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
{
    let mut stmt = db.prepare(sql).map_err(err500)?;
    let rows = stmt.query_map([], |r| f(r)).map_err(err500)?;
    let v: Vec<Value> = rows.filter_map(Result::ok).collect();
    Ok(v)
}

async fn admin_page() -> Html<&'static str> {
    Html(ADMIN_HTML)
}

async fn admin_data(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiErr> {
    let u = auth(&st, &headers)?;
    if !is_admin(&u) {
        return Err((StatusCode::FORBIDDEN, "Нет доступа".to_string()));
    }
    let online: Vec<i64> = st.online.lock().unwrap().keys().copied().collect();
    let db = st.db.lock().unwrap();

    let users = rows_json(
        &db,
        "SELECT id, username, COALESCE(handle, lower(username)), created_at FROM users ORDER BY id",
        |r| {
            let id: i64 = r.get(0)?;
            Ok(json!({
                "id": id,
                "username": r.get::<_, String>(1)?,
                "handle": r.get::<_, String>(2)?,
                "created_at": r.get::<_, i64>(3)?,
                "online": online.contains(&id),
            }))
        },
    )?;
    let channels = rows_json(
        &db,
        "SELECT c.id, c.name, c.created_at, (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) \
         FROM channels c ORDER BY c.id",
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "created_at": r.get::<_, i64>(2)?,
                "messages": r.get::<_, i64>(3)?,
            }))
        },
    )?;
    let messages = rows_json(
        &db,
        "SELECT m.id, c.name, m.username, m.text, m.created_at FROM messages m \
         LEFT JOIN channels c ON c.id = m.channel_id ORDER BY m.id DESC LIMIT 200",
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "channel": r.get::<_, Option<String>>(1)?,
                "user": r.get::<_, String>(2)?,
                "text": r.get::<_, String>(3)?,
                "created_at": r.get::<_, i64>(4)?,
            }))
        },
    )?;
    let friendships = rows_json(
        &db,
        "SELECT a.username, b.username, f.status, f.created_at FROM friendships f \
         JOIN users a ON a.id = f.requester_id JOIN users b ON b.id = f.addressee_id \
         ORDER BY f.created_at DESC",
        |r| {
            Ok(json!({
                "from": r.get::<_, String>(0)?,
                "to": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
                "created_at": r.get::<_, i64>(3)?,
            }))
        },
    )?;
    let total_messages: i64 = db
        .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
        .map_err(err500)?;

    Ok(Json(json!({
        "stats": {
            "users": users.len(),
            "online": online.len(),
            "channels": channels.len(),
            "messages": total_messages,
        },
        "users": users,
        "channels": channels,
        "messages": messages,
        "friendships": friendships,
    })))
}

// ───────────────────────── чат (WebSocket) ─────────────────────────

fn history(st: &AppState, channel: i64) -> Vec<ChatMsg> {
    let db = st.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT id, channel_id, username, text, created_at FROM \
             (SELECT * FROM messages WHERE channel_id = ?1 ORDER BY id DESC LIMIT 50) ORDER BY id ASC",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![channel], |r| {
            Ok(ChatMsg {
                id: r.get(0)?,
                channel: r.get(1)?,
                user: r.get(2)?,
                text: r.get(3)?,
                ts: r.get(4)?,
            })
        })
        .unwrap();
    let v: Vec<ChatMsg> = rows.filter_map(Result::ok).collect();
    v
}

fn save_message(st: &AppState, user: &User, channel: i64, text: String) -> Option<ChatMsg> {
    let db = st.db.lock().unwrap();
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM channels WHERE id = ?1)",
            params![channel],
            |r| r.get(0),
        )
        .ok()?;
    if !exists {
        return None;
    }
    let ts = now();
    db.execute(
        "INSERT INTO messages (user_id, channel_id, username, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![user.id, channel, user.username, text, ts],
    )
    .ok()?;
    Some(ChatMsg {
        id: db.last_insert_rowid(),
        channel,
        user: user.username.clone(),
        text,
        ts,
    })
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(st): State<AppState>,
) -> impl IntoResponse {
    match user_by_token(&st, &q.token) {
        Some(user) => ws
            .on_upgrade(move |socket| handle_socket(socket, st, user))
            .into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn handle_socket(mut socket: WebSocket, st: AppState, user: User) {
    // подписываемся заранее, чтобы получить и своё событие presence
    let mut rx = st.tx.subscribe();

    {
        let mut o = st.online.lock().unwrap();
        *o.entry(user.id).or_insert(0) += 1;
    }
    push(&st, presence_value(&st));

    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(raw))) => {
                    match serde_json::from_str::<ClientMsg>(&raw) {
                        Ok(ClientMsg::History { channel }) => {
                            let msgs = history(&st, channel);
                            let payload = json!({ "type": "history", "channel": channel, "messages": msgs }).to_string();
                            if socket.send(Message::Text(payload)).await.is_err() {
                                break;
                            }
                        }
                        Ok(ClientMsg::Send { channel, text }) => {
                            let text = text.trim().to_string();
                            if text.is_empty() || text.chars().count() > 2000 {
                                continue;
                            }
                            if let Some(msg) = save_message(&st, &user, channel, text) {
                                push(&st, json!({ "type": "message", "message": msg }));
                            }
                        }
                        Err(_) => {}
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
            broadcasted = rx.recv() => match broadcasted {
                Ok(json) => {
                    if socket.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    }

    {
        let mut o = st.online.lock().unwrap();
        let remove = match o.get_mut(&user.id) {
            Some(c) => {
                *c -= 1;
                *c == 0
            }
            None => false,
        };
        if remove {
            o.remove(&user.id);
        }
    }
    push(&st, presence_value(&st));
}

// ───────────────────────── база данных ─────────────────────────

fn has_column(conn: &Connection, table: &str, col: &str) -> bool {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let found = names.iter().any(|n| n == col);
    found
}

fn init_db(conn: &Connection) {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS users (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
             handle        TEXT,
             password_hash TEXT NOT NULL,
             created_at    INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sessions (
             token   TEXT PRIMARY KEY,
             user_id INTEGER NOT NULL REFERENCES users(id)
         );
         CREATE TABLE IF NOT EXISTS channels (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
             created_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS messages (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             user_id    INTEGER NOT NULL REFERENCES users(id),
             channel_id INTEGER NOT NULL DEFAULT 1,
             username   TEXT NOT NULL,
             text       TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS friendships (
             requester_id INTEGER NOT NULL,
             addressee_id INTEGER NOT NULL,
             status       TEXT NOT NULL,
             created_at   INTEGER NOT NULL,
             PRIMARY KEY (requester_id, addressee_id)
         );",
    )
    .expect("не удалось создать таблицы");

    // миграции для старых баз
    if !has_column(conn, "users", "handle") {
        conn.execute("ALTER TABLE users ADD COLUMN handle TEXT", [])
            .expect("миграция users.handle");
    }
    if !has_column(conn, "messages", "channel_id") {
        conn.execute(
            "ALTER TABLE messages ADD COLUMN channel_id INTEGER NOT NULL DEFAULT 1",
            [],
        )
        .expect("миграция messages.channel_id");
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
         CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);",
    )
    .expect("не удалось создать индексы");

    // юзернейм по умолчанию = ник маленькими буквами
    let missing: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, username FROM users WHERE handle IS NULL")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        let v: Vec<(i64, String)> = rows.filter_map(Result::ok).collect();
        v
    };
    for (id, name) in missing {
        let h = name.to_lowercase();
        if conn
            .execute("UPDATE users SET handle = ?1 WHERE id = ?2", params![h, id])
            .is_err()
        {
            let _ = conn.execute(
                "UPDATE users SET handle = ?1 WHERE id = ?2",
                params![format!("{h}{id}"), id],
            );
        }
    }
}

#[tokio::main]
async fn main() {
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "fycord.db".into());
    let conn = Connection::open(&db_path).expect("не удалось открыть базу");
    init_db(&conn);

    let (tx, _) = broadcast::channel(256);
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        tx,
        online: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/admin", get(admin_page))
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/me", get(me))
        .route("/api/profile", post(set_profile))
        .route("/api/channels", get(list_channels).post(create_channel))
        .route("/api/friends", get(friends_list))
        .route("/api/friends/request", post(friend_request))
        .route("/api/friends/accept", post(friend_accept))
        .route("/api/friends/remove", post(friend_remove))
        .route("/api/admin/data", get(admin_data))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(41600);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    println!("Fycord слушает на {addr}");
    axum::serve(listener, app).await.unwrap();
}

const ADMIN_HTML: &str = r##"<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fycord · админка</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #1e1f22; color: #dbdee1; font: 14px/1.5 system-ui, "Segoe UI", sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #fff; }
  h2 { font-size: 16px; margin: 32px 0 10px; color: #fff; }
  .muted { color: #949ba4; }
  .login { max-width: 340px; margin: 12vh auto 0; background: #2b2d31; padding: 28px; border-radius: 12px; }
  input { width: 100%; height: 40px; margin: 6px 0 14px; padding: 0 12px; border: 0; border-radius: 6px; background: #1e1f22; color: #fff; font: inherit; }
  input:focus { outline: 2px solid #5865f2; }
  button { height: 40px; padding: 0 18px; border: 0; border-radius: 6px; background: #5865f2; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #4752c4; }
  .err { color: #f23f42; min-height: 20px; margin-top: 10px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
  .stat { background: #2b2d31; border-radius: 10px; padding: 12px 18px; min-width: 130px; }
  .stat b { display: block; font-size: 24px; color: #fff; }
  .scroll { overflow-x: auto; background: #2b2d31; border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 14px; border-bottom: 1px solid #232428; vertical-align: top; }
  th { color: #949ba4; font-weight: 600; position: sticky; top: 0; background: #2b2d31; }
  tr:last-child td { border-bottom: 0; }
  td.text { max-width: 480px; white-space: pre-wrap; word-break: break-word; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #23a559; margin-right: 6px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <form id="login" class="login">
    <h1>Админка Fycord</h1>
    <p class="muted">Войди аккаунтом администратора</p>
    <label>Ник<input id="u" autocomplete="username"></label>
    <label>Пароль<input id="p" type="password" autocomplete="current-password"></label>
    <button type="submit" style="width:100%">Войти</button>
    <div id="err" class="err"></div>
  </form>

  <div id="main" class="hidden">
    <div class="row">
      <div>
        <h1>База Fycord</h1>
        <div class="muted">Только чтение. Пароли в базе хранятся в виде хешей и здесь не показываются.</div>
      </div>
      <button id="refresh" type="button">Обновить</button>
    </div>
    <div id="stats" class="stats"></div>
    <h2>Пользователи</h2><div id="users" class="scroll"></div>
    <h2>Каналы</h2><div id="channels" class="scroll"></div>
    <h2>Друзья и заявки</h2><div id="friends" class="scroll"></div>
    <h2>Последние сообщения</h2><div id="messages" class="scroll"></div>
  </div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  let token = null;

  const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString("ru-RU") : "—");

  function table(headers, rows) {
    const t = document.createElement("table");
    const hr = t.insertRow();
    headers.forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      hr.appendChild(th);
    });
    if (!rows.length) {
      const tr = t.insertRow();
      const td = tr.insertCell();
      td.colSpan = headers.length;
      td.className = "muted";
      td.textContent = "Пока пусто";
    }
    rows.forEach((cells) => {
      const tr = t.insertRow();
      cells.forEach((c) => {
        const td = tr.insertCell();
        if (c && typeof c === "object") {
          td.className = c.cls || "";
          if (c.dot) {
            const d = document.createElement("span");
            d.className = "dot";
            td.appendChild(d);
          }
          td.appendChild(document.createTextNode(c.text));
        } else {
          td.textContent = c == null ? "" : String(c);
        }
      });
    });
    return t;
  }

  function put(id, el) {
    const box = $(id);
    box.replaceChildren(el);
  }

  function render(d) {
    const s = d.stats;
    $("stats").replaceChildren(
      ...[
        ["Пользователей", s.users],
        ["Онлайн", s.online],
        ["Каналов", s.channels],
        ["Сообщений", s.messages],
      ].map(([label, value]) => {
        const box = document.createElement("div");
        box.className = "stat";
        const b = document.createElement("b");
        b.textContent = value;
        box.append(b, document.createTextNode(label));
        return box;
      })
    );
    put("users", table(["ID", "Ник", "Юзернейм", "Регистрация", "Статус"],
      d.users.map((u) => [u.id, u.username, "@" + u.handle, fmt(u.created_at), u.online ? { text: "онлайн", dot: true } : "оффлайн"])));
    put("channels", table(["ID", "Канал", "Создан", "Сообщений"],
      d.channels.map((c) => [c.id, "#" + c.name, fmt(c.created_at), c.messages])));
    put("friends", table(["От", "Кому", "Статус", "Когда"],
      d.friendships.map((f) => [f.from, f.to, f.status === "accepted" ? "друзья" : "ожидает", fmt(f.created_at)])));
    put("messages", table(["ID", "Канал", "Автор", "Текст", "Время"],
      d.messages.map((m) => [m.id, m.channel ? "#" + m.channel : "—", m.user, { text: m.text, cls: "text" }, fmt(m.created_at)])));
  }

  async function load() {
    $("err").textContent = "";
    const res = await fetch("/api/admin/data", { headers: { Authorization: "Bearer " + token } });
    if (res.status === 403) { $("err").textContent = "У этого аккаунта нет доступа"; return false; }
    if (!res.ok) { $("err").textContent = await res.text(); return false; }
    render(await res.json());
    $("login").classList.add("hidden");
    $("main").classList.remove("hidden");
    return true;
  }

  $("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("err").textContent = "";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: $("u").value, password: $("p").value }),
      });
      if (!res.ok) { $("err").textContent = await res.text(); return; }
      token = (await res.json()).token;
      await load();
    } catch {
      $("err").textContent = "Не удалось подключиться к серверу";
    }
  });

  $("refresh").addEventListener("click", load);
</script>
</body>
</html>
"##;