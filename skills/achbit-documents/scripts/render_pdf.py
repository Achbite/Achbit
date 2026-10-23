"""Render self-contained UTF-8 HTML from stdin to PDF on stdout.

Called by the document tool's owned process; errors stay on stderr. The tool
publishes the destination only after this renderer exits successfully.
"""
import logging
import sys


def render(html):
    try:
        from weasyprint import HTML, URLFetcher
    except (ImportError, OSError) as error:
        raise RuntimeError(
            "WeasyPrint is unavailable in the configured document Python environment: "
            + str(error)
        ) from error

    # Document export has no network or arbitrary file-read effect. Images,
    # styles and SVG must be embedded; font discovery uses installed fonts.
    embedded_resources = URLFetcher(allowed_protocols=["data"], fail_on_errors=True)

    failures = []

    class RenderErrors(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.ERROR:
                failures.append(record.getMessage())

    handler = RenderErrors()
    logger = logging.getLogger("weasyprint")
    logger.addHandler(handler)
    try:
        document = HTML(string=html, url_fetcher=embedded_resources)
        pdf = document.write_pdf()
        if failures:
            raise RuntimeError("; ".join(failures))
        return pdf
    finally:
        logger.removeHandler(handler)


if __name__ == "__main__":
    try:
        source = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(source) > 1024 * 1024 or not source.strip():
            raise ValueError("HTML source must be nonempty and at most 1 MiB")
        sys.stdout.buffer.write(render(source.decode("utf-8")))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
