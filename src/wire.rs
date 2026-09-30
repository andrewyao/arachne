//! JSON served at `GET /api/graph`. Mirrored by `web/src/types.ts`.
//!
//! Endpoint ids share one index space: fns occupy `0..fns.len()`,
//! crates occupy `fns.len()..fns.len() + crates.len()`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Graph {
    /// Index is the FileId. Sorted by path.
    pub files: Vec<File>,
    /// Index is the FnId. Grouped by file, sorted by start line within a file.
    pub fns: Vec<Func>,
    /// Endpoint id is `fns.len() + index`. Sorted by name.
    pub crates: Vec<Crate>,
    /// `[caller fn id, callee endpoint id, call count]`, sorted, unique per pair.
    pub edges: Vec<(u32, u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    /// Relative to the analyzed root. Tooltip only.
    pub path: String,
    pub label: String,
    /// Half-open range into `Graph::fns`.
    pub fns: (u32, u32),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Func {
    pub file: u32,
    /// Full display label, e.g. `album.Photo::load`.
    pub label: String,
    pub kind: FnKind,
    /// 1-based, inclusive.
    pub lines: (u32, u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FnKind {
    Free,
    Method,
    TraitDecl,
    TraitImpl,
    Closure,
    Nested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Crate {
    pub name: String,
}
