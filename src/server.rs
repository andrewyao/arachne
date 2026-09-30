use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;

use crate::wire;

#[derive(RustEmbed)]
#[folder = "web/dist"]
#[allow_missing = true]
struct Assets;

struct AppState {
    root: PathBuf,
    graph: wire::Graph,
    graph_json: String,
}

pub fn router(root: PathBuf, graph: wire::Graph) -> Router {
    let graph_json = serde_json::to_string(&graph).expect("wire graph serializes");
    let state = Arc::new(AppState {
        root,
        graph,
        graph_json,
    });
    Router::new()
        .route("/api/graph", get(graph_handler))
        .route("/api/source/{file_id}", get(source_handler))
        .fallback(asset_handler)
        .with_state(state)
}

pub async fn serve(root: PathBuf, graph: wire::Graph, port: u16, open: bool) -> anyhow::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let url = format!("http://{addr}");
    eprintln!("serving on {url}");
    if open {
        if let Err(err) = open::that(&url) {
            eprintln!("could not open browser: {err}");
        }
    }
    axum::serve(listener, router(root, graph)).await?;
    Ok(())
}

async fn graph_handler(State(state): State<Arc<AppState>>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        state.graph_json.clone(),
    )
        .into_response()
}

/// Looks the file up by id so the client never names a path.
async fn source_handler(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<usize>,
) -> Response {
    let Some(file) = state.graph.files.get(file_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read_to_string(state.root.join(&file.path)).await {
        Ok(source) => (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            source,
        )
            .into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

async fn asset_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(asset) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return (
            [(header::CONTENT_TYPE, mime.as_ref().to_string())],
            asset.data,
        )
            .into_response();
    }
    match Assets::get("index.html") {
        Some(index) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())],
            index.data,
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "UI not built: run `npm run build` in web/",
        )
            .into_response(),
    }
}
