#!/usr/bin/env python3
"""Replace the single GUI resource directory with a complete current build."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from macos_signing import require_same_identity, sign_app, signing_identity


def replace_ui(source, target, app=None):
    source, target = source.resolve(), target.resolve()
    if not (source / 'index.html').is_file():
        raise ValueError(f'GUI index.html is missing: {source}')
    if source == target or source in target.parents or target in source.parents:
        raise ValueError('UI source and destination must be separate directories.')
    identity = signing_identity() if app else None
    if app:
        require_same_identity(app, identity)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Keep staging outside the App resource seal.
    scratch = Path(tempfile.mkdtemp(prefix='.ui-update-', dir=app.parent if app else target.parent))
    next_ui, previous = scratch / 'next', scratch / 'previous'
    installed = False
    try:
        shutil.copytree(source, next_ui)
        if target.exists():
            target.rename(previous)
        next_ui.rename(target)
        installed = True
        if app:
            sign_app(app, identity)
    except BaseException:
        if installed:
            shutil.rmtree(target)
        if previous.exists():
            previous.rename(target)
            if app:
                sign_app(app, identity)
        raise
    else:
        if previous.exists():
            shutil.rmtree(previous)
    finally:
        # Preserve the original assets if restoration itself failed.
        if not previous.exists():
            shutil.rmtree(scratch)
    print(f'GUI resources published: {target}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, default=Path(__file__).resolve().parents[1] / 'bin/ui/web-deepcode-gui')
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument('--package', type=Path, help='Existing platform directory or DeepCode-GUI.app')
    destination.add_argument('--output', type=Path, help='Publish a standalone built UI directory')
    args = parser.parse_args()
    app = None
    if args.package:
        package = args.package.resolve()
        app = package if package.suffix == '.app' else package / 'DeepCode-GUI.app'
        if app.is_dir():
            target = app / 'Contents/Resources/web-deepcode-gui'
        else:
            app = None
            target = package / 'web-deepcode-gui'
        if not target.is_dir():
            parser.error(f'Packaged GUI resources are missing: {target}')
    else:
        target = args.output
    try:
        replace_ui(args.assets, target, app)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'UI update failed: {error}', file=sys.stderr)
        return 1
    if args.package:
        print('Reload the GUI interface (Cmd/Ctrl+Shift+R or browser.page refreshInterface) to load this UI bundle.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
