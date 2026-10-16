# ProxmoxController

Ein Web-Dashboard für deinen Proxmox-VE-Host. Es zeigt die Auslastung des Hosts und seiner CTs/VMs an und bietet Start-/Stopp-Schaltflächen sowie einen Datei-Explorer für die Gäste.

## Das zeigt das Dashboard

- Schnelle Systemübersicht mit CPU-Auslastung des Hosts und jedes logischen CPU-Kerns
- CPU-Frequenz und CPU-Temperatur, sofern Proxmox die Sensorwerte bereitstellt
- RAM und Swap, Datenträger-Lese-/Schreibrate und Netzwerkgeschwindigkeit je Schnittstelle
- Arbeitsspeicher, GPU-Auslastung (NVIDIA), Dateisysteme, Laufwerke und Proxmox-Storage-Pools
- Alle CTs und VMs mit Status, CPU-Auslastung, RAM, Disk und zugewiesenen vCPUs
- Übersicht über konfigurierte Gast-Ressourcen und noch verfügbare Host-Kapazität
- CPU-Modell und Host-Kern-Zuweisung: bei VMs die konfigurierte Affinität, bei laufenden CTs die aktuell von Proxmox zugeteilten Host-Kerne
- Starten und Stoppen von CTs und VMs
- Installierte Debian-Pakete auf dem Proxmox-Host
- Eigene Detailseite für jeden CT/jede VM mit Gast-Auslastung, Datei-Explorer, Download, Drag-and-drop-Upload und Shell-Befehlen
- Optionaler KI-Assistent mit OpenAI-kompatibler API. Jeder KI-Befehl muss vor Ausführung einzeln bestätigt werden.
- Paket-Suche: installierte Pakete durchsuchen und bei nicht installierten Paketen APT-Vorschläge anzeigen
- Aktualisierung der Live-Daten ungefähr einmal pro Sekunde
- Normale Login-Seite statt Browser-Anmelde-Popup; Sitzung läuft nach 12 Stunden ab

## Voraussetzungen

- Proxmox VE 9 oder neuer; installiert wird direkt auf dem Proxmox-Host.
- Zugriff auf den Host als `root` über Konsole oder SSH.
- Internetzugriff vom Host, um das Repository und Python-Pakete herunterzuladen.
- Für VM-Dateien: Linux-VM mit installiertem und aktiviertem QEMU Guest Agent sowie Python 3.
- Für CT-Dateien: laufender Linux-Container mit Python 3.

Die CPU-Auslastung stammt aus Proxmox. Bei VMs zeigt das Dashboard deren CPU-Modell und – sofern gesetzt – CPU-Affinität; ohne Affinität kann die VM auf allen Host-Kernen laufen. Bei laufenden CTs zeigt es die momentane, von Proxmox dynamisch verteilte Host-Kern-Zuweisung. Diese CT-Zuweisung kann sich zur Laufzeit ändern.\n\nDer Datei-Explorer zeigt das Dateisystem **des ausgewählten Gasts**, nicht das des Proxmox-Hosts. Die Gast-Shell führt einzelne Linux-Befehle im ausgewählten Gast aus; sie ist keine dauerhafte interaktive TTY-Sitzung. Für VMs muss der QEMU Guest Agent laufen. CT-Befehle werden über die bereits eingeschränkte sudoers-Regel und das root-eigene Hilfsskript ausgeführt.

Die optionale KI-Verbindung verwendet eine OpenAI-kompatible Chat-Completions-API. Trage Basis-URL, Modell und optionalen API-Key auf der Gast-Detailseite ein. Der API-Key wird auf dem Proxmox-Host in `/var/lib/proxmox-controller/ai-settings.json` mit Dateirechten 600 gespeichert. Die KI erhält den Chatverlauf und die Ausgaben der Befehle, die du bestätigst. Sie kann keine Shell-Befehle ohne deine Freigabe starten. Die obersten Ordner unter `/` sehen bei Linux-Systemen oft ähnlich aus. Ordner anklicken, um deren Inhalt zu sehen. Dateien werden beim Upload nicht überschrieben. VM-Dateien sind standardmäßig auf 8 MiB begrenzt, CT-Dateien auf maximal 512 MiB.

