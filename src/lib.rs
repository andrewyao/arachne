pub mod graph;
pub mod index;
pub mod labels;
pub mod lang;
pub mod server;
pub mod symbol;
pub mod wire;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::Context;

/// Indexes (or reuses the cached index for) `root` and builds its call graph.
pub fn analyze(root: &Path, index_override: Option<&Path>) -> anyhow::Result<wire::Graph> {
    let lang = lang::detect(root)
        .with_context(|| format!("no supported language detected in {}", root.display()))?;
    let index_path = match index_override {
        Some(path) => path.to_path_buf(),
        None => index::ensure(root, lang)?,
    };
    let index = index::load(&index_path)?;
    let workspace: HashSet<String> = (lang.workspace_packages)(root)?.into_iter().collect();

    let mut spans = HashMap::new();
    for doc in index
        .documents
        .iter()
        .filter(|d| graph::is_workspace_doc(d, &workspace))
    {
        let path = root.join(&doc.relative_path);
        let source =
            fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        spans.insert(doc.relative_path.clone(), (lang.source_spans)(&source));
    }
    Ok(graph::build(&index, &spans, &workspace, lang).to_wire())
}
