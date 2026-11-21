//! `sqlx::migrate!` embeds the migration files when the crate is compiled, and
//! cargo does not watch that directory by itself: without this a new file
//! would stay out of the build until some Rust source changed.

fn main() {
    println!("cargo::rerun-if-changed=migrations");
}
