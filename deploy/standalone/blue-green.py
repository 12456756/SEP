#!/usr/bin/env python3
"""First isolated-data blue/green release from the retained green installation."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import quote


SOURCE = Path(__file__).resolve().parents[2]
ROOT = Path('/www/sep')
OLD_BACKEND = 'sep-green-backend'
OLD_WEB = 'sep-green-web'
OLD_DB = 'sep-postgres'
OLD_REDIS = 'sep-redis'
SHARED_NETWORK = 'sep-migration-net'
TAG_PATTERN = r'[a-f0-9]{12}(?:-[a-f0-9]{12})?'
LOG_PATH = None
EXPECTED_TABLES = {
    'enterprise_compute_bindings', 'enterprise_compute_credentials',
    'compute_integration_jobs', 'compute_integration_settlements',
    'compute_integration_transfers', 'compute_integration_executions',
    'compute_integration_reconciliations', 'compute_balance_sync_states',
    'compute_balance_events', 'compute_password_syncs', 'compute_credential_rotations',
}


def run(*args, data=None, output=None):
    result = subprocess.run([str(x) for x in args], input=data, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE)
    if result.returncode:
        if LOG_PATH:
            with open(LOG_PATH, 'ab') as stream:
                os.chmod(LOG_PATH, 0o600)
                stream.write(result.stdout or b'')
                stream.write(result.stderr or b'')
        # Command arguments and stderr can contain credentials. Keep them in neither CI nor chat.
        raise RuntimeError(f'{args[0]} {args[1] if len(args) > 1 else ""} failed (exit {result.returncode}); inspect private operations.log')
    return result.stdout.decode() if result.stdout is not None else ''


def save(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with open(temporary, 'x', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
    os.replace(temporary, path)


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]


def sql(container, query):
    return run('docker', 'exec', '-i', container, 'psql', '-X', '-U', 'sep_admin', '-d',
               'sep_prod', '-v', 'ON_ERROR_STOP=1', '-At', data=query.encode())


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def migration_hash(source=SOURCE):
    digest = hashlib.sha256()
    for path in sorted((source / 'backend/prisma').rglob('*')):
        if path.is_file():
            digest.update(path.relative_to(source).as_posix().encode())
            digest.update(path.read_bytes().replace(b'\r\n', b'\n'))
    return digest.hexdigest()


def verify_migrations(rows, directory):
    expected = {}
    for path in directory.iterdir():
        if not path.is_dir():
            continue
        raw = (path / 'migration.sql').read_bytes()
        lf = raw.replace(b'\r\n', b'\n')
        expected[path.name] = {hashlib.sha256(data).hexdigest() for data in (raw, lf, lf.replace(b'\n', b'\r\n'))}
    completed = {}
    for row in rows:
        if not row['rolledBack']:
            if not row['done']:
                raise RuntimeError('Unresolved candidate migration')
            completed[row['name']] = row['checksum']
    if set(completed) != set(expected) or any(checksum not in expected[name] for name, checksum in completed.items()):
        raise RuntimeError('Migration names or checksums differ from the release')
    return len(expected)


def schema_columns(container):
    query = """BEGIN READ ONLY;
