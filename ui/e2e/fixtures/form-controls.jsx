import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmDialog } from '../../src/components/ui/ConfirmDialog';
import DateTimeField from '../../src/components/ui/DateTimeField';
import { Select } from '../../src/components/settings/shared/components/Inputs';
import { GeneralSelectControl } from '../../src/components/settings/shared/view/GeneralSettingsPrimitives';
import { applyLightAppearance } from '../../src/lib/appearanceRuntime';
import { normalizeLightAppearance } from '../../src/lib/lightAppearance';
import i18n from '../../src/i18n/config';
import { installFormControlEvents } from '../../src/lib/formControlEvents';
import '../../src/index.css';
import '../../src/light-appearance.css';
import '../../src/components/settings/settings-page.css';
import '../../src/form-controls.css';

await i18n.changeLanguage('en');
installFormControlEvents();
window.setControlAppearance = (preset, dark) => {
  document.documentElement.classList.toggle('dark', dark);
  applyLightAppearance(normalizeLightAppearance({ preset }), dark);
};
window.setControlAppearance('default', false);
const many = Array.from({ length: 1000 }, (_, i) => <option key={i} value={String(i)}>Model {String(i).padStart(4, '0')}</option>);
const options = [{value:'a',label:'Alpha'}, {value:'disabled',label:'Unavailable',disabled:true}, {value:'b',label:'Beta'}, {value:'c',label:'中文 · Gamma'}];
function App() {
  const [value, setValue] = useState('a'), [count, setCount] = useState(0), [modal, setModal] = useState(false);
  const [date, setDate] = useState('2028-02-29'), [time, setTime] = useState('09:15');
  const change = value => {setValue(value);setCount(n=>n+1);};
  return <main className="app-root" style={{padding:24,minHeight:'100vh',color:'var(--pd-ink)',background:'var(--pd-surface)'}}>
    <form onSubmit={event => {event.preventDefault();window.controlForm=Object.fromEntries(new FormData(event.currentTarget));}} style={{display:'grid',gap:20,maxWidth:420}}>
      <label>Grouped choice<select className="w-full rounded-lg border p-2" name="choice" value={value} onChange={e=>change(e.target.value)}>
        <optgroup label="Available routes">{options.map(o=><option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</optgroup>
        <optgroup label="Long labels"><option value="long">A long model identifier / provider / project / with enough text to wrap inside narrow windows</option></optgroup>
      </select></label>
      <GeneralSelectControl ariaLabel="General preference" value={value} options={options} onChange={change} />
      <Select value={value} options={options} onChange={change} />
      <label>Large catalog<select className="w-full rounded-lg border p-2" defaultValue="500">{many}</select></label>
      <fieldset disabled><legend>Locked preference</legend><select aria-label="Disabled choice"><option>Cannot change</option></select></fieldset>
      <label><input type="checkbox" name="enabled" defaultChecked /> Enabled</label>
      <label><input type="checkbox" aria-label="Partial selection" ref={node=>{if(node)node.indeterminate=true;}} /> Partial</label>
      <div><label><input type="radio" name="mode" value="one" defaultChecked /> One</label> <label><input type="radio" name="mode" value="two" /> Two</label></div>
      <label>Amount<input type="range" name="amount" min="0" max="100" defaultValue="30" /></label>
      <label>Date<DateTimeField type="date" name="date" value={date} min="2028-02-28" className="h-9 w-full rounded-lg border px-3" onValueChange={setDate} /></label>
      <label>Time<DateTimeField type="time" name="time" value={time} className="h-9 w-full rounded-lg border px-3" onValueChange={setTime} /></label>
      <output aria-label="Change count">{count}</output><output aria-label="Chosen value">{value}</output>
      <button type="submit">Submit form</button><button type="reset">Reset native fields</button>
    </form>
    <button onClick={()=>setModal(true)}>Open dialog</button>
    {modal && <ConfirmDialog title="Choice dialog" onCancel={()=>setModal(false)} onConfirm={()=>setModal(false)}>
      <label>Dialog choice<select className="w-full rounded-lg border p-2" value={value} onChange={e=>change(e.target.value)}>{options.map(o=><option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</select></label>
    </ConfirmDialog>}
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
