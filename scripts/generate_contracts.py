"""Generate the public gateway OpenAPI 3.0 contract using Python's standard library."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def ref(name): return {'$ref': '#/components/schemas/' + name}
def obj(properties, required=()):
    return {'type': 'object', 'properties': properties, **({'required': list(required)} if required else {})}
def arr(item): return {'type': 'array', 'items': item}
S = {'type': 'string'}
I = {'type': 'integer'}
B = {'type': 'boolean'}
DT = {'type': 'string', 'format': 'date-time', 'nullable': True}
SCHEMAS = {
    'Actor': obj({'id': S, 'role': {'type': 'string', 'enum': ['RIDER','DRIVER']}, 'name': S}, ['id','role','name']),
    'Place': obj({'id': S, 'name': S, 'lat': {'type': 'number'}, 'lng': {'type': 'number'}}, ['id','name','lat','lng']),
    'Rule': obj({'base_cents': I, 'per_km_cents': I, 'included_m': I}),
    'Estimate': obj({'id': S, 'rider_id': S, 'origin': ref('Place'), 'destination': ref('Place'), 'distance_m': I, 'duration_s': I, 'amount_cents': I, 'expires_at': DT, 'created_at': DT, 'rule': ref('Rule'), 'estimated': B, 'distance_method': S}, ['id','rider_id','origin','destination','distance_m','amount_cents','expires_at']),
    'Driver': obj({'id': S, 'name': S, 'phone_mask': S, 'vehicle': obj({'plate': S, 'model': S, 'color': S}), 'online': B, 'active_order_id': {'type': 'string', 'nullable': True}, 'active_assignment_id': {'type': 'string', 'nullable': True}, 'updated_at': DT}, ['id','name','vehicle','online']),
    'Order': obj({'id': S, 'rider_id': S, 'status': {'type': 'string', 'enum': ['MATCHING','ASSIGNING','ACCEPTED','ARRIVED','IN_PROGRESS','COMPLETED','CANCELLED','FAILED']}, 'version': {'type': 'integer', 'minimum': 1}, 'origin': ref('Place'), 'destination': ref('Place'), 'estimate': ref('Estimate'), **{k: {'type': 'string', 'nullable': True} for k in ['driver_id','pending_driver_id','offer_id','assignment_id','failure_reason','last_assignment_failure']}, **{k: DT for k in ['created_at','updated_at','accepted_at','arrived_at','started_at','finished_at','cancelled_at']}, 'final_distance_m': {'type': 'integer', 'nullable': True}, 'final_amount_cents': {'type': 'integer', 'nullable': True}}, ['id','rider_id','status','version','origin','destination','estimate']),
    'OrderResult': obj({'order': ref('Order')}, ['order']),
    'QueryResult': obj({'order': {'allOf': [ref('Order')], 'nullable': True}, 'driver': {'allOf': [ref('Driver')], 'nullable': True}, 'projection_version': I, 'projected_at': DT, 'sync_pending': B, 'partial': B, 'warnings': arr(obj({'code': S, 'message': S}))}, ['order','sync_pending','partial','warnings']),
    'Offer': obj({'id': S, 'order_id': S, 'driver_id': S, 'status': {'type': 'string', 'enum': ['PENDING','CLAIMED','ACCEPTED','REJECTED','EXPIRED','FAILED','CANCELLED']}, 'assignment_id': {'type': 'string', 'nullable': True}, 'created_at': DT, 'expires_at': DT, 'resolved_at': DT, 'order': ref('Order'), 'origin': ref('Place'), 'destination': ref('Place')}, ['id','order_id','driver_id','status','expires_at']),
    'Error': obj({'error': obj({'code': S, 'message': S, 'details': {'type': 'object'}}, ['code','message']), 'request_id': S}, ['error','request_id']),
}
PATHS = {}
def endpoint(method, route, summary, schema, body=None, role='ANY', success='200', pending=False, parameters=None, body_required=True):
    parameters = list(parameters or [])
    for part in route.split('/'):
        if part.startswith('{'):
            parameters.append({'name': part[1:-1], 'in': 'path', 'required': True, 'schema': S})
    operation = {'summary': summary, 'description': 'Role: ' + role, 'operationId': method + '_' + route.strip('/').replace('/', '_').replace('{','').replace('}','').replace('-','_'), 'security': [] if role == 'PUBLIC' else [{'bearerAuth': []}], 'responses': {success: {'description': '操作成功', 'content': {'application/json': {'schema': schema}}}}}
    if parameters: operation['parameters'] = parameters
    if body: operation['requestBody'] = {'required': body_required, 'content': {'application/json': {'schema': body}}}
    for code, desc in [('400','输入错误'),('401','未认证或令牌无效'),('403','角色或归属不允许'),('404','资源不存在'),('409','状态冲突或请求已失效'),('502','依赖不可用'),('503','依赖暂不可用或恢复待重试'),('504','确认超时，需查询或幂等重试')]:
        operation['responses'][code] = {'description': desc, 'content': {'application/json': {'schema': ref('Error')}}}
    if pending: operation['responses']['202'] = {'description': '接单确认进行中或查询副本尚未追上版本；检查 order.status / sync_pending', 'content': {'application/json': {'schema': schema}}}
    PATHS.setdefault(route, {})[method] = operation

endpoint('get','/auth/accounts','列出四个预设演示账号',obj({'accounts': arr(ref('Actor'))}),role='PUBLIC')
endpoint('post','/auth/login','选择演示身份并获得令牌',obj({'token': S,'actor': ref('Actor')}),obj({'account_id': S},['account_id']),role='PUBLIC')
endpoint('get','/places','查询上海预设地点（WGS84）',obj({'places': arr(ref('Place'))}),role='PUBLIC')
endpoint('post','/orders/estimate','预估距离和费用',obj({'estimate': ref('Estimate')}),obj({'origin_id': S,'destination_id': S},['origin_id','destination_id']),role='RIDER')
endpoint('post','/orders','创建叫车订单（需幂等请求头）',ref('OrderResult'),obj({'estimate_id': S},['estimate_id']),role='RIDER',success='201',parameters=[{'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','pattern':'^[\\w-]{8,128}$'}}])
endpoint('get','/orders/history','当前乘客最近100条订单',obj({'orders': arr(ref('Order')),'source':S,'eventual_consistency':B}),role='RIDER')
endpoint('get','/orders/current','查询当前乘客或司机的进行中订单',ref('QueryResult'),pending=True)
endpoint('get','/orders/{id}','查询订单并通过API组合司机资料',ref('QueryResult'),pending=True,parameters=[{'name':'min_version','in':'query','required':False,'schema':{'type':'integer','minimum':0},'description':'低于此版本时返回202和sync_pending=true，不回查写库。'}])
endpoint('post','/orders/{id}/cancel','乘客在开始行程前取消自己的订单',ref('OrderResult'),role='RIDER')
endpoint('post','/orders/{id}/arrive','已接单司机确认到达上车点',ref('OrderResult'),role='DRIVER')
endpoint('post','/orders/{id}/start','已接单司机确认上车并开始行程',ref('OrderResult'),role='DRIVER')
endpoint('post','/orders/{id}/finish','结束行程并按后端规则计算费用',ref('OrderResult'),obj({'distance_m':{'type':'integer','minimum':1,'maximum':200000,'description':'省略时使用报价预估里程'}}),role='DRIVER',body_required=False)
endpoint('get','/drivers/me','当前司机资料与占用状态',obj({'driver':ref('Driver')}),role='DRIVER')
endpoint('put','/drivers/me/status','开启或关闭接单；不解除已有占用',obj({'driver':ref('Driver')}),obj({'online':B},['online']),role='DRIVER')
endpoint('get','/drivers/me/offers','当前司机有效待处理派单',obj({'offers':arr(ref('Offer'))}),role='DRIVER')
endpoint('post','/offers/{id}/accept','接受派单，经订单和司机服务最终裁决',ref('OrderResult'),role='DRIVER',pending=True)
endpoint('post','/offers/{id}/reject','拒绝自己的未过期待处理派单',obj({'offer':ref('Offer')}),role='DRIVER')
endpoint('get','/system/health','五个业务服务连通性',obj({'services':{'type':'object','additionalProperties':obj({'healthy':B})}}),role='PUBLIC')
spec = {'openapi':'3.0.3','info':{'title':'沪行 Lab3 public API','version':'1.0.0','description':'上海网约车教学实现。所有金额为整数分，里程为米，时间为ISO8601，地图坐标WGS84。简化认证用于预设账号；资源归属由各业务服务再次校验。'},'servers':[{'url':'http://localhost:8083/api'}],'paths':PATHS,'components':{'securitySchemes':{'bearerAuth':{'type':'http','scheme':'bearer','bearerFormat':'HMAC demo token'}},'schemas':SCHEMAS}}
output=ROOT/'contracts'/'openapi.json'; output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'Wrote {len(PATHS)} public paths / {sum(len(v) for v in PATHS.values())} operations to {output.name}')
