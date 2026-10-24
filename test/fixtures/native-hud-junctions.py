"""Test-only read-only inspection of a checkpointed Wasm fixture copy.

Junction tables have no numeric row ID. Do not route them through findObject(0),
redeclare them as application models, or use this diagnostic in production.
"""
from contextlib import closing
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import struct
import sys

store, request = (Path(value).resolve(strict=True) for value in sys.argv[1:])
root = Path('/Users/jason/localdev').resolve()
assert store.is_relative_to(root) and request.is_relative_to(root)
assert re.fullmatch(r'junction-(baseline|returned)\.lattice', store.name)
assert store.parent == request.parent
spec = json.loads(request.read_text())
assert isinstance(spec['tables'], list) and 0 < len(spec['tables']) <= 16
assert len(set(spec['tables'])) == len(spec['tables'])
original = hashlib.sha256(store.read_bytes()).hexdigest()
for suffix in ['-wal', '-journal']:
    pending = Path(str(store) + suffix)
    assert not pending.exists() or pending.stat().st_size == 0

def quoted(name):
    assert isinstance(name, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', name)
    return '"' + name + '"'

rows, schemas = [], {}
with closing(sqlite3.connect(store.as_uri() + '?mode=ro&immutable=1', uri=True)) as database:
    database.execute('PRAGMA query_only=ON')
    assert database.execute('PRAGMA query_only').fetchone()[0] == 1
    for table in spec['tables']:
        columns = database.execute('PRAGMA table_info(' + quoted(table) + ')').fetchall()
        assert columns, 'Missing actual junction metadata'
        names = [column[1] for column in columns]
        assert len(set(names)) == len(names)
        schema = {column[1]: column[2].upper() for column in columns}
        assert all(kind in ['INTEGER', 'REAL', 'TEXT'] for kind in schema.values())
        expected = [row for row in spec['rows'] if row['table'] == table]
        assert expected, 'Fixture must supply actual physical junction columns'
        manifest_names = set(expected[0]['fields']) | {'globalId'}
        if expected[0].get('localId') is not None:
            manifest_names.add('id')
        assert set(names) == manifest_names, 'Actual junction schema differs from manifest'
        schemas[table] = schema
        sql = 'SELECT ' + ','.join(quoted(name) for name in names) + ' FROM ' + quoted(table)
        for values in database.execute(sql):
            fields = {}
            for name, value in zip(names, values):
                if value is None:
                    fields[name] = {'kind': 'null'}
                elif schema[name] == 'INTEGER':
                    assert type(value) is int and -(1 << 63) <= value < (1 << 63)
                    fields[name] = {'kind': 'int64', 'value': str(value)}
                elif schema[name] == 'REAL':
                    assert type(value) in [int, float] and math.isfinite(value)
                    fields[name] = {'kind': 'float64', 'bits': struct.pack('>d', value).hex()}
                else:
                    assert type(value) is str
                    fields[name] = {'kind': 'text', 'value': value}
            gid, local = fields.pop('globalId'), fields.pop('id', None)
            assert gid['kind'] == 'text' and gid['value']
            assert local is None or local['kind'] == 'int64'
            rows.append({'table': table, 'globalId': gid['value'], 'localId': local['value'] if local else None, 'fields': fields})
assert hashlib.sha256(store.read_bytes()).hexdigest() == original, 'Read-only inspection changed fixture bytes'
print(json.dumps({'rows': rows, 'schemas': schemas, 'fileSHA256': original,
    'readOnlySQLiteCopy': True, 'sqliteVersion': sqlite3.sqlite_version}))
