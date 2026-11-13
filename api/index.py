from http.server import BaseHTTPRequestHandler
import json
import time
from datetime import datetime

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.end_headers()
        
        payload = {
            "status": "online",
            "service": "MKVCBot Keep-Alive Ping Service",
            "target": "MKTRADEZ",
            "utc_timestamp": datetime.utcnow().isoformat() + "Z",
            "unix_timestamp": int(time.time()),
            "ping": "pong",
            "health": "operational",
            "message": "Keep-alive ping acknowledged successfully. Bot monitoring active."
        }
        self.wfile.write(json.dumps(payload, indent=2).encode('utf-8'))
