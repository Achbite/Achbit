#!/usr/bin/env python3
"""Delegate macOS packaging from the shared worktree to its Mac development host."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / '.build-cache' / 'macos-build-bridge'
WORKER = BRIDGE / 'worker.json'
PACKAGER = ROOT / 'scripts' / 'package-macos.sh'


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def workspace_path(relative):
    path = (ROOT / relative).resolve()
    path.relative_to(ROOT)
    return path


def finish(directory, request, code, message=''):
    if request.get('transaction'):
        marker = workspace_path(request['transaction']) / 'macos-request'
        if marker.exists() and marker.read_text() == directory.name:
            marker.unlink()
    write_json(directory / 'result.json', {'exitCode': code, 'message': message})


def request_host(operation, shared=None, output=None, timeout=3600):
    if not WORKER.exists():
        raise RuntimeError('Mac host bridge is not running; prepare it with make shell on the host.')
    worker = json.loads(WORKER.read_text())
    directory = Path(tempfile.mkdtemp(prefix='request-', dir=BRIDGE))
    request = {'workerId': worker['workerId'], 'operation': operation,
               'buildKind': os.environ.get('DEEPCODE_BUILD_KIND', 'normal')}
    # Forward the public identity selector explicitly; credentials stay in the host keychain.
    if 'DEEPCODE_MACOS_SIGN_IDENTITY' in os.environ:
        request['signingIdentity'] = os.environ['DEEPCODE_MACOS_SIGN_IDENTITY']
    if operation in ('package', 'computer-use'):
        shared = Path(shared).resolve()
        request.update(
            shared=str(shared.relative_to(ROOT)),
            output=str(Path(output).resolve().relative_to(ROOT)),
            transaction=str(shared.parent.relative_to(ROOT)),
            commit=os.environ['DEEPCODE_BUILD_COMMIT'],
            builtAt=os.environ['DEEPCODE_BUILD_TIME'],
        )
        (shared.parent / 'macos-request').write_text(directory.name)
    log_path = directory / 'output.log'
    log_path.touch()
    write_json(directory / 'request.json', request)
    interrupted = []

    def cancel(signum, _frame):
        if not interrupted:
            interrupted.append(signum)
            (directory / 'cancel').touch()

    handlers = {sig: signal.signal(sig, cancel) for sig in (signal.SIGINT, signal.SIGTERM)}
    deadline = time.monotonic() + timeout
    cancellation_deadline = None
    timed_out = False
    result = None
    try:
        with log_path.open('rb') as log:
            while True:
                sys.stdout.buffer.write(log.read())
                sys.stdout.buffer.flush()
                result_path = directory / 'result.json'
                if result_path.exists():
                    result = json.loads(result_path.read_text())
                    sys.stdout.buffer.write(log.read())
                    sys.stdout.buffer.flush()
                    break
                if interrupted or time.monotonic() >= deadline:
                    if cancellation_deadline is None:
                        timed_out = not interrupted
                        (directory / 'cancel').touch()
                        cancellation_deadline = time.monotonic() + 15
                    if time.monotonic() >= cancellation_deadline:
                        raise RuntimeError(
                            f'Mac host did not acknowledge cancellation; request and staging retained: {directory}'
                        )
                time.sleep(0.2)
        if result['message']:
            print(result['message'], flush=True)
        if interrupted:
            return 128 + interrupted[0]
        if timed_out:
            print(f'Mac host request timed out: {operation}', file=sys.stderr)
            return 124
        return result['exitCode']
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        if result is not None:
            if result['exitCode'] == 0:
                shutil.rmtree(directory)
            else:
                print(f'Mac build log: {log_path}', file=sys.stderr)


def stop_process(process):
    # The packager may have exited while Cargo still owns its output pipe.
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def finish_process(directory, request, child, log, code=None, message=''):
    try:
        stop_process(child)
    except OSError as error:
        status = child.poll()
        status = 1 if status in (None, 0) else status if status > 0 else 128 - status
        # Retain the transaction marker: cleanup did not acknowledge quiescence.
        write_json(directory / 'result.json', {
            'exitCode': status, 'message': f'Mac build process cleanup failed: {error}',
        })
        raise
    finally:
        log.close()
    if code is None:
        code = child.returncode if child.returncode >= 0 else 128 - child.returncode
    finish(directory, request, code, message)


def serve(container_id):
    with (BRIDGE / 'worker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        worker_id = uuid.uuid4().hex
        watcher = subprocess.Popen(['docker', 'wait', container_id], stdout=subprocess.DEVNULL)
        worker = {'workerId': worker_id, 'containerId': container_id, 'pid': os.getpid(),
                  'hostOS': platform.system(), 'arch': platform.machine()}
        stopping = []
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda signum, _frame: stopping.append(signum))
        active = None
        stop_requests = []
        try:
            write_json(WORKER, worker)
            while not stopping and watcher.poll() is None:
                if active:
                    directory, request, child, log = active
                    if (directory / 'cancel').exists() or child.poll() is not None:
                        active = None
                        finish_process(directory, request, child, log)
                for pending in sorted(BRIDGE.glob('request-*/request.json')):
                    directory = pending.parent
                    pending.rename(directory / 'running.json')
                    request = json.loads((directory / 'running.json').read_text())
                    operation = request['operation']
                    if request['workerId'] != worker_id:
                        finish(directory, request, 1, 'Mac host worker changed; request was not executed.')
                    elif (directory / 'cancel').exists():
                        finish(directory, request, 130, 'Mac build cancelled before execution.')
                    elif operation == 'probe':
                        finish(directory, request, 0,
                               f"Mac build host ready: {worker['hostOS']}/{worker['arch']}")
                    elif operation == 'stop':
                        stop_requests.append((directory, request))
                        stopping.append(signal.SIGTERM)
                        break
                    elif active:
                        finish(directory, request, 1, 'Another macOS build is active in this worktree.')
                    else:
                        arguments = ['bash', str(PACKAGER)]
                        environment = os.environ.copy()
                        environment['DEEPCODE_BUILD_KIND'] = request.get('buildKind', 'normal')
                        if 'signingIdentity' in request:
                            environment['DEEPCODE_MACOS_SIGN_IDENTITY'] = request['signingIdentity']
                        if operation == 'check':
                            arguments.append('--check')
                        elif operation in ('package', 'computer-use'):
                            arguments.extend([str(workspace_path(request['shared'])) if operation == 'package' else '--computer-use',
                                              str(workspace_path(request['output']))])
                            environment.update(DEEPCODE_BUILD_COMMIT=request['commit'],
                                               DEEPCODE_BUILD_TIME=request['builtAt'])
                        else:
                            finish(directory, request, 1, f'Unknown Mac build operation: {operation}')
                            continue
                        log = (directory / 'output.log').open('wb')
                        try:
                            child = subprocess.Popen(arguments, cwd=ROOT, env=environment,
                                                     stdout=log, stderr=subprocess.STDOUT,
                                                     start_new_session=True)
                        except OSError as error:
                            log.close()
                            finish(directory, request, 1, str(error))
                            continue
                        active = directory, request, child, log
                time.sleep(0.2)
        finally:
            try:
                if active:
                    finish_process(*active, code=130, message='Mac build stopped with its host bridge.')
            finally:
                try:
                    if watcher.poll() is None:
                        watcher.terminate()
                    watcher.wait()
                finally:
                    WORKER.unlink(missing_ok=True)
    # A stop reply means the worker has released its process lock as well.
    for directory, request in stop_requests:
        finish(directory, request, 0)


def container_identity(container, workdir):
    info = subprocess.check_output(
        ['docker', 'inspect', '--format',
         '{{.Id}}\n{{.State.Running}}\n{{json .Mounts}}', container], text=True
    ).splitlines()
    mounted = next((mount['Source'] for mount in json.loads(info[2])
                    if mount['Destination'] == workdir and mount['Type'] == 'bind'), None)
    if info[1] != 'true' or mounted is None or Path(mounted).resolve() != ROOT:
        raise RuntimeError('Mac bridge requires the running container mounted to this worktree.')
    return info[0]


def ensure(container, workdir):
    if platform.system() != 'Darwin':
        raise RuntimeError('The Mac build bridge must be prepared by the macOS development host.')
    container_id = container_identity(container, workdir)
    BRIDGE.mkdir(parents=True, exist_ok=True)
    with (BRIDGE / 'startup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with (BRIDGE / 'worker.lock').open('a') as worker_lock:
            try:
                fcntl.flock(worker_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                worker = json.loads(WORKER.read_text())
                # Only the host checks its process lock. Container readiness uses a fresh reply.
                if request_host('probe', timeout=3) != 0:
                    raise RuntimeError('Mac build bridge did not respond.')
                if worker['containerId'] == container_id:
                    return
                if request_host('stop', timeout=3) != 0:
                    raise RuntimeError('Could not stop the previous Mac build bridge.')
                fcntl.flock(worker_lock, fcntl.LOCK_EX)
            WORKER.unlink(missing_ok=True)
        with (BRIDGE / 'worker.log').open('ab') as log:
            child = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), 'serve', '--container', container_id],
                cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        deadline = time.monotonic() + 10
        while not WORKER.exists():
            if child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError(f'Mac build bridge did not start; see {BRIDGE / "worker.log"}')
            time.sleep(0.1)
        if request_host('probe', timeout=3) != 0:
            raise RuntimeError('Mac build bridge did not respond.')


def stop():
    if not WORKER.exists():
        return 0
    if platform.system() == 'Darwin':
        with (BRIDGE / 'worker.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return request_host('stop', timeout=5)
            WORKER.unlink(missing_ok=True)
            return 0
    return request_host('stop', timeout=5)


def cancel_package(shared):
    marker = Path(shared).resolve().parent / 'macos-request'
    try:
        request_id = marker.read_text()
        directory = BRIDGE / request_id
        (directory / 'cancel').touch()
    except FileNotFoundError:
        # The host or request client may finish while the build enters its exit handler.
        return 0
    deadline = time.monotonic() + 15
    while marker.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError(f'Mac build exit is unconfirmed; staging retained: {marker.parent}')
        time.sleep(0.2)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['ensure', 'serve', 'stop', 'check', 'package', 'computer-use', 'cancel'])
    parser.add_argument('--container', default=os.environ.get('CONTAINER_NAME', 'deepcode-dev'))
    parser.add_argument('--workdir', default=os.environ.get('WORKDIR_IN_CTNR', '/workspace'))
    parser.add_argument('--shared')
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.operation == 'ensure':
        ensure(args.container, args.workdir)
    elif args.operation == 'serve':
        serve(args.container)
    elif args.operation == 'stop':
        return stop()
    elif args.operation == 'cancel':
        if not args.shared:
            parser.error('cancel requires --shared')
        return cancel_package(args.shared)
    elif args.operation == 'check':
        if not WORKER.exists() and os.environ.get('DEEPCODE_BUILD_HOST_OS') != 'Darwin':
            print('No macOS build host is registered for this worktree.')
            return 3
        return request_host('check', timeout=15)
    else:
        if not args.shared or not args.output:
            parser.error('package requires --shared and --output')
        return request_host(args.operation, args.shared, args.output)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f'==[build][macos][error]== {error}', file=sys.stderr)
        sys.exit(1)
