//! Per-language knowledge. Supporting a new language means adding a `Language` to `LANGUAGES`.

use std::path::Path;
use std::process::Command;

use crate::symbol::Descriptor;

pub mod rust;

pub struct Language {
    pub name: &'static str,
    /// Shown in the indexing log line.
    pub indexer: &'static str,
    pub detect: fn(root: &Path) -> bool,
    pub index_cmd: fn(root: &Path, out: &Path) -> Command,
    pub workspace_packages: fn(root: &Path) -> anyhow::Result<Vec<String>>,
    /// Extension of source files hashed for the index cache key.
    pub source_ext: &'static str,
    /// Root-level file hashed alongside the sources.
    pub lockfile: &'static str,
    /// Interprets a callable symbol from the descriptors enclosing its method descriptor.
    pub fn_name: fn(parents: &[Descriptor], name: &str) -> FnName,
    /// Path components ending in the module name, e.g. `app/src/db/mod.rs` -> `[app, src, db]`.
    pub module_path: fn(rel_path: &str, package: &str) -> Vec<String>,
    pub source_spans: fn(source: &str) -> SourceSpans,
}

pub static LANGUAGES: &[Language] = &[rust::RUST];

pub fn detect(root: &Path) -> Option<&'static Language> {
    LANGUAGES.iter().find(|lang| (lang.detect)(root))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FnName {
    Free {
        name: String,
    },
    Method {
        self_ty: String,
        name: String,
    },
    TraitDecl {
        trait_: String,
        name: String,
    },
    TraitImpl {
        self_ty: String,
        trait_: String,
        name: String,
    },
}

/// 0-based line and column, ordered by line then column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub line: u32,
    pub col: u32,
}

/// Half-open `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: Pos,
    pub end: Pos,
}

impl Span {
    pub fn contains(&self, pos: Pos) -> bool {
        self.start <= pos && pos < self.end
    }
}

/// What SCIP can't tell us about a source file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceSpans {
    /// Test fns and test-only modules. Everything inside is excluded.
    pub tests: Vec<Span>,
}
