use std::{
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
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<String>,
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
}

#[derive(Serialize)]
struct ChatMsg {
    id: i64,
    user: String,
    text: String,
    ts: i64,
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

type ApiErr = (StatusCode, String);

fn err500<E>(_: E) -> ApiErr {
    (StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера".into())
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

async fn register(
    State(st): State<AppState>,
    Json(c): Json<Creds>,
) -> Result<Json<AuthResp>, ApiErr> {
    let username = c.username.trim().to_string();
    let len = username.chars().count();
    if !(3..=32).contains(&len) {
        return Err((StatusCode::BAD_REQUEST, "Имя должно быть от 3 до 32 символов".into()));
    }
    if c.password.len() < 6 {
        return Err((StatusCode::BAD_REQUEST, "Пароль должен быть не короче 6 символов".into()));
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

    let token = new_token();
    {
        let db = st.db.lock().unwrap();
        match db.execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?1, ?2, ?3)",
            params![username, hash, now()],
        ) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                return Err((StatusCode::CONFLICT, "Это имя уже занято".into()));
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

    Ok(Json(AuthResp { token, username }))
}

async fn login(
    State(st): State<AppState>,
    Json(c): Json<Creds>,
) -> Result<Json<AuthResp>, ApiErr> {
    let bad = || (StatusCode::UNAUTHORIZED, "Неверное имя или пароль".to_string());

    let row: Option<(i64, String, String)> = {
        let db = st.db.lock().unwrap();
        db.query_row(
            "SELECT id, username, password_hash FROM users WHERE username = ?1",
            params![c.username.trim()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok()
    };
    let (uid, username, hash) = row.ok_or_else(bad)?;

    let pw = c.password;
    let ok = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|p| Argon2::default().verify_password(pw.as_bytes(), &p).is_ok())
            .unwrap_or(false)
    })
    .await
    .map_err(err500)?;
    if !ok {
        return Err(bad());
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

    Ok(Json(AuthResp { token, username }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(st): State<AppState>,
) -> impl IntoResponse {
    let user: Option<(i64, String)> = {
        let db = st.db.lock().unwrap();
        db.query_row(
            "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1",
            params![q.token],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    };

    match user {
        Some((uid, name)) => ws
            .on_upgrade(move |socket| handle_socket(socket, st, uid, name))
            .into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn handle_socket(mut socket: WebSocket, st: AppState, uid: i64, name: String) {
    // подписываемся до чтения истории, чтобы не потерять сообщения
    let mut rx = st.tx.subscribe();

    let history: Vec<ChatMsg> = {
        let db = st.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id, username, text, created_at FROM \
                 (SELECT * FROM messages ORDER BY id DESC LIMIT 50) ORDER BY id ASC",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok(ChatMsg {
                    id: r.get(0)?,
                    user: r.get(1)?,
                    text: r.get(2)?,
                    ts: r.get(3)?,
                })
            })
            .unwrap();
        let v: Vec<ChatMsg> = rows.filter_map(Result::ok).collect();
        v
    };
    let payload = serde_json::json!({ "type": "history", "messages": history }).to_string();
    if socket.send(Message::Text(payload)).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let text = text.trim().to_string();
                    if text.is_empty() || text.chars().count() > 2000 {
                        continue;
                    }
                    let ts = now();
                    let id = {
                        let db = st.db.lock().unwrap();
                        if db.execute(
                            "INSERT INTO messages (user_id, username, text, created_at) VALUES (?1, ?2, ?3, ?4)",
                            params![uid, name, text, ts],
                        ).is_err() {
                            continue;
                        }
                        db.last_insert_rowid()
                    };
                    let msg = ChatMsg { id, user: name.clone(), text, ts };
                    let json = serde_json::json!({ "type": "message", "message": msg }).to_string();
                    let _ = st.tx.send(json);
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
}

#[tokio::main]
async fn main() {
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "fycord.db".into());
    let conn = Connection::open(&db_path).expect("не удалось открыть базу");
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS users (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
             password_hash TEXT NOT NULL,
             created_at    INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sessions (
             token   TEXT PRIMARY KEY,
             user_id INTEGER NOT NULL REFERENCES users(id)
         );
         CREATE TABLE IF NOT EXISTS messages (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             user_id    INTEGER NOT NULL REFERENCES users(id),
             username   TEXT NOT NULL,
             text       TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );",
    )
    .expect("не удалось создать таблицы");

    let (tx, _) = broadcast::channel(256);
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        tx,
    };

    let app = Router::new()
        .route("/api/register", post(register))
        .route("/api/login", post(login))
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