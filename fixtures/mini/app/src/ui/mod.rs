pub mod util;

use crate::album::Album;

pub fn render(_album: &Album) {
    let items = vec![1, 2];
    items.iter().for_each(|x| {
        util::format_error(&x.to_string());
    });
    fn helper() -> usize {
        1
    }
    helper();
}

pub fn summary() {
    fn helper() -> usize {
        util::format_error("empty").len()
    }
    helper();
}
