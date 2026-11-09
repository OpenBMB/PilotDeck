import { THINKING_EFFORTS, thinkingFormatsForProtocol, type ModelThinkingSettings, type ThinkingFormat } from '../../../../../../../src/model/thinking/settings.js';
import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, Loader2, Plug, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../../../ui/ConfirmDialog';
import type { ConnectionTestTask } from '../hooks/useConnectionTestTasks';

export type ModelSettingsPatch = { maxOutputTokens: number; maxContextTokens: number; supportsImage: boolean; thinking?: ModelThinkingSettings };

type Props = {
  modelId: string;
  protocol?: string;
  initial: ModelSettingsPatch;
  task?: ConnectionTestTask;
  testDisabled: boolean;
  testDisabledReason?: string;
  saveBeforeTest?: boolean;
  blockingTask?: ConnectionTestTask;
  onCancelBlockingTest?: () => void;
  cancellingBlockedTest?: boolean;
  applyTestResult?: boolean;
  testError?: string;
  onTest: (patch?: ModelSettingsPatch) => Promise<{ ok: boolean; error?: string }>;
  onCancelTest: () => void;
  onSave: (patch: ModelSettingsPatch) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
};

export default function ModelSettingsModal({ modelId, protocol = 'openai', initial, task, testDisabled, testDisabledReason, saveBeforeTest = false, blockingTask, onCancelBlockingTest, cancellingBlockedTest, applyTestResult = true, testError, onTest, onCancelTest, onSave, onClose }: Props) {
  const { t } = useTranslation('settings');
  const label = (key: string) => t(`pilotDeckConfig.panels.models.modelSettings.${key}`);
  const [output, setOutput] = useState(String(initial.maxOutputTokens));
  const [context, setContext] = useState(String(initial.maxContextTokens));
  const [image, setImage] = useState(initial.supportsImage);
  const [thinking, setThinking] = useState<ModelThinkingSettings>(initial.thinking ?? { state: 'default', efforts: [], format: 'provider' });
  const formats = thinkingFormatsForProtocol(protocol);
  const effectiveFormat = formats.includes(thinking.format) ? thinking.format : 'provider';
  const [saving, setSaving] = useState(false);
  const [submittingTest, setSubmittingTest] = useState(false);
  const [error, setError] = useState('');
  const reasonId = useId();
  const manual = useRef(false);
  const applied = useRef<string | null>(null);
  const saveLock = useRef(false);
  const running = task?.status === 'testing' || task?.status === 'cancelling';
  const result = task?.result?.models?.find(model => model.modelId === modelId);
  useEffect(() => {
    if (!applyTestResult || !task || running || !result || applied.current === task.id) return;
    applied.current = task.id;
    if (!manual.current && result.imageInput !== 'unknown') setImage(result.imageInput === 'supported');
  }, [task, result, running, applyTestResult]);
  const valid = [output, context].every(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0);
  const values = (): ModelSettingsPatch => ({ maxOutputTokens: Number(output), maxContextTokens: Number(context), supportsImage: image, thinking: { ...thinking, format: effectiveFormat } });
  const initialThinking = initial.thinking ?? { state: 'default', efforts: [], format: 'provider' };
  const dirty = Number(output) !== initial.maxOutputTokens || Number(context) !== initial.maxContextTokens || image !== initial.supportsImage
    || thinking.state !== initialThinking.state || effectiveFormat !== initialThinking.format
    || JSON.stringify(thinking.efforts) !== JSON.stringify(initialThinking.efforts);
  const reason = testDisabledReason || (!valid ? label('invalidTokenLimits') : undefined);
  const busy = saving || submittingTest;
  const test = async () => {
    if (testDisabled || !valid || running || saveLock.current) return;
    saveLock.current = true; setSubmittingTest(true); setError('');
    try {
      const started = await onTest(saveBeforeTest || dirty ? values() : undefined);
      if (started.ok) manual.current = false;
      else setError(started.error || label('saveFailed'));
    } catch { setError(t('pilotDeckConfig.panels.models.testRequestFailed')); }
    finally { saveLock.current = false; setSubmittingTest(false); }
  };
  const save = async () => {
    if (!valid || saveLock.current) return;
    saveLock.current = true; setSaving(true); setError('');
    try {
      const saved = await onSave(values());
      if (saved.ok) onClose(); else setError(saved.error || label('saveFailed'));
    } catch { setError(label('saveFailed')); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const status = (value?: string) => value === 'supported'
    ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label={label('passed')} />
    : value === 'unsupported'
      ? <XCircle className="h-4 w-4 text-[var(--pd-danger-ink)]" aria-label={label('failed')} />
      : <CircleHelp className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-label={label('unknown')} />;
  const probeMessage = result?.error?.message === 'The model replied without describing the test image.'
    ? label('imageNotDescribed')
    : result?.error?.message;
  const imageUnconfirmed = result?.textInput === 'supported' && result?.imageInput === 'unknown';
  const inputClass = 'mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary';
  return <ConfirmDialog title={label('title')} confirmLabel={label('save')} busy={busy} disabled={!valid || running} error={error} onCancel={onClose} onConfirm={() => void save()}>
    <p className="mb-5 break-all text-sm font-medium text-foreground">{modelId}</p>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="text-xs font-medium">{t('pilotDeckConfig.panels.models.maxOutputTokens')}
        <input className={inputClass} aria-label={t('pilotDeckConfig.panels.models.maxOutputTokens')} inputMode="numeric" value={output} onChange={e => setOutput(e.target.value)} disabled={busy} />
      </label>
      <label className="text-xs font-medium">{t('pilotDeckConfig.panels.models.maxContextTokens')}
        <input className={inputClass} aria-label={t('pilotDeckConfig.panels.models.maxContextTokens')} inputMode="numeric" value={context} onChange={e => setContext(e.target.value)} disabled={busy} />
      </label>
    </div>
    <div className="my-5 flex flex-wrap gap-x-5 gap-y-3 text-sm text-foreground">
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={image} disabled={busy} onChange={e => { manual.current = true; setImage(e.target.checked); }} />{label('imageInput')}
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={thinking.state === 'enabled'} disabled={busy} onChange={e => setThinking({ ...thinking, state: e.target.checked ? 'enabled' : 'default' })} />{label('thinkingEnabled')}
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={thinking.state === 'disabled'} disabled={busy} onChange={e => setThinking({ ...thinking, state: e.target.checked ? 'disabled' : 'default' })} />{label('thinkingDisabled')}
      </label>
    </div>
    <p className="mb-4 text-xs text-muted-foreground" role="status">{label(`thinkingHelp.${thinking.state}`)}</p>
    {thinking.state === 'enabled' && <fieldset disabled={busy} className="mb-4">
      <legend className="mb-2 text-xs font-medium">{label('thinkingEfforts')}</legend>
      <div className="flex flex-wrap gap-4">{THINKING_EFFORTS.map(effort => <label key={effort} className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={thinking.efforts.includes(effort)} onChange={e => setThinking({ ...thinking, efforts: THINKING_EFFORTS.filter(value => value === effort ? e.target.checked : thinking.efforts.includes(value)) })} />{effort}
      </label>)}</div>
      <p className="mt-2 text-xs text-muted-foreground">{label('thinkingEffortsHelp')}</p>
    </fieldset>}
    <details className="mb-5 text-sm">
      <summary className="cursor-pointer">{label('thinkingAdvanced')}</summary>
      <label className="mt-3 block text-xs font-medium">{label('thinkingFormat')}
        <select className={inputClass} value={effectiveFormat} disabled={busy} onChange={e => setThinking({ ...thinking, format: e.target.value as ThinkingFormat })}>
          {formats.map(format => <option key={format} value={format}>{label(`thinkingFormats.${format}`)}</option>)}
        </select>
      </label>
      <p className="mt-2 text-xs text-muted-foreground">{label('thinkingFormatHelp')}</p>
    </details>
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" disabled={testDisabled || busy || running || !valid} aria-describedby={reason ? reasonId : undefined} onClick={() => void test()} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">
          {running || submittingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {running ? label('testing') : saveBeforeTest || dirty ? label('saveAndTest') : t('pilotDeckConfig.panels.models.testConnection')}
        </button>
        {running && <button type="button" disabled={task?.status === 'cancelling'} className="text-xs text-muted-foreground hover:text-foreground" onClick={onCancelTest}>{label('cancelTest')}</button>}
      </div>
      {reason && <p id={reasonId} role="status" className="mt-3 text-xs text-muted-foreground">{reason}</p>}
      {blockingTask && onCancelBlockingTest && <button type="button" disabled={cancellingBlockedTest || blockingTask.status === 'cancelling' || blockingTask.status === 'savingTest'} onClick={onCancelBlockingTest} className="mt-2 text-xs text-[var(--pd-accent-strong,#4948cf)] hover:underline disabled:opacity-40">{label('cancelPreviousTest')}</button>}
      {!running && result && <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3 text-xs" role="status">
        <div className="flex items-center justify-between">{label('textRequest')}{status(result.textInput)}</div>
        <div className="flex items-center justify-between">{label('imageRequest')}{status(result.imageInput)}</div>
        {probeMessage && <p className={`break-words ${imageUnconfirmed ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{probeMessage}</p>}
      </div>}
      {(testError || task?.message) && <p role="status" className="mt-3 text-xs text-[var(--pd-danger-ink)]">{testError || task?.message}</p>}
    </div>
  </ConfirmDialog>;
}
