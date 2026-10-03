// Bakes the target triple into the binary so `kwnote update` knows which
// release asset to download, and bundles the third-party license notices
// shown by `kwnote licenses`.
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    println!("cargo:rustc-env=KWNOTE_TARGET={target}");

    // KWNOTE_LICENSES = file made by cargo-about (see about.toml), relative
    // to the workspace root so it also works inside `cross` containers
    // (Cross.toml passes the variable through). Release builds set it; other
    // builds get a pointer to the release asset instead.
    println!("cargo:rerun-if-env-changed=KWNOTE_LICENSES");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("licenses.txt");
    let text = match std::env::var("KWNOTE_LICENSES") {
        Ok(rel) if !rel.is_empty() => {
            let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
            let path = Path::new(&manifest).join("..").join(&rel);
            println!("cargo:rerun-if-changed={}", path.display());
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("KWNOTE_LICENSES={rel}: {e}"))
        }
        _ => "This build does not bundle the third-party license notices.\n\
              Release builds do; they are also attached to every GitHub release as\n\
              THIRD-PARTY-LICENSES.txt, and can be generated with cargo-about\n\
              (see cli/about.toml).\n"
            .to_string(),
    };
    std::fs::write(out, text).unwrap();
}
