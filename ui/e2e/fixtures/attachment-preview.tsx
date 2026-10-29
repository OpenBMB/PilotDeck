import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import '../../src/i18n/config';
import ComposerAttachments from '../../src/components/chat/view/subcomponents/ComposerAttachments';
import MessageRowV2 from '../../src/components/chat-v2/MessageRowV2';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
function App() {
 const [files,setFiles]=useState<File[]>([]);
 const [message,setMessage]=useState<any>(null);
 return <FindShortcutProvider><main className="mx-auto max-w-4xl p-6"><h1 className="mb-6 text-2xl">附件预览测试</h1>
 <input type="file" multiple aria-label="Pick files" onChange={e=>setFiles(Array.from(e.target.files||[]))}/>
 <section className="my-6 rounded-xl border bg-neutral-50 p-4"><ComposerAttachments files={files} uploading={new Map(files.map(f=>[f,100]))} errors={new Map()} onRemove={i=>setFiles(files.filter((_,j)=>i!==j))} onRetry={()=>{}}/></section>
 <button onClick={async()=>{ const images=await Promise.all(files.filter(f=>f.type.startsWith('image/')).map(file=>new Promise<any>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve({data:reader.result,name:file.name});reader.readAsDataURL(file)})));setMessage({id:'user',type:'user',content:'比较这些图片',timestamp:new Date(),images});setFiles([]); }}>Send test message</button>
 {message&&<MessageRowV2 message={message} prevMessage={null} provider="pilotdeck" selectedProject={null} createDiff={()=>[]}/>}
 </main></FindShortcutProvider>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
