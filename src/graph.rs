//! Builds the call graph from a SCIP index plus the spans SCIP doesn't provide.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use scip::types::{Document, Index, Occurrence, SymbolRole};

use crate::labels::{self, FnLabelInput};
use crate::lang::{FnName, Language, Pos, SourceSpans, Span};
use crate::symbol::{Descriptor, Symbol};
use crate::wire;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FileId(pub u32);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FnId(pub u32);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CrateId(pub u32);

/// Callee side of an edge. Callers are always fns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Endpoint {
    Fn(FnId),
    Crate(CrateId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub path: String,
    pub label: String,
    pub fns: Range<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Func {
    pub file: FileId,
    pub label: String,
    pub kind: FnKind,
    /// 1-based, inclusive.
    pub lines: (u32, u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FnKind {
    Named(FnName),
    Nested { parent: FnId, name: FnName },
    Closure { parent: FnId },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallGraph {
    pub files: Vec<File>,
    /// Grouped by file, sorted by position within a file.
    pub fns: Vec<Func>,
    /// Sorted by name.
    pub crates: Vec<String>,
    /// `out[out_offsets[f]..out_offsets[f + 1]]` are fn `f`'s callees with call counts.
    out_offsets: Vec<u32>,
    out: Vec<(Endpoint, u32)>,
}

impl CallGraph {
    pub fn callees(&self, f: FnId) -> &[(Endpoint, u32)] {
        let i = f.0 as usize;
        &self.out[self.out_offsets[i] as usize..self.out_offsets[i + 1] as usize]
    }

    pub fn to_wire(&self) -> wire::Graph {
        let fn_count = self.fns.len() as u32;
        let endpoint = |e: Endpoint| match e {
            Endpoint::Fn(f) => f.0,
            Endpoint::Crate(c) => fn_count + c.0,
        };
        wire::Graph {
            files: self
                .files
                .iter()
                .map(|f| wire::File {
                    path: f.path.clone(),
                    label: f.label.clone(),
                    fns: (f.fns.start, f.fns.end),
                })
                .collect(),
            fns: self
                .fns
                .iter()
                .map(|f| wire::Func {
                    file: f.file.0,
                    label: f.label.clone(),
                    kind: match &f.kind {
                        FnKind::Named(FnName::Free { .. }) => wire::FnKind::Free,
                        FnKind::Named(FnName::Method { .. }) => wire::FnKind::Method,
                        FnKind::Named(FnName::TraitDecl { .. }) => wire::FnKind::TraitDecl,
                        FnKind::Named(FnName::TraitImpl { .. }) => wire::FnKind::TraitImpl,
                        FnKind::Nested { .. } => wire::FnKind::Nested,
                        FnKind::Closure { .. } => wire::FnKind::Closure,
                    },
                    lines: f.lines,
                })
                .collect(),
            crates: self
                .crates
                .iter()
                .map(|name| wire::Crate { name: name.clone() })
                .collect(),
            edges: (0..fn_count)
                .flat_map(|f| {
                    self.callees(FnId(f))
                        .iter()
                        .map(move |&(e, n)| (f, endpoint(e), n))
                })
                .collect(),
        }
    }
}

const STD: &str = "std";

/// Whether the document defines any fn of a workspace package.
pub fn is_workspace_doc(doc: &Document, workspace: &HashSet<String>) -> bool {
    doc.occurrences
        .iter()
        .filter(|o| is_definition(o))
        .filter_map(|o| Symbol::parse(&o.symbol))
        .any(|s| s.is_callable() && workspace.contains(&s.package))
}

/// `spans` holds the tree-sitter spans of every document `is_workspace_doc` accepts.
pub fn build(
    index: &Index,
    spans: &HashMap<String, SourceSpans>,
    workspace: &HashSet<String>,
    lang: &Language,
) -> CallGraph {
    let no_spans = SourceSpans::default();
    let mut docs: Vec<Doc> = index
        .documents
        .iter()
        .filter_map(|d| {
            Doc::new(
                d,
                spans.get(&d.relative_path).unwrap_or(&no_spans),
                workspace,
                lang,
            )
        })
        .collect();
    docs.sort_by(|a, b| a.doc.relative_path.cmp(&b.doc.relative_path));

    let mut files = Vec::with_capacity(docs.len());
    let mut fns = Vec::new();
    let module_paths: Vec<Vec<String>> = docs
        .iter()
        .map(|d| (lang.module_path)(&d.doc.relative_path, &d.package))
        .collect();
    let file_paths: Vec<&str> = docs.iter().map(|d| d.doc.relative_path.as_str()).collect();
    let file_labels = labels::file_labels(&module_paths, &file_paths);
    for (file_idx, (doc, file_label)) in docs.iter_mut().zip(file_labels).enumerate() {
        let first = fns.len() as u32;
        let mut label_inputs = Vec::new();
        let mut kinds = Vec::new();
        let mut lines = Vec::new();
        let mut local_of_entry = vec![None; doc.entries.len()];
        for (e, entry) in doc.entries.iter().enumerate() {
            let parent = doc.parents[e].and_then(|p| local_of_entry[p]);
            let (input, kind) = match (&entry.what, parent) {
                (What::Def { name, .. }, None) => {
                    (FnLabelInput::Named(name), FnKind::Named(name.clone()))
                }
                (What::Def { name, .. }, Some(p)) => (
                    FnLabelInput::Nested { parent: p, name },
                    FnKind::Nested {
                        parent: FnId(first + p as u32),
                        name: name.clone(),
                    },
                ),
                (What::Closure, Some(p)) => (
                    FnLabelInput::Closure { parent: p },
                    FnKind::Closure {
                        parent: FnId(first + p as u32),
                    },
                ),
                (What::Closure, None) | (What::Excluded, _) => continue,
            };
            local_of_entry[e] = Some(label_inputs.len());
            label_inputs.push(input);
            kinds.push(kind);
            lines.push((entry.first_line + 1, entry.span.end.line + 1));
        }
        let fn_labels = labels::fn_labels(&file_label, &label_inputs);
        for ((label, kind), lines) in fn_labels.into_iter().zip(kinds).zip(lines) {
            fns.push(Func {
                file: FileId(file_idx as u32),
                label,
                kind,
                lines,
            });
        }
        doc.fn_of_entry = local_of_entry
            .iter()
            .map(|l| l.map(|l| FnId(first + l as u32)))
            .collect();
        files.push(File {
            path: doc.doc.relative_path.clone(),
            label: file_label,
            fns: first..fns.len() as u32,
        });
    }

    let fn_of_symbol: HashMap<&str, FnId> = docs
        .iter()
        .flat_map(|d| {
            d.entries
                .iter()
                .zip(&d.fn_of_entry)
                .filter_map(|(entry, f)| match (&entry.what, f) {
                    (What::Def { symbol, .. }, Some(f)) => Some((symbol.as_str(), *f)),
                    _ => None,
                })
        })
        .collect();

    #[derive(PartialEq, Eq, Hash)]
    enum Callee {
        Fn(FnId),
        Crate(String),
    }
    let mut counts: HashMap<(FnId, Callee), u32> = HashMap::new();
    for doc in &docs {
        for occ in doc.doc.occurrences.iter().filter(|o| !is_definition(o)) {
            let Some(symbol) = Symbol::parse(&occ.symbol).filter(Symbol::is_callable) else {
                continue;
            };
            let Some(caller) = doc
                .innermost(range_start(&occ.range))
                .and_then(|e| doc.fn_of_entry[e])
            else {
                continue;
            };
            let callee = if workspace.contains(&symbol.package) {
                match fn_of_symbol.get(occ.symbol.as_str()) {
                    Some(&f) => Callee::Fn(f),
                    None => continue,
                }
            } else if (lang.is_std_package)(&symbol.package) {
                Callee::Crate(STD.to_string())
            } else {
                Callee::Crate(symbol.package)
            };
            *counts.entry((caller, callee)).or_default() += 1;
        }
    }

    let mut trait_decls: HashMap<(&str, &str, &str), Vec<FnId>> = HashMap::new();
    for doc in &docs {
        for (entry, f) in doc.entries.iter().zip(&doc.fn_of_entry) {
            if let (
                What::Def {
                    name: FnName::TraitDecl { trait_, name },
                    ..
                },
                Some(f),
            ) = (&entry.what, f)
            {
                trait_decls
                    .entry((&doc.package, trait_, name))
                    .or_default()
                    .push(*f);
            }
        }
    }
    for doc in &docs {
        for (entry, f) in doc.entries.iter().zip(&doc.fn_of_entry) {
            let Some(f) = *f else { continue };
            match &entry.what {
                What::Def {
                    name: FnName::TraitImpl { trait_, name, .. },
                    ..
                } => {
                    let key = (doc.package.as_str(), trait_base(trait_), name.as_str());
                    for &decl in trait_decls.get(&key).into_iter().flatten() {
                        *counts.entry((decl, Callee::Fn(f))).or_default() += 1;
                    }
                }
                What::Closure => {
                    if let FnKind::Closure { parent } = fns[f.0 as usize].kind {
                        *counts.entry((parent, Callee::Fn(f))).or_default() += 1;
                    }
                }
                _ => {}
            }
        }
    }

    let mut crates: Vec<String> = counts
        .keys()
        .filter_map(|(_, c)| match c {
            Callee::Crate(name) => Some(name.clone()),
            Callee::Fn(_) => None,
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    crates.sort();
    let crate_id: HashMap<&str, CrateId> = crates
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), CrateId(i as u32)))
        .collect();

    let mut edges: Vec<(FnId, Endpoint, u32)> = counts
        .into_iter()
        .map(|((caller, callee), n)| {
            let e = match callee {
                Callee::Fn(f) => Endpoint::Fn(f),
                Callee::Crate(name) => Endpoint::Crate(crate_id[name.as_str()]),
            };
            (caller, e, n)
        })
        .collect();
    edges.sort();
    let mut out_offsets = Vec::with_capacity(fns.len() + 1);
    let mut i = 0;
    for f in 0..=fns.len() as u32 {
        while i < edges.len() && edges[i].0 .0 < f {
            i += 1;
        }
        out_offsets.push(i as u32);
    }
    let out = edges.into_iter().map(|(_, e, n)| (e, n)).collect();

    CallGraph {
        files,
        fns,
        crates,
        out_offsets,
        out,
    }
}

/// `From<&str>` in an impl matches the trait decl `From`.
fn trait_base(trait_: &str) -> &str {
    trait_.split('<').next().unwrap_or(trait_)
}

fn is_definition(o: &Occurrence) -> bool {
    o.symbol_roles & SymbolRole::Definition as i32 != 0
}

fn range_start(range: &[i32]) -> Pos {
    Pos {
        line: range[0] as u32,
        col: range[1] as u32,
    }
}

/// SCIP ranges are `[line, col, end_col]` or `[line, col, end_line, end_col]`.
fn range_span(range: &[i32]) -> Option<Span> {
    let end = match *range {
        [line, _, end_col] => Pos {
            line: line as u32,
            col: end_col as u32,
        },
        [_, _, end_line, end_col] => Pos {
            line: end_line as u32,
            col: end_col as u32,
        },
        _ => return None,
    };
    Some(Span {
        start: range_start(range),
        end,
    })
}

enum What {
    Def {
        symbol: String,
        name: FnName,
    },
    Closure,
    /// A test region. Occurrences inside it belong to no fn.
    Excluded,
}

struct Entry {
    span: Span,
    /// Where the fn is shown to start. SCIP's enclosing range for a fn begins at its doc comment.
    first_line: u32,
    what: What,
}

/// One workspace document's spans, sorted by start with outer spans first.
struct Doc<'a> {
    doc: &'a Document,
    package: String,
    entries: Vec<Entry>,
    parents: Vec<Option<usize>>,
    fn_of_entry: Vec<Option<FnId>>,
}

impl<'a> Doc<'a> {
    fn new(
        doc: &'a Document,
        spans: &SourceSpans,
        workspace: &HashSet<String>,
        lang: &Language,
    ) -> Option<Self> {
        let in_test = |pos: Pos| spans.tests.iter().any(|t| t.contains(pos));
        let mut package = None;
        let mut entries: Vec<Entry> = spans
            .tests
            .iter()
            .map(|&span| Entry {
                span,
                first_line: span.start.line,
                what: What::Excluded,
            })
            .collect();
        for occ in doc.occurrences.iter().filter(|o| is_definition(o)) {
            let Some(symbol) = Symbol::parse(&occ.symbol) else {
                continue;
            };
            let Some((Descriptor::Method(name), parents)) = symbol.descriptors.split_last() else {
                continue;
            };
            if !workspace.contains(&symbol.package) || in_test(range_start(&occ.range)) {
                continue;
            }
            let Some(span) = range_span(&occ.enclosing_range) else {
                continue;
            };
            entries.push(Entry {
                span,
                first_line: range_start(&occ.range).line,
                what: What::Def {
                    symbol: occ.symbol.clone(),
                    name: (lang.fn_name)(parents, name),
                },
            });
            package.get_or_insert(symbol.package);
        }
        let package = package?;
        entries.extend(
            spans
                .closures
                .iter()
                .filter(|c| !in_test(c.start))
                .map(|&span| Entry {
                    span,
                    first_line: span.start.line,
                    what: What::Closure,
                }),
        );
        entries.sort_by(|a, b| {
            a.span
                .start
                .cmp(&b.span.start)
                .then(b.span.end.cmp(&a.span.end))
        });

        let mut parents = Vec::with_capacity(entries.len());
        let mut stack: Vec<usize> = Vec::new();
        for (i, entry) in entries.iter().enumerate() {
            while stack
                .last()
                .is_some_and(|&top| entries[top].span.end <= entry.span.start)
            {
                stack.pop();
            }
            parents.push(stack.last().copied());
            stack.push(i);
        }
        Some(Doc {
            doc,
            package,
            entries,
            parents,
            fn_of_entry: Vec::new(),
        })
    }

    /// The innermost entry containing `pos`. Spans are properly nested, so it is
    /// the last entry starting at or before `pos`, or one of its ancestors.
    fn innermost(&self, pos: Pos) -> Option<usize> {
        let mut candidate = self
            .entries
            .partition_point(|e| e.span.start <= pos)
            .checked_sub(1);
        while let Some(i) = candidate {
            if self.entries[i].span.contains(pos) {
                return Some(i);
            }
            candidate = self.parents[i];
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lang::rust::RUST;

    fn occ(symbol: &str, range: &[i32], enclosing: &[i32], def: bool) -> Occurrence {
        let mut o = Occurrence::new();
        o.symbol = format!("rust-analyzer cargo app 0.1.0 {symbol}");
        o.range = range.to_vec();
        o.enclosing_range = enclosing.to_vec();
        o.symbol_roles = if def {
            SymbolRole::Definition as i32
        } else {
            0
        };
        o
    }

    fn span(start: (u32, u32), end: (u32, u32)) -> Span {
        Span {
            start: Pos {
                line: start.0,
                col: start.1,
            },
            end: Pos {
                line: end.0,
                col: end.1,
            },
        }
    }

    fn build_one(occurrences: Vec<Occurrence>, spans: SourceSpans) -> wire::Graph {
        let mut doc = Document::new();
        doc.relative_path = "src/ui.rs".into();
        doc.occurrences = occurrences;
        let mut index = Index::new();
        index.documents = vec![doc];
        let spans = HashMap::from([("src/ui.rs".to_string(), spans)]);
        build(&index, &spans, &HashSet::from(["app".to_string()]), &RUST).to_wire()
    }

    fn edges_by_label(g: &wire::Graph) -> Vec<(&str, &str, u32)> {
        let label = |id: u32| g.fns[id as usize].label.as_str();
        g.edges
            .iter()
            .map(|&(a, b, n)| (label(a), label(b), n))
            .collect()
    }

    /// ```text
    /// 0 fn render() {
    /// 1     a();
    /// 2     xs.map(|x| {
    /// 3         b();
    /// 4     });
    /// 5     c();
    /// 6 }
    /// 7 fn a() {}  fn b() {}  fn c() {}
    /// ```
    #[test]
    fn closure_calls_belong_to_the_closure_and_calls_around_it_to_the_parent() {
        let g = build_one(
            vec![
                occ("ui/render().", &[0, 3, 9], &[0, 0, 6, 1], true),
                occ("ui/a().", &[1, 4, 5], &[], false),
                occ("ui/b().", &[3, 8, 9], &[], false),
                occ("ui/c().", &[5, 4, 5], &[], false),
                occ("ui/a().", &[7, 3, 4], &[7, 0, 9], true),
                occ("ui/b().", &[7, 14, 15], &[7, 11, 20], true),
                occ("ui/c().", &[7, 25, 26], &[7, 22, 31], true),
            ],
            SourceSpans {
                closures: vec![span((2, 11), (4, 5))],
                tests: vec![],
            },
        );
        assert_eq!(
            edges_by_label(&g),
            [
                ("ui.render", "ui.render::{closure#1}", 1),
                ("ui.render", "ui.a", 1),
                ("ui.render", "ui.c", 1),
                ("ui.render::{closure#1}", "ui.b", 1),
            ]
        );
    }

    /// ```text
    /// 0 fn render() {}
    /// 1
    /// 2 mod tests {
    /// 3     fn t() {
    /// 4         render();
    /// 5     }
    /// 6 }
    /// ```
    #[test]
    fn test_regions_drop_their_fns_and_calls() {
        let g = build_one(
            vec![
                occ("ui/render().", &[0, 3, 9], &[0, 0, 14], true),
                occ("ui/tests/t().", &[3, 7, 8], &[3, 4, 5, 5], true),
                occ("ui/render().", &[4, 8, 14], &[], false),
            ],
            SourceSpans {
                closures: vec![],
                tests: vec![span((2, 0), (6, 1))],
            },
        );
        let labels: Vec<&str> = g.fns.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(labels, ["ui.render"]);
        assert!(g.edges.is_empty());
    }

    #[test]
    fn fn_lines_start_at_the_name_not_the_doc_comment() {
        let g = build_one(
            vec![occ("ui/render().", &[2, 3, 9], &[0, 0, 4, 1], true)],
            SourceSpans::default(),
        );
        assert_eq!(g.fns[0].lines, (3, 5));
    }
}
