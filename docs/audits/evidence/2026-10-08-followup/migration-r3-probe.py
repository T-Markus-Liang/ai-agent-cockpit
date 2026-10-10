import hashlib, json, sqlite3, tempfile
from pathlib import Path
from services.memory import migration, migration_preflight

DDL = "CREATE TABLE turns(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,error_kind TEXT,created_at REAL NOT NULL)"

def seed(directory, empty=False):
    directory.mkdir(mode=0o700)
    obj={'event_id':'TESTONLY-event','user_id':'TESTONLY-user','role':'user','text':'TESTONLY preference','source':'TESTONLY-audit'}
    with sqlite3.connect(directory/'ingest.sqlite') as db:
        db.execute(DDL)
        if not empty:
            db.execute('INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)',(obj['event_id'],json.dumps(obj,sort_keys=True,ensure_ascii=False),migration_preflight._canonical_digest(obj),'done',1))
    (directory/'ingest.sqlite').chmod(0o600)

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

observations=[]
with tempfile.TemporaryDirectory(prefix='migration-r3-audit-') as tmp:
    base=Path(tmp).resolve()
    source=base/'source';seed(source)
    target=base/'unknown';target.mkdir(mode=0o755);target.chmod(0o755)
    with sqlite3.connect(target/'ingest.sqlite') as db: db.execute('CREATE TABLE unrelated(value TEXT)')
    before=digest(target/'ingest.sqlite');entries=sorted(x.name for x in target.iterdir())
    error=None
    try: migration.snapshot(source,target)
    except migration.MigrationError as exc: error=str(exc)
    observations.append({'probe':'unknown-target','error':error,'modePreserved':target.stat().st_mode&0o777==0o755,'bytesPreserved':digest(target/'ingest.sqlite')==before,'entriesPreserved':sorted(x.name for x in target.iterdir())==entries})
    empty=base/'empty-copy';seed(empty,True);before=digest(empty/'ingest.sqlite')
    error=None
    try: migration.snapshot(source,empty)
    except migration.MigrationError as exc:error=str(exc)
    observations.append({'probe':'manifestless-empty-subset','error':error,'bytesPreserved':digest(empty/'ingest.sqlite')==before,'accepted':error is None})
print(json.dumps({'realModels':False,'productionTouched':False,'observations':observations},indent=2))
assert observations[0]['error']=='unknown_existing_db' and all(observations[0][k] for k in ['modePreserved','bytesPreserved','entriesPreserved'])
assert observations[1]['error']=='unknown_existing_db' and observations[1]['bytesPreserved'] and not observations[1]['accepted']

