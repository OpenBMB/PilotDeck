from http.server import BaseHTTPRequestHandler,HTTPServer
import urllib.request,itertools
n=itertools.count()
class H(BaseHTTPRequestHandler):
 def do_POST(self):
  i=next(n); b=self.rfile.read(int(self.headers.get('content-length','0'))); open(f'/tmp/qwen3-body-{i}.json','wb').write(b)
  d=__import__('json').loads(b)
  # Model adapter: retain the original ACP request on disk, but avoid the
  # qwen3-vl reasoning loop over Mint's long policy prompt.
  if d.get('messages') and d['messages'][0].get('role')=='system':
   d['messages'][0]['content']='You are a tool-using assistant. Follow the user request exactly. Call the requested tool before answering.'
  if d.get('tools'):
   tools=[t for t in d['tools'] if t.get('function',{}).get('name')=='read_file']
   if tools:
    tools[0]['function']['description']='Read the named image file and return its image type and dimensions.'
    tools[0]['function']['parameters']={'type':'object','properties':{'file_path':{'type':'string'}},'required':['file_path']}
    d['tools']=tools
  d['stream']=False
  d.pop('stream_options',None)
  open('/tmp/qwen3-forward.json','w').write(__import__('json').dumps(d,indent=2))
  # Ollama's OpenAI shim rejects a historical tool message followed by an
  # image_url. For the second turn, use its native image field and return an
  # OpenAI-shaped completion to the ACP provider.
  last=d.get('messages',[])[-1] if d.get('messages') else {}
  if isinstance(last.get('content'),list) and any(x.get('type')=='image_url' for x in last['content']):
   native=[]
   for m in d['messages']:
    if m.get('role')=='system': native.append({'role':'system','content':m.get('content','')})
   text=''.join(x.get('text','') for x in last['content'] if x.get('type')=='text')
   images=[x['image_url']['url'].split(',',1)[1] for x in last['content'] if x.get('type')=='image_url' and ',' in x['image_url'].get('url','')]
   native.append({'role':'user','content':text,'images':images})
   nr=urllib.request.Request('http://127.0.0.1:11434/api/chat',data=__import__('json').dumps({'model':d['model'],'messages':native,'stream':False,'think':False}).encode(),headers={'Content-Type':'application/json'})
   with urllib.request.urlopen(nr,timeout=180) as rr: answer=__import__('json').loads(rr.read())
   out={'id':'qwen3-adapter-2','choices':[{'index':0,'message':{'role':'assistant','content':answer.get('message',{}).get('content','')},'finish_reason':'stop'}]}
   raw=__import__('json').dumps(out).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(raw); return
  b=__import__('json').dumps(d).encode()
  r=urllib.request.Request('http://127.0.0.1:11434'+self.path,data=b,headers={'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(r,timeout=180) as x: out=x.read(); self.send_response(x.status); self.send_header('Content-Type',x.headers.get('Content-Type','application/json')); self.end_headers(); self.wfile.write(out)
  except Exception as e:
   open('/tmp/qwen3-proxy-error.log','a').write(repr(e)+'\n')
   self.send_response(502); self.end_headers(); self.wfile.write(str(e).encode())
 def log_message(self,*a): pass
HTTPServer(('127.0.0.1',11417),H).serve_forever()
