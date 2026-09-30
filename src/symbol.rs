//! Parser for SCIP symbol strings (`<scheme> <manager> <name> <version> <descriptors>`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub package: String,
    pub descriptors: Vec<Descriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Descriptor {
    Namespace(String),
    Type(String),
    Term(String),
    Meta(String),
    Macro(String),
    Method(String),
    TypeParameter(String),
    Parameter(String),
}

impl Symbol {
    /// `None` for local symbols and malformed input.
    pub fn parse(s: &str) -> Option<Symbol> {
        if s.starts_with("local ") {
            return None;
        }
        let mut rest = s;
        let mut fields = Vec::with_capacity(4);
        for _ in 0..4 {
            let (field, tail) = space_field(rest)?;
            fields.push(field);
            rest = tail;
        }
        Some(Symbol {
            package: fields.swap_remove(2),
            descriptors: descriptors(rest)?,
        })
    }

    pub fn is_callable(&self) -> bool {
        matches!(self.descriptors.last(), Some(Descriptor::Method(_)))
    }
}

/// A space-terminated field where `  ` escapes a literal space.
fn space_field(s: &str) -> Option<(String, &str)> {
    let mut out = String::new();
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c != ' ' {
            out.push(c);
        } else if chars.peek().map(|&(_, c)| c) == Some(' ') {
            chars.next();
            out.push(' ');
        } else {
            return Some((out, &s[i + 1..]));
        }
    }
    None
}

fn descriptors(s: &str) -> Option<Vec<Descriptor>> {
    let mut out = Vec::new();
    let mut rest = s;
    while !rest.is_empty() {
        let (d, tail) = if let Some(tail) = rest.strip_prefix('[') {
            let (name, tail) = name(tail)?;
            (Descriptor::TypeParameter(name), tail.strip_prefix(']')?)
        } else if let Some(tail) = rest.strip_prefix('(') {
            let (name, tail) = name(tail)?;
            (Descriptor::Parameter(name), tail.strip_prefix(')')?)
        } else {
            let (name, tail) = name(rest)?;
            let mut chars = tail.chars();
            match chars.next()? {
                '/' => (Descriptor::Namespace(name), chars.as_str()),
                '#' => (Descriptor::Type(name), chars.as_str()),
                '.' => (Descriptor::Term(name), chars.as_str()),
                ':' => (Descriptor::Meta(name), chars.as_str()),
                '!' => (Descriptor::Macro(name), chars.as_str()),
                '(' => {
                    let close = tail.find(')')?;
                    (
                        Descriptor::Method(name),
                        tail[close + 1..].strip_prefix('.')?,
                    )
                }
                _ => return None,
            }
        };
        out.push(d);
        rest = tail;
    }
    Some(out)
}

/// A simple identifier, or a backtick-escaped name where ``` `` ``` is a literal backtick.
fn name(s: &str) -> Option<(String, &str)> {
    if let Some(body) = s.strip_prefix('`') {
        let mut out = String::new();
        let mut chars = body.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if c != '`' {
                out.push(c);
            } else if chars.peek().map(|&(_, c)| c) == Some('`') {
                chars.next();
                out.push('`');
            } else {
                return Some((out, &body[i + 1..]));
            }
        }
        return None;
    }
    let end = s
        .find(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '+' | '-' | '$')))
        .unwrap_or(s.len());
    Some((s[..end].to_string(), &s[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use Descriptor::*;

    #[test]
    fn trait_impl_with_escaped_type() {
        let s = Symbol::parse(
            "rust-analyzer cargo core https://github.com/rust-lang/rust/library/core slice/iter/impl#[`Iter<'a, T>`][Iterator]for_each().",
        )
        .unwrap();
        assert_eq!(s.package, "core");
        assert_eq!(
            s.descriptors,
            vec![
                Namespace("slice".into()),
                Namespace("iter".into()),
                Type("impl".into()),
                TypeParameter("Iter<'a, T>".into()),
                TypeParameter("Iterator".into()),
                Method("for_each".into()),
            ]
        );
        assert!(s.is_callable());
    }

    #[test]
    fn non_callables_and_locals() {
        let mac = Symbol::parse("rust-analyzer cargo alloc v macros/vec!").unwrap();
        assert!(!mac.is_callable());
        let konst = Symbol::parse("rust-analyzer cargo core v f64/consts/PI.").unwrap();
        assert!(!konst.is_callable());
        assert_eq!(Symbol::parse("local 3"), None);
    }
}
