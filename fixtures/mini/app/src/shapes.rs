pub trait Shape {
    fn area(&self) -> f64;

    fn describe(&self) -> String {
        format!("{}", self.area())
    }
}

struct Square;
struct Circle;

impl Shape for Square {
    fn area(&self) -> f64 {
        1.0
    }
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        std::f64::consts::PI
    }

    fn describe(&self) -> String {
        "circle".into()
    }
}

pub fn report() {
    let shapes: Vec<Box<dyn Shape>> = vec![Box::new(Square), Box::new(Circle)];
    for shape in &shapes {
        shape.describe();
    }
    Square.area();
}
