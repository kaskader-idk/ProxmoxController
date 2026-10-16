# ProxmoxController

Ein selbst gehostetes Dashboard für einen Proxmox-VE-Host. Host- und Workload-Daten werden etwa einmal pro Sekunde aktualisiert. Häufig abgefragte, langsam veränderliche Daten wie installierte Pakete werden im Backend kurz zwischengespeichert.

## Funktionen

- CPU-Auslastung des Hosts und separate Auslastung jedes logischen Kerns
- Host-RAM, Dateisysteme, Blockgeräte und Proxmox-Storage-Pools
- NVIDIA-GPU-Auslastung, VRAM und Temperatur, sofern `nvidia-smi` verfügbar
- CTs und VMs mit Status, CPU-Auslastung, konfigurierten Kernen, RAM und Disk; Starten und Stoppen per Schaltfläche
- Anklickbare CTs/VMs mit Datei-Explorer, Download und Drag-and-drop-Upload ins Gast-Dateisystem
- Installierte Debian-Pakete mit Suche
- HTTP-Basic-Anmeldung für Dashboard und API

Der Dateibrowser funktioniert bei laufenden Gästen. Bei VMs muss der QEMU Guest Agent installiert und in der VM-Konfiguration aktiviert sein. Bei LXC wird `pct exec` über eine sudoers-Regel mit festem Hilfsskript ausgeführt; im CT wird Python 3 benötigt. Vorhandene Dateien werden nicht überschrieben. VM-Dateien sind standardmäßig auf 8 MiB, CT-Dateien auf 512 MiB begrenzt. Die Limits lassen sich über Umgebungsvariablen ändern. Geräte-Passthrough-GPUs in einer VM können nicht als aktuelle VM-GPU-Auslastung gemessen werden; angezeigt wird die NVIDIA-GPU des Hosts.

## Voraussetzungen

- Proxmox VE; die Anwendung läuft direkt auf dem PVE-Host.
- Python 3.11 oder neuer, `sudo`, `dpkg-query` und `lsblk`.
- Für VM-Dateien: QEMU Guest Agent in der VM installiert und aktiviert.
- Für CT-Dateien: laufender Container mit Python 3.
- Ein Proxmox-API-Token und ein starkes Dashboard-Passwort.

## 1. API-Benutzer und Token einrichten

Auf dem Proxmox-Host als root ausführen. Bei bereits angelegtem Benutzer/Rolle nur fehlende Befehle anwenden.

```bash
pveum user add proxmoxcontroller@pve --comment "ProxmoxController Dashboard"
pveum role add ProxmoxController --privs "Sys.Audit Datastore.Audit VM.Audit VM.PowerMgmt VM.GuestAgent.Unrestricted"
pveum acl modify / --user proxmoxcontroller@pve --role ProxmoxController
pveum user token add proxmoxcontroller@pve dashboard --privsep 1
pveum acl modify / --token 'proxmoxcontroller@pve!dashboard' --role ProxmoxController
```

Das Token-Geheimnis wird nur einmal ausgegeben. In `PVE_API_TOKEN` kommt der vollständige Wert im Format `proxmoxcontroller@pve!dashboard=GEHEIMNIS`. Bei einer vorhandenen Rolle das benötigte Guest-Agent-Recht ergänzen:

```bash
pveum role modify ProxmoxController --privs "Sys.Audit Datastore.Audit VM.Audit VM.PowerMgmt VM.GuestAgent.Unrestricted"
```

`VM.GuestAgent.Unrestricted` wird benötigt, damit der Dateibrowser Verzeichnisse in VMs auflisten und Dateien übertragen kann. Damit kann der Token weitreichende Befehle über den QEMU Guest Agent in laufenden VMs ausführen. Den Token und das Dashboard-Passwort daher geheim halten. Das Proxmox-Token erhält keine Rechte zur Änderung der VM-Konfiguration oder Benutzerverwaltung.

## 2. Repository installieren

```bash
cd /opt
git clone https://github.com/kaskader-idk/ProxmoxController.git
cd /opt/ProxmoxController
apt update
apt install -y python3 python3-venv python3-pip sudo
useradd --system --home /var/lib/proxmox-controller --create-home --shell /usr/sbin/nologin proxmox-controller
install -d -o proxmox-controller -g proxmox-controller /var/lib/proxmox-controller
python3 -m venv /opt/ProxmoxController/.venv
/opt/ProxmoxController/.venv/bin/pip install -r requirements.txt
install -o root -g root -m 755 scripts/pct_files.py /opt/ProxmoxController/scripts/pct_files.py
install -o root -g root -m 440 sudoers/proxmox-controller /etc/sudoers.d/proxmox-controller
visudo -cf /etc/sudoers.d/proxmox-controller
```

Die sudoers-Regel erlaubt dem Dienstbenutzer nur, das root-eigene CT-Hilfsskript mit Argumenten aufzurufen. Das Skript begrenzt Aktionen auf `list`, `read` und `write` innerhalb eines angegebenen, laufenden Containers.

