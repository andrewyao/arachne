pub struct Photo;
pub struct Album;

impl Photo {
    pub fn load() -> Self {
        Photo
    }

    pub fn resize(&self) -> usize {
        rawish::decode(&[1, 2, 3])
    }
}

impl Album {
    pub fn load() -> Self {
        let photo = Photo::load();
        photo.resize();
        Album
    }
}
