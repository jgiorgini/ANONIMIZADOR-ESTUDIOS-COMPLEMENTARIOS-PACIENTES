/* Anonimizador LAB Web v0.3: procesamiento en memoria del navegador; validar con casos de prueba. */
'use strict';
const $=id=>document.getElementById(id);
const state={pages:[],history:[],kind:'',source:'',text:'',initializing:false};
const ui={type:$('type'),date:$('date'),scope:$('scope'),mode:$('mode')};
const MAX_PAGES=60;
function clamp(n,min=0,max=1){return Math.max(min,Math.min(max,n));}
function announce(text,warning=false){$('status').textContent=text;$('warning').hidden=!warning;if(warning)$('warning').textContent=text;}
let toastTimer;
function toast(text){let node=$('toast');node.textContent=text;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,2700);}
function saveSettings(){try{localStorage.setItem('anon_lab_web_config_v1',JSON.stringify({mode:ui.mode.value,type:ui.type.value}));}catch{}}
function loadSettings(){try{const v=JSON.parse(localStorage.getItem('anon_lab_web_config_v1')||'{}');if(['auto','copy','save'].includes(v.mode))ui.mode.value=v.mode;if(['lab','other'].includes(v.type))ui.type.value=v.type;}catch{}}
function updateModeNote(){
 const note=$('modeNote');if(!note)return;
 note.textContent=ui.mode.value==='auto'
  ?'Automático: una página → copiar imagen; varias → guardar PDF completo.'
  :ui.mode.value==='copy'
   ?'Copiar imagen: reúne TODAS las páginas en una sola imagen vertical. En estudios largos, usá PDF para conservar legibilidad.'
   :'Guardar: exporta siempre el PDF completo.';
}
function dataRect(x,y,w,h,type='manual'){return {x:clamp(x),y:clamp(y),w:clamp(w,0,1-x),h:clamp(h,0,1-y),type};}
function documentName(){return ui.type.value==='lab'?'LABORATORIO':'ESTUDIO';}
function pageDescription(i){const p=state.pages[i];return `PÁGINA ${i+1} · ${p.boxes.length} ocultaciones`+(p.headerProposal ? ' · encabezado propuesto':'');}
function datesInText(text){let matches=[];const re=/(?:^|\D)([0-3]?\d)[\/\-.]([01]?\d)[\/\-.]((?:19|20)\d{2})(?!\d)/g;for(let m;(m=re.exec(text));){let d=+m[1],mon=+m[2],year=+m[3];let day=new Date(year,mon-1,d);if(year>=2000&&year<=new Date().getFullYear()+1&&day.getFullYear()===year&&day.getMonth()===mon-1&&day.getDate()===d){matches.push(String(d).padStart(2,'0')+'/'+String(mon).padStart(2,'0')+'/'+year);}}return Array.from(new Set(matches));}
function suggestDate(fullText){const dates=datesInText(fullText);if(dates.length&&(!ui.date.value.trim()))ui.date.value=dates[0];}
function getRenderedViewport(page,scale){return page.getViewport({scale});}
function groupTextLines(items,viewport){const rows=[];for(const item of items){const str=(item.str||'').trim();if(!str)continue;const t=pdfjsLib.Util.transform(viewport.transform,item.transform);let y=clamp((t[5]-Math.max(5,Math.abs(item.height||9)))/viewport.height);let x=clamp(t[4]/viewport.width);let width=clamp((item.width||0)/viewport.width);let row=rows.find(r=>Math.abs(r.y-y)<.0055);if(!row){row={y,items:[]};rows.push(row);}row.items.push({text:str,x,w:width});}return rows.sort((a,b)=>a.y-b.y).map(r=>({y:r.y,text:r.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join(' ')}));}
// Detecta una FRANJA identificatoria, no todo el encabezado: conserva institución y firmantes.
// No se activa por años ni por texto genérico. PDF escaneados sin texto necesitan intervención manual.
function proposeHeader(lines){
 const rows=lines.filter(r=>r.y>=.015&&r.y<.50);
 const identifying=/(?:\bpaciente\s*[:#-]|\bpatient\s*[:#-]|\bpatient\s+name\s*[:#-]|\bnombre\s+(?:del\s+)?paciente\b|\bd\.?n\.?i\.?\s*[:#-]?\s*\d|\bdocumento\s*[:#-]|\bprotocolo\s*(?:n[°ºo.]*)?\s*[:#-]|\bhistoria\s+cl[ií]nica\s*[:#-]|\bf\.?\s*nac\.?\s*[:#-]|\bfecha\s+de\s+nacimiento\s*[:#-]|\bafiliad[oa]\s*[:#-])/i;
 const hits=rows.filter(r=>identifying.test(r.text));
 if(!hits.length)return null;
 const first=Math.min(...hits.map(r=>r.y));
 const last=Math.max(...hits.map(r=>r.y));
 // No invadir secciones clínicas: estos marcadores limitan el extremo inferior.
 const clinical=rows.filter(r=>r.y>last+.002&&r.y<last+.12&&
  /\b(?:resultado(?:s)?|valores?\s+de\s+referencia|hemograma|serie\s+eritrocitaria|creatinina|glucosa|colesterol|triglic[eé]ridos|determinaciones|anal[ií]tica|estudio)\b/i.test(r.text));
 const next=clinical.length?Math.min(...clinical.map(r=>r.y)):null;
 const top=clamp(first-.012,0,.45);
 let bottom=Math.min(.55,last+.036);
 if(next!==null)bottom=Math.min(bottom,next-.009);
 if(bottom-top<.018)bottom=Math.min(.55,top+.018);
 if(bottom<=top)return null;
 return dataRect(0,top,1,bottom-top,'header');
}
function proposeFooter(lines){for(const row of lines){if(row.y>.70&&/este protocolo fue validado|copia fiel del original|firma digital|acceder a sus informes|laboratorio habilitado/i.test(row.text))return clamp(row.y-.006,.7,.96);}return null;}
function newPage(canvas,lines=[]){return {canvas,boxes:[],headerProposal:proposeHeader(lines),footerProposal:null,noHeader:false,handled:false,lines};}
async function openFile(file){if(!file)return;state.pages=[];state.history=[];state.kind='';ui.date.value='';$('textSection').hidden=true;$('pageGrid').hidden=false;announce('Leyendo '+file.name+'…');try{
 if(file.type==='application/pdf'||/\.pdf$/i.test(file.name))await readPDF(file);
 else if(file.type.startsWith('image/'))await readImage(file);
 else if(file.type.startsWith('text/')){showText(await file.text());return;}
 else throw new Error('Formato no reconocido. Usá PDF, JPG, PNG o texto pegado.');
 if(state.pages.length)render();
}catch(e){announce('No se pudo abrir el archivo: '+(e?.message||String(e)),true);console.error(e);}}
async function readPDF(file){if(typeof pdfjsLib==='undefined')throw new Error('Falta PDF.js. Ejecutá PREPARAR_LIBRERIAS.ps1 en la carpeta descargada.');pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/pdf.worker.min.js';const bytes=new Uint8Array(await file.arrayBuffer());let doc=await pdfjsLib.getDocument({data:bytes,disableAutoFetch:true,disableStream:true,useSystemFonts:true,isEvalSupported:false}).promise;if(doc.numPages>MAX_PAGES)throw new Error('Límite provisional de '+MAX_PAGES+' páginas.');state.kind='pdf';let allText=[];for(let i=1;i<=doc.numPages;i++){announce(`Preparando página ${i} de ${doc.numPages}…`);let page=await doc.getPage(i);let one=getRenderedViewport(page,1);let scale=Math.min(2,2000/one.width);let viewport=getRenderedViewport(page,scale);let canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);let cx=canvas.getContext('2d',{alpha:false});cx.fillStyle='white';cx.fillRect(0,0,canvas.width,canvas.height);await page.render({canvasContext:cx,viewport}).promise;let content=await page.getTextContent();let lines=groupTextLines(content.items,one);state.pages.push(newPage(canvas,lines));allText.push(lines.map(l=>l.text).join('\n'));page.cleanup();}
 await doc.destroy();suggestDate(allText.join('\n'));announce(`PDF cargado: ${state.pages.length} páginas. Encabezados propuestos: ${state.pages.filter(p=>p.headerProposal!==null).length}/${state.pages.length}. Revisá los recuadros ámbar.`);}
async function readImage(file){const obj=URL.createObjectURL(file);try{let img=new Image();img.src=obj;await img.decode();const scale=Math.min(1,2400/img.naturalWidth,3300/img.naturalHeight);let can=document.createElement('canvas');can.width=Math.round(img.naturalWidth*scale);can.height=Math.round(img.naturalHeight*scale);let c=can.getContext('2d',{alpha:false});c.fillStyle='white';c.fillRect(0,0,can.width,can.height);c.drawImage(img,0,0,can.width,can.height);state.pages.push(newPage(can));state.kind='image';announce('Imagen cargada. Sin OCR local aún: cubrí los identificadores manualmente y marcá «Sin encabezado» si corresponde.');}finally{URL.revokeObjectURL(obj);}}
function originalToCleanText(text){let lines=text.split(/\r?\n/);let identifying=/\b(?:paciente|documento|dni|historia\s*cl[ií]nica|n[úu]mero de afiliado|protocolo|registro|m[eé]dico|solicitad[oa]\s+por|domicilio|direcci[oó]n|tel[eé]fono|celular|e-?mail|correo|fecha de nacimiento|f\.\s*nac\.)\s*[:=\-]/i;return lines.map(line=>identifying.test(line)?'[IDENTIFICADOR OMITIDO]':line).join('\n');}
function showText(text){state.kind='text';state.text=text;state.pages=[];$('pageGrid').hidden=true;$('textSection').hidden=false;$('textArea').value=originalToCleanText(text);suggestDate(text);announce('Texto pegado. Revisá la versión propuesta: puede contener nombres no etiquetados u otros identificadores.');}
function allTargets(clicked){return ui.scope.value==='all'?state.pages.map((_,i)=>i):[clicked];}
function snapshot(){state.history.push(state.pages.map(p=>({boxes:p.boxes.map(b=>({...b})),headerProposal:p.headerProposal,footerProposal:p.footerProposal,noHeader:p.noHeader,handled:p.handled})));if(state.history.length>30)state.history.shift();}
function undo(){const ss=state.history.pop();if(!ss){toast('Sin cambios para deshacer');return;}state.pages.forEach((p,i)=>Object.assign(p,ss[i]));render();}
function toggleNoHeader(i){snapshot();const p=state.pages[i];p.noHeader=!p.noHeader;p.handled=p.noHeader||p.boxes.some(b=>b.type==='header');if(p.noHeader)p.headerProposal=null;render();}
function confirmAll(){if(!state.pages.length){toast('Primero abrí un documento');return false;}snapshot();for(const p of state.pages){if(p.headerProposal!==null&&!p.handled){p.boxes.push({...p.headerProposal,type:'header'});p.handled=true;p.headerProposal=null;}}render();let missing=state.pages.map((p,i)=>!p.handled&&!p.noHeader?i+1:null).filter(Boolean);if(missing.length){announce(`Falta revisar encabezado en página(s) ${missing.join(', ')}. Marcá el recuadro o «Sin encabezado».`,true);return false;}toast('Encabezados confirmados');return true;}
function render(){
 const grid=$('pageGrid');grid.replaceChildren();
 if(!state.pages.length)return;
 const unresolved=state.pages.filter(p=>!p.handled&&!p.noHeader&&p.headerProposal===null).length;
 $('status').textContent=`${state.pages.length} páginas visibles en desplazamiento continuo · ${unresolved} encabezados sin resolver · Arrastrá para ocultar un área. Por defecto se replica en todo el estudio.`;
 $('warning').hidden=true;
 // No se duplica el bitmap original: cada página conserva un único canvas de origen.
 state.pages.forEach((p,i)=>{
   let card=document.createElement('article');card.className='page-card';
   let top=document.createElement('div');top.className='page-top';
   let title=document.createElement('span');title.textContent=pageDescription(i);top.append(title);
   if(p.headerProposal===null){
     let btn=document.createElement('button');btn.textContent=p.noHeader?'✓ SIN ENCABEZADO':'SIN ENCABEZADO (revisado)';
     btn.title='Usá esta excepción solo cuando comprobaste que no hay información del paciente en esta página.';
     btn.onclick=()=>toggleNoHeader(i);top.append(btn);
   } else {
     let status=document.createElement('span');status.className='found-header';status.textContent='Encabezado propuesto';top.append(status);
   }
   card.append(top);
   let paper=document.createElement('div');paper.className='paper';
   const display=p.canvas;display.classList.add('source-page');paper.append(display);
   let overlay=document.createElement('canvas');overlay.className='overlay';
   // La máscara de revisión puede tener menos píxeles que el original para ahorrar memoria.
   const overlayWidth=Math.min(900,p.canvas.width);
   overlay.width=overlayWidth;overlay.height=Math.round(overlayWidth*p.canvas.height/p.canvas.width);
   paper.append(overlay);card.append(paper);
   let note=document.createElement('div');note.className='page-note';
   note.textContent=p.headerProposal!==null?'Ámbar: encabezado propuesto; se confirmará al exportar.':p.noHeader?'Página revisada: sin encabezado.':p.handled?'Encabezado ocultado.':'Sin límite automático: cubrí identificadores o marcá «Sin encabezado».';
   card.append(note);grid.append(card);
   const c=overlay.getContext('2d');
   function paint(){
     c.clearRect(0,0,overlay.width,overlay.height);
     function draw(b,proposal){
       c.fillStyle=proposal?'rgba(255,165,0,0.33)':'rgba(0,0,0,0.90)';
       c.strokeStyle=proposal?'#ed8c00':'#070707';
       c.lineWidth=Math.max(2,overlay.width/500);
       c.fillRect(b.x*overlay.width,b.y*overlay.height,b.w*overlay.width,b.h*overlay.height);
       c.strokeRect(b.x*overlay.width,b.y*overlay.height,b.w*overlay.width,b.h*overlay.height);
     }
     if(p.headerProposal!==null)draw(p.headerProposal,true);
     p.boxes.forEach(b=>draw(b,false));
   }
   paint();let down=null;
   function point(e){const b=overlay.getBoundingClientRect();return{x:clamp((e.clientX-b.left)/b.width),y:clamp((e.clientY-b.top)/b.height)};}
   overlay.addEventListener('pointerdown',e=>{down=point(e);overlay.setPointerCapture(e.pointerId);});
   overlay.addEventListener('pointermove',e=>{
     if(!down)return;let end=point(e);paint();let x=Math.min(down.x,end.x),y=Math.min(down.y,end.y);
     let w=Math.abs(end.x-down.x),h=Math.abs(end.y-down.y);
     if(w>.002&&h>.002){c.fillStyle='rgba(12,80,170,0.35)';c.fillRect(x*overlay.width,y*overlay.height,w*overlay.width,h*overlay.height);}
   });
   overlay.addEventListener('pointerup',e=>{
     if(!down)return;let end=point(e);
     let r=dataRect(Math.min(down.x,end.x),Math.min(down.y,end.y),Math.abs(end.x-down.x),Math.abs(end.y-down.y));
     down=null;if(r.w<.005||r.h<.005){paint();return;}
     snapshot();for(const target of allTargets(i)){
       let pg=state.pages[target];pg.boxes.push({...r});
       if(r.y<.24&&r.w>=.70){pg.handled=true;pg.headerProposal=null;}
     }
     render();
   });
 });
}
function checkSafe(){const unresolved=[];const clinical=[];state.pages.forEach((p,i)=>{if(!p.handled&&!p.noHeader)unresolved.push(i+1);for(const box of p.boxes){if(box.y>.25&&box.h>.35)clinical.push(i+1);if(p.lines.length){for(const line of p.lines){if(line.y>box.y+.003&&line.y<box.y+box.h&&/\b(?:glucosa|creatinina|colesterol|triglic[eé]ridos|hemoglobina|potasio|ferritina|urea|resultado|ldl|hdl|plaquetas|vitamina)\b/i.test(line.text))clinical.push(i+1);}}}});if(unresolved.length)throw new Error('Faltan encabezados en páginas '+unresolved.join(', ')+'. Marcá recuadros o «Sin encabezado».');if(clinical.length)throw new Error('Posible ocultación de datos clínicos en páginas '+[...new Set(clinical)].join(', ')+'. Ajustá los recuadros.');if(ui.type.value==='lab'&&!/^\d{2}\/\d{2}\/\d{4}$/.test(ui.date.value.trim()))throw new Error('Confirmá una fecha válida (dd/mm/aaaa) para el laboratorio.');}
function finalizedCanvas(page){const src=page.canvas,can=document.createElement('canvas');can.width=src.width;can.height=src.height;let c=can.getContext('2d',{alpha:false});c.drawImage(src,0,0);for(const b of page.boxes){c.fillStyle='#fff';c.fillRect(Math.max(0,Math.floor(b.x*can.width)),Math.max(0,Math.floor(b.y*can.height)),Math.ceil(b.w*can.width)+2,Math.ceil(b.h*can.height)+2);}const header=page.boxes.find(b=>b.type==='header');if(header&&ui.date.value.trim()){c.fillStyle='#111';c.font=`bold ${Math.max(14,Math.round(can.width/65))}px Arial`;c.textBaseline='top';const top=Math.max(2,Math.round(header.y*can.height)+3);c.fillText(`${documentName()} ${ui.date.value.trim()}`,Math.round(can.width*.018),top);}return can;}
async function exportDocument(force=null){try{if(!state.pages.length){toast('Abrí primero un documento');return;}if(!confirmAll())return;checkSafe();let mode=force||ui.mode.value;if(mode==='auto')mode=state.pages.length===1?'copy':'save';/* La elección explícita «Copiar» incluye todas las páginas o informa un error; nunca exporta solo una parte. */if(mode==='copy'){await copyImages();return;}let blob=await makePDF();const a=document.createElement('a');const obj=URL.createObjectURL(blob);a.href=obj;a.download=(ui.type.value==='lab'?'LABORATORIO':'ESTUDIO')+'_'+((ui.date.value||'SIN_FECHA').replaceAll('/',''))+'_desidentificado.pdf';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(obj),60000);toast('PDF preparado para guardar');announce(`PDF generado: ${state.pages.length} páginas. Revisá el archivo descargado antes de compartir.`);}catch(e){announce(e.message,true);}}
async function copyImages(){if(!window.isSecureContext||!navigator.clipboard?.write)throw new Error('El navegador no permite copiar imágenes aquí. Usá HTTPS o «Guardar PDF».');const sources=state.pages.map(finalizedCanvas);const maxWidth=Math.max(...sources.map(c=>c.width));const scale=Math.min(1,1800/maxWidth);const width=Math.round(maxWidth*scale);const height=Math.ceil(sources.reduce((sum,c)=>sum+c.height*scale,0))+Math.max(0,sources.length-1)*8;if(height>30000||width*height>65000000)throw new Error('El estudio es demasiado largo para copiarlo íntegro como una sola imagen sin perder legibilidad. Elegí «Guardar» para exportar todas las páginas en PDF.');const out=document.createElement('canvas');out.width=width;out.height=height;const c=out.getContext('2d',{alpha:false});c.fillStyle='white';c.fillRect(0,0,width,height);let y=0;for(let s of sources){c.drawImage(s,0,y,Math.round(s.width*scale),Math.round(s.height*scale));y+=Math.round(s.height*scale)+8;}const blob=await new Promise((resolve,reject)=>out.toBlob(b=>b?resolve(b):reject(new Error('No se pudo preparar PNG')),'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);toast('IMAGEN COPIADA · Pegá con Ctrl+V');announce(`Imagen copiada: ${state.pages.length} página(s) unidas en una sola imagen. Pegá con Ctrl+V y revisá que se lean todos los resultados.`);}
function ascii(s){return new TextEncoder().encode(s);}function joinBytes(parts){const length=parts.reduce((n,b)=>n+b.length,0),out=new Uint8Array(length);let i=0;for(const b of parts){out.set(b,i);i+=b.length;}return out;}
function jpegBytes(canvas){const b64=canvas.toDataURL('image/jpeg',.96).split(',')[1];let binary=atob(b64),out=new Uint8Array(binary.length);for(let i=0;i<out.length;i++)out[i]=binary.charCodeAt(i);return out;}
async function makePDF(){const pages=state.pages.map(finalizedCanvas),n=pages.length,objects=new Map();objects.set(1,ascii('<< /Type /Catalog /Pages 2 0 R >>'));let kids=[];pages.forEach((canvas,index)=>{const pageId=3+index*3,contId=4+index*3,imgId=5+index*3;kids.push(pageId+' 0 R');const pw=612,ph=+(canvas.height/canvas.width*pw).toFixed(3);const operations=ascii(`q\n${pw} 0 0 ${ph} 0 0 cm\n/Im0 Do\nQ\n`);objects.set(pageId,ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contId} 0 R >>`));objects.set(contId,joinBytes([ascii(`<< /Length ${operations.length} >>\nstream\n`),operations,ascii('endstream')]));let img=jpegBytes(canvas);objects.set(imgId,joinBytes([ascii(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`),img,ascii('\nendstream')]));});objects.set(2,ascii(`<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`));let chunks=[ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')],offsets=[0],position=chunks[0].length;for(let i=1;i<=2+n*3;i++){let obj=objects.get(i),bytes=joinBytes([ascii(`${i} 0 obj\n`),obj,ascii('\nendobj\n')]);offsets[i]=position;chunks.push(bytes);position+=bytes.length;}const startxref=position;let xref=`xref\n0 ${2+n*3+1}\n0000000000 65535 f \n`;for(let i=1;i<=2+n*3;i++)xref+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';xref+=`trailer\n<< /Size ${2+n*3+1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;chunks.push(ascii(xref));return new Blob(chunks,{type:'application/pdf'});}
async function parsePaste(e){if(state.initializing)return;if(e && (document.activeElement===$('textArea') || document.activeElement===ui.date))return;let data=e?.clipboardData;if(data){const image=[...data.items].find(it=>it.type.startsWith('image/'));if(image){e.preventDefault();await openFile(image.getAsFile());return;}const text=data.getData('text/plain');if(text&&document.activeElement!==$('textArea')&&document.activeElement!==ui.date){e.preventDefault();showText(text);return;}}
 try{const entries=await navigator.clipboard.read();for(const entry of entries){const t=entry.types.find(x=>x.startsWith('image/'));if(t){await openFile(new File([await entry.getType(t)],'captura.png',{type:t}));return;}}const text=await navigator.clipboard.readText();if(text)showText(text);else announce('El portapapeles no contiene una imagen ni texto.',true);}catch(e){if(!e?.clipboardData)announce('Presioná Ctrl+V o permití el acceso al portapapeles en el navegador.',true);}}
window.addEventListener('DOMContentLoaded',()=>{loadSettings();$('fileInput').addEventListener('change',e=>openFile(e.target.files[0]));$('openBtn').onclick=()=>$('fileInput').click();$('pasteBtn').onclick=()=>parsePaste(null);document.addEventListener('paste',parsePaste);$('undo').onclick=undo;$('confirmExport').onclick=()=>exportDocument();ui.mode.onchange=()=>{saveSettings();updateModeNote();};ui.type.onchange=saveSettings;$('copyText').onclick=async()=>{try{await navigator.clipboard.writeText($('textArea').value);toast('TEXTO COPIADO · Revisá antes de pegar');}catch(e){announce('No se pudo copiar. Seleccioná texto manualmente: '+e.message,true);}};window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files.length)openFile(e.dataTransfer.files[0]);});updateModeNote();});
