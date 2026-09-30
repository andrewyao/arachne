pub(super) fn entry() {
    relay();
}

pub(crate) fn relay() {
    hop();
}

pub(self) fn hop() {
    Hop::step();
}

struct Hop;

impl Hop {
    fn step() {
        sink();
    }
}

pub(in crate) fn sink() {
    crate::db::util::format_error("vis");
}
