mod album;
mod db;
mod shapes;
mod ui;
mod vis;

fn main() {
    let album = album::Album::load();
    let _photo = album::Photo::load();
    ui::render(&album);
    db::util::format_error("boot");
    shapes::report();
    vis::entry();
}
