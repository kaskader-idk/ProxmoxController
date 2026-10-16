const $=s=>document.querySelector(s);
const pathParts=location.pathname.split('/').filter(Boolean);
const kind=pathParts[1], vmid=Number(pathParts[2]);
let guest=null, currentPath='/', messages=[], pendingCalls=[], busy=false, configuredAI=false;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=n=>{n=Number(n)||0;if(n<1)return '—';const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return n.toFixed(i?1:0)+' '+u[i];};
function setError(message){const el=$('#guest-error');el.textContent=message||'';el.classList.toggle('hidden',!message);}
async function api(url,options={}){
 const response=await fetch(url,{cache:'no-store',...options});
 if(response.status===401){location.assign('/login');throw new Error('Anmeldung abgelaufen');}
 const data=await response.json().catch(()=>({detail:response.statusText}));
 if(!response.ok)throw new Error(data.detail||response.statusText);
 return data;
}
function cpuAssignment(g){
 if(g.status!=='running')return 'Nicht aktiv';
 if(g.type==='lxc')return g.cpu_affinity?'Host-Kerne '+g.cpu_affinity+' (dynamisch)':'Host-Kerne nicht verfügbar';
 return g.cpu_affinity?'Pinning: '+g.cpu_affinity:'Keine feste Pinning-Affinität';
}
function renderGuest(){
 const g=guest;if(!g)return;
 const display=g.name||((kind==='lxc'?'CT ':'VM ')+vmid);
 document.title=display+' · ProxmoxController';
 $('#guest-title').textContent=display;
 $('#guest-subtitle').textContent=(kind==='lxc'?'LXC-Container':'QEMU-VM')+' · ID '+vmid+' · '+(g.node||'');
 $('#terminal-host').textContent=display;
 $('#guest-live').textContent=g.status==='running'?'Läuft':'Gestoppt';
 $('#guest-live').classList.toggle('stopped',g.status!=='running');
 $('#guest-status').textContent=g.status==='running'?'Läuft':g.status==='paused'?'Pausiert':'Gestoppt';
 const cpu=Math.round((Number(g.cpu)||0)*100);
 $('#guest-cpu-value').textContent=cpu+'%';
 const cpuModel=kind==='lxc'?'Host-CPU':('CPU-Modell: '+(g.cpu_model||'Proxmox-Standard'));
 $('#guest-cpu-meta').textContent=(g.cores||1)+' vCPU · '+cpuModel+' · '+cpuAssignment(g);
 const used=Number(g.mem)||0,total=Number(g.maxmem)||Number(g.memory_configured)||0;
 $('#guest-ram-value').textContent=(total?Math.round(used/total*100):0)+'%';
 $('#guest-ram-meta').textContent=bytes(used)+' / '+bytes(total);
 const disk=Number(g.disk)||0,maxdisk=Number(g.maxdisk)||0;
 $('#guest-disk-value').textContent=bytes(disk);
 $('#guest-disk-meta').textContent=maxdisk?bytes(disk)+' / '+bytes(maxdisk):String(g.disk_configured||'');
}
async function loadGuest(){
 try{
  const data=await api('/api/overview');
  guest=(data.guests||[]).find(g=>Number(g.vmid)===vmid&&((kind==='lxc')===(g.type==='lxc')));
  if(!guest)throw new Error('CT/VM nicht gefunden.');
  renderGuest();setError('');
  $('#guest-updated').textContent='Aktualisiert '+new Date().toLocaleTimeString('de-AT');
 }catch(e){setError(e.message);}
}
function appendTerminal(command,result){
 const out=$('#terminal-output'),item=document.createElement('div');
 item.className='terminal-entry';
 const code=result.exit_code===0?'OK':'Exit '+result.exit_code;
 item.innerHTML='<div class="terminal-command"><span>root@'+esc(guest?.name||vmid)+':$</span> '+esc(command)+'</div><pre>'+esc((result.stdout||'')+(result.stderr?'\n'+result.stderr:'' )||'(keine Ausgabe)')+'</pre><small>'+esc(code)+'</small>';
 out.appendChild(item);out.scrollTop=out.scrollHeight;
}
$('#terminal-form').addEventListener('submit',async e=>{
 e.preventDefault();const input=$('#terminal-command'),command=input.value.trim();
 if(!command||!guest)return;
 input.value='';input.disabled=true;
 try{const result=await api('/api/guest/'+kind+'/'+vmid+'/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command})});appendTerminal(command,result);}
 catch(err){appendTerminal(command,{exit_code:1,stderr:err.message});}
 finally{input.disabled=false;input.focus();}
});
function renderAI(){
 const box=$('#ai-messages');
 box.innerHTML=messages.filter(m=>m.role==='user'||m.role==='assistant').map(m=>'<div class="ai-message '+(m.role==='user'?'user':'assistant')+'"><b>'+(m.role==='user'?'Du':'KI')+'</b><pre>'+esc(typeof m.content==='string'?m.content:(m.content==null?'':JSON.stringify(m.content)))+'</pre></div>').join('');
 box.scrollTop=box.scrollHeight;
}
function syncAIControls(){
 const disabled=!configuredAI||busy||pendingCalls.length>0;
 $('#ai-send').disabled=disabled;$('#ai-prompt').disabled=disabled;
}
function systemPrompt(){
 return 'Du hilfst bei der Diagnose und Administration genau dieses Linux-Gasts: '+(guest?.name||'Gast')+', Typ '+kind+', ID '+vmid+'. Du darfst einen Shell-Befehl nur über das Tool run_guest_command vorschlagen. Jeder vorgeschlagene Befehl wird dem Benutzer zuerst angezeigt und nur nach seiner manuellen Freigabe ausgeführt. Erkläre kurz riskante oder destruktive Befehle und vermeide sie, sofern der Benutzer sie nicht ausdrücklich verlangt. Führe bevorzugt lesende Diagnosebefehle aus. Behaupte niemals, einen Befehl ausgeführt zu haben, bevor ein Tool-Ergebnis vorliegt.';
}
async function requestAI(){
 if(busy)return;busy=true;$('#ai-send').disabled=true;$('#ai-state').textContent='KI arbeitet …';
 try{
  const data=await api('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:systemPrompt()},...messages]})});
  const message=data.message||{};messages.push(message);
  const calls=message.tool_calls||[];
  pendingCalls=calls.map(call=>({id:call.id,name:call.function?.name,args:call.function?.arguments||'{}'}));
  renderAI();renderPending();
  if(!pendingCalls.length)$('#ai-state').textContent='Verbunden';
 }catch(e){messages.push({role:'assistant',content:'KI-Fehler: '+e.message});renderAI();$('#ai-state').textContent='Fehler';}
 finally{busy=false;syncAIControls();}
}
function renderPending(){
 const panel=$('#ai-pending');
 if(!pendingCalls.length){panel.innerHTML='';return;}
 const item=pendingCalls[0];let args={};
 try{args=JSON.parse(item.args);}catch(_){}
 if(item.name!=='run_guest_command'||typeof args.command!=='string'){
  panel.innerHTML='<div class="approval-card"><b>Unbekannter KI-Befehl</b><p>Dieser Tool-Aufruf wird nicht ausgeführt.</p><button id="ai-reject" class="button">Verwerfen</button></div>';
 }else{
  panel.innerHTML='<div class="approval-card"><b>Befehl wartet auf deine Freigabe</b><pre>'+esc(args.command)+'</pre><div><button id="ai-approve" class="button primary">Im Gast ausführen</button> <button id="ai-reject" class="button">Verwerfen</button></div></div>';
 }
 $('#ai-approve')?.addEventListener('click',()=>resolveTool(true,args.command,item));
 $('#ai-reject')?.addEventListener('click',()=>resolveTool(false,args.command,item));
}
async function resolveTool(approve,command,item){
 if(busy)return;busy=true;$('#ai-state').textContent=approve?'Befehl läuft …':'Befehl verworfen';
 let result={exit_code:1,stdout:'',stderr:'Vom Benutzer verworfen; nicht ausgeführt.'};
 if(approve){
  try{result=await api('/api/guest/'+kind+'/'+vmid+'/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command})});}
  catch(e){result={exit_code:1,stdout:'',stderr:e.message};}
  appendTerminal(command,result);
 }
 messages.push({role:'tool',tool_call_id:item.id,name:item.name,content:JSON.stringify(result)});
 pendingCalls.shift();renderAI();renderPending();busy=false;
 syncAIControls();
 if(pendingCalls.length){$('#ai-state').textContent='Freigabe erforderlich';return;}
 await requestAI();
}
$('#ai-form').addEventListener('submit',async e=>{
 e.preventDefault();const prompt=$('#ai-prompt'),content=prompt.value.trim();
 if(!content||!configuredAI||busy)return;
 messages.push({role:'user',content});prompt.value='';renderAI();await requestAI();
});
$('#ai-clear').addEventListener('click',()=>{messages=[];pendingCalls=[];renderAI();renderPending();});
async function loadAISettings(){
 try{
  const data=await api('/api/ai/settings');
  $('#ai-base-url').value=data.base_url||'';$('#ai-model').value=data.model||'';
  configuredAI=!!data.configured;$('#ai-state').textContent=configuredAI?'Verbunden':'Nicht verbunden';
  syncAIControls();
 }catch(e){$('#ai-state').textContent='Nicht verfügbar';}
}
$('#ai-settings-form').addEventListener('submit',async e=>{
 e.preventDefault();const button=e.submitter;button.disabled=true;
 try{
  await api('/api/ai/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
   base_url:$('#ai-base-url').value,model:$('#ai-model').value,api_key:$('#ai-api-key').value,
   clear_api_key:$('#ai-clear-key').checked
  })});
  $('#ai-api-key').value='';$('#ai-clear-key').checked=false;configuredAI=true;
  $('#ai-state').textContent='Verbindung gespeichert';syncAIControls();
  $('#ai-settings-form').closest('details').open=false;
 }catch(err){$('#ai-state').textContent=err.message;}
 finally{button.disabled=false;}
});
async function browseFiles(){
 if(!guest)return;$('#guest-file-table').innerHTML='<tr><td colspan="5" class="empty">Lade Verzeichnis …</td></tr>';
 $('#file-path').textContent=currentPath;
 try{
  const data=await api('/api/guest/'+kind+'/'+vmid+'/files?path='+encodeURIComponent(currentPath));
  $('#file-path').textContent=data.path||currentPath;
  const rows=(data.entries||[]).map(f=>{
   const path=(currentPath==='/'?'':currentPath)+'/'+f.name,dir=f.kind==='dir';
   return '<tr><td class="name-cell">'+(dir?'<button class="file-open" data-file-path="'+esc(path)+'">📁 '+esc(f.name)+'</button>':'📄 '+esc(f.name))+'</td><td>'+(dir?'Ordner':f.kind==='file'?'Datei':'Spezialdatei')+'</td><td>'+(dir?'—':bytes(f.size))+'</td><td>'+(f.modified?new Date(f.modified*1000).toLocaleString('de-AT'):'—')+'</td><td>'+(f.kind==='file'?'<a class="download-link" href="/api/guest/'+kind+'/'+vmid+'/file?path='+encodeURIComponent(path)+'">Download ↓</a>':'')+'</td></tr>';
  }).join('');
  $('#guest-file-table').innerHTML=rows||'<tr><td colspan="5" class="empty">Dieses Verzeichnis ist leer</td></tr>';
 }catch(e){$('#guest-file-table').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.message)+'</td></tr>';}
}
document.addEventListener('click',e=>{const folder=e.target.closest('[data-file-path]');if(folder){currentPath=folder.dataset.filePath;browseFiles();}});
$('#file-up').addEventListener('click',()=>{if(currentPath==='/')return;currentPath=currentPath.slice(0,currentPath.lastIndexOf('/'))||'/';browseFiles();});
$('#guest-files').addEventListener('toggle',e=>{if(e.target.open)browseFiles();});
const drop=$('#guest-dropzone'),fileInput=$('#guest-file-input');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag');}));
drop.addEventListener('drop',e=>uploadFiles(e.dataTransfer.files));
fileInput.addEventListener('change',()=>uploadFiles(fileInput.files));
async function uploadFiles(list){
 if(!list?.length||!guest)return;const form=new FormData();for(const file of list)form.append('files',file);
 $('#file-progress').textContent='Lade '+list.length+' Datei(en) …';
 try{
  await api('/api/guest/'+kind+'/'+vmid+'/files?path='+encodeURIComponent(currentPath),{method:'POST',body:form});
  $('#file-progress').textContent='Upload abgeschlossen';await browseFiles();
 }catch(e){$('#file-progress').textContent='Fehler: '+e.message;}
 finally{fileInput.value='';setTimeout(()=>$('#file-progress').textContent='',5000);}
}
$('#guest-refresh').addEventListener('click',loadGuest);
if(!['qemu','lxc'].includes(kind)||!Number.isInteger(vmid)){setError('Ungültige Gastadresse.');}
else{loadGuest();loadAISettings();setInterval(loadGuest,3000);}
