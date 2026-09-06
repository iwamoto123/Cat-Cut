"""Network helpers for Mac environments where IPv6 is advertised but unusable."""

import socket
from contextlib import contextmanager

_getaddrinfo_orig = socket.getaddrinfo


def prefer_ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    results = _getaddrinfo_orig(host, port, family, type, proto, flags)
    v4 = [row for row in results if row[0] == socket.AF_INET]
    return v4 or results


@contextmanager
def prefer_ipv4():
    prev = socket.getaddrinfo
    socket.getaddrinfo = prefer_ipv4_getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = prev
