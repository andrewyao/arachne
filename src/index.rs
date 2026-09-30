//! Runs the language's SCIP indexer, cached under `<root>/.arachne` by a content hash.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use ignore::WalkBuilder;
use protobuf::Message;

use crate::lang::Language;

const CACHE_DIR: &str = ".arachne";

/// Returns the path of an index that matches the current sources, indexing if needed.
pub fn ensure(root: &Path, lang: &Language) -> anyhow::Result<PathBuf> {
    let dir = root.join(CACHE_DIR);
    let index = dir.join("index.scip");
    let hash_file = dir.join("hash");
    let hash = content_hash(root, lang)?;

    let reason = match fs::read_to_string(&hash_file) {
        Ok(cached) if cached == hash && index.is_file() => {
            eprintln!("index: cache hit");
            return Ok(index);
        }
        Ok(_) => "sources changed",
        Err(_) => "no cache",
    };
    eprintln!("index: running {} ({reason})", lang.indexer);

    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    fs::write(dir.join(".gitignore"), "*\n")?;
    let tmp = dir.join("index.scip.tmp");
    let status = (lang.index_cmd)(root, &tmp)
        .status()
        .with_context(|| format!("running {}", lang.indexer))?;
    if !status.success() {
        bail!("{} failed with {status}", lang.indexer);
    }
    fs::rename(&tmp, &index)?;
    fs::write(&hash_file, hash)?;
    Ok(index)
}

pub fn load(path: &Path) -> anyhow::Result<scip::types::Index> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    scip::types::Index::parse_from_bytes(&bytes)
        .with_context(|| format!("parsing SCIP index {}", path.display()))
}

/// Hash of every source file (respecting .gitignore, never `target/` or the cache) plus the lockfile.
fn content_hash(root: &Path, lang: &Language) -> anyhow::Result<String> {
    let mut paths = Vec::new();
    let walk = WalkBuilder::new(root)
        .require_git(false)
        .filter_entry(|e| {
            !(e.file_type().is_some_and(|t| t.is_dir())
                && matches!(e.file_name().to_str(), Some("target" | CACHE_DIR)))
        })
        .build();
    for entry in walk {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type().is_some_and(|t| t.is_file())
            && path.extension().is_some_and(|x| x == lang.source_ext)
        {
            paths.push(path.to_path_buf());
        }
    }
    let lockfile = root.join(lang.lockfile);
    if lockfile.is_file() {
        paths.push(lockfile);
    }
    paths.sort();

    let mut hasher = blake3::Hasher::new();
    for path in &paths {
        let content = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        hasher.update(
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .as_bytes(),
        );
        hasher.update(&[0]);
        hasher.update(&(content.len() as u64).to_le_bytes());
        hasher.update(&content);
    }
    Ok(hasher.finalize().to_hex().to_string())
}
