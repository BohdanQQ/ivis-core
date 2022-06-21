import sys
import os
import json
from elasticsearch6 import Elasticsearch, helpers

from datetime import datetime, timezone
import numpy as np
from dtw import dtw

# Get parameters and set up elasticsearch
data = json.loads(sys.stdin.readline())
es = Elasticsearch([{'host': data['es']['host'], 'port': int(data['es']['port'])}])

state = data.get('state')

params= data['params']
entities= data['entities']

# Get ES index and fields
sensor_set = entities['signalSets'][params['sensors']]
sensor_ts = entities['signals'][params['sensors']][params['ts']]
sensor_co2 = entities['signals'][params['sensors']][params['co2']]

limit_val = float(params['limitValue'])

limit = limit_val

if state is None or state.get('index') is None:
    ns = sensor_set['namespace']
  
    msg = {}
    msg['type'] = 'sets'
    # Request new signal set creation 
    msg['sigSet'] = {
    "cid" : "e_plus_mod",
    "name" : "E+ comparison" ,
    "namespace": ns,
    "description" : "Comparison of Energy+ models" ,
    "aggs" :  "0" 
    }

    signals= [] 
    signals.append({
      "cid": "ts",
      "name": "ts",
      "description": "timestamp",
      "namespace": ns,
      "type": "date",
      "indexed": False,
      "settings": {}
    })
    signals.append({
      "cid": "mod",
      "name": "mod",
      "description": "mod",
      "namespace": ns,
      "type": "keyword",
      "indexed": False,
      "settings": {}
    })
    signals.append({
      "cid": "model",
      "name": "model",
      "description": "Closest model's cid",
      "namespace": ns,
      "type": "keyword",
      "indexed": False,
      "settings": {}
    })
    msg['sigSet']['signals'] = signals

    ret = os.write(3,(json.dumps(msg) + '\n').encode())
    state = json.loads(sys.stdin.readline())
    error = state.get('error')
    if error:
      sys.stderr.write(error+"\n")
      sys.exit(1)
    else:
      store_msg = {}
      store_msg["type"] = "store"
      store_msg["state"] = state
      ret = os.write(3,(json.dumps(store_msg) + '\n').encode())

def get_co2_values(index,ts_field, co2_field):
  # sensor data query
  query = {
      '_source': [co2_field, ts_field],
      'sort': [{ts_field: 'asc'}],
      'query': {
        "range" : {
          ts_field : {
            "gt" : "now-180m/m",
            "lt" : "now/m"
          }
        }
      }
  }
  
  results = es.search(index=index, body=query)
  
  sensor_data = []
  for item in results['hits']['hits']:
    val = item["_source"][co2_field]
    if val is not None:
      sensor_data.append(val)
    else:
      continue
  
  return sensor_data

sensor_data = get_co2_values(sensor_set['index'], sensor_ts['field'], sensor_co2['field'])

if not sensor_data:
  print('No sensor data to measure on')
  exit()

sensor_np = np.array(sensor_data, dtype=float).reshape(-1, 1)

euclidean_norm = lambda x, y: np.abs(x - y)

min_model={}
min_distance=float("inf")
for model in params['models']:
  
  ts =entities['signals'][model['sigSet']][model['ts']]['field']
  co2 =entities['signals'][model['sigSet']][model['co2']]['field']
  sig_set = entities['signalSets'][model['sigSet']]['index']
  
  model_data = get_co2_values(sig_set, ts,co2)
  if not model_data:
    print(f'No data for signal set {sig_set}')
    continue
  # Calculate for all models
  model_np = np.array(model_data, dtype=float).reshape(-1, 1)
  
  # Calculate for all models
  d, cost_matrix, acc_cost_matrix, path = dtw(sensor_np, model_np, dist=euclidean_norm)
  
  if d<min_distance:
    min_distance = d
    min_model['name'] = entities["signalSets"][model["sigSet"]]["name"]
    min_model['cid'] = model["sigSet"]
    min_model['ts'] = ts
    min_model['co2'] = co2
    min_model['index'] = sig_set

# Do something with closest model
if not min_model:
  print('No model found')
  exit()
print(f'Closest model is: {min_model["name"]}')

# Query prediction
query = {
    '_source': [min_model['co2'], min_model['ts']],
    'sort': [{min_model['ts']: 'asc'}],
    "aggs" : {
        "max_co2" : { "max" : { "field" : min_model['co2'] } }
    },
    'query': {
      "range" : {
        min_model['ts'] : {
          "gt" : "now/m",
          "lt" : "now+60m/m"
        }
      }
    }
}


results = es.search(index=min_model['index'], body=query)
max_co2 = results['aggregations']['max_co2']['value']

# Get current mode 
# TODO this will probably change later on to take data from the actual system
query = {
   'size': 1,
   '_source': [state['fields']['mod']],
   'sort': [{state['fields']['ts']: 'desc'}],
   'query': {
      "match_all": {}
   }
}
results = es.search(index=state['index'], body=query)
mod = results['hits']['hits'][0]['_source'][state['fields']['mod']] if results['hits']['total'] > 0 else 'mod1'

# If currently over limit or going to be according to models data, open more
if sensor_data[-1] > limit or max_co2 > limit:
  mod = 'mod2'
elif sensor_data[-1] < limit - 200:
  mod = 'mod1'

print(f'Chosen: {mod}')

ts = datetime.now(timezone.utc).astimezone()
doc = {
  state['fields']['ts']: ts,
  state['fields']['model']: min_model['cid'],
  state['fields']['mod']: mod 
}
res = es.index(index=state['index'], doc_type='_doc', id=ts, body=doc)

#prediction_data = []
#for item in results['hits']['hits']:
#  val = item["_source"][min_model['co2']]
#  if val is not None:
#    prediction_data.append(val)
#  else:
#    continue
#print (prediction_data)
