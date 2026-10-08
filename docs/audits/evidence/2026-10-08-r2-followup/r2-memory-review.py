import json, os, sqlite3, tempfile
from pathlib import Path
from types import SimpleNamespace
from services.memory import migration, migration_preflight, reconcile, purge

ddl="CREATE TABLE turns(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,error_kind TEXT,created_at REAL NOT NULL)"
def seed(directory,empty=False):
    directory.mkdir(mode=0o700)
    obj={'event_id':'synthetic-event','user_id':'synthetic-user','role':'user','text':'synthetic preference','source':'synthetic-audit'}
    raw=json.dumps(obj,sort_keys=True,ensure_ascii=False)
    with sqlite3.connect(directory/'ingest.sqlite') as db:
        db.execute(ddl)
        if not empty:db.execute('INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)',(obj['event_id'],raw,migration_preflight._canonical_digest(obj),'done',1))
    (directory/'ingest.sqlite').chmod(0o600)

out=[]
with tempfile.TemporaryDirectory(dir=str(Path.cwd()),prefix='r2-memory-') as tmp:
    base=Path(tmp);source=base/'source';target=base/'unknown';seed(source);target.mkdir(mode=0o755);target.chmod(0o755)
    with sqlite3.connect(target/'ingest.sqlite') as db:db.execute('CREATE TABLE unrelated(value TEXT)')
    before=(target.stat().st_mode&0o777)
    try:migration.snapshot(source,target)
    except migration.MigrationError as error:
        assert str(error)=='unknown_existing_db'
        after=target.stat().st_mode&0o777;assert before==0o755 and after==0o700
        out.append({'probe':'M01-F001-r2-unknown-target-chmod','error':str(error),'beforeMode':'0755','afterMode':'0700','unknownTargetChangedBeforeRefusal':True})
    else:raise AssertionError('unknown target expected refusal')

    empty=base/'unknown-empty-baseline';seed(empty,empty=True)
    result=migration.snapshot(source,empty)
    with sqlite3.connect(empty/'ingest.sqlite') as db:rows=db.execute('SELECT count(*) FROM turns').fetchone()[0]
    assert rows==0
    out.append({'probe':'M01-F001-r2-empty-subset-admitted','acceptedManifestlessIndependentTarget':True,'sourceRows':1,'targetRows':rows})

view=reconcile.reconcile([{'event_id':'a','user_id':'synthetic-user','text':'A','created_at':1,'slot':'s','supersedes':'b'},{'event_id':'b','user_id':'synthetic-user','text':'B','created_at':2,'slot':'s'},{'event_id':'c','user_id':'synthetic-user','text':'C','created_at':3,'slot':'s'}])
edges={r['event_id']:r['superseded_by'] for r in view['current']+view['superseded']}
assert edges=={'c':None,'a':'b','b':'c'}
out.append({'probe':'RC-F001-r2','successorEdges':edges,'cycleRemoved':True})

def receipt(e,v,d='d'):return {'event_id':e,'user_id':'u','digest':d,'source_hash':'shared-source','vector_ids':[v],'has_archive':False}
tomb=[{'user_id':'u','event_id':'e1','source_hash':'shared-source','quote_hashes':[]}]
plan=purge.plan_purge([receipt('e1','v1')],tomb,{'user_id':'u','selector':{'event_id':'e1'},'mode':'event'})
turn=SimpleNamespace(purged=False,digest='d',payload='SYNTHETIC_REMAINS',plan='SYNTHETIC_PLAN_REMAINS')
def mark(e):turn.purged=True
try:purge.execute_purge(plan,lambda v:None,mark,lambda v:False,lambda e:turn)
except purge.PurgeError as error:
    assert error.code=='verify-failed';out.append({'probe':'PG-F001-r2','residualContentRejected':True,'error':error.code})
else:raise AssertionError('remaining content cannot be verified')

both=purge.plan_purge([receipt('e1','v1'),receipt('e2','v2')],tomb,{'user_id':'u','selector':{'source_hash':'shared-source'},'mode':'fact'})
turns={e:SimpleNamespace(purged=False,digest='d',payload='SYNTHETIC_OLD',plan='SYNTHETIC_PLAN') for e in ['e1','e2']};effects=[]
def delete(v):
    effects.append('delete:'+v)
    if v=='v1':turns['e2'].digest='new';turns['e2'].payload='SYNTHETIC_NEW_CONTENT'
def scrub(e):effects.append('scrub:'+e);turns[e].purged=True;turns[e].payload='';turns[e].plan=''
try:purge.execute_purge(both,delete,scrub,lambda v:False,lambda e:turns[e])
except purge.PurgeError as error:
    assert error.code=='verify-failed';assert 'scrub:e2' in effects and turns['e2'].payload==''
    out.append({'probe':'PG-F002-r2-between-preflight-and-effect','error':error.code,'effects':effects,'driftedNewContentErased':True})
else:raise AssertionError('digest drift should be reported after damage in r2')

print(json.dumps({'realModels':False,'productionTouched':False,'observations':out}))