## 1. Proxmox-API-Zugriff einrichten

Das Dashboard verwendet einen API-Token. Es braucht kein Proxmox-root-Passwort. Die folgenden Befehle auf dem Proxmox-Host als `root` ausführen.

### Neuen Benutzer, Rolle und Token erstellen

Diese Befehle nur ausführen, wenn Benutzer und Rolle noch nicht angelegt sind:

```bash
pveum user add proxmoxcontroller@pve --comment "ProxmoxController Dashboard"
pveum role add ProxmoxController --privs "Sys.Audit Datastore.Audit VM.Audit VM.PowerMgmt VM.GuestAgent.Unrestricted"
pveum acl modify / --user proxmoxcontroller@pve --role ProxmoxController
pveum user token add proxmoxcontroller@pve dashboard --privsep 1
pveum acl modify / --token 'proxmoxcontroller@pve!dashboard' --role ProxmoxController
```

Beim Befehl `pveum user token add` zeigt Proxmox einen geheimen Wert an. Kopiere ihn sofort. Er wird später als vollständiger Wert in dieser Form eingetragen:

```text
proxmoxcontroller@pve!dashboard=HIER_DAS_TOKEN_SECRET
```

**Das Token-Secret nicht hier in GitHub oder in Chats einfügen.** Wenn du bereits einen API-Benutzer und eine Rolle eingerichtet hast, erstelle keinen zweiten Benutzer. Ergänze nur das Guest-Agent-Recht:

```bash
pveum role modify ProxmoxController --privs "Sys.Audit Datastore.Audit VM.Audit VM.PowerMgmt VM.GuestAgent.Unrestricted"
```

`VM.GuestAgent.Unrestricted` wird für den VM-Datei-Explorer benötigt. Es erlaubt weitreichende Befehle in einer VM, wenn deren Guest Agent läuft. Schütze deshalb das Token und das Dashboard-Passwort. CT-Dateizugriff verwendet eine separate, auf ein Hilfsskript beschränkte sudoers-Regel.

## 2. Repository herunterladen und installieren

Alle Befehle in diesem Abschnitt auf dem Proxmox-Host als `root` ausführen.

### Pakete installieren

```bash
apt update
apt install -y git python3 python3-venv python3-pip sudo
```

### Repository herunterladen

```bash
cd /opt
```

Wenn `/opt/ProxmoxController` **noch nicht existiert**, klone das Repository:

```bash
git clone https://github.com/kaskader-idk/ProxmoxController.git
```

Wenn `/opt/ProxmoxController` bereits existiert, zuerst prüfen, ob es ein Git-Checkout ist:

```bash
test -d /opt/ProxmoxController/.git && echo "Git-Checkout vorhanden" || echo "Kein Git-Checkout"
```

Bei `Kein Git-Checkout` die alte Mappe zur Sicherheit umbenennen und danach klonen:

```bash
systemctl stop proxmox-controller 2>/dev/null || true
mv /opt/ProxmoxController "/opt/ProxmoxController-backup-$(date +%s)"
git clone https://github.com/kaskader-idk/ProxmoxController.git
```

Dann die Python-Umgebung und Abhängigkeiten einrichten:

