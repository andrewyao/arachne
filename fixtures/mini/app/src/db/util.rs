pub fn format_error(message: &str) -> String {
    message.to_uppercase()
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats() {
        super::format_error("a");
    }
}
