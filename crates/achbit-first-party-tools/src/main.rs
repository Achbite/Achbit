fn main() {
    if let Err(error) = achbit_first_party_tools::run_from_args(std::env::args().skip(1)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
