#!/usr/bin/python3
"""Restricted SSH entrypoint for a dedicated rootless Docker user."""
import datetime
import fcntl
import json
import os
import pwd
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request


def run(args, env, **kwargs):
    return subprocess.run(args, env=env, check=True, timeout=240, **kwargs)


def write_state(destination, value):
    with tempfile.NamedTemporaryFile(mode='w', dir=destination.parent, delete=False, encoding='utf-8') as handle:
        json.dump(value, handle)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, destination)


def main():
    if os.geteuid() == 0 or len(sys.argv) != 2:
        raise ValueError('Invalid deployment invocation')
    command = re.fullmatch(r'deploy (ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}) ([a-f0-9]{40})', sys.argv[1])
    if not command:
        raise ValueError('Only deploy IMAGE@sha256:DIGEST COMMIT is accepted')
    image, revision = command.groups()
    # This file and all paths it names are provisioned by the host administrator.
    config = json.loads(Path('/etc/zhongshu-deploy/config.json').read_text(encoding='utf-8'))
    if image.split('@', 1)[0] != config['image_repository']:
        raise ValueError('Image repository is not authorized on this host')
    state_dir = Path(config['state_directory'])
    if not state_dir.is_dir():
        raise ValueError('Deployment state directory must be initialized first')
    with (state_dir / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # The workflow token is short-lived and scoped to package reads. It never
        # appears in argv or persistent host configuration. Public pulls need {}.
        data = sys.stdin.buffer.read(8193)
        if len(data) > 8192:
            raise ValueError('Registry credential input is too large')
        credential = json.loads(data or b'{}')
        if not isinstance(credential, dict) or set(credential) - {'username', 'token'}:
            raise ValueError('Invalid registry credential input')
        runtime_dir = f'/run/user/{os.geteuid()}'
        with tempfile.TemporaryDirectory(prefix='zhongshu-registry-', dir=runtime_dir) as registry_dir:
            env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': pwd.getpwuid(os.geteuid()).pw_dir,
                   'DOCKER_CONFIG': registry_dir, 'DOCKER_HOST': f'unix://{runtime_dir}/docker.sock',
                   'XDG_RUNTIME_DIR': runtime_dir,
                   'IMAGE': image, 'PORT': str(config['port']), 'BIND_ADDRESS': '127.0.0.1',
                   'MEMORY_LIMIT': '128m', 'CPU_LIMIT': '0.5'}
            token = credential.get('token')
            if token is not None:
                username = credential.get('username', '')
                if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_]{20,2048}', token):
                    raise ValueError('Invalid registry token format')
                if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9_\[\]-]{1,100}', username):
                    raise ValueError('Invalid registry username')
                run(['/usr/bin/docker', 'login', 'ghcr.io', '--username', username, '--password-stdin'],
                    env, input=token.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            run(['/usr/bin/docker', 'pull', image], env)
            label = run(['/usr/bin/docker', 'image', 'inspect', '--format',
                         '{{index .Config.Labels "org.opencontainers.image.revision"}}', image],
                        env, capture_output=True, text=True).stdout.strip()
            if label != revision:
                raise ValueError('Image revision does not match the requested commit')
            compose = ['/usr/bin/docker', 'compose', '--env-file', '/dev/null',
                       '--project-name', config['project_name'], '--file', config['compose_file']]
            current_file = state_dir / 'current.json'
            previous = json.loads(current_file.read_text(encoding='utf-8')) if current_file.exists() else None

            def activate(target_image, expected_revision):
                env['IMAGE'] = target_image
                run(compose + ['up', '-d', '--wait', '--wait-timeout', '60', '--remove-orphans'], env)
                url = f"http://127.0.0.1:{int(config['port'])}/api/version"
                with urllib.request.urlopen(url, timeout=10) as response:
                    metadata = json.load(response)
                if metadata.get('revision') != expected_revision:
                    raise ValueError('Running revision verification failed')

            try:
                activate(image, revision)
            except Exception:
                if previous:
                    activate(previous['image'], previous['revision'])
                    print('Deployment failed; previous application image restored', file=sys.stderr)
                else:
                    run(compose + ['down'], env)
                    print('Initial deployment failed; failed application removed', file=sys.stderr)
                raise
            if previous:
                write_state(state_dir / 'previous.json', previous)
            write_state(current_file, {'image': image, 'revision': revision,
                        'deployed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
            print(json.dumps({'status': 'deployed', 'image': image, 'revision': revision}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Avoid reflecting untrusted input or registry credentials into job logs.
        print(f'Deployment failed ({type(error).__name__}); inspect the deployment job and host state.', file=sys.stderr)
        sys.exit(1)
