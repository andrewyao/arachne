use std::path::PathBuf;

use anyhow::Context;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(about = "Explore a codebase's function call graph")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the call graph as JSON.
    Graph {
        root: PathBuf,
        /// Use this SCIP index instead of indexing.
        #[arg(long)]
        index: Option<PathBuf>,
    },
    /// Serve the explorer UI.
    Serve {
        root: PathBuf,
        #[arg(long, default_value_t = 7878)]
        port: u16,
        /// Use this SCIP index instead of indexing.
        #[arg(long)]
        index: Option<PathBuf>,
        /// Don't open a browser.
        #[arg(long)]
        no_open: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Graph { root, index } => {
            let root = canonical(&root)?;
            let graph = arachne::analyze(&root, index.as_deref())?;
            println!("{}", serde_json::to_string(&graph)?);
        }
        Command::Serve {
            root,
            port,
            index,
            no_open,
        } => {
            let root = canonical(&root)?;
            let graph = arachne::analyze(&root, index.as_deref())?;
            arachne::server::serve(root, graph, port, !no_open).await?;
        }
    }
    Ok(())
}

fn canonical(root: &PathBuf) -> anyhow::Result<PathBuf> {
    root.canonicalize()
        .with_context(|| format!("no such directory {}", root.display()))
}
