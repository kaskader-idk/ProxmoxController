#!/usr/bin/python3
"""Run a small, bounded file operation inside one explicitly selected LXC CT."""
import subprocess
import sys

MAX_BYTES = 512 * 1024**2
GUEST_SCRIPT = r'''
import json, os, pathlib, stat, sys
op, path = sys.argv[1:]
if not path.startswith('/') or '\x00' in path or '..' in path.split('/'):
    raise SystemExit('Ungültiger Dateipfad')
target = pathlib.Path(path)
if op == 'list':
    if not target.is_dir(): raise SystemExit('Kein Verzeichnis')
    rows=[]
    for item in target.iterdir():
        try: info=item.lstat()
        except OSError: continue
        kind='dir' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
        rows.append({'name':item.name,'kind':kind,'size':info.st_size,'modified':info.st_mtime})
    print(json.dumps({'path':str(target),'entries':sorted(rows,key=lambda x:(x['kind']!='dir',x['name'].lower()))}))
elif op == 'read':
    if not target.is_file(): raise SystemExit('Keine reguläre Datei')
    if target.stat().st_size > 512*1024**2: raise SystemExit('Datei ist größer als das Limit von 512 MiB')
    with target.open('rb') as f: data=f.read(512*1024**2+1)
    if len(data)>512*1024**2: raise SystemExit('Datei ist größer als das Limit von 512 MiB')
    sys.stdout.buffer.write(data)
elif op == 'write':
    if not target.parent.is_dir(): raise SystemExit('Zielordner existiert nicht')
    created=False
    try:
        with target.open('xb') as f:
            created=True
            total=0
            while True:
                chunk=sys.stdin.buffer.read(1024*1024)
                if not chunk: break
                total+=len(chunk)
                if total>512*1024**2: raise SystemExit('Upload überschreitet das Limit von 512 MiB')
                f.write(chunk)
    except BaseException:
        if created: target.unlink(missing_ok=True)
        raise
else: raise SystemExit('Ungültige Operation')
'''


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def main() -> None:
    if len(sys.argv) != 4:
        fail("Aufruf: pct_files.py list|read|write VMID /pfad", 2)
    op, vmid_text, path = sys.argv[1:]
    if op not in {"list", "read", "write"} or not vmid_text.isdigit() or int(vmid_text) < 100:
        fail("Ungültige Operation oder VMID", 2)
    if not path.startswith("/") or "\x00" in path or ".." in path.split("/"):
        fail("Ungültiger Dateipfad", 2)
    try:
        result = subprocess.run(
            ["/usr/sbin/pct", "exec", vmid_text, "--", "python3", "-c", GUEST_SCRIPT, op, path],
            input=sys.stdin.buffer.read(MAX_BYTES + 1) if op == "write" else None,
            capture_output=True, timeout=25, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail(f"pct exec fehlgeschlagen: {exc}")
    if result.returncode:
        fail(result.stderr.decode("utf-8", "replace").strip() or "CT-Dateioperation fehlgeschlagen")
    if op == "write" and len(result.stdout) > 0:
        fail("Unerwartete Antwort von pct exec")
    if op == "read" and len(result.stdout) > MAX_BYTES:
        fail("Datei ist größer als das Limit von 512 MiB")
    sys.stdout.buffer.write(result.stdout)


if __name__ == "__main__":
    main()
