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

    let readable = |g: &Graph| -> Vec<String> {
        let label = |id: u32| &g.fns[id as usize].label;
        g.edges
            .iter()
            .map(|&(a, b, n)| format!("{} -> {} x{n}", label(a), label(b)))
            .collect()
    };
    assert_eq!(readable(&got), readable(&want), "edges by label");
    assert_eq!(got, want);
}
