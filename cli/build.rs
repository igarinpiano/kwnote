// Bakes the target triple into the binary so `kwnote update` knows which
// release asset to download.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    println!("cargo:rustc-env=KWNOTE_TARGET={target}");
}
