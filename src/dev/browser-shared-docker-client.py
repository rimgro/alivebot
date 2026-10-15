"""Disposable protocol fixture: no browser process or SDK is installed in this client."""
import base64
import hashlib
import json
import os
import socket
import struct
import urllib.request

address = "host.docker.internal"
port = int(os.environ["ALIVE_SHARED_FIXTURE_PORT"])
token = os.environ["ALIVE_BROWSER_SHARED_TEST_TOKEN"]
request = urllib.request.Request(
    f"http://{address}:{port}/v1/status",
    headers={"Authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(request, timeout=10) as response:
    assert json.load(response)["protocol"] == 1

connection = socket.create_connection((address, port), timeout=10)
key = base64.b64encode(os.urandom(16)).decode()
connection.sendall((
    f"GET /connect HTTP/1.1\r\nHost: {address}:{port}\r\n"
    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
    f"Sec-WebSocket-Key: {key}\r\nAuthorization: Bearer {token}\r\n\r\n"
).encode())
header = b""
while not header.endswith(b"\r\n\r\n"):
    header += connection.recv(1)
assert header.startswith(b"HTTP/1.1 101 ")
accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
assert accept.lower() in header.lower()


def read_exact(size):
    result = b""
    while len(result) < size:
        chunk = connection.recv(size - len(result))
        assert chunk, "Unexpected protocol disconnection"
        result += chunk
    return result


def send(payload, opcode=1):
    mask = os.urandom(4)
    size = len(payload)
    length = bytes([0x80 | size]) if size < 126 else bytes([0xFE]) + struct.pack("!H", size)
    connection.sendall(bytes([0x80 | opcode]) + length + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))


objects = {}
sequence = 0


def call(guid, method, params):
    global sequence
    sequence += 1
    send(json.dumps({"id": sequence, "guid": guid, "method": method, "params": params,
                     "metadata": {"apiName": "container.fixture", "internal": True}}).encode())
    while True:
        first, second = read_exact(2)
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", read_exact(2))[0]
        elif size == 127:
            size = struct.unpack("!Q", read_exact(8))[0]
        assert not second & 0x80 and size < 4 * 1024 * 1024
        payload = read_exact(size)
        if first & 0xF == 9:
            send(payload, opcode=10)
            continue
        assert first & 0xF == 1 and first & 0x80
        packet = json.loads(payload)
        if packet.get("method") == "__create__":
            obj = packet["params"]
            objects[obj["guid"]] = obj
        if packet.get("id") == sequence:
            assert "error" not in packet, packet.get("error")
            return packet.get("result", {})


try:
    call("", "initialize", {"sdkLanguage": "javascript"})
    browser = next(guid for guid, obj in objects.items() if obj["type"] == "Browser")
    context = call(browser, "newContext", {"acceptDownloads": "deny", "viewport": {"width": 640, "height": 480}})["context"]["guid"]
    page = call(context, "newPage", {})["page"]["guid"]
    frame = objects[page]["initializer"]["mainFrame"]["guid"]
    call(frame, "setContent", {"html": "<title>Container client</title>", "waitUntil": "load", "timeout": 5000})
    assert call(frame, "title", {})["value"] == "Container client"
    call(context, "close", {})
    print("Docker client: authenticated remote context/page worked without launching a browser")
finally:
    connection.close()
