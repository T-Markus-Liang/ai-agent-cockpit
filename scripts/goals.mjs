#!/usr/bin/env node
import { goalRequest } from '../control-plane/goal-client.mjs'
const [action = 'list', id] = process.argv.slice(2)
if (!['list', 'get', 'pause', 'resume', 'cancel'].includes(action)) throw new Error('usage: node scripts/goals.mjs list|get|pause|resume|cancel [goal_id]')
if (action !== 'list' && !/^goal_[a-z0-9-]+$/.test(id ?? '')) throw new Error('exact goal id is required')
console.log(JSON.stringify(await goalRequest(action === 'list' ? '/api/goals' : `/api/goals/${id}${action === 'get' ? '' : `/${action}`}`, ['list', 'get'].includes(action) ? undefined : {}), null, 2))
