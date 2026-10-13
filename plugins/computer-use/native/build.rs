use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=src/sharing.m");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    // Built by the existing macOS package bridge with the installed Apple SDK.
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    let object = out.join("sharing.o");
    assert!(
        Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-fmodules",
                "-mmacosx-version-min=15.2",
                "-c",
                "src/sharing.m",
                "-o"
            ])
            .arg(&object)
            .arg(format!(
                "-fmodules-cache-path={}",
                out.join("clang-modules").display()
            ))
            .status()
            .expect("Apple clang")
            .success(),
        "ScreenCaptureKit bridge compilation failed"
    );
    assert!(Command::new("ar")
        .arg("crs")
        .arg(out.join("libdeepcode_sharing.a"))
        .arg(object)
        .status()
        .expect("Apple ar")
        .success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=deepcode_sharing");
    for framework in ["ScreenCaptureKit", "AppKit", "CoreMedia"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
