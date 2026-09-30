use std::path::Path;

use arachne::wire::Graph;

#[test]
fn mini_fixture_matches_golden_graph() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let root = fixtures.join("mini").canonicalize().unwrap();
    let got = arachne::analyze(&root, None).unwrap();
    let want: Graph =
        serde_json::from_str(&std::fs::read_to_string(fixtures.join("mini.graph.json")).unwrap())
            .unwrap();

    let label = |g: &Graph, id: u32| {
        g.fns.get(id as usize).map_or_else(
            || g.crates[id as usize - g.fns.len()].name.clone(),
            |f| f.label.clone(),
        )
    };
    let readable = |g: &Graph| -> Vec<String> {
        g.edges
            .iter()
            .map(|&(a, b, n)| format!("{} -> {} x{n}", label(g, a), label(g, b)))
            .collect()
    };
    assert_eq!(readable(&got), readable(&want), "edges by label");
    assert_eq!(got, want);
}
