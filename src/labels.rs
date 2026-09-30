//! Display labels for files and fns.

use std::collections::HashMap;

use crate::lang::FnName;

/// Each file is labelled by its module name. Clashing labels take on parent dirs
/// (`db/util`) until unique. A group that runs out of dirs, like `lib.rs` next to
/// `main.rs`, falls back to the file path.
pub fn file_labels(module_paths: &[Vec<String>], file_paths: &[&str]) -> Vec<String> {
    let mut depth = vec![1usize; module_paths.len()];
    let label = |i: usize, depth: usize| {
        let parts = &module_paths[i];
        parts[parts.len().saturating_sub(depth)..].join("/")
    };
    loop {
        let labels: Vec<String> = (0..module_paths.len())
            .map(|i| label(i, depth[i]))
            .collect();
        let mut groups: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, l) in labels.iter().enumerate() {
            groups.entry(l).or_default().push(i);
        }
        let mut grew = false;
        for members in groups.values().filter(|m| m.len() > 1) {
            for &i in members {
                if depth[i] < module_paths[i].len() {
                    depth[i] += 1;
                    grew = true;
                }
            }
        }
        if !grew {
            return labels
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    if groups[l.as_str()].len() > 1 {
                        file_paths[i].to_string()
                    } else {
                        l.clone()
                    }
                })
                .collect();
        }
    }
}

/// A fn as the labeller sees it. `parent` indexes an earlier entry in the same file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FnLabelInput<'a> {
    Named(&'a FnName),
    Nested { parent: usize, name: &'a FnName },
    Closure { parent: usize },
}

/// Labels for the fns of one file, in the order given.
pub fn fn_labels(file_label: &str, fns: &[FnLabelInput]) -> Vec<String> {
    let mut short: Vec<String> = fns
        .iter()
        .map(|f| match f {
            FnLabelInput::Named(name) | FnLabelInput::Nested { name, .. } => short_name(name),
            FnLabelInput::Closure { .. } => String::new(),
        })
        .collect();

    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (f, s) in fns.iter().zip(&short) {
        if let FnLabelInput::Named(_) = f {
            *counts.entry(s).or_default() += 1;
        }
    }
    let clashing: Vec<usize> = fns
        .iter()
        .enumerate()
        .filter(|(i, f)| matches!(f, FnLabelInput::Named(_)) && counts[short[*i].as_str()] > 1)
        .map(|(i, _)| i)
        .collect();
    for i in clashing {
        if let FnLabelInput::Named(FnName::TraitImpl {
            self_ty,
            trait_,
            name,
        }) = &fns[i]
        {
            short[i] = format!("<{self_ty} as {trait_}>::{name}");
        }
    }

    let mut closures_seen: HashMap<usize, u32> = HashMap::new();
    for (i, f) in fns.iter().enumerate() {
        match *f {
            FnLabelInput::Named(_) => {}
            FnLabelInput::Nested { parent, .. } => {
                short[i] = format!("{}::{}", short[parent], short[i])
            }
            FnLabelInput::Closure { parent } => {
                let n = closures_seen.entry(parent).or_default();
                *n += 1;
                short[i] = format!("{}::{{closure#{n}}}", short[parent]);
            }
        }
    }
    short
        .into_iter()
        .map(|s| format!("{file_label}.{s}"))
        .collect()
}

fn short_name(name: &FnName) -> String {
    match name {
        FnName::Free { name } => name.clone(),
        FnName::Method { self_ty, name } | FnName::TraitImpl { self_ty, name, .. } => {
            format!("{self_ty}::{name}")
        }
        FnName::TraitDecl { trait_, name } => format!("{trait_}::{name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(ps: &[&str]) -> Vec<Vec<String>> {
        ps.iter()
            .map(|p| p.split('/').map(str::to_string).collect())
            .collect()
    }

    #[test]
    fn file_label_clashes_take_parent_dirs_until_unique() {
        let labels = file_labels(
            &paths(&[
                "src/db/util",
                "src/ui/util",
                "src/ui",
                "a/x/common",
                "b/x/common",
                "src/album",
            ]),
            &[
                "src/db/util.rs",
                "src/ui/util.rs",
                "src/ui/mod.rs",
                "a/x/common.rs",
                "b/x/common.rs",
                "src/album.rs",
            ],
        );
        assert_eq!(
            labels,
            [
                "db/util",
                "ui/util",
                "ui",
                "a/x/common",
                "b/x/common",
                "album"
            ]
        );
    }

    #[test]
    fn file_label_clash_that_never_resolves_uses_file_path() {
        let labels = file_labels(
            &paths(&["src/app", "src/app", "src/db"]),
            &["src/lib.rs", "src/main.rs", "src/db.rs"],
        );
        assert_eq!(labels, ["src/lib.rs", "src/main.rs", "db"]);
    }

    fn free(name: &str) -> FnName {
        FnName::Free { name: name.into() }
    }

    fn trait_impl(self_ty: &str, trait_: &str, name: &str) -> FnName {
        FnName::TraitImpl {
            self_ty: self_ty.into(),
            trait_: trait_.into(),
            name: name.into(),
        }
    }

    #[test]
    fn clashing_trait_impls_get_qualified_and_children_follow() {
        let inherent = FnName::Method {
            self_ty: "Photo".into(),
            name: "from".into(),
        };
        let from_str = trait_impl("Photo", "From<&str>", "from");
        let from_u8 = trait_impl("Photo", "From<u8>", "from");
        let decl = FnName::TraitDecl {
            trait_: "Shape".into(),
            name: "area".into(),
        };
        let area = trait_impl("Square", "Shape", "area");
        let helper = free("helper");
        let fns = [
            FnLabelInput::Named(&inherent),
            FnLabelInput::Named(&from_str),
            FnLabelInput::Closure { parent: 1 },
            FnLabelInput::Named(&from_u8),
            FnLabelInput::Nested {
                parent: 3,
                name: &helper,
            },
            FnLabelInput::Named(&decl),
            FnLabelInput::Named(&area),
        ];
        assert_eq!(
            fn_labels("album", &fns),
            [
                "album.Photo::from",
                "album.<Photo as From<&str>>::from",
                "album.<Photo as From<&str>>::from::{closure#1}",
                "album.<Photo as From<u8>>::from",
                "album.<Photo as From<u8>>::from::helper",
                "album.Shape::area",
                "album.Square::area",
            ]
        );
    }

    #[test]
    fn closures_number_per_parent_in_order() {
        let render = free("render");
        let other = free("other");
        let fns = [
            FnLabelInput::Named(&render),
            FnLabelInput::Closure { parent: 0 },
            FnLabelInput::Closure { parent: 1 },
            FnLabelInput::Closure { parent: 0 },
            FnLabelInput::Named(&other),
            FnLabelInput::Closure { parent: 4 },
        ];
        assert_eq!(
            fn_labels("ui", &fns),
            [
                "ui.render",
                "ui.render::{closure#1}",
                "ui.render::{closure#1}::{closure#1}",
                "ui.render::{closure#2}",
                "ui.other",
                "ui.other::{closure#1}",
            ]
        );
    }
}
