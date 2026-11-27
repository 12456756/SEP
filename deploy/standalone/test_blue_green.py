import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('blue_green', Path(__file__).with_name('blue-green.py'))
bg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bg)


class DataChecks(unittest.TestCase):
    def test_file_audit_detects_changes_with_unchanged_file_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'skill.py').write_bytes(b'original')
            before = bg.file_audit(root)
            (root / 'skill.py').write_bytes(b'modified')
            after = bg.file_audit(root)
            self.assertEqual(before['skill.py']['bytes'], after['skill.py']['bytes'])
            self.assertNotEqual(before['skill.py']['sha256'], after['skill.py']['sha256'])

    def test_migration_checksum_accepts_only_identical_sql_with_different_line_endings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'migration1').mkdir()
            (root / 'migration1/migration.sql').write_bytes(b'CREATE TABLE example(id TEXT);\r\n')
            row = {'name': 'migration1', 'done': True, 'rolledBack': False,
                   'checksum': hashlib.sha256(b'CREATE TABLE example(id TEXT);\n').hexdigest()}
            self.assertEqual(bg.verify_migrations([row], root), 1)
            row['checksum'] = hashlib.sha256(b'DROP TABLE example;\n').hexdigest()
            with self.assertRaisesRegex(RuntimeError, 'checksums'):
                bg.verify_migrations([row], root)

    def test_unfinished_migration_blocks_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'Unresolved'):
                bg.verify_migrations([{'name': 'failed', 'done': False, 'rolledBack': False}], Path(directory))

    def test_checks_values_not_only_counts(self):
        before = {'wallets': {'rows': 1, 'sha256': 'original'}}
        with self.assertRaisesRegex(RuntimeError, 'wallets'):
            bg.compare_audits(before, {'wallets': {'rows': 1, 'sha256': 'changed'}})

    def test_additive_columns_preserve_original_projection(self):
        before = {'wallets': {'rows': 1, 'sha256': 'same'}, '_prisma_migrations': {'rows': 100}}
        after = {'wallets': {'rows': 1, 'sha256': 'same'}, '_prisma_migrations': {'rows': 115}}
        bg.compare_audits(before, after, migrated=True)
        with self.assertRaisesRegex(RuntimeError, '_prisma_migrations'):
            bg.compare_audits(before, after)

    def test_missing_original_table_fails(self):
        with self.assertRaises(RuntimeError):
            bg.compare_audits({'users': {'rows': 2}}, {})

    def test_invalid_tags_cannot_select_arbitrary_paths(self):
        for tag in ['../green', '/www/sep/postgres', '$(id)', 'abcdef123456;id', '']:
            with self.assertRaises(ValueError):
                bg.Release(tag, 'final')


class RoutingChecks(unittest.TestCase):
    def setUp(self):
        self.original = 'sep.longdaoec.com { reverse_proxy sep-green-web:3000 }\n# LONGDAO-AI-BEGIN\nai.example.com { respond 200 }\n# LONGDAO-AI-END\nother.example.com { respond 200 }\n'
        self.template = (bg.SOURCE / 'deploy/standalone/Caddyfile').read_text(encoding='utf-8')

    def test_switches_all_routes_and_preserves_other_sites(self):
        result = bg.render_caddy(self.original, self.template)
        self.assertNotIn('sep-green-', result)
        self.assertEqual(result.count('sep-blue-backend:3001'), self.template.count('sep-green-backend:3001'))
        for route in ['/ws/*', '/api/skill-import', '/api/gateway/v1/media/video-real/video-references']:
            self.assertIn(route, result)
        self.assertTrue(result.endswith(self.original[self.original.index('# LONGDAO-AI-BEGIN'):]))

    def test_maintenance_keeps_downloads_and_other_sites(self):
        result = bg.render_caddy(self.original, '', maintenance=True)
        self.assertIn('503', result)
        self.assertIn('sep-downloads:80', result)
        self.assertIn('other.example.com', result)
        self.assertNotIn('sep-blue-backend', result)

    def test_missing_site_boundaries_fail(self):
        with self.assertRaises(RuntimeError):
            bg.render_caddy('unknown config', self.template)

    def test_rollback_preserves_independent_site_updates(self):
        updated = self.original.replace('ai.example.com { respond 200 }', 'ai.example.com { respond 201 }')
        result = bg.restore_caddy(self.original, updated)
        self.assertIn('sep-green-web:3000', result)
        self.assertIn('ai.example.com { respond 201 }', result)
        self.assertNotIn('ai.example.com { respond 200 }', result)

    def test_web_build_uses_candidate_backend(self):
        dockerfile = (bg.SOURCE / 'deploy/standalone/Dockerfile.web-domain').read_text()
        self.assertIn('ARG SEP_API_ORIGIN=', dockerfile)
        self.assertIn('ENV API_ORIGIN=${SEP_API_ORIGIN}', dockerfile)


class ConfigurationChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(bg, 'ROOT', self.root)
        self.root_patch.start()
        (self.root / 'deploy').mkdir()

    def tearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()

    def fixture(self, name):
        if name == bg.OLD_BACKEND:
            return {'Image': 'sha256:backend', 'Config': {'Env': ['JWT_SECRET=test-$only', 'DATABASE_URL=old-db',
                'REDIS_URL=old-redis', 'COMPUTE_INTEGRATION_ENABLED=true'], 'Healthcheck': {}},
                'Mounts': [{'Source': str(self.root / directory), 'Destination': destination, 'RW': writable}
                           for directory, destination, writable in [('uploads', '/app/uploads', True),
                              ('packages', '/app/storage/packages', True), ('knowledge', '/app/private/knowledge', True),
                              ('tokenizers', '/app/tokenizers', False)]]}
        if name == bg.OLD_DB:
            return {'Image': 'sha256:pgvector', 'Config': {'Env': ['PGDATA=/var/lib/postgresql/data']}}
        return {'Image': 'sha256:' + name}

    def create(self, phase='final'):
        release = bg.Release('abcdef123456', phase)
        with patch.object(bg, 'inspect', side_effect=self.fixture), patch.object(bg, 'run'):
            release.create({'migrator': 'migrator:v1', 'backend': 'backend:v1', 'web': 'web:v1'})
        return release, bg.load(release.path / 'compose.json')

    def test_database_and_redis_are_private_and_independent(self):
        release, config = self.create()
        for name in ['postgres', 'redis']:
            service = config['services'][name]
            self.assertNotIn('ports', service)
            self.assertEqual(service['networks'], ['private'])
            self.assertTrue(service['volumes'][0].startswith(str(release.path)))
        self.assertTrue(config['networks']['private']['internal'])
        backend = config['services']['backend']
        self.assertIn(release.db, backend['environment']['DATABASE_URL'])
        self.assertIn(release.redis, backend['environment']['REDIS_URL'])
        self.assertEqual(backend['ports'], ['127.0.0.1:13001:3001'])

    def test_all_writable_files_are_copied_but_readonly_assets_reused(self):
        release, config = self.create()
        mounts = config['services']['backend']['volumes']
        for name in ['uploads', 'packages', 'knowledge']:
            self.assertTrue(any(mount.startswith(str(release.path / 'files' / name) + ':') for mount in mounts))
        self.assertIn(str(self.root / 'tokenizers') + ':/app/tokenizers:ro', mounts)

    def test_unknown_writable_mount_is_rejected(self):
        original = self.fixture(bg.OLD_BACKEND)
        original['Mounts'].append({'Source': str(self.root / 'new-data'), 'Destination': '/private/new', 'RW': True})
        fixture = self.fixture
        with patch.object(bg, 'inspect', side_effect=lambda name: original if name == bg.OLD_BACKEND else fixture(name)), patch.object(bg, 'run'):
            with self.assertRaisesRegex(RuntimeError, 'Unrecognized writable'):
                bg.Release('abcdef123456', 'final').create({'migrator': 'm', 'backend': 'b', 'web': 'w'})

    def test_secrets_are_preserved_without_compose_interpolation(self):
        _, config = self.create()
        self.assertEqual(config['services']['backend']['environment']['JWT_SECRET'], 'test-$$only')
        self.assertEqual(config['services']['backend']['environment']['COMPUTE_INTEGRATION_ENABLED'], 'false')

    def test_missing_compute_setup_blocks_before_maintenance(self):
        with self.assertRaisesRegex(RuntimeError, 'before maintenance'):
            bg.require_compute_setup({})

    def test_compute_private_key_cannot_escape_secret_mount(self):
        values = {'COMPUTE_INTEGRATION_ENABLED': 'true', 'COMPUTE_API_ORIGIN': 'https://ai.longdaoec.com',
                  'COMPUTE_SIGNING_KEY_ID': 'test-sign', 'COMPUTE_SIGNING_PRIVATE_KEY_FILE': '/run/sep-compute/../../etc/passwd',
                  'COMPUTE_ENCRYPTION_KEY_ID': 'test-enc', 'COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES': '{"test-enc":"/run/sep-compute/private.pem"}'}
        with self.assertRaisesRegex(RuntimeError, 'secret mount'):
            bg.require_compute_setup(values)

    def test_rehearsal_cannot_start_workers_or_access_shared_network(self):
        _, config = self.create('rehearsal')
        self.assertEqual(set(config['services']), {'postgres', 'redis', 'migrator'})
        self.assertNotIn('shared', config['networks'])
        self.assertEqual(config['services']['migrator']['networks'], ['private'])


class RollbackChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(bg, 'ROOT', self.root)
        self.root_patch.start()
        (self.root / '.deploy').mkdir()
        (self.root / 'deploy').mkdir()
        (self.root / 'deploy/Caddyfile').write_text('old\n# LONGDAO-AI-BEGIN\n# LONGDAO-AI-END')
        self.release = bg.Release('abcdef123456', 'final')
        self.release.path.mkdir(parents=True)
        (self.release.path / 'Caddyfile.original').write_text('old\n# LONGDAO-AI-BEGIN\n# LONGDAO-AI-END')
        bg.save(self.release.state_path, {'status': 'active', 'oldImages': {'sep-green-backend': 'old-b', 'sep-green-web': 'old-w'}})

    def tearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()

    def fixture(self, name):
        if name.startswith('sep-blue-'):
            return {'Config': {'Labels': {'com.docker.compose.project': self.release.name}}, 'State': {'Running': True}}
        return {'Image': 'old-b' if name == 'sep-green-backend' else 'old-w'}

    def test_old_workers_restart_only_after_candidate_is_stopped(self):
        events = []
        with patch.object(bg, 'run', return_value='sep-blue-backend\nsep-blue-web\n'), patch.object(bg, 'inspect', side_effect=self.fixture), \
             patch.object(self.release, 'caddy', side_effect=lambda text: events.append('maintenance' if '503' in text else 'old-route')), \
             patch.object(self.release, 'lifecycle', side_effect=lambda action, target: events.append((action, target))):
            self.release.rollback()
        self.assertEqual(events, ['maintenance', ('drain_gateway', 'sep-blue-backend'),
            ('signal_and_wait_stopped', 'sep-blue-backend'), ('signal_and_wait_stopped', 'sep-blue-web'),
            ('restart_target', 'sep-green-web'), 'old-route'])

    def test_stop_failure_keeps_maintenance_and_does_not_restart_old(self):
        events = []
        def lifecycle(action, target):
            events.append(action)
            if action == 'signal_and_wait_stopped':
                raise RuntimeError('stop failed')
        with patch.object(bg, 'run', return_value='sep-blue-backend\n'), patch.object(bg, 'inspect', side_effect=self.fixture), \
             patch.object(self.release, 'caddy') as caddy, patch.object(self.release, 'lifecycle', side_effect=lifecycle):
            with self.assertRaises(RuntimeError):
                self.release.rollback()
        self.assertNotIn('restart_target', events)
        self.assertEqual(caddy.call_count, 1)

    def test_foreign_candidate_is_never_stopped(self):
        with patch.object(bg, 'run', return_value='sep-blue-backend\n'), \
             patch.object(bg, 'inspect', return_value={'Config': {'Labels': {'com.docker.compose.project': 'other'}}}), \
             patch.object(self.release, 'caddy'), patch.object(self.release, 'lifecycle') as lifecycle:
            with self.assertRaisesRegex(RuntimeError, 'ownership'):
                self.release.rollback()
        lifecycle.assert_not_called()


class OrchestrationChecks(unittest.TestCase):
    def test_failed_preflight_never_builds_or_freezes(self):
        with patch.object(bg, 'Release') as factory, patch.object(bg, 'build_images') as build:
            release = factory.return_value
            release.preflight.side_effect = RuntimeError('not ready')
            with self.assertRaisesRegex(RuntimeError, 'not ready'):
                bg.execute('stage', 'abcdef123456')
            build.assert_not_called()
            release.freeze.assert_not_called()
            release.create.assert_not_called()

    def test_migration_failure_rolls_back_without_starting_candidate(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bg, 'Release') as factory, \
             patch.object(bg, 'build_images', return_value={'migrator': 'm'}):
            release = factory.return_value
            release.path = Path(directory)
            (release.path / 'Caddyfile.original').write_text('retained')
            release.restore_and_migrate.side_effect = RuntimeError('migration failed')
            with self.assertRaisesRegex(RuntimeError, 'migration failed'):
                bg.execute('stage', 'abcdef123456')
            release.rollback.assert_called_once()
            release.start_candidate.assert_not_called()

    def test_rehearsal_failure_stops_only_its_isolated_database(self):
        with patch.object(bg, 'Release') as factory, patch.object(bg, 'old_migrator', return_value='m'):
            release = factory.return_value
            release.restore_and_migrate.side_effect = RuntimeError('migration failed')
            with self.assertRaisesRegex(RuntimeError, 'migration failed'):
                bg.execute('rehearse', 'abcdef123456')
            release.freeze.assert_not_called()
            release.rollback.assert_not_called()
            release.start_candidate.assert_not_called()
            release.compose.assert_called_once_with('stop', 'postgres')


if __name__ == '__main__':
    unittest.main()
