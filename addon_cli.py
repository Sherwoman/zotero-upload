"""Use Zotero's native add-on manager over a TEMPORARY Marionette session.

Close Zotero normally and restore the exact prefs snapshot after use. This tool
does not enable a debugging listener or change global compatibility settings.
"""
import argparse
import json
import socket


def receive(sock):
    header = bytearray()
    while True:
        char = sock.recv(1)
        if not char:
            raise EOFError("Zotero closed the connection")
        if char == b":":
            break
        header.extend(char)
    body = bytearray()
    while len(body) < int(header):
        chunk = sock.recv(int(header) - len(body))
        if not chunk:
            raise EOFError("Incomplete response")
        body.extend(chunk)
    return json.loads(body)


def send(sock, number, name, data):
    payload = json.dumps([0, number, name, data]).encode("utf-8")
    sock.sendall(str(len(payload)).encode("ascii") + b":" + payload)


def addon_command(port, name, parameters):
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        sock.settimeout(120)
        assert receive(sock).get("applicationType") == "gecko"
        # Zotero does not emit Firefox's browser-startup event. Pipeline the
        # window-independent add-on command using the native protocol.
        send(sock, 1, "WebDriver:NewSession", {})
        send(sock, 2, name, parameters)
        try:
            reply = receive(sock)
            while reply[:2] != [1, 2]:
                reply = receive(sock)
            if reply[2]:
                raise RuntimeError(json.dumps(reply[2]))
            return reply[3]
        finally:
            send(sock, 3, "WebDriver:DeleteSession", {})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=2828)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install").add_argument("xpi")
    sub.add_parser("uninstall").add_argument("id")
    args = parser.parse_args()
    name, parameters = ("Addon:Install", {"path": args.xpi, "temporary": False}) if args.command == "install" else ("Addon:Uninstall", {"id": args.id})
    print(json.dumps(addon_command(args.port, name, parameters)))
