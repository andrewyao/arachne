use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context};
use tree_sitter::{Node, Parser};

use super::{FnName, Language, Pos, SourceSpans, Span};
use crate::symbol::Descriptor;

pub const RUST: Language = Language {
    name: "rust",
    indexer: "rust-analyzer scip",
    detect: |root| root.join("Cargo.toml").is_file(),
    index_cmd,
    workspace_packages,
    source_ext: "rs",
    lockfile: "Cargo.lock",
    fn_name,
    module_path,
    source_spans,
};

fn index_cmd(root: &Path, out: &Path) -> Command {
    let mut cmd = Command::new("rust-analyzer");
    cmd.arg("scip").arg(root).arg("--output").arg(out);
    cmd
}

fn workspace_packages(root: &Path) -> anyhow::Result<Vec<String>> {
    let output = Command::new("cargo")
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(root.join("Cargo.toml"))
        .output()
        .context("running cargo metadata")?;
    if !output.status.success() {
        bail!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let meta: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("parsing cargo metadata")?;
    let packages = meta["packages"]
        .as_array()
        .context("cargo metadata has no packages")?;
    Ok(packages
        .iter()
        .filter_map(|p| p["name"].as_str().map(str::to_string))
        .collect())
}

/// rust-analyzer encodes impls as `impl#[SelfTy][Trait]method().` and trait items as `Trait#method().`.
fn fn_name(parents: &[Descriptor], name: &str) -> FnName {
    use Descriptor::*;
    let name = name.to_string();
    match parents {
        [.., Type(imp), TypeParameter(self_ty), TypeParameter(trait_)] if imp == "impl" => {
            FnName::TraitImpl {
                self_ty: self_ty.clone(),
                trait_: trait_.clone(),
                name,
            }
        }
        [.., Type(imp), TypeParameter(self_ty)] if imp == "impl" => FnName::Method {
            self_ty: self_ty.clone(),
            name,
        },
        [.., Type(trait_)] => FnName::TraitDecl {
            trait_: trait_.clone(),
            name,
        },
        _ => FnName::Free { name },
    }
}

fn module_path(rel_path: &str, package: &str) -> Vec<String> {
    let path = rel_path.strip_suffix(".rs").unwrap_or(rel_path);
    let mut parts: Vec<String> = path.split('/').map(str::to_string).collect();
    match parts.last().map(String::as_str) {
        Some("mod") => {
            parts.pop();
        }
        Some("lib" | "main") => *parts.last_mut().unwrap() = package.to_string(),
        _ => {}
    }
    parts
}

fn source_spans(source: &str) -> SourceSpans {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .expect("tree-sitter-rust grammar is ABI compatible");
    let tree = parser
        .parse(source, None)
        .expect("parser has a language and no timeout");
    let mut spans = SourceSpans::default();
    let mut stack = vec![(tree.root_node(), Scope::Module)];
    while let Some((node, scope)) = stack.pop() {
        let kind = node.kind();
        if matches!(kind, "function_item" | "mod_item" | "impl_item")
            && has_attr(node, source, is_test_attr)
        {
            spans.tests.push(span(node));
            continue;
        }
        if matches!(kind, "function_item" | "function_signature_item")
            && is_private(node, scope, source)
        {
            if let Some(name) = node.child_by_field_name("name") {
                spans.private_fns.insert(span(name).start);
            }
        }
        let inner = match (scope, kind) {
            (Scope::FnBody, _) | (_, "function_item") => Scope::FnBody,
            (_, "impl_item") if node.child_by_field_name("trait").is_some() => Scope::TraitImpl,
            (_, "impl_item") => Scope::Impl,
            (_, "trait_item") => Scope::Trait,
            (_, "mod_item") => Scope::Module,
            _ => scope,
        };
        let mut cursor = node.walk();
        stack.extend(node.named_children(&mut cursor).map(|c| (c, inner)));
    }
    spans.tests.sort_by_key(|s| s.start);
    spans
}

/// Where an item sits, as far as its visibility is concerned.
#[derive(Debug, Clone, Copy)]
enum Scope {
    Module,
    Impl,
    /// Methods are reached through the trait and can't carry a modifier.
    TraitImpl,
    Trait,
    /// Anything inside a fn body, however deep.
    FnBody,
}

fn is_private(item: Node, scope: Scope, source: &str) -> bool {
    match scope {
        Scope::FnBody => true,
        Scope::TraitImpl | Scope::Trait => false,
        Scope::Module | Scope::Impl => {
            let mut cursor = item.walk();
            let modifier = item
                .named_children(&mut cursor)
                .find(|c| c.kind() == "visibility_modifier");
            modifier.is_none_or(|m| {
                text(m, source).split_whitespace().collect::<String>() == "pub(self)"
            })
        }
    }
}

fn span(node: Node) -> Span {
    let pos = |p: tree_sitter::Point| Pos {
        line: p.row as u32,
        col: p.column as u32,
    };
    Span {
        start: pos(node.start_position()),
        end: pos(node.end_position()),
    }
}

/// Outer attributes are the item's preceding siblings, not its children.
fn has_attr(item: Node, source: &str, pred: fn(&str, &str) -> bool) -> bool {
    let mut sibling = item.prev_named_sibling();
    while let Some(node) = sibling {
        match node.kind() {
            "attribute_item" => {
                if let Some(attr) = node.named_child(0) {
                    let path = attr.named_child(0).map_or("", |p| text(p, source));
                    let args = attr
                        .child_by_field_name("arguments")
                        .map_or("", |a| text(a, source));
                    if pred(path, args) {
                        return true;
                    }
                }
            }
            "line_comment" | "block_comment" => {}
            _ => break,
        }
        sibling = node.prev_named_sibling();
    }
    false
}

fn is_test_attr(path: &str, args: &str) -> bool {
    path == "test"
        || path.ends_with("::test")
        || (path == "cfg" && args.split_whitespace().collect::<String>() == "(test)")
}

fn text<'a>(node: Node, source: &'a str) -> &'a str {
    &source[node.byte_range()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(spans: &[Span]) -> Vec<(u32, u32)> {
        spans
            .iter()
            .map(|s| (s.start.line + 1, s.end.line + 1))
            .collect()
    }

    #[test]
    fn finds_tests() {
        let src = r#"
fn keep() {
    let f = |x| x + 1;
}
#[test]
fn plain() {}
/// doc
#[tokio::test(flavor = "multi_thread")]
async fn tokio_test() {}
#[cfg(test)]
mod tests {
    fn helper() { let g = || 1; }
}
#[cfg(feature = "test")]
mod not_tests {}
impl Loader {
    #[cfg(test)]
    fn for_test() {}
}
"#;
        let spans = source_spans(src);
        assert_eq!(
            lines(&spans.tests),
            vec![(6, 6), (9, 9), (11, 13), (18, 18)]
        );
    }

    #[test]
    fn private_fns_by_visibility_and_scope() {
        let src = r#"
fn plain() {
    fn nested() {}
    let f = || { pub fn in_closure() {} };
}
pub fn public() {}
pub(crate) fn krate() {}
pub(super) fn sup() {}
pub(in crate::a) fn in_path() {}
pub(self) fn slf() {}
pub( self ) fn slf_spaced() {}
impl Photo {
    fn method() {}
    pub fn pub_method() {}
    pub(self) fn self_method() {}
}
impl Shape for Photo {
    fn trait_impl() {}
}
trait Shape {
    fn decl();
    fn provided() {}
}
mod inner {
    fn in_mod() {}
    pub fn pub_in_mod() {}
}
"#;
        let lines: Vec<&str> = src.lines().collect();
        let mut private: Vec<&str> = source_spans(src)
            .private_fns
            .iter()
            .map(|p| {
                let rest = &lines[p.line as usize][p.col as usize..];
                &rest[..rest.find('(').unwrap()]
            })
            .collect();
        private.sort();
        assert_eq!(
            private,
            [
                "in_closure",
                "in_mod",
                "method",
                "nested",
                "plain",
                "self_method",
                "slf",
                "slf_spaced"
            ]
        );
    }

    #[test]
    fn module_paths() {
        assert_eq!(
            module_path("app/src/db/mod.rs", "app"),
            ["app", "src", "db"]
        );
        assert_eq!(module_path("app/src/main.rs", "app"), ["app", "src", "app"]);
        assert_eq!(module_path("src/ui/util.rs", "x"), ["src", "ui", "util"]);
    }
}
