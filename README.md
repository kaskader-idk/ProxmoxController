# ProxmoxController

Ein selbst gehostetes Dashboard für einen Proxmox-VE-Host. Die Weboberfläche fragt im 5-Sekunden-Takt das lokale Backend ab. Das Backend liest Hostwerte direkt aus Debian und CT-/VM-Status sowie Storage-Daten aus der Proxmox-API.

## Funktionen

- Host-CPU, logische Kerne, Arbeitsspeicher, Dateisysteme und Blockgeräte
- NVIDIA-GPU-Auslastung, VRAM und Temperatur, sofern `nvidia-smi` verfügbar ist
- Alle CTs und VMs mit Status, CPU-Anteil, konfigurierten Kernen, RAM und Disk; Starten und Stoppen per Schaltfläche
- Proxmox-Storage-Pools und Host-Laufwerke
- Installierte Debian-Pakete mit Suchfeld
- Drag-and-drop-Upload in einen separaten Ablageordner sowie Downloads
- HTTP-Basic-Anmeldung für Dashboard, API, Dateiablage und Start-/Stop-Aktionen

Der Upload legt Dateien lediglich ab. Er kopiert sie nicht automatisch in einen CT/eine VM, installiert sie nicht und führt sie nicht aus. Geräte-Passthrough-GPUs innerhalb einer VM lassen sich durch die Proxmox-API nicht als deren aktuelle GPU-Auslastung messen; angezeigt wird die NVIDIA-GPU des Hosts.

## Voraussetzungen

- Proxmox VE (das Projekt ist für den Lauf direkt auf dem PVE-Host ausgelegt)
- Python 3.11 oder neuer
- Für Host-Paketliste und Blockgeräte: Debian-Tools `dpkg-query` und `lsblk` (auf PVE vorhanden)
- Für NVIDIA-Werte optional: funktionierendes `nvidia-smi`
- Ein Proxmox-API-Token und ein starkes Dashboard-Passwort

## 1. API-Benutzer und eingeschränkten Token anlegen

Die Website nutzt einen Token statt des Proxmox-root-Passworts. Auf dem Proxmox-Host als root ausführen:

```bash
pveum user add proxmoxcontroller@pve --comment "ProxmoxController Dashboard"
pveum role add ProxmoxController --privs "Sys.Audit Datastore.Audit VM.Audit VM.PowerMgmt"
pveum acl modify / --user proxmoxcontroller@pve --role ProxmoxController
pveum user token add proxmoxcontroller@pve dashboard --privsep 1
pveum acl modify / --token 'proxmoxcontroller@pve!dashboard' --role ProxmoxController
```

Beim letzten Token-Befehl gibt Proxmox das Token-Geheimnis genau einmal aus. Für `PVE_API_TOKEN` später den vollständigen Wert im Format `proxmoxcontroller@pve!dashboard=GEHEIMNIS` verwenden. Das Token kann CTs/VMs sehen und deren Energiezustand ändern; es erhält keine Rechte zur Änderung der Konfiguration oder Benutzerverwaltung. Wenn deine Proxmox-Version einen der Privileg-Namen ablehnt, erstelle die Rolle in der Proxmox-Weboberfläche mit denselben passenden Berechtigungen.

## 2. Repository auf dem Host installieren

```bash
cd /opt
git clone https://github.com/kaskader-idk/ProxmoxController.git
cd /opt/ProxmoxController
apt update
apt install -y python3 python3-venv python3-pip
useradd --system --home /var/lib/proxmox-controller --create-home --shell /usr/sbin/nologin proxmox-controller
install -d -o proxmox-controller -g proxmox-controller /var/lib/proxmox-controller/uploads
python3 -m venv /opt/ProxmoxController/.venv
/opt/ProxmoxController/.venv/bin/pip install -r requirements.txt
```

Konfiguration anlegen und nur für root lesbar machen:

```bash
cp .env.example /etc/default/proxmox-controller
nano /etc/default/proxmox-controller
chmod 600 /etc/default/proxmox-controller
```

