mod typst_renderer;

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let result = if arguments == ["--render-pdf"] {
        typst_renderer::run()
    } else {
        achbit_first_party_tools::run_from_args(arguments.into_iter())
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