```bash
cd /opt/ProxmoxController
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### Dienstbenutzer und CT-Dateihilfe installieren

```bash
getent passwd proxmox-controller >/dev/null || useradd --system --home /var/lib/proxmox-controller --create-home --shell /usr/sbin/nologin proxmox-controller
install -d -o proxmox-controller -g proxmox-controller /var/lib/proxmox-controller
install -o root -g root -m 755 scripts/pct_files.py /opt/ProxmoxController/scripts/pct_files.py
install -o root -g root -m 440 sudoers/proxmox-controller /etc/sudoers.d/proxmox-controller
visudo -cf /etc/sudoers.d/proxmox-controller
```

Das Skript unter `/opt/ProxmoxController/scripts/pct_files.py` muss root gehören. Die sudoers-Regel erlaubt dem Dashboard-Dienst nur, dieses Skript aufzurufen.

## 3. Einstellungen eintragen

Konfiguration aus der Vorlage erstellen und öffnen:

```bash
cp .env.example /etc/default/proxmox-controller
nano /etc/default/proxmox-controller
```

Mindestens diese drei Werte prüfen:

```text
PVE_NODE=kamilsServer
PVE_API_TOKEN=proxmoxcontroller@pve!dashboard=HIER_DAS_TOKEN_SECRET
APP_PASSWORD=HIER_EIN_LANGES_EIGENES_PASSWORT
```

- `PVE_NODE`: den Namen des Proxmox-Knotens verwenden. Anzeigen mit `hostname` oder in **Datacenter → Nodes**.
- `PVE_API_TOKEN`: den vollständigen Token-Wert einsetzen, inklusive `=SECRET`.
- `APP_USER` und `APP_PASSWORD`: Benutzername und Passwort für die Login-Seite des Dashboards selbst wählen.
- `APP_SESSION_SECRET`: Optionaler geheimer Schlüssel zum Signieren der Login-Sitzung. Erzeugen mit `openssl rand -hex 32`. Wenn leer, wird `APP_PASSWORD` verwendet.
- `PVE_CA_CERT`: Zertifikat für die sichere Verbindung zur lokalen Proxmox-API. Standardmäßig `/etc/pve/pve-root-ca.pem`.

Anschließend die Konfigurationsdatei schützen:

```bash
chmod 600 /etc/default/proxmox-controller
```

Falls der Dienst beim Start `Permission denied` für `/etc/pve/pve-root-ca.pem` meldet, kopiere das Zertifikat in einen für den Dienst lesbaren Ordner und setze `PVE_CA_CERT` auf den neuen Pfad:

```bash
install -d -o root -g proxmox-controller -m 750 /etc/proxmox-controller
install -o root -g proxmox-controller -m 640 /etc/pve/pve-root-ca.pem /etc/proxmox-controller/pve-root-ca.pem
nano /etc/default/proxmox-controller
```

In der geöffneten Datei dann setzen:

```text
PVE_CA_CERT=/etc/proxmox-controller/pve-root-ca.pem
```

## 4. Dienst starten

```bash
install -d /run/lxc/lock
install -m 644 /opt/ProxmoxController/systemd/proxmox-controller.service /etc/systemd/system/proxmox-controller.service
systemctl daemon-reload
systemctl enable --now proxmox-controller
systemctl status proxmox-controller
```

Dashboard im Browser öffnen:

```text
http://IP-DEINES-PROXMOX-HOSTS:8787
```

Melde dich mit `APP_USER` und `APP_PASSWORD` an. Die IP-Adresse findest du auf dem Proxmox-Host mit `hostname -I`.

## 5. QEMU Guest Agent in VMs einschalten

Damit der Datei-Explorer eine VM öffnen kann, muss dort der QEMU Guest Agent laufen. In Proxmox die VM auswählen, **Options → QEMU Guest Agent** aktivieren und den Guest Agent im Linux-System der VM installieren. Danach die VM starten oder neu starten. Python 3 muss ebenfalls in der VM installiert sein.

## Später aktualisieren

Wenn `/opt/ProxmoxController` ein Git-Checkout ist:

```bash
cd /opt/ProxmoxController
git pull --ff-only
.venv/bin/pip install -r requirements.txt
install -o root -g root -m 755 scripts/pct_files.py /opt/ProxmoxController/scripts/pct_files.py
install -o root -g root -m 440 sudoers/proxmox-controller /etc/sudoers.d/proxmox-controller
visudo -cf /etc/sudoers.d/proxmox-controller
install -m 644 systemd/proxmox-controller.service /etc/systemd/system/proxmox-controller.service
install -d /run/lxc/lock
systemctl daemon-reload
systemctl restart proxmox-controller
```

Die Datei `/etc/default/proxmox-controller` enthält deine Einstellungen und wird durch `git pull` nicht überschrieben.

## Fehlerbehebung

### `destination path 'ProxmoxController' already exists`

Die Mappe existiert bereits. Prüfe, ob es ein Git-Checkout ist:

```bash
test -d /opt/ProxmoxController/.git && echo "git pull verwenden" || echo "Mappe sichern und neu klonen"
```

Wenn `.git` existiert, nach `/opt/ProxmoxController` wechseln und `git pull --ff-only` ausführen. Wenn `.git` fehlt, die Mappe umbenennen, wie im Download-Abschnitt beschrieben.

### `Permission denied` bei Proxmox-Daten oder Zertifikat

Zertifikat wie oben beschrieben kopieren. Die Upload-/Arbeitsablage muss dem Dienstbenutzer gehören:

```bash
install -d -o proxmox-controller -g proxmox-controller /var/lib/proxmox-controller
```

### Proxmox-API meldet HTTP 401

`PVE_API_TOKEN` in `/etc/default/proxmox-controller` prüfen. Der Wert muss Token-ID und Secret enthalten. Danach:

```bash
systemctl restart proxmox-controller
```

### `lxc-attach ... Read-only file system` beim CT-Datei-Explorer

Die systemd-Datei muss diese Zeile enthalten, damit LXC seine Sperrdatei verwenden kann:

```ini
ReadWritePaths=/var/lib/proxmox-controller /run/lxc/lock
```

Anwenden:

```bash
install -d /run/lxc/lock
systemctl daemon-reload
systemctl restart proxmox-controller
```

### VM-Datei-Explorer zeigt einen Guest-Agent-Fehler

Guest Agent in der VM installieren und aktivieren. Prüfen, ob der Proxmox-Rolle `ProxmoxController` das Recht `VM.GuestAgent.Unrestricted` zugewiesen wurde. Der Gast muss außerdem Python 3 enthalten.

### Logs ansehen

```bash
journalctl -u proxmox-controller -n 100 --no-pager
journalctl -u proxmox-controller -f
```

## Netzwerk und Sicherheit

Der Dienst lauscht standardmäßig auf `0.0.0.0:8787` und zeigt vor dem Dashboard eine Login-Seite. Nach erfolgreichem Login wird eine signierte, HTTP-only Sitzung im Browser-Cookie gespeichert; sie läuft nach 12 Stunden ab. Über **Abmelden** wird das Cookie gelöscht. Verwende den Port nur im vertrauenswürdigen LAN oder über Tailscale. Für Zugriff aus dem Internet einen TLS-Reverse-Proxy verwenden und Port 8787 nicht direkt öffentlich freigeben. Proxmox-Token, Dashboard-Passwort, Sitzungsschlüssel und `/etc/default/proxmox-controller` geheim halten.

## Einstellbare Werte

| Variable | Standard | Bedeutung |
|---|---|---|
| `PVE_API` | `https://127.0.0.1:8006/api2/json` | Adresse der Proxmox-API |
| `PVE_NODE` | Hostname | Name des Proxmox-Knotens |
| `PVE_API_TOKEN` | – | Proxmox API-Token |
| `PVE_CA_CERT` | `/etc/pve/pve-root-ca.pem` | Zertifikat für TLS-Prüfung |
| `PVE_TLS_VERIFY` | `true` | TLS-Zertifikat überprüfen |
| `APP_USER` | `admin` | Dashboard-Benutzername |
| `APP_PASSWORD` | – | Dashboard-Passwort |
| `APP_SESSION_SECRET` | APP_PASSWORD | Optionaler Schlüssel zum Signieren von Sitzungen |
| `MAX_VM_FILE_BYTES` | `8388608` | Maximale VM-Dateigröße in Bytes |
| `MAX_CT_FILE_BYTES` | `536870912` | Maximale CT-Dateigröße, höchstens 512 MiB |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Adresse und Port des Webservers |
