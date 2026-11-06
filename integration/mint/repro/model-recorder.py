#!/usr/bin/env python3
"""Transparent local model proxy: record exact bodies, forward bytes unchanged."""
import argparse,http.client,itertools,json,urllib.parse
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--upstream',default='http://127.0.0.1:11434');p.add_argument('--port',type=int,default=11428);p.add_argument('--output',required=True);a=p.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True);counter=itertools.count();url=urllib.parse.urlsplit(a.upstream)
class H(BaseHTTPRequestHandler):
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('Content-Length','0')));n=next(counter);(out/f'{n:04d}-request.json').write_bytes(body)
  conn=(http.client.HTTPSConnection if url.scheme=='https' else http.client.HTTPConnection)(url.hostname,url.port,timeout=180)
  try:
   conn.request('POST',self.path,body,{k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','content-length')});response=conn.getresponse();self.send_response(response.status);self.send_header('Content-Type',response.getheader('Content-Type','application/json'));self.end_headers()
   with (out/f'{n:04d}-response.txt').open('wb') as f:
    while True:
     chunk=response.read1(8192)
     if not chunk:break
     f.write(chunk);self.wfile.write(chunk);self.wfile.flush()
  except Exception as error:print(repr(error),flush=True)
  finally:conn.close();self.close_connection=True
 def log_message(self,*args):pass
ThreadingHTTPServer(('127.0.0.1',a.port),H).serve_forever()
