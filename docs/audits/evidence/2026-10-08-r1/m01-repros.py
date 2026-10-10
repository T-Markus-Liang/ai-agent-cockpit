import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
from pathlib import Path

from services.memory import migration, lifecycle
from services.memory.service import MemoryService, Mem0Engine, Turn

INPUT = Path('/tmp/personal-ai-os-review-r1.bgwgKU/input')
spec = importlib.util.spec_from_file_location('frozen_audit_fixtures', INPUT / 'tests/memory_service_test.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
DDL = '''CREATE TABLE turns(event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0, error_kind TEXT, created_at REAL NOT NULL)'''

def seed(directory, *, created=1.0, text='我喜欢用中文回复。'):
    directory.mkdir(mode=0o700)
    obj = {'event_id':'synthetic-event','user_id':'synthetic-user','role':'user','text':text,'source':'synthetic-audit'}
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    with sqlite3.connect(directory / 'ingest.sqlite') as db:
        db.execute(DDL)
        db.execute('INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)', (obj['event_id'],raw,hashlib.sha256(raw.encode()).hexdigest(),'done',created))
    (directory / 'ingest.sqlite').chmod(0o600)

out=[]
with tempfile.TemporaryDirectory(prefix='audit-m01-', dir=str(Path.cwd())) as tmp:
    root=Path(tmp)
    src=root/'source'; unknown=root/'independent-target'
    seed(src); seed(unknown,created=99.0)
    before=(src/'ingest.sqlite').read_bytes()
    result=migration.convert(src,unknown)
    with sqlite3.connect(unknown/'ingest.sqlite') as db:
        row=db.execute('SELECT status,created_at FROM turns').fetchone()
    assert result['conservation']['digests_match'] and row==('pending',99.0)
    assert (src/'ingest.sqlite').read_bytes()==before
    out.append({'probe':'unknown-existing-db-and-created-at','acceptedUnknownDb':True,'targetMutatedToPending':True,'wrongTimestampRetained':True,'conservationReportedTrue':True,'sourceBytesUnchanged':True})

    src2=root/'source-2'; target2=root/'copy-2'; victim=root/'victim-dir'; alias=root/'alias-dir'
    seed(src2); seed(victim)
    alias.symlink_to(victim,target_is_directory=True)
    result=migration.convert(src2,alias)
    with sqlite3.connect(victim/'ingest.sqlite') as db:
        changed=db.execute('SELECT status FROM turns').fetchone()[0]
    assert changed=='pending'
    out.append({'probe':'symlink-destination','acceptedOtherTargetSymlink':True,'victimDbMutated':True})

    src3=root/'source-3'; target3=root/'copy-3'; seed(src3)
    migration.convert(src3,target3)
    mem=fixtures.FakeMem0()
    evaluator=fixtures.FakeEvaluator()
    engine=Mem0Engine(memory=mem,evaluator=evaluator,quality_config=fixtures.make_config(),version='synthetic-only')
    service=MemoryService(target3,engine)
    prepare=engine.prepare
    def forget_after_prepare(turn):
        plan=prepare(turn)
        service.forget(lifecycle.ForgetRequest(request_id='synthetic-forget',user_id=turn.user_id,event_ids=[turn.event_id]))
        return plan
    engine.prepare=forget_after_prepare
    result=migration.reverify(target3,engine)
    with service.connect() as db:
        status,validation,forgotten=db.execute('SELECT status,validation_status,forgotten FROM turns').fetchone()
    assert forgotten==1 and status=='done' and validation=='validated' and len(mem.rows)==1
    out.append({'probe':'forget-during-prepare','forgetCommitted':True,'vectorEffectsAfterForget':len(mem.rows),'converterReportsValidated':result['validated'],'forgottenFlagRetained':True})

    src4=root/'source-4'; target4=root/'copy-4'; seed(src4)
    migration.convert(src4,target4)
    mem4=fixtures.FakeMem0(); mem4.fail_add=True
    eval4=fixtures.FakeEvaluator()
    engine4=Mem0Engine(memory=mem4,evaluator=eval4,quality_config=fixtures.make_config(),version='synthetic-only')
    first=migration.reverify(target4,engine4)
    count=len(eval4.calls)
    mem4.fail_add=False
    second=migration.reverify(target4,engine4)
    assert first['errors']==1 and second['validated']==1 and len(eval4.calls)>count
    out.append({'probe':'store-retry-reprepares','firstPassEvaluatorCalls':count,'secondPassAdditionalEvaluatorCalls':len(eval4.calls)-count,'secondPassValidated':second['validated']})

print(json.dumps({'source':'frozen-M01-r1','productionTouched':False,'realModels':False,'observations':out},ensure_ascii=False))
