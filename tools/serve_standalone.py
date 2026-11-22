"""Serve only the standalone DashBar HTML to browsers on a local network."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


def serve(page, host, port):
    class AppHandler(BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.send_page(False)

        def do_GET(self):
            self.send_page(True)

        def send_page(self, body):
            if urlsplit(self.path).path not in {"/", "/dashbar.html"}:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body:
                self.wfile.write(page)

    with ThreadingHTTPServer((host, port), AppHandler) as server:
        print(f"DashBar · http://{host}:{server.server_port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("file", type=Path)
    cli.add_argument("--host", default="127.0.0.1")
    cli.add_argument("--port", type=int, default=8765)
    args = cli.parse_args()
    serve(args.file.read_bytes(), args.host, args.port)
