"""Regenerate synthetic test assets with libultrahdr and libavif command-line tools.

Uses only Python's standard library. No photographs or external downloads.
"""
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib


def run(*args):
    subprocess.run([str(value) for value in args], check=True)


def encode_srgb(value):
    return 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055


def png16(file, values):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    row = b'\0' + b''.join(struct.pack('>HHH', *([round(v * 65535)] * 3)) for v in values)
    file.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 128, 96, 16, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(row * 96)) + chunk(b'IEND', b''))


def encode_pq(value):
    p = (value * 203 / 10000) ** (2610 / 16384)
    return ((3424 / 4096 + 2413 / 128 * p) / (1 + 2392 / 128 * p)) ** (2523 / 32)


destination = Path(__file__).resolve().parent.parent / 'src/image/fixtures'
destination.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory() as folder:
    folder = Path(folder)
    hdr, sdr = bytearray(), bytearray()
    for y in range(96):
        for x in range(128):
            region = x // 32
            hdr_value = [0.25, 1, 2, 4][region]
            sdr_value = round(encode_srgb([0.125, 0.25, 0.5, 0.75][region]) * 255)
            hdr.extend(struct.pack('<4e', hdr_value, hdr_value, hdr_value, 1))
            sdr.extend(bytes([sdr_value] * 3 + [255]))
    (folder / 'hdr.raw').write_bytes(hdr)
    (folder / 'sdr.raw').write_bytes(sdr)
    jpeg = destination / 'steps.jpg'
    run('ultrahdr_app', '-m', '0', '-p', folder / 'hdr.raw', '-y', folder / 'sdr.raw',
        '-a', '4', '-b', '3', '-t', '0', '-C', '0', '-c', '0', '-w', '128', '-h', '96',
        '-q', '100', '-Q', '100', '-s', '1', '-M', '1', '-L', '812', '-z', jpeg)
    png16(folder / 'sdr.png', [encode_srgb([0.125, 0.25, 0.5, 0.75][x // 32]) for x in range(128)])
    png16(folder / 'hdr.png', [encode_pq([0.25, 1, 2, 4][x // 32]) for x in range(128)])
    run('avifgainmaputil', 'combine', folder / 'sdr.png', folder / 'hdr.png', destination / 'steps.avif',
        '-q', '100', '--qgain-map', '100', '-d', '10', '-y', '444', '--ignore-profile',
        '--cicp-base', '1/13/6', '--cicp-alternate', '1/16/6', '--max-headroom', '0')