SELECT json_build_object('table', table_name, 'columns', json_agg(column_name ORDER BY ordinal_position))
FROM information_schema.columns WHERE table_schema='public' AND table_name IN
(SELECT tablename FROM pg_tables WHERE schemaname='public') GROUP BY table_name ORDER BY table_name;
COMMIT;"""
    return [json.loads(line) for line in sql(container, query).splitlines() if line.startswith('{')]


def audit(container, columns):
    result = {}
    for table in columns:
        # Project only original columns: additive DDL must not change any original business value.
        fields = ','.join(identifier(column) + '::text' for column in table['columns'])
        expression = f'jsonb_build_array({fields})::text'
        query = 'SET TimeZone=\'UTC\'; SET DateStyle=\'ISO,YMD\'; '
        query += f'COPY (SELECT {expression} FROM public.{identifier(table["table"])} ORDER BY {expression} COLLATE "C") TO STDOUT;'
        digest = hashlib.sha256()
        process = subprocess.Popen(['docker', 'exec', container, 'psql', '-X', '-q', '-U',
                                    'sep_admin', '-d', 'sep_prod', '-v', 'ON_ERROR_STOP=1', '-c', query],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        count = 0
        for line in process.stdout:
            digest.update(line)
            count += 1
        process.stdout.close()
        if process.wait():
            raise RuntimeError(f'Data audit failed: {table["table"]}')
        result[table['table']] = {'rows': count, 'sha256': digest.hexdigest()}
    return result


def compare_audits(before, after, migrated=False):
    for table, expected in before.items():
        if migrated and table == '_prisma_migrations':
            continue
        if after.get(table) != expected:
            raise RuntimeError(f'Original data changed: {table}')


def render_caddy(original, template, maintenance=False):
    begin, end = '# LONGDAO-AI-BEGIN', '# LONGDAO-AI-END'
    if original.count(begin) != 1 or original.count(end) != 1:
        raise RuntimeError('Cannot identify the independently managed AI site')
    start = original.index(begin)
    finish = original.index(end, start) + len(end)
    # Preserve all sites outside the SEP block verbatim, including trailing sites.
    tail = original[start:]
    if end not in original[start:finish]:
        raise RuntimeError('Invalid AI block')
    if maintenance:
        sep = '''sep.longdaoec.com {
    handle /sep-client/* { reverse_proxy sep-downloads:80 }
    handle {
        header Retry-After 60
        respond "SEP is updating. Please retry shortly." 503
    }
}
'''
    else:
        sep = template.replace('sep-green-backend', 'sep-blue-backend').replace('sep-green-web', 'sep-blue-web')
        if 'sep-green-' in sep or 'sep-blue-backend:3001' not in sep or 'sep-blue-web:3000' not in sep:
            raise RuntimeError('Incomplete candidate routing')
    return sep + '\n' + tail


def restore_caddy(original, current):
    # Restore only SEP routing; another platform may have updated its site meanwhile.
    render_caddy(current, '', maintenance=True)
    return original.split('# LONGDAO-AI-BEGIN', 1)[0] + current[current.index('# LONGDAO-AI-BEGIN'):]


def private_env(path):
    values = {}
    if not path.exists():
        return values
    if path.stat().st_mode & 0o077:
        raise RuntimeError('Compute configuration must have mode 600')
    for line in path.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or not re.fullmatch(r'COMPUTE_[A-Z0-9_]+', key):
            raise RuntimeError('Invalid compute configuration entry')
        values[key] = value
    return values


def compose_escape(value):
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, dict):
        return {key: compose_escape(item) for key, item in value.items()}
    if isinstance(value, list):
        return [compose_escape(item) for item in value]
    return value


def require_compute_setup(values):
    required = ('COMPUTE_API_ORIGIN', 'COMPUTE_SIGNING_KEY_ID', 'COMPUTE_SIGNING_PRIVATE_KEY_FILE',
                'COMPUTE_ENCRYPTION_KEY_ID', 'COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES')
    if values.get('COMPUTE_INTEGRATION_ENABLED') != 'true' or any(not values.get(key) for key in required):
        raise RuntimeError('Compute platform deployment and production integration configuration are required before maintenance')
    if values['COMPUTE_API_ORIGIN'] != 'https://ai.longdaoec.com':
        raise RuntimeError('Unexpected production compute origin')
    try:
        files = json.loads(values['COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES'])
        paths = [values['COMPUTE_SIGNING_PRIVATE_KEY_FILE'], files[values['COMPUTE_ENCRYPTION_KEY_ID']]]
        for value in paths:
            relative = Path(value).relative_to('/run/sep-compute')
            host = (ROOT / 'secrets/compute' / relative).resolve()
            host.relative_to((ROOT / 'secrets/compute').resolve())
            if not host.is_file():
                raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise RuntimeError('Production compute keys are missing or outside the dedicated secret mount') from None


def file_audit(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('Business storage contains a symlink; review before migration')
        if not path.is_file():
            continue
        digest = hashlib.sha256()
        with open(path, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        result[path.relative_to(root).as_posix()] = {'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}
    return result


class Release:
    def __init__(self, tag, phase):
        if not re.fullmatch(TAG_PATTERN, tag) or phase not in ('rehearsal', 'final'):
            raise ValueError('Invalid release identity')
        self.tag, self.phase = tag, phase
        self.path = ROOT / 'blue-green' / tag / phase
        self.name = 'sep-bg-' + tag + '-' + phase
        self.db = self.name + '-postgres'
        self.redis = self.name + '-redis'
        self.state_path = self.path / 'state.json'

    def state(self):
        return load(self.state_path)

    def mark(self, **changes):
        state = self.state()
        state.update(changes)
        save(self.state_path, state)

    def compose(self, *args):
        return run('docker', 'compose', '--project-name', self.name, '-f', self.path / 'compose.json', *args)

    def lifecycle(self, function, target):
        if function not in ('drain_gateway', 'signal_and_wait_stopped', 'restart_target'):
            raise ValueError('Unsupported lifecycle action')
        script = 'SEP_DEPLOY_LIBRARY=true source "$1/deploy/production/sep-deploy.sh"; '
        script += 'STATE_DIR=/www/sep/.deploy; ' + function + ' "$2"'
        run('bash', '-Eeuo', 'pipefail', '-c', script, 'lifecycle', SOURCE, target)

    def wait(self, name):
        for _ in range(90):
            state = inspect(name)['State']
            if state.get('Health', {}).get('Status') == 'healthy':
                return
            if state['Status'] in ('exited', 'dead'):
                break
            time.sleep(2)
        raise RuntimeError('Container not healthy: ' + name)

    def caddy(self, text):
        candidate = self.path / 'Caddyfile.validate'
        candidate.write_text(text)
        run('docker', 'cp', candidate, 'sep-caddy:/tmp/sep-bg-validate.caddy')
        run('docker', 'exec', 'sep-caddy', 'caddy', 'validate', '--config', '/tmp/sep-bg-validate.caddy', '--adapter', 'caddyfile')
        # Keep the inode because the edge container bind-mounts this file.
        (ROOT / 'deploy/Caddyfile').write_text(text)
        run('docker', 'exec', 'sep-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile')

    def preflight(self):
        if os.geteuid() != 0:
            raise RuntimeError('Run on the SEP server as root')
        if (ROOT / '.deploy/active-blue-green').exists():
            raise RuntimeError('An isolated release is already active; do not overwrite it')
        if 'sep-green-web:3000' not in (ROOT / 'deploy/Caddyfile').read_text():
            raise RuntimeError('This transition requires the retained green installation')
        for name in (OLD_DB, OLD_REDIS, OLD_BACKEND, OLD_WEB):
            if inspect(name)['State'].get('Health', {}).get('Status') != 'healthy':
                raise RuntimeError('Source service is not healthy: ' + name)
        if shutil.disk_usage(ROOT).free < 10 * 1024 ** 3:
            raise RuntimeError('Less than 10 GiB free on the data disk')
        if sql(OLD_DB, 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;').strip() != '0':
            raise RuntimeError('Unresolved source migration')
        if self.path.exists():
            raise RuntimeError('Release directory exists; retain it and use a new release tag')
        if self.phase == 'final':
            require_compute_setup(private_env(ROOT / 'deploy/compute-integration.env'))
            rehearsal = Release(self.tag, 'rehearsal').state()
            if rehearsal.get('status') != 'verified' or rehearsal.get('migrationHash') != migration_hash():
                raise RuntimeError('A matching successful migration rehearsal is required')
            names = run('docker', 'container', 'ls', '-a', '--format', '{{.Names}}').splitlines()
            if 'sep-blue-backend' in names or 'sep-blue-web' in names:
                raise RuntimeError('Retained blue containers already exist; never overwrite them')

    def create(self, images):
        global LOG_PATH
        self.path.mkdir(parents=True, mode=0o700)
        LOG_PATH = self.path / 'operations.log'
        save(self.state_path, {'tag': self.tag, 'phase': self.phase, 'status': 'created',
                              'migrationHash': migration_hash(), 'source': str(SOURCE),
                              'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                              'oldImages': {name: inspect(name)['Image'] for name in (OLD_BACKEND, OLD_WEB)}})
        backend = inspect(OLD_BACKEND)
        old_env = dict(item.split('=', 1) for item in backend['Config']['Env'])
        integration = private_env(ROOT / 'deploy/compute-integration.env')
        old_env.update(integration)
        admin_password, app_password = secrets.token_hex(32), secrets.token_hex(32)
        database_host, redis_host = self.db, self.redis
        base = f'postgresql://sep_admin:{quote(admin_password)}@{database_host}:5432/sep_prod?schema=public'
        app = f'postgresql://sep_app:{quote(app_password)}@{database_host}:5432/sep_prod?schema=public'
        log = {'driver': 'json-file', 'options': {'max-size': '20m', 'max-file': '3'}}
        pg = inspect(OLD_DB)
        pg_env = dict(item.split('=', 1) for item in pg['Config']['Env'])
        services = {
            'postgres': {'image': pg['Image'], 'container_name': self.db, 'restart': 'unless-stopped',
                         'environment': {'POSTGRES_USER': 'sep_admin', 'POSTGRES_PASSWORD': admin_password,
                                         'POSTGRES_DB': 'sep_prod', 'PGDATA': pg_env['PGDATA']},
                         'volumes': [f'{self.path}/postgres:{pg_env["PGDATA"]}'], 'networks': ['private'],
                         'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U sep_admin -d sep_prod'], 'interval': '2s', 'retries': 60}, 'logging': log},
            'redis': {'image': inspect(OLD_REDIS)['Image'], 'container_name': self.redis,
                      'restart': 'unless-stopped', 'command': ['redis-server', '--appendonly', 'no'],
                      'volumes': [f'{self.path}/redis:/data'], 'networks': ['private'],
                      'healthcheck': {'test': ['CMD', 'redis-cli', 'ping'], 'interval': '2s', 'retries': 60}, 'logging': log},
            'migrator': {'image': images['migrator'], 'profiles': ['tools'], 'restart': 'no',
                         'environment': {'DATABASE_URL': base}, 'networks': ['private'],
                         'volumes': [f'{SOURCE}/backend/prisma:/release-prisma:ro'],
                         'entrypoint': ['sh', '-ec'],
                         'command': ['cd /app/backend; pnpm exec prisma migrate deploy --schema /release-prisma/schema.prisma'], 'logging': log},
        }
        if self.phase == 'final':
            mounts = []
            for mount in backend['Mounts']:
                original = Path(mount['Source'])
                relative = original.relative_to(ROOT)
                if relative.parts[0] in ('uploads', 'packages', 'knowledge') and mount['RW']:
                    mounts.append(f'{self.path / "files" / relative}:{mount["Destination"]}')
                elif not mount['RW']:
                    mounts.append(f'{original}:{mount["Destination"]}:ro')
                else:
                    raise RuntimeError('Unrecognized writable application mount')
            secret_dir = ROOT / 'secrets/compute'
            if secret_dir.is_dir():
                mounts.append(f'{secret_dir}:/run/sep-compute:ro')
            old_env.update(DATABASE_URL=app, REDIS_URL=f'redis://{redis_host}:6379/1')
            # A missing integration never silently inherits a legacy model credential.
            old_env['COMPUTE_INTEGRATION_ENABLED'] = integration.get('COMPUTE_INTEGRATION_ENABLED', 'false')
            services['backend'] = {'image': images['backend'], 'container_name': 'sep-blue-backend',
                                   'restart': 'unless-stopped', 'environment': old_env, 'volumes': mounts,
                                   'ports': ['127.0.0.1:13001:3001'], 'networks': ['private', 'shared'],
                                   'depends_on': {'postgres': {'condition': 'service_healthy'}, 'redis': {'condition': 'service_healthy'}},
                                   'healthcheck': backend['Config']['Healthcheck'], 'logging': log}
            # docker inspect reports nanoseconds; Compose JSON expects duration strings.
            services['backend']['healthcheck'] = {'test': ['CMD', 'node', '-e',
                "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                'interval': '5s', 'timeout': '5s', 'retries': 36}
            services['web'] = {'image': images['web'], 'container_name': 'sep-blue-web', 'restart': 'unless-stopped',
                               'environment': {'NODE_ENV': 'production', 'API_ORIGIN': 'http://sep-blue-backend:3001'},
                               'ports': ['127.0.0.1:13000:3000'], 'networks': ['private', 'shared'],
                               'depends_on': {'backend': {'condition': 'service_healthy'}},
                               'healthcheck': {'test': ['CMD', 'node', '-e',
                                   "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                                   'interval': '5s', 'timeout': '5s', 'retries': 36}, 'logging': log}
        document = {'services': services, 'networks': {'private': {'internal': True}}}
        if self.phase == 'final':
            document['networks']['shared'] = {'external': True, 'name': SHARED_NETWORK}
        save(self.path / 'compose.json', compose_escape(document))
        save(self.path / 'database-identity.json', {'appPassword': app_password})
        self.compose('config', '-q')

    def backup(self, final=False):
        self.mark(status='backup')
        columns = schema_columns(OLD_DB)
        save(self.path / 'original-columns.json', columns)
        if final:
            sessions = sql(OLD_DB, "SELECT count(*) FROM pg_stat_activity WHERE datname='sep_prod' AND pid<>pg_backend_pid();")
            if sessions.strip() != '0':
                raise RuntimeError('Source database still has client connections')
            save(self.path / 'source-audit.json', audit(OLD_DB, columns))
        with open(self.path / 'database.dump', 'xb') as stream:
            os.chmod(stream.name, 0o600)
            run('docker', 'exec', OLD_DB, 'pg_dump', '-U', 'sep_admin', '-d', 'sep_prod', '-Fc', output=stream)
        run('docker', 'exec', '-i', OLD_DB, 'pg_restore', '-l', data=(self.path / 'database.dump').read_bytes())
        if final:
            files = self.path / 'files'
            files.mkdir(mode=0o700)
            for directory in ('uploads', 'packages', 'knowledge'):
                run('cp', '-a', ROOT / directory, files / directory)
                original_files = file_audit(ROOT / directory)
                if file_audit(files / directory) != original_files:
                    raise RuntimeError('Business file copy differs: ' + directory)
                save(self.path / (directory + '-audit.json'), original_files)
            redis = self.path / 'redis'
            redis.mkdir(mode=0o700)
            run('docker', 'exec', OLD_REDIS, 'redis-cli', '--rdb', '/tmp/sep-bg-' + self.tag + '.rdb')
            run('docker', 'cp', OLD_REDIS + ':/tmp/sep-bg-' + self.tag + '.rdb', redis / 'dump.rdb')
            # Keep Redis backup separate from the candidate's live persistence file.
            shutil.copy2(redis / 'dump.rdb', self.path / 'redis-backup.rdb')
            run('docker', 'exec', OLD_REDIS, 'rm', '/tmp/sep-bg-' + self.tag + '.rdb')
            run('docker', 'run', '--rm', '--network', 'none', '--user', '0:0', '-v', f'{redis}:/data',
                '--entrypoint', 'sh', inspect(OLD_REDIS)['Image'], '-ec', 'chown -R redis:redis /data')
        checksums = {}
        for filename in ('database.dump', 'redis-backup.rdb'):
            path = self.path / filename
            if path.exists():
                digest = hashlib.sha256()
                with open(path, 'rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                checksums[filename] = digest.hexdigest()
        save(self.path / 'backup-checksums.json', checksums)

    def restore_and_migrate(self):
        self.mark(status='restore')
        self.compose('up', '-d', 'postgres')
        self.wait(self.db)
        with open(self.path / 'database.dump', 'rb') as stream:
            result = subprocess.run(['docker', 'exec', '-i', self.db, 'pg_restore', '-U', 'sep_admin',
                                     '-d', 'sep_prod', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'],
                                    stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode:
            (self.path / 'restore-error.log').write_bytes(result.stderr)
            raise RuntimeError('Database restore failed; source database is unchanged')
        password = load(self.path / 'database-identity.json')['appPassword']
        sql(self.db, f"CREATE ROLE sep_app LOGIN PASSWORD '{password}';")
        columns = load(self.path / 'original-columns.json')
        before = audit(self.db, columns)
        save(self.path / 'restored-audit.json', before)
        if (self.path / 'source-audit.json').exists():
            compare_audits(load(self.path / 'source-audit.json'), before)
        self.mark(status='migrate')
        self.compose('--profile', 'tools', 'run', '--rm', '--no-deps', '-T', 'migrator')
        after = audit(self.db, columns)
        compare_audits(before, after, migrated=True)
        save(self.path / 'migrated-audit.json', after)
        tables = {item['table'] for item in schema_columns(self.db)}
        if not EXPECTED_TABLES <= tables:
            raise RuntimeError('New compute tables are missing')
        rows = sql(self.db, "SELECT json_build_object('name',migration_name,'checksum',checksum,'done',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) FROM _prisma_migrations;")
        migration_count = verify_migrations([json.loads(line) for line in rows.splitlines()], SOURCE / 'backend/prisma/migrations')
        verify = (SOURCE / 'deploy/production/postgres/verify-knowledge-schema.sql').read_bytes()
        sql(self.db, 'BEGIN READ ONLY;\n' + verify.decode() + '\nCOMMIT;')
        sql(self.db, '''GRANT CONNECT ON DATABASE sep_prod TO sep_app;
GRANT USAGE ON SCHEMA public TO sep_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sep_app;
REVOKE ALL ON TABLE public._prisma_migrations FROM sep_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO sep_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sep_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sep_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sep_admin IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO sep_app;''')
        self.mark(status='verified', originalTableCount=len(columns), migrationCount=migration_count)
        print(f'{self.phase}: all {len(columns)} original tables verified; migrations and pgvector verified', flush=True)

    def freeze(self):
        original = (ROOT / 'deploy/Caddyfile').read_text()
        (self.path / 'Caddyfile.original').write_text(original)
        (ROOT / '.deploy/isolated-release').write_text(self.tag + '\n')
        self.mark(status='freezing')
        self.caddy(render_caddy(original, '', maintenance=True))
        status = run('curl', '--noproxy', '*', '--resolve', 'sep.longdaoec.com:443:127.0.0.1', '-sS',
                     '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}', 'https://sep.longdaoec.com/')
        if status != '503':
            raise RuntimeError('Maintenance route was not applied')
        self.lifecycle('drain_gateway', OLD_BACKEND)
        self.lifecycle('signal_and_wait_stopped', OLD_BACKEND)
        self.lifecycle('signal_and_wait_stopped', OLD_WEB)
        pending = run('docker', 'exec', OLD_REDIS, 'redis-cli', '-n', '1', '--raw', 'EVAL',
            'local n=0; for _,q in ipairs({"task-execution","knowledge-version-processing"}) do '
            'for _,s in ipairs({"wait","active","paused"}) do n=n+redis.call("LLEN","bull:"..q..":"..s) end; '
            'for _,s in ipairs({"delayed","prioritized","waiting-children"}) do n=n+redis.call("ZCARD","bull:"..q..":"..s) end end; return n', '0')
        if pending.strip() != '0':
            raise RuntimeError('Pending queues must finish before migration')

    def check_app(self):
        for name, url in [('sep-blue-backend', 'http://127.0.0.1:3001/api/health/ready'),
                          ('sep-blue-web', 'http://127.0.0.1:3000/'),
                          ('sep-blue-web', 'http://127.0.0.1:3000/api/health')]:
            run('docker', 'exec', name, 'node', '-e',
                "fetch(process.argv[1],{signal:AbortSignal.timeout(15000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", url)

    def start_candidate(self):
        self.compose('up', '-d', 'redis')
        self.wait(self.redis)
        run('docker', 'exec', self.redis, 'redis-cli', 'CONFIG', 'SET', 'appendonly', 'yes')
        for _ in range(90):
            persistence = run('docker', 'exec', self.redis, 'redis-cli', '--raw', 'INFO', 'persistence')
            if 'aof_rewrite_in_progress:0' in persistence and 'aof_last_bgrewrite_status:ok' in persistence:
                break
            time.sleep(2)
        else:
            raise RuntimeError('Candidate Redis AOF initialization failed')
        config = load(self.path / 'compose.json')
        config['services']['redis']['command'] = ['redis-server', '--appendonly', 'yes']
        save(self.path / 'compose.json', config)
        self.compose('up', '-d', 'redis')
        self.wait(self.redis)
        self.compose('up', '-d', 'backend', 'web')
        self.wait('sep-blue-backend')
        self.wait('sep-blue-web')
        self.check_app()

    def rollback(self):
        state = self.state()
        if self.phase != 'final' or not (self.path / 'Caddyfile.original').exists():
            raise RuntimeError('No frozen environment to roll back')
        original = (self.path / 'Caddyfile.original').read_text()
        self.caddy(render_caddy((ROOT / 'deploy/Caddyfile').read_text(), '', maintenance=True))
        names = run('docker', 'container', 'ls', '-a', '--format', '{{.Names}}').splitlines()
        if 'sep-blue-backend' in names:
            backend = inspect('sep-blue-backend')
            if backend['Config'].get('Labels', {}).get('com.docker.compose.project') != self.name:
                raise RuntimeError('Candidate ownership mismatch')
            if backend['State']['Running']:
                self.lifecycle('drain_gateway', 'sep-blue-backend')
                self.lifecycle('signal_and_wait_stopped', 'sep-blue-backend')
        if 'sep-blue-web' in names:
            if inspect('sep-blue-web')['Config'].get('Labels', {}).get('com.docker.compose.project') != self.name:
                raise RuntimeError('Candidate web ownership mismatch')
            self.lifecycle('signal_and_wait_stopped', 'sep-blue-web')
        for name, image in state['oldImages'].items():
            if inspect(name)['Image'] != image:
                raise RuntimeError('Retained source container changed')
        self.lifecycle('restart_target', OLD_WEB)
        self.caddy(restore_caddy(original, (ROOT / 'deploy/Caddyfile').read_text()))
        self.mark(status='rolled-back')
        active = ROOT / '.deploy/active-blue-green'
        if active.exists() and active.read_text().strip() == self.tag:
            active.unlink()
        isolated = ROOT / '.deploy/isolated-release'
        if isolated.exists() and isolated.read_text().strip() == self.tag:
            isolated.unlink()
        print('Original program, database, Redis and files restored; candidate data retained privately', flush=True)


def old_migrator():
    for line in (ROOT / 'deploy/release.env').read_text().splitlines():
        if line.startswith('SEP_MIGRATOR_IMAGE='):
            return line.split('=', 1)[1]
    raise RuntimeError('Current migrator image is not recorded')


def build_images(tag):
    global LOG_PATH
    LOG_PATH = ROOT / 'tmp' / ('blue-green-build-' + tag + '.private.log')
    LOG_PATH.parent.mkdir(mode=0o700, exist_ok=True)
    images = {'backend': 'sep-blue-backend:' + tag, 'web': 'sep-blue-web:' + tag, 'migrator': 'sep-migrator:' + tag}
    names = run('docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}').splitlines()
    if any(image in names for image in images.values()):
        raise RuntimeError('Immutable candidate image already exists')
    backend, web, migrator = inspect(OLD_BACKEND)['Config']['Image'], inspect(OLD_WEB)['Config']['Image'], old_migrator()
    for target, name in [('migrator', images['migrator']), ('runner', images['backend'])]:
        print('Building ' + target, flush=True)
        run('docker', 'build', '--pull=false', '--build-arg', 'SEP_BUILDER_BASE_IMAGE=' + migrator,
            '--build-arg', 'SEP_RUNNER_BASE_IMAGE=' + backend,
            '--build-arg', 'SEP_NODE_RUNTIME_IMAGE=' + web, '--target', target,
            '-f', SOURCE / 'deploy/standalone/Dockerfile.backend-release', '-t', name, SOURCE)
    print('Building paired web image', flush=True)
    run('docker', 'build', '--pull=false', '--network=none', '--build-arg', 'SEP_WEB_BASE_IMAGE=' + web,
        '--build-arg', 'SEP_BACKEND_MODULES_IMAGE=' + images['migrator'],
        '--build-arg', 'SEP_API_ORIGIN=http://sep-blue-backend:3001',
        '-f', SOURCE / 'deploy/standalone/Dockerfile.web-domain', '-t', images['web'], SOURCE)
    return images


def execute(action, tag):
    global LOG_PATH
    release = Release(tag, 'rehearsal' if action == 'rehearse' else 'final')
    if action == 'status' and not release.state_path.exists():
        release = Release(tag, 'rehearsal')
    if release.path.is_dir():
        LOG_PATH = release.path / 'operations.log'
    if action in ('rehearse', 'stage'):
        release.preflight()
        images = build_images(tag) if action == 'stage' else {'migrator': old_migrator()}
        release.create(images)
        try:
            if action == 'stage':
                release.freeze()
            release.backup(final=action == 'stage')
            release.restore_and_migrate()
            if action == 'stage':
                release.start_candidate()
                release.mark(status='awaiting-acceptance')
                print('Candidate ready privately on 127.0.0.1:13000; public site remains in maintenance', flush=True)
        except BaseException:
            release.mark(failed=True)
            if action == 'stage' and (release.path / 'Caddyfile.original').exists():
                release.rollback()
            raise
        finally:
            if action == 'rehearse':
                release.compose('stop', 'postgres')
    elif action == 'activate':
        state = release.state()
        if state['status'] != 'awaiting-acceptance' or state['migrationHash'] != migration_hash():
            raise RuntimeError('Candidate is not awaiting acceptance for this release')
        if any(inspect(name)['State']['Running'] for name in (OLD_BACKEND, OLD_WEB)):
            raise RuntimeError('Old workers must remain stopped')
        release.check_app()
        # This gate must be explicitly saved after checking real account/billing/client workflows.
        acceptance = load(release.path / 'acceptance.json')
        if acceptance != {'tag': tag, 'data': True, 'accounts': True, 'billing': True, 'client': True}:
            raise RuntimeError('Business acceptance is incomplete')
        env = inspect('sep-blue-backend')['Config']['Env']
        if 'COMPUTE_INTEGRATION_ENABLED=true' not in env:
            raise RuntimeError('Enterprise compute integration is not enabled')
        try:
            release.caddy(render_caddy((ROOT / 'deploy/Caddyfile').read_text(), (SOURCE / 'deploy/standalone/Caddyfile').read_text()))
            run('curl', '--noproxy', '*', '--resolve', 'sep.longdaoec.com:443:127.0.0.1', '--fail',
                '--max-time', '20', '-sS', 'https://sep.longdaoec.com/api/health/ready')
            release.mark(status='active')
            (ROOT / '.deploy/active-blue-green').write_text(tag + '\n')
        except BaseException:
            release.rollback()
            raise
    elif action == 'rollback':
        release.rollback()
    else:
        print(json.dumps(release.state(), indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['rehearse', 'stage', 'activate', 'rollback', 'status'])
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    if not re.fullmatch(TAG_PATTERN, args.tag):
        parser.error('tag must be the commit prefix and optional attempt hash')
    os.umask(0o077)
    def interrupted(signum, _frame):
        # Raise through the guarded stage so cancellation also fences and restores the old group.
        raise RuntimeError('Release interrupted by signal ' + str(signum))
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    # Every action shares the existing production deployment lock.
    import fcntl
    with open(ROOT / '.deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute(args.action, args.tag)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
