import json
from types import SimpleNamespace
from services.memory.reconcile import reconcile
from services.memory.purge import plan_purge, execute_purge, PurgeError

out = []
receipts = [
    {'event_id': 'a', 'user_id': 'synthetic-user', 'slot': 'synthetic-slot', 'text': 'A', 'created_at': 1, 'supersedes': 'b'},
    {'event_id': 'b', 'user_id': 'synthetic-user', 'slot': 'synthetic-slot', 'text': 'B', 'created_at': 2},
    {'event_id': 'c', 'user_id': 'synthetic-user', 'slot': 'synthetic-slot', 'text': 'C', 'created_at': 3},
]
view = reconcile(receipts)
edges = {r['event_id']: r['superseded_by'] for r in view['current'] + view['superseded']}
assert edges == {'c': None, 'a': 'b', 'b': 'a'}
out.append({'probe': 'reconcile-disconnected-cycle', 'current': [r['event_id'] for r in view['current']], 'successorEdges': edges, 'conflicts': len(view['conflicts']), 'cycleRetained': True})

receipt = {'event_id': 'synthetic-event', 'user_id': 'synthetic-user', 'digest': 'synthetic-digest-original', 'source_hash': 'synthetic-source', 'vector_ids': ['synthetic-vector'], 'has_archive': False}
tombstone = {'user_id': 'synthetic-user', 'event_id': 'synthetic-event', 'source_hash': 'synthetic-source', 'quote_hashes': []}
request = {'user_id': 'synthetic-user', 'selector': {'event_id': 'synthetic-event'}, 'mode': 'event'}
plan = plan_purge([receipt], [tombstone], request)

turn = SimpleNamespace(purged=False, digest=receipt['digest'], payload='SYNTHETIC_CONTENT_LEFT_IN_PLACE')
effects = []
vectors = {'synthetic-vector'}
def remove(vector_id):
    effects.append('vector-delete')
    vectors.discard(vector_id)
def mark_only(event_id):
    effects.append('mark-purged-without-scrub')
    turn.purged = True
result = execute_purge(plan, remove, mark_only, lambda v: v in vectors, lambda e: turn)
assert result['verified'] and turn.payload == 'SYNTHETIC_CONTENT_LEFT_IN_PLACE'
out.append({'probe': 'purge-payload-not-erased', 'reportsVerified': result['verified'], 'payloadStillPresent': True, 'vectorRemoved': not vectors})

drifted = SimpleNamespace(purged=False, digest='synthetic-digest-new', payload='SYNTHETIC_CHANGED_CONTENT')
effects2 = []
def remove2(vector_id):
    effects2.append('vector-delete')
def scrub2(event_id):
    effects2.append('turn-scrub')
    drifted.purged = True
    drifted.payload = ''
try:
    execute_purge(plan, remove2, scrub2, lambda v: False, lambda e: drifted)
except PurgeError as error:
    assert error.code == 'verify-failed'
    assert effects2 == ['vector-delete', 'turn-scrub']
    out.append({'probe': 'purge-stale-receipt-preflight', 'error': error.code, 'effectsBeforeDriftRejected': effects2, 'changedContentErased': drifted.payload == ''})
else:
    raise AssertionError('stale digest should be detected after effects in r1')

print(json.dumps({'frozenReview': 'r2-new-batches-r1', 'realModels': False, 'productionTouched': False, 'observations': out}, ensure_ascii=False))