## 3. Konfiguration und Dienst starten

```bash
cp .env.example /etc/default/proxmox-controller
nano /etc/default/proxmox-controller
chmod 600 /etc/default/proxmox-controller
```

`PVE_NODE` muss dem Namen unter **Datacenter → Nodes** entsprechen. `PVE_API_TOKEN` und `APP_PASSWORD` ersetzen; für `APP_PASSWORD` ein langes, einzigartiges Passwort verwenden.

```bash
install -m 644 systemd/proxmox-controller.service /etc/systemd/system/proxmox-controller.service
systemctl daemon-reload
systemctl enable --now proxmox-controller
systemctl status proxmox-controller
```

Dashboard: `http://IP-DES-PROXMOX-HOSTS:8787`. Die Zugangsdaten sind `APP_USER` und `APP_PASSWORD`. Logs: `journalctl -u proxmox-controller -f`.

## Updates

Wenn `/opt/ProxmoxController` ein Git-Checkout ist (`test -d .git`), dann:

```bash
cd /opt/ProxmoxController
git pull
/opt/ProxmoxController/.venv/bin/pip install -r requirements.txt
install -o root -g root -m 755 scripts/pct_files.py /opt/ProxmoxController/scripts/pct_files.py
install -o root -g root -m 440 sudoers/proxmox-controller /etc/sudoers.d/proxmox-controller
visudo -cf /etc/sudoers.d/proxmox-controller
install -m 644 systemd/proxmox-controller.service /etc/systemd/system/proxmox-controller.service
systemctl daemon-reload
systemctl restart proxmox-controller
```

Falls die vorhandene `/opt/ProxmoxController`-Mappe kein `.git` enthält, kann `git pull` dort nicht funktionieren. Mappe erst umbenennen/sichern und dann das Repository sauber klonen.

## Netzwerk und Sicherheit

Der Dienst läuft mit eigenem Linux-Systembenutzer, bindet standardmäßig an `0.0.0.0:8787` und verlangt HTTP-Basic-Anmeldedaten. HTTP-Basic verschlüsselt das Passwort nicht selbst. Stelle den Port nur in einem vertrauenswürdigen LAN oder über Tailscale bereit. Für Zugriff von außerhalb den Dienst hinter einen TLS-Reverse-Proxy setzen und Port 8787 nicht direkt ins Internet weiterleiten. Token und `/etc/default/proxmox-controller` niemals veröffentlichen.

## Konfiguration

| Variable | Standard | Zweck |
|---|---|---|
| `PVE_API` | `https://127.0.0.1:8006/api2/json` | Proxmox-API-Basisadresse |
| `PVE_NODE` | Hostname | Proxmox-Knotenname |
| `PVE_API_TOKEN` | – | Token im Format `user@realm!id=secret` |
| `PVE_CA_CERT` | `/etc/pve/pve-root-ca.pem` | CA-Zertifikat für TLS-Prüfung |
| `PVE_TLS_VERIFY` | `true` | Zertifikatsprüfung aktivieren |
| `APP_USER` / `APP_PASSWORD` | – | Dashboard-Anmeldung |
| `MAX_VM_FILE_BYTES` | `8388608` | VM-Dateigröße maximal in Bytes |
| `MAX_CT_FILE_BYTES` | `536870912` | CT-Dateigröße maximal in Bytes |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Webserver-Adresse und Port |

## Fehlerbehebung

- `503 PVE_API_TOKEN ist nicht konfiguriert`: `/etc/default/proxmox-controller` prüfen und Dienst neu starten.
- `502 Proxmox API HTTP 401`: Token-ID und Token-Geheimnis in `PVE_API_TOKEN` kontrollieren.
- TLS-Fehler: CA-Pfad prüfen. `PVE_TLS_VERIFY=false` nur vorübergehend zum Eingrenzen verwenden.
- VM-Dateibrowser nicht verfügbar: QEMU Guest Agent installieren und in der VM-Konfiguration aktivieren; dem API-Token muss `VM.GuestAgent.Unrestricted` zugewiesen sein.
- CT-Dateibrowser meldet sudo-Fehler: sudoers-Datei und root-eigenes Skript anhand der Installationsschritte aktualisieren. Der CT muss laufen und Python 3 enthalten.
- Start/Stop verweigert: Das Token benötigt `VM.PowerMgmt` und `VM.Audit` auf den betreffenden CTs/VMs.
- GPU fehlt: `nvidia-smi` als Dienstbenutzer testen. Nur NVIDIA-Karten werden erkannt.

## Aufbau

```text
app/main.py                  FastAPI, Proxmox-API, Hostdaten und Gast-Dateibrowser
app/static/index.html        Dashboard-Struktur
app/static/style.css         Layout und Darstellung
app/static/app.js            Ein-Sekunden-Aktualisierung und Interaktionen
scripts/pct_files.py         CT-Dateioperationen über pct exec
sudoers/proxmox-controller   Erlaubte sudo-Aktion des Dienstbenutzers
systemd/proxmox-controller.service
```