`PVE_NODE` muss dem Knotennamen entsprechen, den Proxmox unter **Datacenter → Nodes** zeigt. Mit `hostname` lässt er sich normalerweise auf dem Host prüfen. `PVE_API_TOKEN` und `APP_PASSWORD` ersetzen. Verwende für `APP_PASSWORD` ein langes, einzigartiges Passwort. Das Zertifikat unter `/etc/pve/pve-root-ca.pem` wird standardmäßig zur TLS-Prüfung der lokalen Proxmox-API benutzt.

Dienst einrichten und starten:

```bash
install -m 644 systemd/proxmox-controller.service /etc/systemd/system/proxmox-controller.service
systemctl daemon-reload
systemctl enable --now proxmox-controller
systemctl status proxmox-controller
```

Aufrufen: `http://IP-DES-PROXMOX-HOSTS:8787`. Zugangsdaten aus `APP_USER` und `APP_PASSWORD` verwenden. Logs: `journalctl -u proxmox-controller -f`.

## Netzwerk und Sicherheit

Der Dienst läuft mit eigenem Linux-Systembenutzer, bindet standardmäßig an `0.0.0.0:8787` und verlangt HTTP-Basic-Anmeldedaten. HTTP-Basic verschlüsselt das Passwort nicht selbst. Stelle den Port nur in einem vertrauenswürdigen LAN oder über Tailscale bereit. Für Zugriff außerhalb davon den Dienst hinter einen TLS-Reverse-Proxy (zum Beispiel Nginx Proxy Manager) setzen und Port 8787 nicht direkt ins Internet weiterleiten. Beschränke den Proxmox-API-Token auf diesen Zweck und veröffentliche weder Token noch `/etc/default/proxmox-controller`.

Der Upload ist standardmäßig auf 2 GiB pro Datei begrenzt. Ablageort: `/var/lib/proxmox-controller/uploads`. Das Limit kann in `/etc/default/proxmox-controller` über `MAX_UPLOAD_BYTES` gesetzt werden. Vorhandene Dateinamen werden nicht überschrieben.

## Konfiguration

| Variable | Standard | Zweck |
|---|---|---|
| `PVE_API` | `https://127.0.0.1:8006/api2/json` | Proxmox-API-Basisadresse |
| `PVE_NODE` | Hostname | Proxmox-Knotenname |
| `PVE_API_TOKEN` | – | API-Token im Format `user@realm!id=secret` |
| `PVE_CA_CERT` | `/etc/pve/pve-root-ca.pem` | CA-Zertifikat für TLS-Prüfung |
| `PVE_TLS_VERIFY` | `true` | Zertifikatsprüfung aktivieren |
| `APP_USER` / `APP_PASSWORD` | – | Dashboard-Anmeldung |
| `UPLOAD_DIR` | `/var/lib/proxmox-controller/uploads` | Upload-Ablage |
| `MAX_UPLOAD_BYTES` | `2147483648` | Upload-Limit je Datei in Bytes |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Webserver-Adresse und Port |

## Entwicklung und Fehlerbehebung

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Werte in .env setzen und dann:
cd app
../.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

- `503 PVE_API_TOKEN ist nicht konfiguriert`: Token-Variable in `/etc/default/proxmox-controller` prüfen.
- `502 Proxmox API Anfrage fehlgeschlagen`: Knotenname, Token-Secret und Token-ACL kontrollieren; Logs zeigen den Fehler.
- TLS-Fehler: CA-Pfad prüfen. `PVE_TLS_VERIFY=false` nur vorübergehend zum Eingrenzen verwenden.
- GPU fehlt: `nvidia-smi` als Dienstbenutzer testen. Nur NVIDIA-Karten werden erkannt.
- Start/Stop verweigert: Das Token benötigt `VM.PowerMgmt` und `VM.Audit` auf den betreffenden CTs/VMs.

## Aufbau

```text
app/main.py                 FastAPI, Proxmox-API, Hostdaten, Upload
app/static/index.html       Dashboard-Struktur
app/static/style.css        Layout und Darstellung
app/static/app.js           Live-Aktualisierung und Interaktionen
systemd/proxmox-controller.service
```
